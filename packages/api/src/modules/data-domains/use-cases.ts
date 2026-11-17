import { dataDomainConnectionTestResultSchema } from '@agentport/contract/data-domains';
import { fail } from '@agentport/core';
import type { Database, DbHandle } from '@agentport/db';
import { newId, repo, schema } from '@agentport/db';
import {
  DATA_DOMAIN_BUILDS_QUEUE,
  DATA_DOMAIN_ENRICHMENTS_QUEUE,
  dataDomainBuildEnqueueOptions,
  dataDomainEnrichmentEnqueueOptions,
} from '@agentport/shared';
import { and, eq, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import type { Logger } from 'pino';
import { z } from 'zod';
import { getDataDomainBuildQueue, getDataDomainEnrichmentQueue } from '../../queue/producer.js';

function managedServerWhere(dataDomainId: string) {
  return and(
    eq(schema.servers.kind, 'data_domain'),
    sql`${schema.servers.config}->>'dataDomainId' = ${dataDomainId}`,
  );
}

export async function ensureDataDomainServer(
  db: DbHandle,
  domain: { id: string; slug: string; ownerBusinessId: string | null },
): Promise<repo.servers.ServerRow> {
  const name = `dd-${domain.slug}`;
  const [existing] = await db
    .select()
    .from(schema.servers)
    .where(managedServerWhere(domain.id))
    .limit(1);
  if (existing) {
    let row = existing;
    if (row.name !== name) {
      const [clash] = await db
        .select({ id: schema.servers.id })
        .from(schema.servers)
        .where(eq(schema.servers.name, name))
        .limit(1);
      if (clash && clash.id !== row.id) {
        fail('CONFLICT', `连接器名称 ${name} 已被占用，请更换数据域标识`);
      }
      row = (await repo.servers.updateServer(db, row.id, { name })) ?? row;
    }
    if (row.ownerBusinessId !== domain.ownerBusinessId) {
      const [synced] = await db
        .update(schema.servers)
        .set({ ownerBusinessId: domain.ownerBusinessId })
        .where(eq(schema.servers.id, row.id))
        .returning();
      if (synced) row = synced;
    }
    return row;
  }
  const [clash] = await db
    .select({ id: schema.servers.id })
    .from(schema.servers)
    .where(eq(schema.servers.name, name))
    .limit(1);
  if (clash) {
    fail('CONFLICT', `连接器名称 ${name} 已被占用，请更换数据域标识`);
  }
  const [row] = await db
    .insert(schema.servers)
    .values({
      id: newId('server'),
      name,
      kind: 'data_domain',
      config: { dataDomainId: domain.id },
      secretsEncrypted: null,
      ownerBusinessId: domain.ownerBusinessId,
    })
    .returning();
  if (!row) throw new Error('data domain server insert returned no row');
  return row;
}

export async function deleteDataDomainServer(db: DbHandle, dataDomainId: string): Promise<void> {
  await db.delete(schema.servers).where(managedServerWhere(dataDomainId));
}

export async function enqueueDataDomainBuild(
  db: Database,
  log: Logger,
  dataDomainId: string,
  versionId: string,
): Promise<void> {
  try {
    await getDataDomainBuildQueue().add(
      'build',
      { dataDomainId, versionId },
      dataDomainBuildEnqueueOptions(versionId),
    );
  } catch {
    try {
      await repo.dataDomains.failDataDomainVersionBuild(db, versionId, 'queued');
    } catch {
      log.warn({ dataDomainId, versionId }, 'data domain version failed-state compensation failed');
    }
    log.warn(
      { dataDomainId, versionId },
      `data domain build enqueue failed (queue ${DATA_DOMAIN_BUILDS_QUEUE})`,
    );
    fail('SERVICE_UNAVAILABLE', '构建任务入队失败，请稍后重试');
  }
}

export async function enqueueDataDomainEnrichment(
  db: Database,
  log: Logger,
  dataDomainId: string,
  proposalId: string,
): Promise<boolean> {
  try {
    await getDataDomainEnrichmentQueue().add(
      'enrich',
      { dataDomainId, proposalId },
      dataDomainEnrichmentEnqueueOptions(proposalId),
    );
    return true;
  } catch {
    try {
      await repo.dataDomains.failDataDomainEnrichmentProposal(db, proposalId, '生成任务入队失败');
    } catch {
      log.warn(
        { dataDomainId, proposalId },
        'data domain enrichment proposal failed-state compensation failed',
      );
    }
    log.warn(
      { dataDomainId, proposalId },
      `data domain enrichment enqueue failed (queue ${DATA_DOMAIN_ENRICHMENTS_QUEUE})`,
    );
    return false;
  }
}

const CONNECTION_TEST_TIMEOUT_MS = 15_000;
const MDL_GENERATION_TIMEOUT_MS = 60_000;

const generatedMdlPayloadSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    projectFiles: z.record(z.string(), z.string()),
    mdlManifest: z.string(),
    log: z.string(),
    logTruncated: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const postWrenRuntime = (
  url: string,
  datasource: string,
  connection: Record<string, string>,
  timeoutMs: number,
): Effect.Effect<unknown, Error> =>
  Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (active) => Effect.sync(() => active.abort()),
    );
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ datasource, connection }),
          signal: controller.signal,
        });
        return (await response.json()) as unknown;
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.timeout(timeoutMs));
  }).pipe(Effect.scoped);

export async function testDataDomainConnection(
  wrenRuntimeUrl: string,
  datasource: string,
  connection: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  if (wrenRuntimeUrl === '') {
    fail('SERVICE_UNAVAILABLE', '连接测试服务未配置（WREN_RUNTIME_URL）');
  }
  const url = `${wrenRuntimeUrl.replace(/\/+$/, '')}/test-connection`;
  const exit = await Effect.runPromiseExit(
    postWrenRuntime(url, datasource, connection, CONNECTION_TEST_TIMEOUT_MS),
  );
  if (exit._tag !== 'Success') {
    return { ok: false, error: '连接测试服务不可用，请稍后重试' };
  }
  const parsed = dataDomainConnectionTestResultSchema.safeParse(exit.value);
  if (!parsed.success) return { ok: false, error: '连接测试服务响应异常' };
  const { ok, error } = parsed.data;
  return error === undefined ? { ok } : { ok, error };
}

export async function generateDataDomainMdl(
  wrenRuntimeUrl: string,
  datasource: string,
  connection: Record<string, string>,
): Promise<{ ok: true; projectFiles: Record<string, string> } | { ok: false; error: string }> {
  if (wrenRuntimeUrl === '') {
    fail('SERVICE_UNAVAILABLE', '结构反射服务未配置（WREN_RUNTIME_URL）');
  }
  const url = `${wrenRuntimeUrl.replace(/\/+$/, '')}/generate-mdl`;
  const exit = await Effect.runPromiseExit(
    postWrenRuntime(url, datasource, connection, MDL_GENERATION_TIMEOUT_MS),
  );
  if (exit._tag !== 'Success') {
    return { ok: false, error: '结构反射服务不可用，请稍后重试' };
  }
  const parsed = generatedMdlPayloadSchema.safeParse(exit.value);
  if (!parsed.success) return { ok: false, error: '结构反射服务响应异常' };
  if (!parsed.data.ok) return { ok: false, error: parsed.data.error };
  return { ok: true, projectFiles: parsed.data.projectFiles };
}
