import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createDb, newId, schema } from '@agentport/db';
import type { AgentRunJob } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { publishRun } = vi.hoisted(() => ({
  publishRun: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// 事件通道用假 publishRun：单测只验证补发内容，避免往真实 run stream 写数据。
vi.mock('../src/runner-client.js', () => ({ publishRun }));

const { LOST_RUN_ERROR, reconcileOrphanedRuns } = await import('../src/reconcile.js');

const AGENT_TIMEOUT_MS = 10_000;
/** 超过 timeout + 5 分钟宽限期，必定被当成孤儿。 */
const STALE_MS = 15 * 60_000;
/** 超过短超时 agent 的截止线，但在长超时 agent 的截止线内。 */
const BETWEEN_CUTOFFS_MS = AGENT_TIMEOUT_MS + 5 * 60_000 + 60_000;
const LONG_TIMEOUT_MS = 60 * 60_000;

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

describe.skipIf(!ready)('reconcileOrphanedRuns against a live queue', () => {
  const dbHandle = createDb(process.env.DATABASE_URL ?? '');
  const { db } = dbHandle;
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runWaiting = newId('run');
  const runDelayed = newId('run');
  const runMissing = newId('run');
  const ownedRuns = [runWaiting, runDelayed, runMissing];
  // 队列名按测试唯一：真实 worker 只消费 agent-runs，不会把这里的 job 跑掉。
  const queue = new Queue<AgentRunJob, void, string>(`reconcile-${randomUUID()}`, {
    connection: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    },
  });
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  let waitingJob: Awaited<ReturnType<typeof queue.add>>;
  let delayedJob: Awaited<ReturnType<typeof queue.add>>;

  beforeAll(async () => {
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `reconcile-${agentId.slice(4, 12)}`,
      name: 'reconcile',
      model: 'test',
    });
    await db.insert(schema.conversations).values({ id: conversationId, agentId });

    const stale = new Date(Date.now() - STALE_MS);
    await db.insert(schema.agentRuns).values(
      ownedRuns.map((id) => ({
        id,
        conversationId,
        agentId,
        status: 'queued' as const,
        createdAt: stale,
      })),
    );

    const data = (runId: string): AgentRunJob => ({
      runId,
      agentId,
      conversationId,
      prompt: 'reconcile test',
    });
    waitingJob = await queue.add('run', data(runWaiting), { jobId: runWaiting });
    // 未来的延迟任务同样是有效工作，不能因为 DB 里还 queued 就被收敛。
    delayedJob = await queue.add('run', data(runDelayed), { jobId: runDelayed, delay: 60_000 });
  });

  beforeEach(() => {
    publishRun.mockClear();
  });

  afterAll(async () => {
    await waitingJob?.remove();
    await delayedJob?.remove();
    await queue.close();
    await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, ownedRuns));
    await db.delete(schema.agentRuns).where(inArray(schema.agentRuns.id, ownedRuns));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await dbHandle.pool.end();
  });

  it('fails only the stale queued run whose job is gone', async () => {
    const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue);
    // 全表可能有其他测试的陈旧行；只要求至少收敛本用例的 missing，靠下方行状态确认。
    expect(reconciled).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({
        id: schema.agentRuns.id,
        status: schema.agentRuns.status,
        error: schema.agentRuns.error,
        endedAt: schema.agentRuns.endedAt,
      })
      .from(schema.agentRuns)
      .where(inArray(schema.agentRuns.id, ownedRuns));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(runMissing)).toMatchObject({
      status: 'failed',
      error: LOST_RUN_ERROR,
    });
    expect(byId.get(runMissing)?.endedAt).not.toBeNull();

    // waiting 任务的 run 和延迟到未来的 run 都仍有真实 job，必须原样保留。
    expect(byId.get(runWaiting)).toMatchObject({ status: 'queued', error: null });
    expect(byId.get(runDelayed)).toMatchObject({ status: 'queued', error: null });

    expect(await queue.getJob(runWaiting)).toBeDefined();
    expect(await queue.getJob(runDelayed)).toBeDefined();
    expect(await queue.getJob(runMissing)).toBeUndefined();
    await expect(waitingJob.getState()).resolves.toBe('waiting');
    await expect(delayedJob.getState()).resolves.toBe('delayed');

    // DB 先落终态，再补发唯一一条 run_finished。
    expect(publishRun).toHaveBeenCalledTimes(1);
    expect(publishRun).toHaveBeenCalledWith(
      runMissing,
      { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
      logger,
    );
  });

  it('keeps queued work when Redis never becomes ready and closes the connection', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('missing local port');
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const offline = new Queue(`offline-${randomUUID()}`, {
      connection: { host: '127.0.0.1', port: address.port },
    });
    offline.on('error', () => undefined);
    const started = Date.now();
    try {
      // 其他测试文件可能有陈旧行：这里只断言本用例两条运行仍保留，不依赖全表计数。
      expect(await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, offline)).toBeLessThan(3);
      expect(Date.now() - started).toBeGreaterThanOrEqual(19_000);
      expect(Date.now() - started).toBeLessThan(27_000);
      const rows = await db
        .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(inArray(schema.agentRuns.id, [runWaiting, runDelayed]));
      expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
        new Map([
          [runWaiting, 'queued'],
          [runDelayed, 'queued'],
        ]),
      );
      expect(publishRun).not.toHaveBeenCalled();
    } finally {
      await offline.close();
    }
  }, 30_000);

  it('fails a stale running run even when the queue has no job for it', async () => {
    const runRunning = newId('run');
    const agentRunning = newId('agent');
    // 只有 running 路径按 agent 超时判断：该 agent 显式短超时，运行时间超过它的截止线。
    await db.insert(schema.agents).values({
      id: agentRunning,
      slug: `reconcile-${agentRunning.slice(4, 12)}`,
      name: 'reconcile-running',
      model: 'test',
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    await db.insert(schema.agentRuns).values({
      id: runRunning,
      conversationId,
      agentId: agentRunning,
      status: 'running',
      createdAt: new Date(Date.now() - STALE_MS),
      startedAt: new Date(Date.now() - STALE_MS),
    });

    try {
      const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue);
      expect(reconciled).toBeGreaterThanOrEqual(1);

      const [row] = await db
        .select({ status: schema.agentRuns.status, error: schema.agentRuns.error })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runRunning));
      expect(row).toMatchObject({ status: 'failed', error: LOST_RUN_ERROR });
      expect(publishRun).toHaveBeenCalledTimes(1);
      expect(publishRun).toHaveBeenCalledWith(
        runRunning,
        { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
        logger,
      );
    } finally {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.target, runRunning));
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runRunning));
      await db.delete(schema.agents).where(eq(schema.agents.id, agentRunning));
    }
  }, 10_000);

  it('keeps a running run within its own agent timeout while failing a shorter one', async () => {
    const shortRun = newId('run');
    const longRun = newId('run');
    const shortAgent = newId('agent');
    const longAgent = newId('agent');
    await db.insert(schema.agents).values([
      {
        id: shortAgent,
        slug: `reconcile-${shortAgent}`,
        name: 'reconcile-short',
        model: 'test',
        timeoutMs: AGENT_TIMEOUT_MS,
      },
      {
        id: longAgent,
        slug: `reconcile-${longAgent}`,
        name: 'reconcile-long',
        model: 'test',
        timeoutMs: LONG_TIMEOUT_MS,
      },
    ]);
    const startedAt = new Date(Date.now() - BETWEEN_CUTOFFS_MS);
    await db.insert(schema.agentRuns).values(
      [shortRun, longRun].map((id, index) => ({
        id,
        conversationId,
        agentId: index === 0 ? shortAgent : longAgent,
        status: 'running' as const,
        createdAt: startedAt,
        startedAt,
      })),
    );

    try {
      const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue);
      expect(reconciled).toBe(1);

      const rows = await db
        .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, shortRun));
      const [shortRow] = rows;
      expect(shortRow).toMatchObject({ status: 'failed' });
      const [longRow] = await db
        .select({ status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, longRun));
      expect(longRow).toMatchObject({ status: 'running' });
      expect(publishRun).toHaveBeenCalledTimes(1);
      expect(publishRun).toHaveBeenCalledWith(
        shortRun,
        { type: 'run_finished', status: 'failed', error: LOST_RUN_ERROR },
        logger,
      );
    } finally {
      await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, [shortRun, longRun]));
      await db.delete(schema.agentRuns).where(inArray(schema.agentRuns.id, [shortRun, longRun]));
      await db.delete(schema.agents).where(inArray(schema.agents.id, [shortAgent, longAgent]));
    }
  }, 10_000);
});
