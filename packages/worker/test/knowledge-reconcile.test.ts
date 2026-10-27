import { randomUUID } from 'node:crypto';
import { createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_TIMEOUT_MS } from '../src/knowledge/queue.js';
import {
  ensureDailyCleanup,
  KNOWLEDGE_LOST_ERROR,
  type KnowledgeQueueLike,
  reconcileKnowledgeJobs,
} from '../src/knowledge/reconcile.js';

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
const redisUrl = process.env.REDIS_URL ?? '';
// 独立前缀：真实 worker 只消费默认前缀的 knowledge-jobs。
const prefix = `knowledge-reconcile-${randomUUID().slice(0, 8)}`;

describe.skipIf(!ready)('reconcileKnowledgeJobs against a live queue', () => {
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  let queue: Queue<{ jobId: string }>;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  const serverId = newId('server');
  const profileId = newId('knowledgeModelProfile');
  const baseId = newId('knowledgeBase');
  const jobIds: string[] = [];

  /** 与真实 Queue 同形；不消费 job 也不需要连接。 */
  function liveQueue(): KnowledgeQueueLike {
    return {
      getJob: (id) =>
        queue.getJob(id) as unknown as Promise<{ getState: () => Promise<string> } | undefined>,
      remove: async (id) => {
        await queue.remove(id);
      },
      add: (_name, data, opts) => queue.add('knowledge', data, opts),
    };
  }

  /** 超过对账宽限期但仍远未到超时：这些行必须参与本轮判断。 */
  const PAST_GRACE = new Date(Date.now() - 10 * 60_000);

  async function insertJob(input: {
    type?: 'ingest' | 'sync';
    status: 'queued' | 'running';
    startedAt?: Date;
    createdAt?: Date;
    payload?: Record<string, unknown>;
    sourceId?: string | null;
  }): Promise<string> {
    const id = newId('knowledgeJob');
    jobIds.push(id);
    await db.insert(schema.knowledgeJobs).values({
      id,
      type: input.type ?? 'ingest',
      baseId,
      documentId: null,
      sourceId: input.sourceId ?? null,
      status: input.status,
      payload: input.payload ?? { type: 'ingest', documentId: newId('knowledgeDocument') },
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
    return id;
  }

  async function rowOf(id: string) {
    const row = await repo.knowledge.getJob(db, id);
    if (!row) throw new Error(`job ${id} missing`);
    return row;
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL ?? ''));
    queue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
    await db.insert(schema.servers).values({
      id: serverId,
      name: `kb-rec-${serverId.slice(-6)}`,
      kind: 'knowledge',
      config: {},
    });
    await db.insert(schema.knowledgeModelProfiles).values({
      id: profileId,
      kind: 'embedding',
      name: `emb-rec-${profileId.slice(-6)}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'test',
      dimensions: 1024,
      enabled: true,
    });
    await db.insert(schema.knowledgeBases).values({
      id: baseId,
      slug: `kb-rec-${baseId.slice(-6)}`,
      name: 'rec',
      description: '',
      serverId,
      embeddingProfileId: profileId,
      settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false },
    });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await clearTodayCleanup();
  });

  /** cleanup 行 baseId 为 null，无法按库隔离；清掉当天遗留，保证「首次建立」从零开始。 */
  async function clearTodayCleanup(): Promise<void> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await db
      .delete(schema.knowledgeJobs)
      .where(
        and(
          eq(schema.knowledgeJobs.type, 'cleanup'),
          isNull(schema.knowledgeJobs.baseId),
          gte(schema.knowledgeJobs.createdAt, dayStart),
        ),
      );
  }

  async function todayCleanupRows() {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return db
      .select()
      .from(schema.knowledgeJobs)
      .where(
        and(
          eq(schema.knowledgeJobs.type, 'cleanup'),
          isNull(schema.knowledgeJobs.baseId),
          gte(schema.knowledgeJobs.createdAt, dayStart),
        ),
      );
  }

  afterAll(async () => {
    try {
      if (queue) {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
      if (db) {
        await db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.baseId, baseId));
        await db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, baseId));
        await db
          .delete(schema.knowledgeModelProfiles)
          .where(eq(schema.knowledgeModelProfiles.id, profileId));
        await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
      }
    } finally {
      if (pool) await pool.end();
    }
  });

  it('fails a running job whose queue entry is gone and returns retrying ones to queued', async () => {
    const retrying = await insertJob({ status: 'running', startedAt: PAST_GRACE });
    const lost = await insertJob({ status: 'running', startedAt: PAST_GRACE });
    await queue.add('knowledge', { jobId: retrying }, knowledgeEnqueueOptions(retrying));
    const delayed = await insertJob({ status: 'running', startedAt: PAST_GRACE });
    await queue.add(
      'knowledge',
      { jobId: delayed },
      { ...knowledgeEnqueueOptions(delayed), delay: 60_000 },
    );

    const result = await reconcileKnowledgeJobs(db, logger, liveQueue());
    expect(result.failed).toBeGreaterThanOrEqual(1);

    expect((await rowOf(lost)).status).toBe('failed');
    expect((await rowOf(lost)).error).toBe(KNOWLEDGE_LOST_ERROR);
    // waiting/delayed 是 BullMQ 正在重试的 job：行退回 queued 才能继续认领。
    expect((await rowOf(retrying)).status).toBe('queued');
    expect((await rowOf(delayed)).status).toBe('queued');
  });

  it('requeues a queued job missing from redis and leaves real waiting jobs alone', async () => {
    const present = await insertJob({ status: 'queued', createdAt: PAST_GRACE });
    const missing = await insertJob({ status: 'queued', createdAt: PAST_GRACE });
    await queue.add('knowledge', { jobId: present }, knowledgeEnqueueOptions(present));

    const result = await reconcileKnowledgeJobs(db, logger, liveQueue());
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const enqueued = await queue.getJob(missing);
    expect(enqueued).toBeDefined();
    expect(await enqueued?.getState()).toBe('waiting');
    expect((await rowOf(present)).status).toBe('queued');
    expect((await rowOf(missing)).status).toBe('queued');
  });

  it('fails a running job past twice its type timeout even if a job still exists', async () => {
    const timedOutAt = new Date(Date.now() - 2 * KNOWLEDGE_TIMEOUT_MS.ingest - 60_000);
    const id = await insertJob({ status: 'running', startedAt: timedOutAt });
    await queue.add('knowledge', { jobId: id }, { ...knowledgeEnqueueOptions(id), delay: 60_000 });

    await reconcileKnowledgeJobs(db, logger, liveQueue());
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'failed', error: '任务超时' });
    expect(row.endedAt).not.toBeNull();
  });

  it('fails the paired sync run when a running sync job is lost', async () => {
    const sourceId = newId('knowledgeSource');
    const syncRunId = newId('knowledgeSyncRun');
    await db.insert(schema.knowledgeSources).values({
      id: sourceId,
      baseId,
      type: 'feed',
      name: `feed-${sourceId.slice(-6)}`,
      config: {},
      secretsEncrypted: null,
      syncCron: null,
    });
    await db.insert(schema.knowledgeSyncRuns).values({
      id: syncRunId,
      sourceId,
      status: 'running',
      startedAt: new Date(),
    });
    const id = await insertJob({
      type: 'sync',
      status: 'running',
      startedAt: PAST_GRACE,
      sourceId,
      payload: { type: 'sync', sourceId, syncRunId },
    });

    await reconcileKnowledgeJobs(db, logger, liveQueue());
    const runs = await repo.knowledge.listSyncRuns(db, sourceId);
    expect(runs.items[0]).toMatchObject({
      id: syncRunId,
      status: 'failed',
      error: KNOWLEDGE_LOST_ERROR,
    });
    expect((await rowOf(id)).status).toBe('failed');

    await db.delete(schema.knowledgeSyncRuns).where(eq(schema.knowledgeSyncRuns.id, syncRunId));
    await db.delete(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, sourceId));
  });

  it('does nothing when the queue probe fails', async () => {
    const id = await insertJob({ status: 'queued', createdAt: PAST_GRACE });
    const offline: KnowledgeQueueLike = {
      getJob: async () => {
        throw new Error('redis down');
      },
      remove: async () => {
        throw new Error('must not remove');
      },
      add: async () => {
        throw new Error('must not add');
      },
    };
    const result = await reconcileKnowledgeJobs(db, logger, offline);
    expect(result).toEqual({ failed: 0, requeued: 0 });
    expect((await rowOf(id)).status).toBe('queued');
  }, 15_000);

  it('re-enqueues a queued job whose redis entry already finished', async () => {
    const id = await insertJob({ status: 'queued', createdAt: PAST_GRACE });
    // 用一个必定失败的 worker 把 job 跑到 failed，模拟「Redis 里已有终态条目」。
    const failing = new Worker(
      KNOWLEDGE_JOBS_QUEUE,
      async () => {
        throw new Error('boom');
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null }, prefix },
    );
    try {
      await queue.add('knowledge', { jobId: id }, { jobId: id });
      const deadline = Date.now() + 10_000;
      while (true) {
        const state = await (await queue.getJob(id))?.getState();
        if (state === 'failed') break;
        if (Date.now() > deadline) throw new Error('job did not fail in time');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await failing.close();
    }
    expect(await (await queue.getJob(id))?.getState()).toBe('failed');

    await reconcileKnowledgeJobs(db, logger, liveQueue());
    const requeued = await queue.getJob(id);
    expect(await requeued?.getState()).toBe('waiting');
  }, 20_000);

  it('is safe when called twice in a row', async () => {
    const id = await insertJob({ status: 'queued', createdAt: PAST_GRACE });
    await reconcileKnowledgeJobs(db, logger, liveQueue());
    await reconcileKnowledgeJobs(db, logger, liveQueue());
    const jobs = await queue.getJobs(['waiting', 'delayed']);
    expect(jobs.filter((job: Job<{ jobId: string }>) => job.data.jobId === id)).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('queued');
  });

  describe('ensureDailyCleanup', () => {
    it('creates one global queued cleanup job and enqueues it on the first tick', async () => {
      await ensureDailyCleanup(db, logger, liveQueue());

      const rows = await todayCleanupRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('cleanup job missing');
      expect(row).toMatchObject({
        type: 'cleanup',
        status: 'queued',
        baseId: null,
        documentId: null,
        sourceId: null,
        payload: { type: 'cleanup' },
      });
      expect(await (await queue.getJob(row.id))?.getState()).toBe('waiting');
    });

    it('does not create a second cleanup job on a later tick the same UTC day', async () => {
      await ensureDailyCleanup(db, logger, liveQueue());
      await ensureDailyCleanup(db, logger, liveQueue());

      expect(await todayCleanupRows()).toHaveLength(1);
      const cleanupJobs = (await queue.getJobs(['waiting', 'delayed'])).filter(
        (job) => job.name === 'knowledge',
      );
      expect(cleanupJobs).toHaveLength(1);
    });

    it('leaves the queued row for reconcile to re-enqueue when the enqueue fails', async () => {
      const failing: KnowledgeQueueLike = {
        getJob: async () => undefined,
        remove: async () => undefined,
        add: async () => {
          throw new Error('redis down');
        },
      };
      await ensureDailyCleanup(db, logger, failing);

      const rows = await todayCleanupRows();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('cleanup job missing');
      expect(row.status).toBe('queued');
      expect(await queue.getJob(row.id)).toBeUndefined();

      const result = await reconcileKnowledgeJobs(db, logger, liveQueue());
      expect(result.requeued).toBeGreaterThanOrEqual(1);
      expect(await (await queue.getJob(row.id))?.getState()).toBe('waiting');
      expect(await todayCleanupRows()).toHaveLength(1);
    });
  });
});
