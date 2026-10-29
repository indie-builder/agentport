import { RUNTIME_ENVIRONMENT_BUILDS_QUEUE } from '@agentport/shared';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  RUNTIME_ENVIRONMENT_BUILD_JOB,
  RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS,
  type RuntimeEnvironmentBuildStore,
  runtimeEnvironmentBuildEnqueueOptions,
} from './build.js';

const RECONCILE_MS = 5 * 60_000;
/** 刚认领的 building 行先放过一轮：探测与认领并发时状态仍有瞬时窗口。 */
const BUILDING_GRACE_MS = 5 * 60_000;

export const RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR =
  'runtime environment build worker lost track of this build';

const ACTIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** 对账只读这些列；字段名与 DB 行保持一致。 */
export interface RuntimeEnvironmentBuildPending {
  id: string;
  status: 'queued' | 'building';
  createdAt: Date;
  startedAt: Date | null;
}

export interface RuntimeEnvironmentBuildReconcileStore extends RuntimeEnvironmentBuildStore {
  listPendingBuilds(): Promise<RuntimeEnvironmentBuildPending[]>;
}

export interface RuntimeEnvironmentBuildQueueLike {
  getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined>;
  /** 同 jobId 已存在 failed/completed 时 add 会被去重，必须先移除旧条目。 */
  remove: (id: string) => Promise<unknown>;
  add: (
    name: string,
    data: { versionId: string },
    opts: ReturnType<typeof runtimeEnvironmentBuildEnqueueOptions>,
  ) => Promise<unknown>;
}

async function queueState(
  queue: RuntimeEnvironmentBuildQueueLike,
  id: string,
): Promise<string | null> {
  const job = await queue.getJob(id);
  return job ? job.getState() : null;
}

/**
 * 崩溃恢复：DB 的 queued/building 与 Redis 实际状态对账。
 * - building + active：保留（构建不能被误杀）。
 * - building + 消失/终态/等待重投/超过 2 倍超时：置 failed，不留下假 building。
 * - queued + 队列不存在：重新入队。
 */
export async function reconcileRuntimeEnvironmentBuilds(
  store: RuntimeEnvironmentBuildReconcileStore,
  logger: Logger,
  queue: RuntimeEnvironmentBuildQueueLike,
  now: number = Date.now(),
): Promise<{ failed: number; requeued: number }> {
  const rows = await store.listPendingBuilds();
  let failed = 0;
  let requeued = 0;

  for (const row of rows) {
    if (
      row.status === 'building' &&
      now - (row.startedAt ?? row.createdAt).getTime() < BUILDING_GRACE_MS
    ) {
      continue;
    }
    const state = await queueState(queue, row.id).catch(() => undefined);
    if (state === undefined) continue; // Redis 不可用：本轮不动任何行。

    if (row.status === 'building') {
      const timedOut =
        row.startedAt !== null &&
        now - row.startedAt.getTime() > 2 * RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS;
      // 只有仍在执行的行可以保留；等待重投的 job 因 attempts=1 不会再认领 building 行。
      if (!timedOut && state === 'active') continue;
      const error = timedOut ? '构建超时' : RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR;
      await store.failBuild(row.id, error);
      failed += 1;
      logger.warn({ versionId: row.id, error }, 'runtime environment build reconciled as failed');
      continue;
    }

    // queued：job 仍在队列里就不动；Redis 丢数据才会得到 null/终态。
    if (state !== null && ACTIVE_STATES.has(state)) continue;
    try {
      if (state !== null) await queue.remove(row.id).catch(() => undefined);
      await queue.add(
        RUNTIME_ENVIRONMENT_BUILD_JOB,
        { versionId: row.id },
        runtimeEnvironmentBuildEnqueueOptions(row.id),
      );
      requeued += 1;
      logger.warn({ versionId: row.id }, 'runtime environment build re-enqueued');
    } catch (err) {
      logger.warn({ err, versionId: row.id }, 'runtime environment build re-enqueue failed');
    }
  }

  return { failed, requeued };
}

/**
 * 启动先跑一次，之后每 5 分钟一次；返回的 stop 等本轮结束再关队列。
 */
export function startRuntimeEnvironmentBuildReconciler(input: {
  store: RuntimeEnvironmentBuildReconcileStore;
  logger: Logger;
  redisUrl: string;
  prefix?: string;
}): () => Promise<void> {
  const queue = new Queue<{ versionId: string }>(RUNTIME_ENVIRONMENT_BUILDS_QUEUE, {
    connection: { url: input.redisUrl, maxRetriesPerRequest: null },
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  });
  queue.on('error', () => input.logger.warn('runtime environment build queue connection failed'));

  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (busy) return;
    busy = true;
    inFlight = reconcileRuntimeEnvironmentBuilds(input.store, input.logger, queue)
      .then(() => undefined)
      .catch((err: unknown) => {
        input.logger.error({ err }, 'runtime environment build reconcile failed');
      })
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await inFlight;
    await queue.close();
  };
}
