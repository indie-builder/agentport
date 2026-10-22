import { randomUUID } from 'node:crypto';
import { createDb, newId, schema } from '@agentport/db';
import type { EvalRunJob } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { publishRun } = vi.hoisted(() => ({
  publishRun: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// 收敛 evals 本身不发事件，但模块静态导入 runner-client；照既有用例挡掉真实 Redis stream。
vi.mock('../src/runner-client.js', () => ({ publishRun }));

const { reconcileOrphanedEvalRuns } = await import('../src/reconcile.js');

const STALE_MS = 2 * 60 * 60_000;
const RUNNING = { status: 'running', error: null, finishedAt: null };
/** 只在行状态上断言，文案用字面量，避免依赖实现的导出。 */
const LOST = { status: 'failed', error: 'eval run lost', finishedAt: expect.any(Date) };

async function probeInfra(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) return false;
  const { pool } = createDb(databaseUrl);
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await pool.query('select 1');
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

const ready = await probeInfra();

describe.skipIf(!ready)('reconcileOrphanedEvalRuns against a live eval queue', () => {
  const dbHandle = createDb(process.env.DATABASE_URL ?? '');
  const { db } = dbHandle;
  const redisUrl = process.env.REDIS_URL ?? '';
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;

  const agentIds: string[] = [];
  const evalRunIds: string[] = [];
  const queues: { queue: Queue<EvalRunJob>; jobIds: string[] }[] = [];

  /** 每个用例独占队列名：真实 worker 只消费 eval-runs，用例之间也不会互相抢 job。 */
  function makeQueue(): { queue: Queue<EvalRunJob>; jobIds: string[] } {
    const queue = new Queue<EvalRunJob>(`reconcile-eval-${randomUUID()}`, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });
    const handle = { queue, jobIds: [] as string[] };
    queues.push(handle);
    return handle;
  }

  async function seedStaleEval(): Promise<string> {
    const agentId = newId('agent');
    const evalRunId = newId('evalRun');
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `reconcile-eval-redis-${randomUUID().slice(0, 8)}`,
      name: 'reconcile-eval-redis',
      model: 'test',
    });
    // 超过 1 小时陈旧线；claimedAt 同老，表示这是长时间跑批而不是从未被认领。
    await db.insert(schema.evalRuns).values({
      id: evalRunId,
      agentId,
      status: 'running',
      createdAt: new Date(Date.now() - STALE_MS),
      claimedAt: new Date(Date.now() - STALE_MS),
    });
    agentIds.push(agentId);
    evalRunIds.push(evalRunId);
    return evalRunId;
  }

  async function statusOf(evalRunId: string) {
    const [row] = await db
      .select({
        status: schema.evalRuns.status,
        error: schema.evalRuns.error,
        finishedAt: schema.evalRuns.finishedAt,
      })
      .from(schema.evalRuns)
      .where(eq(schema.evalRuns.id, evalRunId));
    return row;
  }

  afterAll(async () => {
    for (const { queue, jobIds } of queues) {
      for (const jobId of jobIds) {
        const job = await queue.getJob(jobId);
        await job?.remove().catch(() => undefined);
      }
      await queue.close();
    }
    if (evalRunIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, evalRunIds));
      await db.delete(schema.evalRuns).where(inArray(schema.evalRuns.id, evalRunIds));
    }
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    await dbHandle.pool.end();
  });

  it('fails the stale eval whose job is gone, keeping waiting and delayed jobs', async () => {
    const { queue, jobIds } = makeQueue();
    const waiting = await seedStaleEval();
    const delayed = await seedStaleEval();
    const missing = await seedStaleEval();
    jobIds.push(waiting, delayed);

    await queue.add('eval-run', { evalRunId: waiting }, { jobId: waiting });
    // 未来才执行的延迟任务仍是有效工作，不能因为 DB 里还 running 就被收敛。
    await queue.add('eval-run', { evalRunId: delayed }, { jobId: delayed, delay: 60_000 });

    // 全局计数可能被其他文件的陈旧行影响：只要求有收敛，实现新旧靠行状态区分。
    expect(await reconcileOrphanedEvalRuns(db, logger, queue)).toBeGreaterThanOrEqual(1);

    expect(await statusOf(missing)).toMatchObject(LOST);
    expect(await statusOf(waiting)).toMatchObject(RUNNING);
    expect(await statusOf(delayed)).toMatchObject(RUNNING);

    await expect((await queue.getJob(waiting))?.getState()).resolves.toBe('waiting');
    await expect((await queue.getJob(delayed))?.getState()).resolves.toBe('delayed');
    expect(await queue.getJob(missing)).toBeUndefined();
  }, 15_000);

  it('keeps an eval whose job is active until that worker finishes', async () => {
    const { queue, jobIds } = makeQueue();
    const evalRunId = await seedStaleEval();
    jobIds.push(evalRunId);
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 唯一的真 worker：只消费这个测试队列，handler 里不接模型也不启沙盒。
    const worker = new Worker<EvalRunJob>(
      queue.name,
      async () => {
        started();
        await gate;
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null } },
    );
    worker.on('error', () => undefined);

    try {
      const job = await queue.add('eval-run', { evalRunId }, { jobId: evalRunId });
      await begun;
      await expect(job.getState()).resolves.toBe('active');

      await reconcileOrphanedEvalRuns(db, logger, queue);
      expect(await statusOf(evalRunId)).toMatchObject(RUNNING);

      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('eval job did not finish')), 10_000);
        worker.once('completed', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      release();
      await completed;
      await expect(job.getState()).resolves.toBe('completed');

      // job 已到终态：这一轮才该收敛。
      expect(await reconcileOrphanedEvalRuns(db, logger, queue)).toBeGreaterThanOrEqual(1);
      expect(await statusOf(evalRunId)).toMatchObject(LOST);
    } finally {
      release();
      await worker.close();
    }
  }, 15_000);
});
