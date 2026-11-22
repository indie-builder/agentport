import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_ABORTED_MESSAGE,
  BUILD_LOG_WRITE_FAILED_MESSAGE,
  BUILD_TIMEOUT_MESSAGE,
} from '@agentport/core';
import {
  errorText,
  RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  type RuntimeEnvironmentBuildJob,
} from '@agentport/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { startRedisWorker } from '../queue-worker.js';
import { keepTail, runDocker, type SpawnFn } from './command.js';
import { verifyRuntimeEnvironmentImage } from './verify.js';

export const RUNTIME_ENVIRONMENT_BUILD_JOB = 'build';

export const RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS = 30 * 60_000;

const BUILD_LOG_FLUSH_BYTES = 16 * 1024;
const BUILD_LOG_FLUSH_MS = 1_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1) ?? ''
  );
}

function detail(stderr: string): string {
  const line = lastLine(stderr);
  return line === '' ? '' : `: ${line}`;
}

function imageTagFor(sandboxImage: string, versionId: string): string {
  const slash = sandboxImage.lastIndexOf('/');
  const colon = sandboxImage.lastIndexOf(':');
  const repository = colon > slash ? sandboxImage.slice(0, colon) : sandboxImage;
  return `${repository}:runtime-env-${versionId}`;
}

/** BuildKit 不接受裸镜像 ID 作为 FROM；用 ID 派生不可变 tag 再传给构建。 */
function immutableBaseTagFor(sandboxImage: string, imageId: string): string {
  const slash = sandboxImage.lastIndexOf('/');
  const colon = sandboxImage.lastIndexOf(':');
  const repository = colon > slash ? sandboxImage.slice(0, colon) : sandboxImage;
  return `${repository}:runtime-base-${imageId.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

interface RuntimeEnvironmentBuildSuccess {
  ok: true;
  baseImageId: string;
  imageId: string;
  imageTag: string;
  buildLog: string;
  logTruncated: boolean;
}

interface RuntimeEnvironmentBuildFailure {
  ok: false;
  /** aborted 表示被关闭信号或超时打断；终态由 handler 按原因写入。 */
  aborted: boolean;
  error: string;
  buildLog: string;
  logTruncated: boolean;
}

type RuntimeEnvironmentBuildResult =
  | RuntimeEnvironmentBuildSuccess
  | RuntimeEnvironmentBuildFailure;

interface RuntimeEnvironmentBuildInput {
  versionId: string;
  /** 版本创建时冻结的 Dockerfile 快照。 */
  dockerfile: string;
  /** 版本入队时冻结的基座引用；构建只认它，不读 worker 当前 SANDBOX_IMAGE。 */
  baseImageId: string;
  /** 构建输出增量回调；用于构建中分批落库。 */
  onOutput?: ((chunk: string) => void) | undefined;
  spawn?: SpawnFn | undefined;
  signal?: AbortSignal | undefined;
}

function createLog(): {
  append: (chunk: string) => void;
  text: () => string;
  truncated: () => boolean;
} {
  let text = '';
  let truncated = false;
  return {
    append: (chunk) => {
      const next = text + chunk;
      if (next.length > RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT) {
        text = keepTail(next);
        truncated = true;
      } else {
        text = next;
      }
    },
    text: () => text,
    truncated: () => truncated,
  };
}

function failure(
  log: ReturnType<typeof createLog>,
  error: string,
  aborted: boolean,
): RuntimeEnvironmentBuildFailure {
  return { ok: false, aborted, error, buildLog: log.text(), logTruncated: log.truncated() };
}

export async function executeRuntimeEnvironmentBuild(
  input: RuntimeEnvironmentBuildInput,
): Promise<RuntimeEnvironmentBuildResult> {
  const log = createLog();
  const spawnFn = input.spawn ?? spawn;
  const { signal } = input;
  const emit = (chunk: string): void => {
    log.append(chunk);
    input.onOutput?.(chunk);
  };
  if (signal?.aborted) return failure(log, BUILD_ABORTED_MESSAGE, true);

  let tempDir: string | undefined;
  try {
    const inspected = await runDocker(
      spawnFn,
      ['image', 'inspect', input.baseImageId, '--format', '{{.Id}}'],
      signal,
      emit,
    );
    if (inspected.aborted) return failure(log, BUILD_ABORTED_MESSAGE, true);
    const baseImageId = inspected.stdout.trim();
    if (inspected.code !== 0 || !IMAGE_ID.test(baseImageId)) {
      return failure(
        log,
        `基座镜像 ${input.baseImageId} 不存在或不可用${detail(inspected.stderr)}`,
        false,
      );
    }
    // 先把基座固定到由 ID 派生的 tag：tag 不可变，BuildKit 也能从本地解析。
    const baseTag = immutableBaseTagFor(input.baseImageId, baseImageId);
    const tagged = await runDocker(spawnFn, ['tag', baseImageId, baseTag], signal, emit);
    if (tagged.aborted) return failure(log, BUILD_ABORTED_MESSAGE, true);
    if (tagged.code !== 0) {
      return failure(log, `固定基座镜像失败${detail(tagged.stderr)}`, false);
    }

    tempDir = await mkdtemp(join(tmpdir(), 'runtime-env-build-'));
    const iidFile = join(tempDir, 'image.iid');
    await writeFile(join(tempDir, 'Dockerfile'), input.dockerfile, 'utf8');
    const imageTag = imageTagFor(input.baseImageId, input.versionId);

    const built = await runDocker(
      spawnFn,
      [
        'buildx',
        'build',
        '--progress',
        'plain',
        '--load',
        '--iidfile',
        iidFile,
        '--build-arg',
        `RUNTIME_BASE_IMAGE=${baseTag}`,
        '--tag',
        imageTag,
        tempDir,
      ],
      signal,
      emit,
    );
    if (built.aborted) return failure(log, BUILD_ABORTED_MESSAGE, true);
    if (built.code !== 0) {
      return failure(
        log,
        lastLine(built.stderr) || lastLine(built.stdout) || `构建失败 (exit ${built.code})`,
        false,
      );
    }

    const imageId = (await readFile(iidFile, 'utf8')).trim();
    if (!IMAGE_ID.test(imageId)) return failure(log, '构建未产出有效的镜像 ID', false);

    const user = await runDocker(
      spawnFn,
      ['image', 'inspect', imageId, '--format', '{{.Config.User}}'],
      signal,
      emit,
    );
    if (user.aborted) return failure(log, BUILD_ABORTED_MESSAGE, true);
    const configuredUser = user.stdout.trim();
    if (user.code !== 0) {
      return failure(log, `无法检查镜像用户${detail(user.stderr)}`, false);
    }
    if (configuredUser !== 'node' && configuredUser !== '1000' && configuredUser !== '1000:1000') {
      return failure(
        log,
        `镜像默认用户必须是 uid 1000 或 node，实际为 ${configuredUser || '(root)'}`,
        false,
      );
    }

    const verified = await verifyRuntimeEnvironmentImage({
      imageId,
      spawn: spawnFn,
      onOutput: emit,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!verified.ok) return failure(log, verified.error, verified.aborted);

    return {
      ok: true,
      baseImageId,
      imageId,
      imageTag,
      buildLog: log.text(),
      logTruncated: log.truncated(),
    };
  } catch (err) {
    return failure(log, errorText(err), signal?.aborted === true);
  } finally {
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RuntimeEnvironmentBuildClaim {
  versionId: string;
  dockerfile: string;
  /** 入队时冻结的基座引用；构建只认这个值。 */
  baseImageId: string;
}

export interface RuntimeEnvironmentBuildStore {
  /** 只认领 queued 版本并置为 building；重复投递或已终态返回 null。 */
  claimBuild(versionId: string): Promise<RuntimeEnvironmentBuildClaim | null>;
  /** 构建中分批追加；长度截断由 DB 按同一限长保留尾部。 */
  appendBuildLog(versionId: string, chunk: string): Promise<void>;
  /** 只改版本行，不推进线上指针；同时保存实际消费的基座 image ID。 */
  completeBuild(
    versionId: string,
    image: { imageTag: string; imageId: string; baseImageId: string },
  ): Promise<void>;
  failBuild(versionId: string, error: string): Promise<void>;
}

interface RuntimeEnvironmentBuildDeps {
  store: RuntimeEnvironmentBuildStore;
  logger: Logger;
  /** worker 关闭信号：abort 后当前构建按失败收尾，不留下 building。 */
  signal?: AbortSignal | undefined;
  spawn?: SpawnFn | undefined;
  timeoutMs?: number | undefined;
}

interface BuildLogStream {
  append: (chunk: string) => void;
  flush: () => Promise<void>;
  close: () => void;
}

function createBuildLogStream(
  store: RuntimeEnvironmentBuildStore,
  versionId: string,
  logger: Logger,
): BuildLogStream {
  let pending = '';
  let appendError: unknown;
  let draining: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    if (draining !== null) return draining;
    if (pending === '') return Promise.resolve();
    const owned = Promise.resolve()
      .then(async () => {
        while (pending !== '') {
          const chunk = pending;
          pending = '';
          await store.appendBuildLog(versionId, chunk);
        }
      })
      .catch((err) => {
        if (appendError === undefined) {
          appendError = err;
          logger.warn({ err, versionId }, 'runtime environment build log append failed');
        }
      })
      .finally(() => {
        draining = null;
      });
    draining = owned;
    return owned;
  };
  const append = (chunk: string): void => {
    pending += chunk;
    if (pending.length >= BUILD_LOG_FLUSH_BYTES) void drain();
  };
  const timer = setInterval(() => {
    void drain();
  }, BUILD_LOG_FLUSH_MS);
  timer.unref();
  return {
    append,
    flush: async () => {
      while (draining !== null || pending !== '') await drain();
      if (appendError !== undefined) throw appendError;
    },
    close: () => clearInterval(timer),
  };
}

export function createRuntimeEnvironmentBuildHandler(
  deps: RuntimeEnvironmentBuildDeps,
): (job: Job<RuntimeEnvironmentBuildJob>) => Promise<void> {
  return async (job) => {
    const { versionId } = job.data;
    const claim = await deps.store.claimBuild(versionId);
    if (claim === null) return;

    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, deps.timeoutMs ?? RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS);
    const signal =
      deps.signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, deps.signal]);
    const logStream = createBuildLogStream(deps.store, versionId, deps.logger);
    try {
      const result = await executeRuntimeEnvironmentBuild({
        versionId,
        dockerfile: claim.dockerfile,
        baseImageId: claim.baseImageId,
        onOutput: logStream.append,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
        signal,
      });
      let logError: unknown;
      try {
        await logStream.flush();
      } catch (err) {
        logError = err;
        deps.logger.warn({ err, versionId }, 'runtime environment build log flush failed');
      }
      if (result.ok && logError === undefined) {
        await deps.store.completeBuild(versionId, {
          imageTag: result.imageTag,
          imageId: result.imageId,
          baseImageId: result.baseImageId,
        });
        return;
      }
      await deps.store.failBuild(
        versionId,
        result.ok
          ? BUILD_LOG_WRITE_FAILED_MESSAGE
          : timedOut
            ? BUILD_TIMEOUT_MESSAGE
            : result.error,
      );
    } finally {
      clearTimeout(timer);
      logStream.close();
    }
  };
}

interface RuntimeEnvironmentBuildWorkerConfig {
  store: RuntimeEnvironmentBuildStore;
  logger: Logger;
  redisUrl: string;
  spawn?: SpawnFn | undefined;
  timeoutMs?: number | undefined;
  /** 测试用独立键前缀，避免消费真实队列。 */
  prefix?: string | undefined;
}

export async function startRuntimeEnvironmentBuildWorker(
  config: RuntimeEnvironmentBuildWorkerConfig,
): Promise<{ close: () => Promise<void> }> {
  return startRedisWorker<RuntimeEnvironmentBuildJob>({
    queue: RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
    redisUrl: config.redisUrl,
    logger: config.logger,
    failureMessage: 'runtime environment build job failed',
    processor: (signal) =>
      createRuntimeEnvironmentBuildHandler({
        store: config.store,
        logger: config.logger,
        signal,
        ...(config.spawn === undefined ? {} : { spawn: config.spawn }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      }),
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    includeErrorInFailedLog: true,
  });
}
