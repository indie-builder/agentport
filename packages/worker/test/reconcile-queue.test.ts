import { createDb, newId, schema } from '@agentport/db';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { publishRun } = vi.hoisted(() => ({
  publishRun: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// 事件通道是外部边界：单测只断言补发内容，避免往真实 Redis stream 写数据。
vi.mock('../src/runner-client.js', () => ({ publishRun }));

const { LOST_RUN_ERROR, reconcileOrphanedRuns } = await import('../src/reconcile.js');

const AGENT_TIMEOUT_MS = 10_000;
const GRACE_MS = 5 * 60_000;
/** 超过 timeout + 5 分钟宽限期，必定被当成孤儿。 */
const STALE_MS = 20 * 60_000;
/** 已超出短超时 agent 的截止线，但仍在长超时 agent 的截止线内。 */
const BETWEEN_CUTOFFS_MS = AGENT_TIMEOUT_MS + GRACE_MS + 60_000;
const LONG_TIMEOUT_MS = 60 * 60_000;

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
type Db = typeof db;
const ready = await dbHandle.pool.query('select 1').then(
  () => true,
  () => false,
);

/**
 * 每个用例在自己的事务里跑并回滚：其他测试文件会并发对同一张表断言全局计数，
 * 提交这些陈旧行会污染它们；回滚后无需清理夹具。
 */
class Rollback extends Error {}
async function isolated(
  fn: (tx: Db, fixture: Fixture) => Promise<void>,
  agent: { timeoutMs?: number } = {},
): Promise<void> {
  await db
    .transaction(async (tx) => {
      const agentId = newId('agent');
      const conversationId = newId('conversation');
      await tx.insert(schema.agents).values({
        id: agentId,
        slug: `reconcile-q-${agentId.slice(4, 12)}`,
        name: 'reconcile-q',
        model: 'test',
        ...agent,
      });
      await tx.insert(schema.conversations).values({ id: conversationId, agentId });
      await fn(tx as unknown as Db, { agentId, conversationId });
      // 用例自己的断言失败会先抛出，不会被这里的回滚吞掉。
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

interface Fixture {
  agentId: string;
  conversationId: string;
}

/** 只 mock BullMQ 的 getJob 边界；返回 null 代表队列里没有这个 job。 */
function fakeQueue(behavior: (runId: string) => string | null | Error): {
  queue: Pick<Queue, 'getJob'>;
  getJob: ReturnType<typeof vi.fn>;
} {
  const getJob = vi.fn(async (runId: string) => {
    if (!ownedRuns.has(runId)) return undefined;
    const result = behavior(runId);
    if (result instanceof Error) throw result;
    if (result === null) return undefined;
    return { getState: async () => result };
  });
  return { queue: { getJob } as unknown as Pick<Queue, 'getJob'>, getJob };
}

const cleanup = vi.fn(
  async (_input: { runId: string; conversationId: string; sandboxId: string }) => undefined,
);

const ownedRuns = new Set<string>();
const warns: { obj: object; msg: string }[] = [];
const logger = {
  info: () => undefined,
  warn: (obj: object, msg: string) => {
    warns.push({ obj, msg });
  },
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

async function seedQueued(tx: Db, fixture: Fixture): Promise<string> {
  const runId = newId('run');
  ownedRuns.add(runId);
  await tx.insert(schema.agentRuns).values({
    id: runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    status: 'queued',
    createdAt: new Date(Date.now() - STALE_MS),
  });
  return runId;
}

async function seedRunning(
  tx: Db,
  fixture: Fixture,
  ageMs = STALE_MS,
  sandboxId: string | null = null,
): Promise<string> {
  const runId = newId('run');
  ownedRuns.add(runId);
  const startedAt = new Date(Date.now() - ageMs);
  await tx.insert(schema.agentRuns).values({
    id: runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    status: 'running',
    sandboxId,
    createdAt: startedAt,
    startedAt,
  });
  return runId;
}

const PENDING_EVENT = {
  type: 'run_finished',
  status: 'cancelled',
  costUsd: 0.5,
  turns: 2,
  error: 'stop unconfirmed',
} as const;

async function seedPending(
  tx: Db,
  fixture: Fixture,
  options: { ageMs?: number; sandboxId?: string | null } = {},
): Promise<string> {
  const runId = newId('run');
  ownedRuns.add(runId);
  const startedAt = new Date(Date.now() - (options.ageMs ?? STALE_MS));
  await tx.insert(schema.agentRuns).values({
    id: runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    status: 'running',
    sandboxId: options.sandboxId === undefined ? 'sandbox-pending' : options.sandboxId,
    pendingFinish: PENDING_EVENT,
    createdAt: startedAt,
    startedAt,
  });
  return runId;
}

async function seedAgent(tx: Db, timeoutMs: number): Promise<Fixture> {
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  await tx.insert(schema.agents).values({
    id: agentId,
    slug: `reconcile-q-${agentId}`,
    name: 'reconcile-q',
    model: 'test',
    timeoutMs,
  });
  await tx.insert(schema.conversations).values({ id: conversationId, agentId });
  return { agentId, conversationId };
}

async function statusOf(tx: Db, runId: string) {
  const [row] = await tx
    .select({
      status: schema.agentRuns.status,
      error: schema.agentRuns.error,
      endedAt: schema.agentRuns.endedAt,
      pendingFinish: schema.agentRuns.pendingFinish,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId));
  return row;
}

async function auditsOf(tx: Db, runId: string) {
  return tx
    .select({ action: schema.auditLog.action, status: schema.auditLog.status })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.target, runId));
}

const runFinished = (runId: string) => [
  runId,
  { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
  logger,
];

const LOST = { status: 'failed', error: LOST_RUN_ERROR, endedAt: expect.any(Date) };
const KEPT_QUEUED = { status: 'queued', error: null };

describe.skipIf(!ready)('reconcileOrphanedRuns queue probe', () => {
  afterAll(() => dbHandle.pool.end());

  beforeEach(() => {
    ownedRuns.clear();
    publishRun.mockClear();
    cleanup.mockClear();
    cleanup.mockImplementation(async () => undefined);
    warns.length = 0;
  });

  it('keeps queued runs whose jobs are still owned by the queue', async () => {
    await isolated(async (tx, fixture) => {
      // 未识别的状态（如 'wait'）也保守保留。
      const states = [
        'waiting',
        'delayed',
        'active',
        'prioritized',
        'waiting-children',
        'wait',
      ] as const;
      for (const state of states) {
        const runId = await seedQueued(tx, fixture);
        const { queue } = fakeQueue(() => state);
        await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);
        expect(await statusOf(tx, runId)).toMatchObject(KEPT_QUEUED);
        expect(publishRun).not.toHaveBeenCalledWith(...runFinished(runId));
      }
    });
  });

  it('fails queued runs only when the job is gone or finished', async () => {
    await isolated(async (tx, fixture) => {
      // 逐个状态单独收敛：事务里的客户端不支持并发语句，并发 4 由下一条用例覆盖。
      for (const state of [null, 'completed', 'failed', 'unknown'] as const) {
        publishRun.mockClear();
        const runId = await seedQueued(tx, fixture);
        const { queue } = fakeQueue(() => state);

        await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);

        expect(await statusOf(tx, runId)).toMatchObject(LOST);
        expect(publishRun).toHaveBeenCalledWith(...runFinished(runId));
        const audits = await tx
          .select({ target: schema.auditLog.target })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, runId));
        expect(audits).toHaveLength(1);
      }
    });
  });

  it('probes at most four candidates at a time', async () => {
    await isolated(async (tx, fixture) => {
      // 同一事务客户端不能并发查询：顺序插入；被探测的 job 都还在，用例不会触发并发 UPDATE。
      for (let i = 0; i < 9; i += 1) await seedQueued(tx, fixture);
      let inFlight = 0;
      let peak = 0;
      const queue = {
        getJob: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { getState: async () => 'waiting' };
        },
      } as unknown as Pick<Queue, 'getJob'>;

      await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);
      expect(peak).toBe(4);
    });
  });

  it('logs probe errors with a fixed message and run id, then continues', async () => {
    await isolated(async (tx, fixture) => {
      const failing = await seedQueued(tx, fixture);
      const waiting = await seedQueued(tx, fixture);
      const { queue } = fakeQueue((runId) =>
        runId === failing
          ? new Error('connect ECONNREFUSED redis://:secret@localhost:6379')
          : 'waiting',
      );

      await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);

      expect(await statusOf(tx, failing)).toMatchObject(KEPT_QUEUED);
      expect(await statusOf(tx, waiting)).toMatchObject(KEPT_QUEUED);
      expect(warns).toContainEqual({
        obj: { runId: failing },
        msg: 'run queue probe failed, keeping queued run',
      });
      expect(JSON.stringify(warns)).not.toContain('secret');
      expect(publishRun).not.toHaveBeenCalled();
    });
  });

  it('does not fail a run claimed while probes are in flight', async () => {
    await isolated(async (tx, fixture) => {
      const runId = await seedQueued(tx, fixture);
      const { queue, getJob } = fakeQueue(() => null);
      // 探测返回「job 不存在」，但同一时刻 job 已被认领：必须靠条件更新保住 running。
      getJob.mockImplementationOnce(async () => {
        await tx
          .update(schema.agentRuns)
          .set({ status: 'running', startedAt: new Date() })
          .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.status, 'queued')));
        return undefined;
      });

      await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);

      expect(await statusOf(tx, runId)).toMatchObject({ status: 'running', error: null });
      expect(publishRun).not.toHaveBeenCalledWith(...runFinished(runId));
    });
  });

  it('times out a hung probe without writing late results and retries on the next tick', async () => {
    await isolated(async (tx, fixture) => {
      const runId = await seedQueued(tx, fixture);
      const { queue, getJob } = fakeQueue(() => 'waiting');
      let release!: () => void;
      let started!: () => void;
      const probing = new Promise<void>((resolve) => {
        started = resolve;
      });
      getJob.mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let settled = false;
        const pending = reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup).then(
          (count) => {
            settled = true;
            return count;
          },
        );
        await probing;
        await vi.advanceTimersByTimeAsync(20_001);
        expect(settled).toBe(true);
        expect(await pending).toBe(0);
        expect(await statusOf(tx, runId)).toMatchObject(KEPT_QUEUED);
        release();
        await Promise.resolve();
        expect(await statusOf(tx, runId)).toMatchObject(KEPT_QUEUED);
        expect(publishRun).not.toHaveBeenCalled();
      } finally {
        release?.();
        vi.useRealTimers();
      }
      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);
      expect(await statusOf(tx, runId)).toMatchObject(KEPT_QUEUED);
    });
  });

  it('still fails a stale running run when the queued probe throws', async () => {
    await isolated(
      async (tx, fixture) => {
        const running = await seedRunning(tx, fixture);
        const queued = await seedQueued(tx, fixture);
        const { queue, getJob } = fakeQueue((runId) =>
          runId === queued ? new Error('redis down') : null,
        );

        const reconciled = await reconcileOrphanedRuns(
          tx,
          logger,
          AGENT_TIMEOUT_MS,
          queue,
          cleanup,
        );

        expect(reconciled).toBeGreaterThanOrEqual(1);
        expect(await statusOf(tx, running)).toMatchObject(LOST);
        expect(await statusOf(tx, queued)).toMatchObject(KEPT_QUEUED);
        expect(publishRun).toHaveBeenCalledWith(...runFinished(running));
        expect(getJob).toHaveBeenCalledWith(queued);
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('uses each agent timeout for stale running runs, not the global one', async () => {
    await isolated(
      async (tx, fixture) => {
        const shortTimeoutRun = await seedRunning(tx, fixture, BETWEEN_CUTOFFS_MS);
        const longAgent = await seedAgent(tx, LONG_TIMEOUT_MS);
        const longTimeoutRun = await seedRunning(tx, longAgent, BETWEEN_CUTOFFS_MS);
        const { queue } = fakeQueue(() => null);

        await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);

        expect(await statusOf(tx, shortTimeoutRun)).toMatchObject(LOST);
        expect(await statusOf(tx, longTimeoutRun)).toMatchObject({
          status: 'running',
          error: null,
        });
        expect(publishRun).toHaveBeenCalledWith(...runFinished(shortTimeoutRun));
        expect(publishRun).not.toHaveBeenCalledWith(...runFinished(longTimeoutRun));
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('keeps a running run started within its own agent timeout', async () => {
    await isolated(
      async (tx, fixture) => {
        // 超过全局 10s + 宽限，但远未到该 agent 的 1 小时。
        const runId = await seedRunning(tx, fixture, BETWEEN_CUTOFFS_MS);
        const { queue } = fakeQueue(() => null);

        await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup);

        expect(await statusOf(tx, runId)).toMatchObject({ status: 'running', error: null });
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: LONG_TIMEOUT_MS },
    );
  });

  it('keeps a stale running run while its queue job is still active', async () => {
    await isolated(
      async (tx, fixture) => {
        const runId = await seedRunning(tx, fixture);
        const { queue } = fakeQueue(() => 'active');

        expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

        // timeout 被改短也不能把仍在执行的 job 提前判死。
        expect(await statusOf(tx, runId)).toMatchObject({
          status: 'running',
          error: null,
          endedAt: null,
        });
        expect(cleanup).not.toHaveBeenCalled();
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('finalizes a pending finish after cleanup and publishes the original event once', async () => {
    await isolated(async (tx, fixture) => {
      // pendingFinish 不等 timeout：刚写完也进入候选。
      const runId = await seedPending(tx, fixture, { ageMs: 0 });
      const { queue } = fakeQueue(() => 'completed');

      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(1);

      expect(cleanup).toHaveBeenCalledWith({
        runId,
        conversationId: fixture.conversationId,
        sandboxId: 'sandbox-pending',
      });
      expect(await statusOf(tx, runId)).toMatchObject({
        status: 'cancelled',
        pendingFinish: null,
        endedAt: expect.any(Date),
      });
      expect(publishRun).toHaveBeenCalledTimes(1);
      expect(publishRun).toHaveBeenCalledWith(runId, PENDING_EVENT, logger);
      expect(await auditsOf(tx, runId)).toEqual([
        { action: 'agent.run.reconciled', status: 'error' },
      ]);
    });
  });

  it('keeps a pending finish running and unpublished when cleanup fails', async () => {
    await isolated(async (tx, fixture) => {
      const runId = await seedPending(tx, fixture, { ageMs: 0 });
      const { queue } = fakeQueue(() => null);
      cleanup.mockRejectedValueOnce(new Error('docker rm failed'));

      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

      expect(await statusOf(tx, runId)).toMatchObject({
        status: 'running',
        pendingFinish: PENDING_EVENT,
        endedAt: null,
      });
      expect(publishRun).not.toHaveBeenCalled();
      expect(warns).toContainEqual({
        obj: { runId, sandboxId: 'sandbox-pending', error: 'docker rm failed' },
        msg: 'run sandbox cleanup failed, keeping running run',
      });
    });
  });

  it('does not take over a pending finish while its job is active', async () => {
    await isolated(async (tx, fixture) => {
      const runId = await seedPending(tx, fixture, { ageMs: 0 });
      const { queue } = fakeQueue(() => 'active');

      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

      expect(await statusOf(tx, runId)).toMatchObject({
        status: 'running',
        pendingFinish: PENDING_EVENT,
      });
      expect(cleanup).not.toHaveBeenCalled();
      expect(publishRun).not.toHaveBeenCalled();
    });
  });

  it('keeps a plain orphan running when cleanup fails', async () => {
    await isolated(
      async (tx, fixture) => {
        const runId = await seedRunning(tx, fixture, STALE_MS, 'sandbox-orphan');
        const { queue } = fakeQueue(() => null);
        cleanup.mockRejectedValueOnce(new Error('docker rm failed'));

        expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

        expect(cleanup).toHaveBeenCalledWith({
          runId,
          conversationId: fixture.conversationId,
          sandboxId: 'sandbox-orphan',
        });
        expect(await statusOf(tx, runId)).toMatchObject({ status: 'running', error: null });
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('finalizes a pending finish without a sandbox without calling cleanup', async () => {
    await isolated(async (tx, fixture) => {
      const runId = await seedPending(tx, fixture, { ageMs: 0, sandboxId: null });
      const { queue } = fakeQueue(() => null);

      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(1);

      expect(cleanup).not.toHaveBeenCalled();
      expect(await statusOf(tx, runId)).toMatchObject({
        status: 'cancelled',
        pendingFinish: null,
      });
    });
  });

  it('does not overwrite a pending finish written while a plain orphan is probed', async () => {
    await isolated(
      async (tx, fixture) => {
        const runId = await seedRunning(tx, fixture);
        const { queue, getJob } = fakeQueue(() => null);
        getJob.mockImplementationOnce(async () => {
          await tx
            .update(schema.agentRuns)
            .set({ pendingFinish: PENDING_EVENT })
            .where(eq(schema.agentRuns.id, runId));
          return undefined;
        });

        expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

        // 条件更新只允许没有 pendingFinish 的孤儿进入 failed，接管留给下一轮。
        expect(await statusOf(tx, runId)).toMatchObject({
          status: 'running',
          pendingFinish: PENDING_EVENT,
        });
        expect(cleanup).not.toHaveBeenCalled();
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('does not clean up a container another run took over while the candidate was probed', async () => {
    await isolated(async (tx, fixture) => {
      // A 是探测开始时的候选；探测期间 A 正常完成，B 在同一会话复用了同一个容器。
      const runId = await seedPending(tx, fixture, {
        ageMs: 0,
        sandboxId: 'sandbox-shared',
      });
      const { queue, getJob } = fakeQueue(() => null);
      getJob.mockImplementationOnce(async () => {
        await tx
          .update(schema.agentRuns)
          .set({ status: 'succeeded', pendingFinish: null, endedAt: new Date() })
          .where(eq(schema.agentRuns.id, runId));
        const nextRunId = newId('run');
        ownedRuns.add(nextRunId);
        const now = new Date();
        await tx.insert(schema.agentRuns).values({
          id: nextRunId,
          conversationId: fixture.conversationId,
          agentId: fixture.agentId,
          status: 'running',
          sandboxId: 'sandbox-shared',
          createdAt: now,
          startedAt: now,
        });
        return undefined;
      });

      expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

      // 主键重读看到 A 已非 running：既不清理 B 正在用的容器，也不覆盖 A 的终态。
      expect(cleanup).not.toHaveBeenCalled();
      expect(await statusOf(tx, runId)).toMatchObject({
        status: 'succeeded',
        pendingFinish: null,
      });
      expect(publishRun).not.toHaveBeenCalled();
    });
  });

  it('leaves a candidate for the next tick when its sandbox id appears during the probe', async () => {
    await isolated(
      async (tx, fixture) => {
        const runId = await seedRunning(tx, fixture, STALE_MS, null);
        const { queue, getJob } = fakeQueue(() => null);
        getJob.mockImplementationOnce(async () => {
          await tx
            .update(schema.agentRuns)
            .set({ sandboxId: 'sandbox-late' })
            .where(eq(schema.agentRuns.id, runId));
          return undefined;
        });

        expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

        // 候选快照没有 sandbox，当前行却有：留到下一轮重新取快照，不能按缺省清理收敛。
        expect(cleanup).not.toHaveBeenCalled();
        expect(await statusOf(tx, runId)).toMatchObject({
          status: 'running',
          endedAt: null,
        });
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });

  it('keeps a same-run candidate when its sandbox id changes during the probe', async () => {
    await isolated(
      async (tx, fixture) => {
        const runId = await seedRunning(tx, fixture, STALE_MS, 'sandbox-s1');
        const { queue, getJob } = fakeQueue(() => null);
        getJob.mockImplementationOnce(async () => {
          await tx
            .update(schema.agentRuns)
            .set({ sandboxId: 'sandbox-s2' })
            .where(eq(schema.agentRuns.id, runId));
          return undefined;
        });

        expect(await reconcileOrphanedRuns(tx, logger, AGENT_TIMEOUT_MS, queue, cleanup)).toBe(0);

        // 同一 run 换了容器：旧快照的 sandbox 已不是当前容器，既不能清理也不能写终态。
        expect(cleanup).not.toHaveBeenCalled();
        expect(await statusOf(tx, runId)).toMatchObject({
          status: 'running',
          endedAt: null,
        });
        expect(publishRun).not.toHaveBeenCalled();
      },
      { timeoutMs: AGENT_TIMEOUT_MS },
    );
  });
});
