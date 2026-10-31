import { randomUUID } from 'node:crypto';
import { createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type KnowledgeJobsQueueLike,
  type KnowledgeSchedulerQueue,
  processKnowledgeSyncTrigger,
  startKnowledgeScheduler,
  syncKnowledgeSchedulers,
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
const redisUrl = process.env.REDIS_URL ?? ''; // 独立前缀：对账会删「库里不存在」的 scheduler，绝不能落到真实知识调度上。
const prefix = `knowledge-sched-${randomUUID().slice(0, 8)}`;

describe.skipIf(!ready)('knowledge sync scheduler against live redis and postgres', () => {
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  /** 触发队列与 jobs 队列都用测试前缀：真实 worker 不会消费。 */
  let triggers: Queue<{ sourceId: string }>;
  let jobs: Queue<{ jobId: string }>;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
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
    if (!triggers) return;
    const entries = await triggers.getJobSchedulers();
    await Promise.all(entries.map((entry) => triggers.removeJobScheduler(entry.key)));
  }

  beforeAll(async () => {
    ({ db, pool } = createDb(process.env.DATABASE_URL ?? ''));
    triggers = new Queue<{ sourceId: string }>('knowledge-sync-triggers', {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
    jobs = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
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
    try {
      await clearSchedulers();
      await jobs?.obliterate({ force: true }).catch(() => undefined);
      await triggers?.close();
      await jobs?.close();
      if (db) {
        await db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.baseId, baseId));
        await db.delete(schema.knowledgeSources).where(eq(schema.knowledgeSources.baseId, baseId));
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

  describe('scheduler isolation', () => {
    it('keeps valid sources scheduled when a stored cron cannot be parsed and drops the old entry', async () => {
      const bad = await insertSource({ syncCron: '99 99 99 99 99' });
      const good = await insertSource({ syncCron: '*/5 * * * *' });
      const paused = await insertSource({ status: 'paused', syncCron: '*/5 * * * *' });
      const warned: string[] = [];
      const capture = {
        ...logger,
        warn: (...args: unknown[]) => warned.push(args.map((arg) => JSON.stringify(arg)).join(' ')),
      } as unknown as Logger;
      await triggers.upsertJobScheduler(
        `knowledge-sync:${bad}`,
        { pattern: '0 2 * * *', tz: 'UTC' },
        { name: 'knowledge-sync', data: { sourceId: bad } },
      );
      await triggers.upsertJobScheduler(
        'knowledge-sync:ghost-isolation',
        { pattern: '* * * * *', tz: 'UTC' },
        { name: 'knowledge-sync', data: { sourceId: 'ghost-isolation' } },
      );
      const scheduler = startKnowledgeScheduler({ db, logger: capture, redisUrl, prefix });
      try {
        await expect(scheduler.sync()).resolves.toBeUndefined();
        const keys = new Set((await schedulerEntries()).map(([key]) => key));
        expect(keys).toContain(`knowledge-sync:${good}`);
        expect(keys).not.toContain(`knowledge-sync:${bad}`);
        expect(keys).not.toContain('knowledge-sync:ghost-isolation');
        expect(keys).not.toContain(`knowledge-sync:${paused}`);
        expect((await triggers.getJobScheduler(`knowledge-sync:${good}`))?.pattern).toBe(
          '*/5 * * * *',
        );
        const log = warned.join('\n');
        expect(log).toContain(bad);
        expect(log).toContain('"stage":"upsert"');
      } finally {
        await scheduler.close();
      }
    });

    it('isolates remove and upsert failures per source through the queue seam', async () => {
      const changed = await insertSource({ syncCron: '0 3 * * *' });
      const unchanged = await insertSource({ syncCron: '0 4 * * *' });
      const orphan = 'knowledge-sync:queued-orphan';
      const calls: string[] = [];
      const warned: string[] = [];
      const capture = {
        ...logger,
        warn: (...args: unknown[]) => warned.push(args.map((arg) => JSON.stringify(arg)).join(' ')),
      } as unknown as Logger;
      const queue: KnowledgeSchedulerQueue = {
        getJobSchedulers: async () => [
          { key: `knowledge-sync:${changed}`, pattern: '0 2 * * *' },
          { key: `knowledge-sync:${unchanged}`, pattern: '0 4 * * *' },
          { key: orphan, pattern: '* * * * *' },
        ],
        upsertJobScheduler: async (id, repeat) => {
          calls.push(`upsert:${id}:${repeat.pattern}`);
          throw new Error('upsert boom');
        },
        removeJobScheduler: async (id) => {
          calls.push(`remove:${id}`);
          if (id === orphan) throw new Error('remove boom');
        },
      };
      await expect(
        syncKnowledgeSchedulers({ db, logger: capture, queue }),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(calls).toEqual(
        expect.arrayContaining([
          `remove:knowledge-sync:${changed}`,
          `upsert:knowledge-sync:${changed}:0 3 * * *`,
          `remove:${orphan}`,
        ]),
      );
      expect(calls.some((call) => call.includes(unchanged))).toBe(false);
      const log = warned.join('\n');
      expect(log).toContain(changed);
      expect(log).toContain(orphan);
      expect(log).toContain('"stage":"upsert"');
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
      const emptyCron = await insertSource({ syncCron: '' });
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
          { sourceId: emptyCron },
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
      const source = await repo.knowledge.getSource(db, sourceId);
      expect(source).toMatchObject({
        lastSyncStatus: 'failed',
        lastError: '定时同步入队失败',
        cursor: {},
      });
    });

    it('does not overwrite a job claimed while enqueue was failing', async () => {
      const sourceId = await insertSource({});
      const queue = fakeJobsQueue({
        add: async (_name, data) => {
          // 第一次入队失败前，worker 抢先认领；scheduler 的 queued CAS 必须无操作。
          await repo.knowledge.claimJob(db, data.jobId);
          throw new Error('redis down');
        },
      });
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId })).toBe('failed');
      const [job] = await db
        .select()
        .from(schema.knowledgeJobs)
        .where(eq(schema.knowledgeJobs.sourceId, sourceId));
      expect(job).toMatchObject({ status: 'running' });
      const runs = await repo.knowledge.listSyncRuns(db, sourceId);
      expect(runs.items[0]).toMatchObject({ status: 'running', endedAt: null });
      expect((await repo.knowledge.getSource(db, sourceId))?.lastSyncStatus).toBeNull();
    });

    it('creates one pair when manual and scheduled triggers race for the same source', async () => {
      const sourceId = await insertSource({});
      const other = await insertSource({});
      const added: string[] = [];
      const queue = fakeJobsQueue({
        add: async (_name, data) => {
          added.push(data.jobId);
        },
      });
      const outcomes = await Promise.all([
        processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId }),
        processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId }),
        repo.knowledge.createSyncJob(db, sourceId),
      ]);
      const fired = outcomes.slice(0, 2).filter((outcome) => outcome === 'fired').length;
      // 谁先拿到锁谁建 pair；其余入口只能看到 duplicate/in_progress，不能各建一条。
      expect(fired).toBeLessThanOrEqual(1);
      expect(added).toHaveLength(fired);
      expect(
        outcomes.filter(
          (outcome) =>
            outcome === 'fired' || (typeof outcome === 'object' && outcome.status === 'created'),
        ),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.knowledgeJobs)
          .where(eq(schema.knowledgeJobs.sourceId, sourceId)),
      ).toHaveLength(1);
      expect(await processKnowledgeSyncTrigger({ db, logger, queue }, { sourceId: other })).toBe(
        'fired',
      );
    });

    it('leaves no sync run when the job insert is rejected', async () => {
      const sourceId = await insertSource({});
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
      const fn = `fail_sync_job_insert_${suffix}`;
      await db.execute(
        sql.raw(
          `create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'injected job insert'; end $$`,
        ),
      );
      await db.execute(
        sql.raw(
          `create trigger ${fn}_trg before insert on knowledge_jobs for each row when (new.source_id = '${sourceId}') execute function ${fn}()`,
        ),
      );
      try {
        await expect(
          processKnowledgeSyncTrigger({ db, logger, queue: fakeJobsQueue() }, { sourceId }),
        ).rejects.toThrow();
      } finally {
        await db.execute(sql.raw(`drop trigger if exists ${fn}_trg on knowledge_jobs`));
        await db.execute(sql.raw(`drop function if exists ${fn}()`));
      }
      expect(await repo.knowledge.listSyncRuns(db, sourceId)).toMatchObject({ items: [] });
      expect(
        await db
          .select()
          .from(schema.knowledgeJobs)
          .where(eq(schema.knowledgeJobs.sourceId, sourceId)),
      ).toHaveLength(0);
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
