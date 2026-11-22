import { BUILD_TIMEOUT_MESSAGE } from '@agentport/core';
import {
  isActiveJobState,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  runtimeBuildEnqueueOptions,
} from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import { queueState } from '../runs/queue-state.js';
import { startIntervalTicker } from '../scheduling/interval-ticker.js';
import {
  RUNTIME_ENVIRONMENT_BUILD_JOB,
  RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS,
  type RuntimeEnvironmentBuildStore,
} from './build.js';

const RECONCILE_MS = 5 * 60_000;
const BUILDING_GRACE_MS = 5 * 60_000;
const QUEUED_STALE_MS = 2 * RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS;

export const RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR =
  'runtime environment build worker lost track of this build';

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
    opts: ReturnType<typeof runtimeBuildEnqueueOptions>,
  ) => Promise<unknown>;
}

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
    if (state === undefined) continue;

    if (row.status === 'building') {
      const timedOut =
        row.startedAt !== null &&
        now - row.startedAt.getTime() > 2 * RUNTIME_ENVIRONMENT_BUILD_TIMEOUT_MS;
      if (!timedOut && state === 'active') continue;
      const error = timedOut ? BUILD_TIMEOUT_MESSAGE : RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR;
      await store.failBuild(row.id, error);
      failed += 1;
      logger.warn({ versionId: row.id, error }, 'runtime environment build reconciled as failed');
      continue;
    }

    if (state === 'active') continue;
    if (state !== null && isActiveJobState(state)) {
      if (now - row.createdAt.getTime() > QUEUED_STALE_MS) {
        await store.failBuild(row.id, '构建排队超时');
        failed += 1;
        logger.warn(
          { versionId: row.id },
          'stale queued runtime environment build reconciled as failed',
        );
      }
      continue;
    }
    try {
      if (state !== null) await queue.remove(row.id).catch(() => undefined);
      await queue.add(
        RUNTIME_ENVIRONMENT_BUILD_JOB,
        { versionId: row.id },
        runtimeBuildEnqueueOptions(row.id),
      );
      requeued += 1;
      logger.warn({ versionId: row.id }, 'runtime environment build re-enqueued');
    } catch (err) {
      logger.warn({ err, versionId: row.id }, 'runtime environment build re-enqueue failed');
    }
  }

  return { failed, requeued };
}

export function startRuntimeEnvironmentBuildReconciler(input: {
  store: RuntimeEnvironmentBuildReconcileStore;
  logger: Logger;
  redisUrl: string;
  prefix?: string;
}): () => Promise<void> {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const queue = new Queue<{ versionId: string }>(RUNTIME_ENVIRONMENT_BUILDS_QUEUE, {
    connection,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  });
  queue.on('error', () => input.logger.warn('runtime environment build queue connection failed'));

  const stopTicker = startIntervalTicker(
    () =>
      reconcileRuntimeEnvironmentBuilds(input.store, input.logger, queue)
        .then(() => undefined)
        .catch((err: unknown) => {
          input.logger.error({ err }, 'runtime environment build reconcile failed');
        }),
    RECONCILE_MS,
  );

  return async () => {
    await stopTicker();
    await queue.close();
    await connection.quit();
  };
}
