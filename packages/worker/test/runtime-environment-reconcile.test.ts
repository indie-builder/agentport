import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR,
  type RuntimeEnvironmentBuildPending,
  type RuntimeEnvironmentBuildQueueLike,
  type RuntimeEnvironmentBuildReconcileStore,
  reconcileRuntimeEnvironmentBuilds,
} from '../src/runtime-environments/reconcile.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quiet,
} as unknown as Logger;

function row(
  id: string,
  status: 'queued' | 'building',
  ageMs: number,
): RuntimeEnvironmentBuildPending {
  return {
    id,
    status,
    createdAt: new Date(NOW - ageMs),
    startedAt: status === 'building' ? new Date(NOW - ageMs) : null,
  };
}

function fakeStore(rows: RuntimeEnvironmentBuildPending[]) {
  const calls = {
    fail: [] as Array<{ id: string; error: string }>,
  };
  const store: RuntimeEnvironmentBuildReconcileStore = {
    claimBuild: async () => null,
    appendBuildLog: async () => undefined,
    completeBuild: async () => undefined,
    failBuild: async (id, error) => {
      calls.fail.push({ id, error });
    },
    listPendingBuilds: async () => rows,
  };
  return { store, calls };
}

function fakeQueue(states: Record<string, string | null>) {
  const added: Array<{ name: string; data: { versionId: string }; opts: { jobId: string } }> = [];
  const removed: string[] = [];
  const queue: RuntimeEnvironmentBuildQueueLike = {
    getJob: async (id) => {
      const state = states[id];
      if (state === null || state === undefined) return undefined;
      return { getState: async () => state };
    },
    remove: async (id) => {
      removed.push(id);
    },
    add: async (name, data, opts) => {
      added.push({ name, data, opts });
    },
  };
  return { queue, added, removed };
}

describe('reconcileRuntimeEnvironmentBuilds', () => {
  it('building 超过宽限期且队列已无 job 时置失败', async () => {
    const { store, calls } = fakeStore([row('ver_lost', 'building', 10 * MINUTE)]);
    const { queue } = fakeQueue({});

    const result = await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(result.failed).toBe(1);
    expect(calls.fail).toEqual([{ id: 'ver_lost', error: RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR }]);
  });

  it('building 仍在宽限期内不动', async () => {
    const { store, calls } = fakeStore([row('ver_new', 'building', MINUTE)]);
    const { queue } = fakeQueue({});

    const result = await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(result).toEqual({ failed: 0, requeued: 0 });
    expect(calls.fail).toHaveLength(0);
  });

  it('building 等待重投时按失败收尾，不留下 building', async () => {
    const { store, calls } = fakeStore([row('ver_wait', 'building', 10 * MINUTE)]);
    const { queue } = fakeQueue({ ver_wait: 'waiting' });

    const result = await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(result.failed).toBe(1);
    expect(calls.fail).toEqual([{ id: 'ver_wait', error: RUNTIME_ENVIRONMENT_BUILD_LOST_ERROR }]);
  });

  it('building 仍 active 时保留', async () => {
    const { store, calls } = fakeStore([row('ver_active', 'building', 10 * MINUTE)]);
    const { queue } = fakeQueue({ ver_active: 'active' });

    await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(calls.fail).toHaveLength(0);
  });

  it('building 超过 2 倍构建超时后即使 active 也按超时失败', async () => {
    const { store, calls } = fakeStore([row('ver_slow', 'building', 61 * MINUTE)]);
    const { queue } = fakeQueue({ ver_slow: 'active' });

    await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(calls.fail).toEqual([{ id: 'ver_slow', error: '构建超时' }]);
  });

  it('queued 但队列没有 job 时重新入队', async () => {
    const { store } = fakeStore([row('ver_queued', 'queued', MINUTE)]);
    const { queue, added } = fakeQueue({});

    const result = await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(result.requeued).toBe(1);
    expect(added).toHaveLength(1);
    expect(added[0]?.data).toEqual({ versionId: 'ver_queued' });
    expect(added[0]?.opts.jobId).toBe('ver_queued');
  });

  it('queued 且 job 已 active 时不重复入队', async () => {
    const { store } = fakeStore([row('ver_running', 'queued', MINUTE)]);
    const { queue, added } = fakeQueue({ ver_running: 'active' });

    await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(added).toHaveLength(0);
  });

  it('queued 对应的旧 failed 条目先移除再重新入队', async () => {
    const { store } = fakeStore([row('ver_retry', 'queued', MINUTE)]);
    const { queue, added, removed } = fakeQueue({ ver_retry: 'failed' });

    await reconcileRuntimeEnvironmentBuilds(store, quiet, queue, NOW);

    expect(removed).toEqual(['ver_retry']);
    expect(added).toHaveLength(1);
  });
});
