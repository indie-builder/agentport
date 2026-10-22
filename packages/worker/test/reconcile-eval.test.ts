import { createDb, newId, schema } from '@agentport/db';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { EVAL_LOST_ERROR, reconcileOrphanedEvalRuns } = await import('../src/reconcile.js');

const STALE_MS = 2 * 60 * 60_000;
const FRESH_MS = 30 * 60_000;

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
type Db = typeof db;
const ready = await dbHandle.pool.query('select 1').then(
  () => true,
  () => false,
);

/** 每个用例在自己的事务里跑并回滚：其他测试文件会并发断言全局计数。 */
class Rollback extends Error {}
async function isolated(fn: (tx: Db) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

interface EvalFixture {
  evalRunId: string;
  agentId: string;
}

/**
 * eval_runs 上同一 agent 只允许一个 running，夹具必须每个跑批独立建 agent。
 * claimedAt 默认为老时间：认领过不影响孤儿判定。
 */
async function seedEval(
  tx: Db,
  options: { ageMs?: number; status?: 'running' | 'succeeded' | 'cancelled' } = {},
): Promise<EvalFixture> {
  const agentId = newId('agent');
  const evalRunId = newId('evalRun');
  ownedEvalIds.add(evalRunId);
  await tx.insert(schema.agents).values({
    id: agentId,
    slug: `reconcile-eval-${agentId}`,
    name: 'reconcile-eval',
    model: 'test',
  });
  await tx.insert(schema.evalRuns).values({
    id: evalRunId,
    agentId,
    status: options.status ?? 'running',
    createdAt: new Date(Date.now() - (options.ageMs ?? STALE_MS)),
    claimedAt: new Date(Date.now() - STALE_MS),
  });
  return { evalRunId, agentId };
}

/** 只 mock BullMQ 的 getJob 边界；null 代表队列里没有这个 job。 */
function fakeQueue(behavior: (evalRunId: string) => string | null | Error): {
  queue: Pick<Queue, 'getJob'>;
  getJob: ReturnType<typeof vi.fn>;
} {
  const getJob = vi.fn(async (evalRunId: string) => {
    if (!ownedEvalIds.has(evalRunId)) return { getState: async () => 'waiting' };
    const result = behavior(evalRunId);
    if (result instanceof Error) throw result;
    if (result === null) return undefined;
    return { getState: async () => result };
  });
  return { queue: { getJob } as unknown as Pick<Queue, 'getJob'>, getJob };
}

const ownedEvalIds = new Set<string>();
const warns: { obj: object; msg: string }[] = [];
const logger = {
  info: () => undefined,
  warn: (obj: object, msg: string) => {
    warns.push({ obj, msg });
  },
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

async function statusOf(tx: Db, evalRunId: string) {
  const [row] = await tx
    .select({
      status: schema.evalRuns.status,
      error: schema.evalRuns.error,
      finishedAt: schema.evalRuns.finishedAt,
    })
    .from(schema.evalRuns)
    .where(eq(schema.evalRuns.id, evalRunId));
  return row;
}

const RUNNING = { status: 'running', error: null, finishedAt: null };
const LOST = { status: 'failed', error: EVAL_LOST_ERROR, finishedAt: expect.any(Date) };

describe.skipIf(!ready)('reconcileOrphanedEvalRuns queue probe', () => {
  afterAll(() => dbHandle.pool.end());

  beforeEach(() => {
    ownedEvalIds.clear();
    warns.length = 0;
  });

  it('keeps running evals whose jobs are still owned by the queue', async () => {
    await isolated(async (tx) => {
      const states = [
        'waiting',
        'delayed',
        'active',
        'prioritized',
        'waiting-children',
        'wait',
      ] as const;
      for (const state of states) {
        const fixture = await seedEval(tx);
        const { queue, getJob } = fakeQueue(() => state);

        expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);

        expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
        expect(getJob).toHaveBeenCalledWith(fixture.evalRunId);
      }
    });
  });

  it('fails running evals only when the job is gone or finished', async () => {
    await isolated(async (tx) => {
      for (const state of [null, 'completed', 'failed', 'unknown'] as const) {
        const fixture = await seedEval(tx);
        const { queue } = fakeQueue(() => state);

        expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(1);

        expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(LOST);
      }
    });
  });

  it('keeps running evals when the redis probe fails, without leaking the connection string', async () => {
    await isolated(async (tx) => {
      const fixture = await seedEval(tx);
      const { queue } = fakeQueue(
        () => new Error('connect ECONNREFUSED redis://:secret@localhost:6379'),
      );

      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);

      expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
      expect(warns).toContainEqual({
        obj: { evalRunId: fixture.evalRunId },
        msg: 'eval queue probe failed, keeping running eval run',
      });
      expect(JSON.stringify(warns)).not.toContain('secret');
    });
  });

  it('probes at most four candidates at a time', async () => {
    await isolated(async (tx) => {
      for (let i = 0; i < 9; i += 1) await seedEval(tx);
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

      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);
      expect(peak).toBe(4);
    });
  });

  it('times out a hung probe without writing late results and retries on the next tick', async () => {
    await isolated(async (tx) => {
      const fixture = await seedEval(tx);
      const { queue, getJob } = fakeQueue(() => 'waiting');
      let release!: () => void;
      let started!: () => void;
      const probing = new Promise<void>((resolve) => {
        started = resolve;
      });
      // 只有目标行第一次探测挂起；其余候选与下一轮探测都走默认 waiting。
      let hanging = true;
      getJob.mockImplementation(async (evalRunId: string) => {
        if (evalRunId !== fixture.evalRunId || !hanging) {
          return { getState: async () => 'waiting' };
        }
        hanging = false;
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let settled = false;
        const pending = reconcileOrphanedEvalRuns(tx, logger, queue).then((count) => {
          settled = true;
          return count;
        });
        await probing;
        await vi.advanceTimersByTimeAsync(20_001);
        expect(settled).toBe(true);
        expect(await pending).toBe(0);
        expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
        release();
        await Promise.resolve();
        expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
      } finally {
        release?.();
        vi.useRealTimers();
      }
      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);
      expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
    });
  });

  it('does not overwrite an eval cancelled while the probe is in flight', async () => {
    await isolated(async (tx) => {
      const fixture = await seedEval(tx);
      const { queue, getJob } = fakeQueue(() => null);
      getJob.mockImplementation(async (evalRunId: string) => {
        if (evalRunId !== fixture.evalRunId) return { getState: async () => 'waiting' };
        await tx
          .update(schema.evalRuns)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(
            and(eq(schema.evalRuns.id, fixture.evalRunId), eq(schema.evalRuns.status, 'running')),
          );
        return undefined;
      });

      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);

      expect(await statusOf(tx, fixture.evalRunId)).toMatchObject({
        status: 'cancelled',
        error: null,
        finishedAt: expect.any(Date),
      });
    });
  });

  it('does not overwrite an eval completed while the probe is in flight', async () => {
    await isolated(async (tx) => {
      const fixture = await seedEval(tx);
      const { queue, getJob } = fakeQueue(() => null);
      getJob.mockImplementation(async (evalRunId: string) => {
        if (evalRunId !== fixture.evalRunId) return { getState: async () => 'waiting' };
        await tx
          .update(schema.evalRuns)
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where(
            and(eq(schema.evalRuns.id, fixture.evalRunId), eq(schema.evalRuns.status, 'running')),
          );
        return undefined;
      });

      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);

      expect(await statusOf(tx, fixture.evalRunId)).toMatchObject({
        status: 'succeeded',
        error: null,
        finishedAt: expect.any(Date),
      });
    });
  });

  it('does not probe evals younger than one hour', async () => {
    await isolated(async (tx) => {
      const fixture = await seedEval(tx, { ageMs: FRESH_MS });
      // 全局扫描会看到其他陈旧候选；它们才该被探测（job 仍在队列里所以计数为 0），新行不该。
      const foreign = await seedEval(tx);
      ownedEvalIds.delete(foreign.evalRunId);
      const { queue, getJob } = fakeQueue(() => 'waiting');

      expect(await reconcileOrphanedEvalRuns(tx, logger, queue)).toBe(0);

      expect(getJob).toHaveBeenCalledWith(foreign.evalRunId);
      expect(getJob).not.toHaveBeenCalledWith(fixture.evalRunId);
      expect(await statusOf(tx, fixture.evalRunId)).toMatchObject(RUNNING);
    });
  });
});
