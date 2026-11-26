import {
  BUILD_ABORTED_MESSAGE,
  BUILD_LOG_WRITE_FAILED_MESSAGE,
  BUILD_TIMEOUT_MESSAGE,
  decryptSecrets,
} from '@agentport/core';
import type { Database } from '@agentport/db';
import { repo } from '@agentport/db';
import {
  DATA_DOMAIN_BUILDS_QUEUE,
  type DataDomainBuildJob,
  dataDomainBuildJobSchema,
} from '@agentport/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { startIntervalTicker } from '../interval-ticker.js';
import { startRedisWorker } from '../queue-worker.js';

const BUILD_TIMEOUT_MS = 5 * 60_000;
const STALE_BUILDING_MS = 15 * 60_000;
const RECONCILE_MS = 5 * 60_000;
const SECRET_KEY_HINTS = [
  'password',
  'secret',
  'token',
  'credential',
  'connection_url',
  'connectionurl',
  'dsn',
  'access_key',
  'private_key',
];

const buildResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    mdlManifest: z.string().min(1),
    log: z.string().default(''),
    logTruncated: z.boolean().default(false),
  }),
  z.object({
    ok: z.literal(false),
    log: z.string().default(''),
    logTruncated: z.boolean().default(false),
    error: z.string().default('构建失败'),
  }),
]);

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hexCi(byte: number): string {
  return byte
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')
    .split('')
    .map((digit) => (/[0-9]/.test(digit) ? digit : `[${digit.toLowerCase()}${digit}]`))
    .join('');
}

function percentPattern(secret: string): RegExp {
  return new RegExp(
    Array.from(secret, (char) => {
      const percent = Array.from(new TextEncoder().encode(char), (byte) => `%${hexCi(byte)}`).join(
        '',
      );
      return `(?:${percent}|${regexEscape(char)})`;
    }).join(''),
    'g',
  );
}

function escapedVariants(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const asciiJson = json
    .split('')
    .map((char) =>
      char.charCodeAt(0) >= 0x7f ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char,
    )
    .join('');
  const variants = new Set<string>();
  for (const base of new Set([secret, json, asciiJson])) {
    variants.add(base);
    variants.add(base.replace(/\//g, '\\/'));
  }
  return [...variants].filter((variant) => variant !== '').sort((a, b) => b.length - a.length);
}

function sensitiveSecrets(connection: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(connection)) {
    const name = key.toLowerCase();
    if (!SECRET_KEY_HINTS.some((hint) => name.includes(hint))) continue;
    secrets.add(value);
    if (
      (name === 'connection_url' || name === 'connectionurl' || name === 'dsn') &&
      URL.canParse(value)
    ) {
      const password = new URL(value).password;
      secrets.add(password);
      try {
        secrets.add(decodeURIComponent(password));
      } catch {}
    }
  }
  return [...secrets].filter((secret) => secret !== '').sort((a, b) => b.length - a.length);
}

function scrub(text: string, secrets: readonly string[]): string {
  return [...secrets]
    .filter((secret) => secret !== '')
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => {
      const replaced = escapedVariants(secret).reduce(
        (acc, variant) => acc.replaceAll(variant, '******'),
        result,
      );
      return replaced.replace(percentPattern(secret), '******');
    }, text);
}

interface DataDomainBuildDeps {
  db: Database;
  logger: Logger;
  wrenRuntimeUrl: string;
  secretKey: string;
  signal: AbortSignal;
}

async function runDataDomainBuild(
  deps: DataDomainBuildDeps,
  job: DataDomainBuildJob,
): Promise<void> {
  const { dataDomainId, versionId } = job;
  const version = await repo.dataDomains.getDataDomainVersion(deps.db, versionId);
  if (!version || version.dataDomainId !== dataDomainId) {
    deps.logger.warn({ dataDomainId, versionId }, 'data domain build job does not match version');
    return;
  }
  const claimed = await repo.dataDomains.claimDataDomainVersionBuild(deps.db, versionId);
  if (claimed === null) return;

  let secrets: string[] = [];
  const failBuild = async (
    reason: string,
    buildLog = '',
    sourceTruncated = false,
  ): Promise<void> => {
    const text = scrub([buildLog, reason].filter((part) => part !== '').join('\n'), secrets);
    await repo.dataDomains
      .appendDataDomainVersionLog(deps.db, versionId, text, sourceTruncated)
      .catch(() => {
        deps.logger.warn({ dataDomainId, versionId }, 'data domain build log append failed');
      });
    await repo.dataDomains.failDataDomainVersionBuild(deps.db, versionId, 'building');
    deps.logger.warn({ dataDomainId, versionId }, 'data domain build failed');
  };

  let domain: Awaited<ReturnType<typeof repo.dataDomains.getDataDomain>>;
  try {
    domain = await repo.dataDomains.getDataDomain(deps.db, claimed.dataDomainId);
  } catch {
    await failBuild('数据域读取失败');
    return;
  }
  if (!domain) {
    await failBuild('数据域不存在，可能已被删除');
    return;
  }

  let connection: Record<string, string>;
  try {
    connection = await decryptSecrets(domain.connectionEncrypted, deps.secretKey);
  } catch {
    await failBuild('连接配置无法解密，请重新保存连接');
    return;
  }
  secrets = sensitiveSecrets(connection);

  if (deps.wrenRuntimeUrl === '') {
    await failBuild('wren runtime 未配置（WREN_RUNTIME_URL）');
    return;
  }

  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, BUILD_TIMEOUT_MS);
  let body: unknown;
  let responseOk = false;
  try {
    const response = await fetch(`${deps.wrenRuntimeUrl.replace(/\/+$/, '')}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectFiles: claimed.projectFiles,
        datasource: domain.datasource,
        connection,
      }),
      signal: AbortSignal.any([timeout.signal, deps.signal]),
    });
    responseOk = response.ok;
    body = await response.json();
  } catch {
    await failBuild(
      timedOut
        ? BUILD_TIMEOUT_MESSAGE
        : deps.signal.aborted
          ? BUILD_ABORTED_MESSAGE
          : 'wren runtime 请求失败',
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  const parsed = buildResponseSchema.safeParse(body);
  if (!parsed.success || (!responseOk && parsed.data.ok)) {
    await failBuild('wren runtime 响应异常');
    return;
  }
  if (!parsed.data.ok) {
    await failBuild(parsed.data.error, parsed.data.log, parsed.data.logTruncated);
    return;
  }

  const buildLog = scrub(parsed.data.log, secrets);
  try {
    await repo.dataDomains.appendDataDomainVersionLog(
      deps.db,
      versionId,
      buildLog,
      parsed.data.logTruncated,
    );
  } catch {
    await failBuild(BUILD_LOG_WRITE_FAILED_MESSAGE);
    return;
  }
  try {
    await repo.dataDomains.completeDataDomainVersionBuild(
      deps.db,
      versionId,
      parsed.data.mdlManifest,
    );
  } catch {
    await failBuild('构建结果写入失败');
  }
}

interface DataDomainBuildWorkerConfig {
  db: Database;
  logger: Logger;
  redisUrl: string;
  wrenRuntimeUrl: string;
  secretKey: string;
}

export async function startDataDomainBuildWorker(
  config: DataDomainBuildWorkerConfig,
): Promise<{ close: () => Promise<void> }> {
  return startRedisWorker<DataDomainBuildJob>({
    queue: DATA_DOMAIN_BUILDS_QUEUE,
    redisUrl: config.redisUrl,
    logger: config.logger,
    failureMessage: 'data domain build job failed',
    processor: (signal) => (job) => {
      const parsed = dataDomainBuildJobSchema.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid data domain build payload');
      return runDataDomainBuild(
        {
          db: config.db,
          logger: config.logger,
          wrenRuntimeUrl: config.wrenRuntimeUrl,
          secretKey: config.secretKey,
          signal,
        },
        parsed.data,
      );
    },
  });
}

export function startDataDomainBuildReconciler(input: {
  db: Database;
  logger: Logger;
}): () => Promise<void> {
  return startIntervalTicker(
    () =>
      reconcileStaleDataDomainBuilds(input.db, input.logger).catch(() => {
        input.logger.error('data domain build reconcile failed');
      }),
    RECONCILE_MS,
  );
}

async function reconcileStaleDataDomainBuilds(db: Database, logger: Logger): Promise<void> {
  const olderThan = new Date(Date.now() - STALE_BUILDING_MS);
  const stale = await repo.dataDomains.listStaleBuildingDataDomainVersions(db, olderThan);
  for (const version of stale) {
    const failed = await repo.dataDomains.failStaleDataDomainVersionBuild(
      db,
      version.id,
      olderThan,
      '构建中断或超时',
    );
    if (failed !== null) {
      logger.warn(
        { dataDomainId: failed.dataDomainId, versionId: failed.id },
        'stale data domain build reconciled as failed',
      );
    }
  }
}
