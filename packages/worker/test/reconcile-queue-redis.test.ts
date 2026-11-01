import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createDb, newId, schema } from '@agentport/db';
import type { AgentRunJob } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testAccess } from './fixtures/access.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { agentOwnership, conversationSubject, runSubjectFields } = testAccess(import.meta.url);

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

// 全表对账必须只看本次套件的数据：独享随机库，不能落到当前共享库。
const isolated = await createIsolatedDatabase('worker_reconcile_queue');
if (isolated) process.env.DATABASE_URL = isolated.url;
const ready = isolated !== null && (await probeInfra());
if (!ready && isolated) await isolated.close();

describe.skipIf(!ready)('reconcileOrphanedRuns against a live queue', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>['db'];
  let queue: Queue<AgentRunJob>;
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runWaiting = newId('run');
  const runDelayed = newId('run');
  const runMissing = newId('run');
  const ownedRuns = [runWaiting, runDelayed, runMissing];
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  let waitingJob: Awaited<ReturnType<typeof queue.add>>;
  let delayedJob: Awaited<ReturnType<typeof queue.add>>;
  const cleanup = vi.fn(
    async (_input: { runId: string; conversationId: string; sandboxId: string }) => undefined,
  );

  beforeAll(async () => {
    dbHandle = createDb(isolated?.url ?? '');
    db = dbHandle.db;
    // 队列名按测试唯一：真实 worker 只消费 agent-runs，不会把这里的 job 跑掉。
    queue = new Queue<AgentRunJob>(`reconcile-${randomUUID()}`, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `reconcile-${agentId.slice(4, 12)}`,
      name: 'reconcile',
      model: 'test',
      ...agentOwnership,
    });
    await db
      .insert(schema.conversations)
      .values({ id: conversationId, agentId, ...conversationSubject });

    const stale = new Date(Date.now() - STALE_MS);
    await db.insert(schema.agentRuns).values(
      ownedRuns.map((id) => ({
        id,
        conversationId,
        agentId,
        status: 'queued',
        createdAt: stale,
        ...runSubjectFields,
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
    cleanup.mockClear();
    cleanup.mockImplementation(async () => undefined);
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
    await isolated?.close();
  });

  it('fails only the stale queued run whose job is gone', async () => {
    const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue, cleanup);
    // 随机库内只有本用例的三条 run，收敛数必须是 1，不能被别的套件/进程影响。
    expect(reconciled).toBe(1);

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
      // 随机库内没有其他陈旧行：Redis 不可用时一条都不该收敛。
      expect(await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, offline, cleanup)).toBe(0);
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
      ...agentOwnership,
    });
    await db.insert(schema.agentRuns).values({
      id: runRunning,
      conversationId,
      agentId: agentRunning,
      status: 'running',
      sandboxId: 'sandbox-orphan-running',
      createdAt: new Date(Date.now() - STALE_MS),
      startedAt: new Date(Date.now() - STALE_MS),
      ...runSubjectFields,
    });

    try {
      const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue, cleanup);
      expect(reconciled).toBe(1);
      expect(cleanup).toHaveBeenCalledWith({
        runId: runRunning,
        conversationId,
        sandboxId: 'sandbox-orphan-running',
      });

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
        ...agentOwnership,
      },
      {
        id: longAgent,
        slug: `reconcile-${longAgent}`,
        name: 'reconcile-long',
        model: 'test',
        timeoutMs: LONG_TIMEOUT_MS,
        ...agentOwnership,
      },
    ]);
    const startedAt = new Date(Date.now() - BETWEEN_CUTOFFS_MS);
    await db.insert(schema.agentRuns).values(
      [shortRun, longRun].map((id, index) => ({
        id,
        conversationId,
        agentId: index === 0 ? shortAgent : longAgent,
        status: 'running',
        createdAt: startedAt,
        startedAt,
        ...runSubjectFields,
      })),
    );

    try {
      const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue, cleanup);
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

  it('keeps a stale running run while its job is active', async () => {
    const runActive = newId('run');
    const agentActive = newId('agent');
    await db.insert(schema.agents).values({
      id: agentActive,
      slug: `reconcile-${agentActive.slice(4, 12)}`,
      name: 'reconcile-active',
      model: 'test',
      timeoutMs: AGENT_TIMEOUT_MS,
      ...agentOwnership,
    });
    await db.insert(schema.agentRuns).values({
      id: runActive,
      conversationId,
      agentId: agentActive,
      status: 'running',
      sandboxId: 'sandbox-still-active',
      createdAt: new Date(Date.now() - STALE_MS),
      startedAt: new Date(Date.now() - STALE_MS),
      ...runSubjectFields,
    });

    const activeQueue = new Queue<AgentRunJob>(`reconcile-active-${randomUUID()}`, {
      connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null },
    });
    let active!: () => void;
    const reachedActive = new Promise<void>((resolve) => {
      active = resolve;
    });
    let release!: () => void;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new Worker(
      activeQueue.name,
      async () => {
        active();
        await blocking;
      },
      { connection: { url: process.env.REDIS_URL, maxRetriesPerRequest: null } },
    );
    worker.on('error', () => undefined);
    const job = await activeQueue.add(
      'run',
      { runId: runActive, agentId: agentActive, conversationId, prompt: 'active' },
      { jobId: runActive },
    );
    // 前面用例的 queued 行也在这个库里：给它们同样的 job 身份，避免被本用例的对账误判为孤儿。
    const mirrorWaiting = await activeQueue.add(
      'run',
      { runId: runWaiting, agentId, conversationId, prompt: 'mirror' },
      { jobId: runWaiting },
    );
    const mirrorDelayed = await activeQueue.add(
      'run',
      { runId: runDelayed, agentId, conversationId, prompt: 'mirror' },
      { jobId: runDelayed, delay: 60_000 },
    );

    try {
      await reachedActive;
      // timeout 被改短也不影响仍在 active 的 job：必须先看到终态才收敛。
      expect(await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, activeQueue, cleanup)).toBe(
        0,
      );
      const [row] = await db
        .select({ status: schema.agentRuns.status, error: schema.agentRuns.error })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runActive));
      expect(row).toMatchObject({ status: 'running', error: null });
      expect(cleanup).not.toHaveBeenCalled();
      expect(publishRun).not.toHaveBeenCalled();
    } finally {
      release();
      await worker.close();
      await Promise.allSettled([job.remove(), mirrorWaiting.remove(), mirrorDelayed.remove()]);
      await activeQueue.close();
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runActive));
      await db.delete(schema.agents).where(eq(schema.agents.id, agentActive));
    }
  }, 20_000);
});
