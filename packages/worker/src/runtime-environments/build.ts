import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT } from '@agentport/db';
import {
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  type RuntimeEnvironmentBuildJob,
} from '@agentport/shared';
import { type Job, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { verifyRuntimeEnvironmentImage } from './verify.js';

/** BullMQ 任务名；jobId 与载荷都由 shared 契约固定。 */
export const RUNTIME_ENVIRONMENT_BUILD_JOB = 'build';

export const RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS = 30 * 60_000;

/** 流式落库的批量窗口；日志总长由 DB 按同一常量保留尾部。 */
const BUILD_LOG_FLUSH_BYTES = 16 * 1024;
const BUILD_LOG_FLUSH_MS = 1_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** 失败不自动重试；只有 worker 关闭退回 queued 后由对账重新入队。 */
export function runtimeEnvironmentBuildEnqueueOptions(versionId: string) {
  return {
    jobId: versionId,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  };
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

interface CommandResult {
  code: number | null;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

function keepTail(text: string): string {
  return text.length > RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT
    ? text.slice(text.length - RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT)
    : text;
}

function runDocker(
  spawnFn: SpawnFn,
  args: string[],
  signal: AbortSignal | undefined,
  onOutput?: (chunk: string) => void,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const child = spawnFn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // 只留尾部，长时间构建不会在工作进程里无限累计输出。
      stdout = keepTail(stdout + chunk);
      onOutput?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk);
      onOutput?.(chunk);
    });
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => signal?.removeEventListener('abort', onAbort);
    child.once('error', (err) => {
      finish();
      reject(err);
    });
    child.once('close', (code) => {
      finish();
      resolveCommand({ code, aborted, stdout, stderr });
    });
    if (signal?.aborted) onAbort();
  });
}

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
  // 去掉已有 tag/digest，保留 registry 与仓库路径；tag 只用来定位构建产物。
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

export interface RuntimeEnvironmentBuildSuccess {
  ok: true;
  baseImageId: string;
  imageId: string;
  imageTag: string;
  buildLog: string;
  logTruncated: boolean;
}

export interface RuntimeEnvironmentBuildFailure {
  ok: false;
  /** aborted 表示被关闭信号或超时打断；终态由 handler 按原因写入。 */
  aborted: boolean;
  error: string;
  buildLog: string;
  logTruncated: boolean;
}

export type RuntimeEnvironmentBuildResult =
  | RuntimeEnvironmentBuildSuccess
  | RuntimeEnvironmentBuildFailure;

export interface RuntimeEnvironmentBuildInput {
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

/**
 * 独立空上下文里只放冻结的 Dockerfile，不发送仓库、工作区或 env。
 * 基座解析为 image ID 后通过 ARG 传入，重复构建默认复用 BuildKit 层缓存。
 */
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
  if (signal?.aborted) return failure(log, '构建已中断', true);

  let tempDir: string | undefined;
  try {
    const inspected = await runDocker(
      spawnFn,
      ['image', 'inspect', input.baseImageId, '--format', '{{.Id}}'],
      signal,
      emit,
    );
    if (inspected.aborted) return failure(log, '构建已中断', true);
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
    if (tagged.aborted) return failure(log, '构建已中断', true);
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
    if (built.aborted) return failure(log, '构建已中断', true);
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
    if (user.aborted) return failure(log, '构建已中断', true);
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

    // 入口启动、卷声明与 uid/可写性由 verify 独占；build 只负责构建与镜像用户检查。
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
    return failure(log, err instanceof Error ? err.message : String(err), signal?.aborted === true);
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

/** 与 db repo 的 runtimeEnvironments 方法一一对应，接线时只做薄映射。 */
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

export interface RuntimeEnvironmentBuildDeps {
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

/** 增量输出按字节窗口或时间窗口批量落库；同一时刻只有一个落库循环。 */
function createBuildLogStream(
  store: RuntimeEnvironmentBuildStore,
  versionId: string,
  logger: Logger,
): BuildLogStream {
  let pending = '';
  let appendError: unknown;
  let draining: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    // 空闲刷新不创建 drain：否则定时器每次空刷新都会留下一个已完成的 Promise。
    if (draining !== null) return draining;
    if (pending === '') return Promise.resolve();
    // 主体放进下一个微任务：store 同步抛错时 finally 不会抢在 draining 赋值前清空。
    const owned = Promise.resolve()
      .then(async () => {
        while (pending !== '') {
          const chunk = pending;
          pending = '';
          await store.appendBuildLog(versionId, chunk);
        }
      })
      .catch((err) => {
        // 落库失败不能吞掉：最终 flush 会抛出，构建按失败收尾而不是假 ready。
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
      // drain 结束与尾部到达可能交替，循环到 pending 真正清空。
      while (draining !== null || pending !== '') await drain();
      if (appendError !== undefined) throw appendError;
    },
    close: () => clearInterval(timer),
  };
}

/** 队列 handler 与测试共用的执行入口。 */
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
      // 先等流式日志收尾，失败尾部与终态同批可见。
      let logError: unknown;
      try {
        await logStream.flush();
      } catch (err) {
        logError = err;
        deps.logger.warn({ err, versionId }, 'runtime environment build log flush failed');
      }
      // 日志没落库就不算成功：否则 ready 版本会没有任何构建记录。
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
        result.ok ? '构建日志写入失败' : timedOut ? '构建超时' : result.error,
      );
    } finally {
      clearTimeout(timer);
      logStream.close();
    }
  };
}

export interface RuntimeEnvironmentBuildWorkerConfig {
  store: RuntimeEnvironmentBuildStore;
  logger: Logger;
  redisUrl: string;
  spawn?: SpawnFn | undefined;
  timeoutMs?: number | undefined;
  /** 测试用独立键前缀，避免消费真实队列。 */
  prefix?: string | undefined;
}

/** 独立队列、并发 1；成功只写版本，不推进线上指针。 */
export async function startRuntimeEnvironmentBuildWorker(
  config: RuntimeEnvironmentBuildWorkerConfig,
): Promise<{ close: () => Promise<void> }> {
  const closing = new AbortController();
  const handler = createRuntimeEnvironmentBuildHandler({
    store: config.store,
    logger: config.logger,
    signal: closing.signal,
    ...(config.spawn === undefined ? {} : { spawn: config.spawn }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  });
  const worker = new Worker<RuntimeEnvironmentBuildJob>(RUNTIME_ENVIRONMENT_BUILDS_QUEUE, handler, {
    connection: { url: config.redisUrl },
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    config.logger.warn({ jobId: job?.id, err }, 'runtime environment build job failed');
  });

  return {
    close: async () => {
      // 先 abort 当前构建让它退回 queued，再等 worker 收尾。
      closing.abort();
      await worker.close();
    },
  };
}
