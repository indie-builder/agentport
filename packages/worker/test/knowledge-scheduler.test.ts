import { randomUUID } from 'node:crypto';
import { createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type KnowledgeJobsQueueLike,
  processKnowledgeSyncTrigger,
  startKnowledgeScheduler,
} from '../src/knowledge/scheduler.js';

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
// 独立前缀：对账会删「库里不存在」的 scheduler，绝不能落到真实知识调度上。
const prefix = `knowledge-sched-${randomUUID().slice(0, 8)}`;

describe.skipIf(!ready)('knowledge sync scheduler against live redis and postgres', () => {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  /** 触发队列与 jobs 队列都用测试前缀：真实 worker 不会消费。 */
  const triggers = new Queue<{ sourceId: string }>('knowledge-sync-triggers', {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    prefix,
  });
  const jobs = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    prefix,
  });
  const serverId = newId('server');
  const profileId = newId('knowledgeModelProfile');
  const baseId = newId('knowledgeBase');
  const sourceIds: string[] = [];

  function fakeJobsQueue(overrides: Partial<KnowledgeJobsQueueLike> = {}): KnowledgeJobsQueueLike {
    return {
      add: async () => undefined,
      ...overrides,
    };
  }

  async function insertSource(input: {
    status?: 'active' | 'paused' | 'auth_error' | 'disabled';
    syncCron?: string | null;
  }): Promise<string> {
    const id = newId('knowledgeSource');
    sourceIds.push(id);
    await db.insert(schema.knowledgeSources).values({
      id,
      baseId,
      type: 'feed',
      name: `feed-${id.slice(-6)}`,
      config: {},
      secretsEncrypted: null,
      status: input.status ?? 'active',
      syncCron: input.syncCron === undefined ? '*/5 * * * *' : input.syncCron,
    });
    return id;
  }

  async function schedulerEntries() {
    return (await triggers.getJobSchedulers()).map((entry) => [entry.key, entry.pattern]);
  }

  async function clearSchedulers(): Promise<void> {
    const entries = await triggers.getJobSchedulers();
    await Promise.all(entries.map((entry) => triggers.removeJobScheduler(entry.key)));
  }

  beforeAll(async () => {
    await db.insert(schema.servers).values({
      id: serverId,
      name: `kb-sched-${serverId.slice(-6)}`,
      kind: 'knowledge',
      config: {},
    });
    await db.insert(schema.knowledgeModelProfiles).values({
      id: profileId,
      kind: 'embedding',
      name: `emb-sched-${profileId.slice(-6)}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'test',
      dimensions: 1024,
      enabled: true,
    });
    await db.insert(schema.knowledgeBases).values({
      id: baseId,
      slug: `kb-sched-${baseId.slice(-6)}`,
      name: 'sched',
      description: '',
      serverId,
      embeddingProfileId: profileId,
      settings: { chunkTokens: 400, chunkOverlap: 40, wikiAutoUpdate: false },
    });
  });

  beforeEach(async () => {
    await clearSchedulers();
    await jobs.obliterate({ force: true });
    await db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.baseId, baseId));
    await db.delete(schema.knowledgeSources).where(eq(schema.knowledgeSources.baseId, baseId));
    sourceIds.length = 0;
  });

  afterAll(async () => {
    await clearSchedulers();
    await jobs.obliterate({ force: true }).catch(() => undefined);
    await triggers.close();
    await jobs.close();
    await db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.baseId, baseId));
    await db.delete(schema.knowledgeSources).where(eq(schema.knowledgeSources.baseId, baseId));
    await db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, baseId));
    await db
      .delete(schema.knowledgeModelProfiles)
      .where(eq(schema.knowledgeModelProfiles.id, profileId));
    await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
    await pool.end();
  });

  describe('sync', () => {
    it('registers a UTC scheduler for an active source with a cron', async () => {
      const sourceId = await insertSource({ syncCron: '0 3 * * *' });
      const scheduler = startKnowledgeScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        const entry = await triggers.getJobScheduler(`knowledge-sync:${sourceId}`);
        expect(entry?.pattern).toBe('0 3 * * *');
        expect(entry?.tz).toBe('UTC');
        expect(entry?.next).toEqual(expect.any(Number));
      } finally {
        await scheduler.close();
      }
    });

    it('keeps paused sources and empty crons out of redis and removes orphans', async () => {
      const paused = await insertSource({ status: 'paused' });
      const noCron = await insertSource({ syncCron: null });
      await triggers.upsertJobScheduler(
        'knowledge-sync:ghost',
        { pattern: '* * * * *', tz: 'UTC' },
        { name: 'knowledge-sync', data: { sourceId: 'ghost' } },
      );
      const scheduler = startKnowledgeScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        const keys = new Set((await schedulerEntries()).map(([key]) => key));
        expect(keys).not.toContain(`knowledge-sync:${paused}`);
        expect(keys).not.toContain(`knowledge-sync:${noCron}`);
        expect(keys).not.toContain('knowledge-sync:ghost');
      } finally {
        await scheduler.close();
      }
    });

    it('does not reset an unchanged scheduler and replaces a changed cron', async () => {
      const sourceId = await insertSource({ syncCron: '*/5 * * * *' });
      const scheduler = startKnowledgeScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        const first = await triggers.getJobScheduler(`knowledge-sync:${sourceId}`);
        await scheduler.sync();
        const second = await triggers.getJobScheduler(`knowledge-sync:${sourceId}`);
        expect(second?.next).toBe(first?.next);

        await db
          .update(schema.knowledgeSources)
          .set({ syncCron: '0 9 * * *' })
          .where(eq(schema.knowledgeSources.id, sourceId));
        await scheduler.sync();
        expect((await triggers.getJobScheduler(`knowledge-sync:${sourceId}`))?.pattern).toBe(
          '0 9 * * *',
        );
      } finally {
        await scheduler.close();
      }
    });
  });

  describe('processKnowledgeSyncTrigger', () => {
    it('creates one queued sync run and job, then enqueues it', async () => {
      const sourceId = await insertSource({});
      const added: string[] = [];
      const queue = fakeJobsQueue({
        add: async (_name, data) => {
          added.push(data.jobId);
        },
      });
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId })).toBe('fired');

      const jobs = await db
        .select()
        .from(schema.knowledgeJobs)
        .where(eq(schema.knowledgeJobs.sourceId, sourceId));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ type: 'sync', status: 'queued', sourceId });
      expect(added).toEqual([jobs[0]?.id]);
      const runs = await repo.knowledge.listSyncRuns(db, sourceId);
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({ status: 'queued' });
      expect(jobs[0]?.payload).toMatchObject({ syncRunId: runs.items[0]?.id });
    });

    it('skips paused, missing and cron-less sources', async () => {
      const paused = await insertSource({ status: 'paused' });
      const noCron = await insertSource({ syncCron: null });
      expect(
        await processKnowledgeSyncTrigger(
          { db, logger, queue: fakeJobsQueue() },
          { sourceId: paused },
        ),
      ).toBe('skipped');
      expect(
        await processKnowledgeSyncTrigger(
          { db, logger, queue: fakeJobsQueue() },
          { sourceId: noCron },
        ),
      ).toBe('skipped');
      expect(
        await processKnowledgeSyncTrigger(
          { db, logger, queue: fakeJobsQueue() },
          { sourceId: 'ksrc_missing' },
        ),
      ).toBe('skipped');
      expect(
        await db.select().from(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.baseId, baseId)),
      ).toHaveLength(0);
    });

    it('does not overlap an active sync for the same source', async () => {
      const sourceId = await insertSource({});
      const added: string[] = [];
      const queue = fakeJobsQueue({
        add: async (_name, data) => {
          added.push(data.jobId);
        },
      });
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId })).toBe('fired');
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId })).toBe(
        'duplicate',
      );
      expect(added).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.knowledgeJobs)
          .where(eq(schema.knowledgeJobs.sourceId, sourceId)),
      ).toHaveLength(1);
    });

    it('marks job and sync run failed when enqueue keeps failing', async () => {
      const sourceId = await insertSource({});
      let attempts = 0;
      const queue = fakeJobsQueue({
        add: async () => {
          attempts += 1;
          throw new Error('redis down');
        },
      });
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId })).toBe('failed');
      expect(attempts).toBe(3);
      const [job] = await db
        .select()
        .from(schema.knowledgeJobs)
        .where(eq(schema.knowledgeJobs.sourceId, sourceId));
      expect(job).toMatchObject({ status: 'failed', error: '定时同步入队失败' });
      const runs = await repo.knowledge.listSyncRuns(db, sourceId);
      expect(runs.items[0]).toMatchObject({ status: 'failed', error: '定时同步入队失败' });
    });

    it('ignores an invalid trigger payload', async () => {
      expect(await processKnowledgeSyncTrigger({ db, logger, queue: fakeJobsQueue() }, {})).toBe(
        'skipped',
      );
      expect(
        await processKnowledgeSyncTrigger({ db, logger, queue: fakeJobsQueue() }, { sourceId: 3 }),
      ).toBe('skipped');
    });
  });
});
