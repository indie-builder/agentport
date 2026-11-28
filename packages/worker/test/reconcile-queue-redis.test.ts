import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createServer } from 'node:net';
import { createDb, newId, schema } from '@agentport/db';
import type { AgentRunJob } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { testAccess } from './fixtures/access.js';
import { bunRedisConnection, probeBunRedis } from './fixtures/bun-redis.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { agentOwnership, conversationSubject, runSubjectFields } = testAccess(import.meta.url);

const publishRun = mock<() => Promise<void>>().mockResolvedValue(undefined);

const runnerClientActual = await import('../src/runner-client.js');
mock.module('../src/runner-client.js', () => ({ ...runnerClientActual, publishRun }));

const { LOST_RUN_ERROR, reconcileOrphanedRuns } = await import('../src/scheduling/reconcile.js');

const AGENT_TIMEOUT_MS = 10_000;
const STALE_MS = 15 * 60_000;

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

const isolated = await createIsolatedDatabase('worker_reconcile_queue');
if (isolated) process.env.DATABASE_URL = isolated.url;
const ready = isolated !== null && (await probeInfra());
if (!ready && isolated) await isolated.close();

describe.skipIf(!ready)('reconcileOrphanedRuns against a live queue', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>['db'];
  let queue: Queue<AgentRunJob>;
  let queueRedis: ReturnType<typeof bunRedisConnection>;
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
  const cleanup = mock(
    async (_input: { runId: string; conversationId: string; sandboxId: string }) => undefined,
  );

  beforeAll(async () => {
    dbHandle = createDb(isolated?.url ?? '');
    db = dbHandle.db;
    queueRedis = bunRedisConnection(process.env.REDIS_URL ?? '');
    queue = new Queue<AgentRunJob>(`reconcile-${crypto.randomUUID()}`, {
      connection: queueRedis.connection,
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
    await queueRedis?.close();
    await db.delete(schema.auditLog).where(inArray(schema.auditLog.target, ownedRuns));
    await db.delete(schema.agentRuns).where(inArray(schema.agentRuns.id, ownedRuns));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await dbHandle.client.close();
    await isolated?.close();
  });

  it('fails only the stale queued run whose job is gone', async () => {
    const reconciled = await reconcileOrphanedRuns(db, logger, AGENT_TIMEOUT_MS, queue, cleanup);
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

    expect(byId.get(runWaiting)).toMatchObject({ status: 'queued', error: null });
    expect(byId.get(runDelayed)).toMatchObject({ status: 'queued', error: null });

    expect(await queue.getJob(runWaiting)).toBeDefined();
    expect(await queue.getJob(runDelayed)).toBeDefined();
    expect(await queue.getJob(runMissing)).toBeUndefined();
    await expect(waitingJob.getState()).resolves.toBe('waiting');
    await expect(delayedJob.getState()).resolves.toBe('delayed');

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
    const offlineRedis = bunRedisConnection(`redis://127.0.0.1:${address.port}`);
    const offline = new Queue(`offline-${crypto.randomUUID()}`, {
      connection: offlineRedis.connection,
    });
    offline.on('error', () => undefined);
    const started = Date.now();
    try {
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
      await offlineRedis.close();
    }
  }, 30_000);

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

    const activeRedis = bunRedisConnection(process.env.REDIS_URL ?? '');
    const activeQueue = new Queue<AgentRunJob>(`reconcile-active-${crypto.randomUUID()}`, {
      connection: activeRedis.connection,
    });
    let active!: () => void;
    const reachedActive = new Promise<void>((resolve) => {
      active = resolve;
    });
    let release!: () => void;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workerRedis = bunRedisConnection(process.env.REDIS_URL ?? '');
    const worker = new Worker(
      activeQueue.name,
      async () => {
        active();
        await blocking;
      },
      { connection: workerRedis.connection },
    );
    worker.on('error', () => undefined);
    const job = await activeQueue.add(
      'run',
      { runId: runActive, agentId: agentActive, conversationId, prompt: 'active' },
      { jobId: runActive },
    );
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
      await workerRedis.close();
      await Promise.allSettled([job.remove(), mirrorWaiting.remove(), mirrorDelayed.remove()]);
      await activeQueue.close();
      await activeRedis.close();
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runActive));
      await db.delete(schema.agents).where(eq(schema.agents.id, agentActive));
    }
  }, 20_000);
});
