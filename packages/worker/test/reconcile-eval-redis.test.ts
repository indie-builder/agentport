import { afterAll, describe, expect, it, mock } from 'bun:test';
import { createDb, newId, schema } from '@agentport/db';
import type { EvalRunJob } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { bunRedisConnection, probeBunRedis } from './fixtures/bun-redis.js';
import { createIsolatedDatabase } from './isolated-db.js';

const publishRun = mock<() => Promise<void>>().mockResolvedValue(undefined);

const runnerClientActual = await import('../src/runner-client.js');
mock.module('../src/runner-client.js', () => ({ ...runnerClientActual, publishRun }));

const { reconcileOrphanedEvalRuns } = await import('../src/scheduling/reconcile.js');

const STALE_MS = 2 * 60 * 60_000;
const RUNNING = { status: 'running', error: null, finishedAt: null };
const LOST = { status: 'failed', error: 'eval run lost', finishedAt: expect.any(Date) };

async function probeInfra(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) return false;
  const { client } = createDb(databaseUrl);
  try {
    await client.unsafe('select 1');
    return await probeBunRedis(redisUrl);
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const isolated = await createIsolatedDatabase('worker_reconcile_eval');
if (isolated) process.env.DATABASE_URL = isolated.url;
const ready = isolated !== null && (await probeInfra());
if (!ready && isolated) await isolated.close();

describe.skipIf(!ready)('reconcileOrphanedEvalRuns against a live eval queue', () => {
  const dbHandle = createDb(isolated?.url ?? '');
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
  const queues: {
    queue: Queue<EvalRunJob>;
    jobIds: string[];
    close: () => Promise<string>;
  }[] = [];

  function makeQueue(): { queue: Queue<EvalRunJob>; jobIds: string[] } {
    const redis = bunRedisConnection(redisUrl);
    const queue = new Queue<EvalRunJob>(`reconcile-eval-${crypto.randomUUID()}`, {
      connection: redis.connection,
    });
    const handle = { queue, jobIds: [] as string[], close: redis.close };
    queues.push(handle);
    return handle;
  }

  async function seedStaleEval(): Promise<string> {
    const agentId = newId('agent');
    const evalRunId = newId('evalRun');
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `reconcile-eval-redis-${crypto.randomUUID().slice(0, 8)}`,
      name: 'reconcile-eval-redis',
      model: 'test',
      createdBy: 'reconcile-eval-user',
      ownerBusinessId: 'reconcile-eval-user',
    });
    await db.insert(schema.evalRuns).values({
      id: evalRunId,
      agentId,
      status: 'running',
      createdAt: new Date(Date.now() - STALE_MS),
      claimedAt: new Date(Date.now() - STALE_MS),
      createdBy: 'reconcile-eval-user',
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
    for (const { queue, jobIds, close } of queues) {
      for (const jobId of jobIds) {
        const job = await queue.getJob(jobId);
        await job?.remove().catch(() => undefined);
      }
      await queue.close();
      await close();
    }
    if (evalRunIds.length > 0) {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, evalRunIds));
      await db.delete(schema.evalRuns).where(inArray(schema.evalRuns.id, evalRunIds));
    }
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    await dbHandle.client.close();
    await isolated?.close();
  });

  it('fails the stale eval whose job is gone, keeping waiting and delayed jobs', async () => {
    const { queue, jobIds } = makeQueue();
    const waiting = await seedStaleEval();
    const delayed = await seedStaleEval();
    const missing = await seedStaleEval();
    jobIds.push(waiting, delayed);

    await queue.add('eval-run', { evalRunId: waiting }, { jobId: waiting });
    await queue.add('eval-run', { evalRunId: delayed }, { jobId: delayed, delay: 60_000 });

    expect(await reconcileOrphanedEvalRuns(db, logger, queue)).toBe(1);

    expect(await statusOf(missing)).toMatchObject(LOST);
    expect(await statusOf(waiting)).toMatchObject(RUNNING);
    expect(await statusOf(delayed)).toMatchObject(RUNNING);

    await expect((await queue.getJob(waiting))?.getState()).resolves.toBe('waiting');
    await expect((await queue.getJob(delayed))?.getState()).resolves.toBe('delayed');
    expect(await queue.getJob(missing)).toBeUndefined();

    await db
      .update(schema.evalRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(inArray(schema.evalRuns.id, [waiting, delayed]));
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
    const workerRedis = bunRedisConnection(redisUrl);
    const worker = new Worker<EvalRunJob>(
      queue.name,
      async () => {
        started();
        await gate;
      },
      { connection: workerRedis.connection },
    );
    worker.on('error', () => undefined);

    try {
      const job = await queue.add('eval-run', { evalRunId }, { jobId: evalRunId });
      await begun;
      await expect(job.getState()).resolves.toBe('active');

      expect(await reconcileOrphanedEvalRuns(db, logger, queue)).toBe(0);
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

      expect(await reconcileOrphanedEvalRuns(db, logger, queue)).toBe(1);
      expect(await statusOf(evalRunId)).toMatchObject(LOST);
    } finally {
      release();
      await worker.close();
      await workerRedis.close();
    }
  }, 15_000);
});
