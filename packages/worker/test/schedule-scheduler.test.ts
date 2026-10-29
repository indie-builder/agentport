import { randomUUID } from 'node:crypto';
import { createDb, newId, schema } from '@agentport/db';
import type { AgentRunJob, ScheduleTriggerJob } from '@agentport/shared';
import { RUNS_QUEUE, SCHEDULE_TRIGGERS_QUEUE, scheduleTriggerArgs } from '@agentport/shared';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processScheduleTrigger,
  type ScheduleTriggerJobLike,
  startScheduleScheduler,
} from '../src/scheduler.js';
import { createIsolatedDatabase } from './isolated-db.js';

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
    // 不需要检查消费者：本套件全程使用独立 prefix（见下方 `prefix`），真实 worker 看不到。
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
// 独立的键前缀：对账会删「库里不存在」的 scheduler，绝不能落到同机真实队列上。
const prefix = `sched-test-${randomUUID().slice(0, 8)}`;
// 套件写的 schedule 是 enabled 的，共享库上真实 worker 的 sync 会把它同步到生产队列并真的触发；
// 独享随机库后，生产 worker 看不到这些行。
const isolated = ready ? await createIsolatedDatabase('worker_sched_test') : null;
if (isolated) process.env.DATABASE_URL = isolated.url;
else if (ready) console.warn('schedule-scheduler: 无法建独立库，使用本轮测试库');
const databaseUrl = isolated?.url ?? process.env.DATABASE_URL ?? '';

describe.skipIf(!ready)('schedule scheduler against live redis and postgres', () => {
  let db: ReturnType<typeof createDb>['db'];
  let pool: ReturnType<typeof createDb>['pool'];
  let schedulerQueue: Queue<ScheduleTriggerJob>;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  const agentId = newId('agent');
  const disabledAgentId = newId('agent');
  let scheduleIds: string[] = [];
  let runsQueue: Queue<AgentRunJob>;

  async function clearSchedulers(): Promise<void> {
    const schedulers = await schedulerQueue.getJobSchedulers();
    await Promise.all(schedulers.map((s) => schedulerQueue.removeJobScheduler(s.key)));
  }

  async function insertSchedule(input: {
    agentId?: string;
    cron?: string;
    enabled?: boolean;
  }): Promise<string> {
    const id = newId('schedule');
    scheduleIds.push(id);
    await db.insert(schema.agentSchedules).values({
      id,
      agentId: input.agentId ?? agentId,
      name: 'digest',
      cron: input.cron ?? '*/5 * * * *',
      prompt: 'summarize',
      enabled: input.enabled ?? true,
    });
    return id;
  }

  async function resetData(): Promise<void> {
    await db
      .delete(schema.agentRuns)
      .where(inArray(schema.agentRuns.agentId, [agentId, disabledAgentId]));
    await db
      .delete(schema.conversations)
      .where(inArray(schema.conversations.agentId, [agentId, disabledAgentId]));
    await db
      .delete(schema.agentSchedules)
      .where(inArray(schema.agentSchedules.id, scheduleIds.length > 0 ? scheduleIds : ['none']));
    scheduleIds = [];
  }

  async function runsOf(agent: string) {
    return db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent));
  }

  async function lastRunAtOf(scheduleId: string): Promise<Date | null> {
    const [row] = await db
      .select({ lastRunAt: schema.agentSchedules.lastRunAt })
      .from(schema.agentSchedules)
      .where(eq(schema.agentSchedules.id, scheduleId));
    return row?.lastRunAt ?? null;
  }

  function fakeJob(data: ScheduleTriggerJob, plannedAt = Date.now()): ScheduleTriggerJobLike {
    const job: ScheduleTriggerJobLike = {
      data,
      opts: { prevMillis: plannedAt },
      updateData: async (next) => {
        job.data = next;
      },
    };
    return job;
  }

  interface FakeRunsQueue {
    added: string[];
    getWaitingCount: () => Promise<number>;
    add: (name: 'run', data: AgentRunJob, opts: { jobId: string }) => Promise<unknown>;
  }

  function fakeRunsQueue(
    options: { waiting?: number; beforeAdd?: (jobId: string) => Promise<void> } = {},
  ): FakeRunsQueue {
    const added: string[] = [];
    return {
      added,
      getWaitingCount: async () => options.waiting ?? 0,
      add: async (_name, _data, opts) => {
        await options.beforeAdd?.(opts.jobId);
        added.push(opts.jobId);
        return { id: opts.jobId };
      },
    };
  }

  async function messagesOf(conversationId: string) {
    return db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
  }

  beforeAll(async () => {
    const handle = createDb(databaseUrl);
    db = handle.db;
    pool = handle.pool;
    schedulerQueue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
    });
    await db.insert(schema.agents).values([
      { id: agentId, slug: `sched-${agentId.slice(4, 12)}`, name: 'sched', model: 'test' },
      {
        id: disabledAgentId,
        slug: `sched-off-${disabledAgentId.slice(4, 12)}`,
        name: 'sched-off',
        model: 'test',
        enabled: false,
      },
    ]);
    runsQueue = new Queue<AgentRunJob>(`${RUNS_QUEUE}-sched-test-${randomUUID()}`, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });
  });

  beforeEach(async () => {
    await clearSchedulers();
    await resetData();
    await runsQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await clearSchedulers();
    await resetData();
    await runsQueue.obliterate({ force: true }).catch(() => undefined);
    await runsQueue.close();
    await schedulerQueue.close();
    await db.delete(schema.agents).where(inArray(schema.agents.id, [agentId, disabledAgentId]));
    await pool.end();
    await isolated?.close();
  });

  describe('sync', () => {
    it('registers a scheduler with a next run', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        const entry = await schedulerQueue.getJobScheduler(scheduleId);
        expect(entry?.next).toEqual(expect.any(Number));
        expect(entry?.pattern).toBe('*/5 * * * *');
        expect(entry?.tz).toBe('UTC');
      } finally {
        await scheduler.close();
      }
    });

    it('removes orphan schedulers that no longer exist in the database', async () => {
      await schedulerQueue.upsertJobScheduler(
        ...scheduleTriggerArgs('ghost-schedule', '* * * * *'),
      );
      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        expect(await schedulerQueue.getJobScheduler('ghost-schedule')).toBeUndefined();
        expect(await schedulerQueue.getDelayedCount()).toBe(0);
      } finally {
        await scheduler.close();
      }
    });

    it('keeps a disabled schedule out of redis', async () => {
      const scheduleId = await insertSchedule({ enabled: false });
      await schedulerQueue.upsertJobScheduler(...scheduleTriggerArgs(scheduleId, '* * * * *'));
      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        expect(await schedulerQueue.getJobScheduler(scheduleId)).toBeUndefined();
      } finally {
        await scheduler.close();
      }
    });

    it('does not reset an unchanged scheduler', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        const before = await schedulerQueue.getJobScheduler(scheduleId);
        await scheduler.sync();
        const after = await schedulerQueue.getJobScheduler(scheduleId);
        expect(after?.next).toBe(before?.next);
      } finally {
        await scheduler.close();
      }
    });

    it('replaces the scheduler when the cron changes', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        await scheduler.sync();
        await db
          .update(schema.agentSchedules)
          .set({ cron: '0 9 * * *' })
          .where(eq(schema.agentSchedules.id, scheduleId));
        await scheduler.sync();
        expect((await schedulerQueue.getJobScheduler(scheduleId))?.pattern).toBe('0 9 * * *');
      } finally {
        await scheduler.close();
      }
    });
  });

  describe('planned trigger time', () => {
    it('records the planned time of this round, not when the job was created', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      // 先在任何 worker 消费前注册计划 job 并固定本轮预期：worker 一取到 job 就会把
      // scheduler.next 推进到下一轮，之后再读可能已换成下一轮。
      const plannedJob = await schedulerQueue.upsertJobScheduler(
        ...scheduleTriggerArgs(scheduleId, '*/5 * * * *'),
      );
      const plannedAt = plannedJob.opts.prevMillis;
      if (plannedAt === undefined) throw new Error('planned job is missing prevMillis');
      expect((await schedulerQueue.getJobScheduler(scheduleId))?.next).toBe(plannedAt);
      // 预期已固定，promote 只影响消费时机，不影响本轮计划时刻。
      await plannedJob.promote();

      const scheduler = startScheduleScheduler({ db, logger, redisUrl, prefix });
      try {
        // 同 cron 已存在，启动对账不能重置刚 promote 的这一轮。
        await scheduler.sync();

        await vi.waitFor(
          async () => {
            expect(await lastRunAtOf(scheduleId)).not.toBeNull();
          },
          { timeout: 5_000 },
        );
        expect((await lastRunAtOf(scheduleId))?.getTime()).toBe(plannedAt);
      } finally {
        await scheduler.close();
      }
    });
  });

  describe('processScheduleTrigger', () => {
    it('fires one conversation, run and message', async () => {
      const scheduleId = await insertSchedule({});
      const job = fakeJob({ scheduleId });
      expect(await processScheduleTrigger({ db, logger, runsQueue }, job)).toBe('fired');
      const runs = await runsOf(agentId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.trigger).toBe('schedule');
      expect(await messagesOf(runs[0]?.conversationId)).toHaveLength(1);
      expect(job.data.runId).toBe(runs[0]?.id);
      const [stored] = await db
        .select({ lastRunAt: schema.agentSchedules.lastRunAt })
        .from(schema.agentSchedules)
        .where(eq(schema.agentSchedules.id, scheduleId));
      expect(stored?.lastRunAt?.getTime()).toBe(job.opts.prevMillis);
      expect(await runsQueue.getJob(runs[0]?.id)).toBeDefined();
    });

    it('creates only one run when the same trigger is delivered twice', async () => {
      const scheduleId = await insertSchedule({});
      const job = fakeJob({ scheduleId });
      expect(await processScheduleTrigger({ db, logger, runsQueue }, job)).toBe('fired');
      expect(await processScheduleTrigger({ db, logger, runsQueue }, job)).toBe('fired');
      const runs = await runsOf(agentId);
      expect(runs).toHaveLength(1);
      expect(await messagesOf(runs[0]?.conversationId)).toHaveLength(1);
      expect((await lastRunAtOf(scheduleId))?.getTime()).toBe(job.opts.prevMillis);
    });

    it('only re-enqueues the existing run after a crash before enqueue', async () => {
      const scheduleId = await insertSchedule({});
      const fake = fakeRunsQueue();
      const job = fakeJob({ scheduleId });
      await processScheduleTrigger({ db, logger, runsQueue: fake }, job);
      // 模拟「事务已提交、入队前崩溃」：用同一份已落盘的 data 重投。
      await processScheduleTrigger({ db, logger, runsQueue: fake }, job);
      expect(await runsOf(agentId)).toHaveLength(1);
      expect(fake.added).toHaveLength(2);
      expect(new Set(fake.added).size).toBe(1);
    });

    it('skips a trigger without a planned time', async () => {
      const scheduleId = await insertSchedule({});
      const job: ScheduleTriggerJobLike = {
        data: { scheduleId },
        opts: {},
        updateData: async () => undefined,
      };
      expect(await processScheduleTrigger({ db, logger, runsQueue }, job)).toBe('skipped');
      expect(await runsOf(agentId)).toHaveLength(0);
      expect(await lastRunAtOf(scheduleId)).toBeNull();
    });

    it('skips a disabled or deleted schedule without creating runs', async () => {
      const disabled = await insertSchedule({ enabled: false });
      const deleted = await insertSchedule({});
      await db.delete(schema.agentSchedules).where(eq(schema.agentSchedules.id, deleted));
      expect(
        await processScheduleTrigger({ db, logger, runsQueue }, fakeJob({ scheduleId: disabled })),
      ).toBe('skipped');
      expect(
        await processScheduleTrigger({ db, logger, runsQueue }, fakeJob({ scheduleId: deleted })),
      ).toBe('skipped');
      expect(await runsOf(agentId)).toHaveLength(0);
      const audits = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'schedule.skipped'),
            inArray(schema.auditLog.target, [disabled, deleted]),
          ),
        );
      expect(audits).toHaveLength(2);
    });

    it('skips when the agent is disabled', async () => {
      const scheduleId = await insertSchedule({ agentId: disabledAgentId });
      expect(await processScheduleTrigger({ db, logger, runsQueue }, fakeJob({ scheduleId }))).toBe(
        'skipped',
      );
      expect(await runsOf(disabledAgentId)).toHaveLength(0);
    });

    it('skips when the runs queue is backlogged', async () => {
      const scheduleId = await insertSchedule({});
      const fake = fakeRunsQueue({ waiting: 101 });
      expect(
        await processScheduleTrigger({ db, logger, runsQueue: fake }, fakeJob({ scheduleId })),
      ).toBe('skipped');
      expect(await runsOf(agentId)).toHaveLength(0);
      expect(fake.added).toHaveLength(0);
    });

    it('marks the run failed/infra when enqueue keeps failing', async () => {
      const scheduleId = await insertSchedule({});
      let attempts = 0;
      const fake = fakeRunsQueue({
        beforeAdd: async () => {
          attempts += 1;
          throw new Error('redis down');
        },
      });
      expect(
        await processScheduleTrigger({ db, logger, runsQueue: fake }, fakeJob({ scheduleId })),
      ).toBe('failed');
      expect(attempts).toBe(3);
      const runs = await runsOf(agentId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'failed', errorKind: 'infra' });
    });

    it('never overwrites a run that already started', async () => {
      const scheduleId = await insertSchedule({});
      const fake = fakeRunsQueue({
        beforeAdd: async (jobId) => {
          await db
            .update(schema.agentRuns)
            .set({ status: 'running', startedAt: new Date() })
            .where(eq(schema.agentRuns.id, jobId));
          throw new Error('redis down');
        },
      });
      await processScheduleTrigger({ db, logger, runsQueue: fake }, fakeJob({ scheduleId }));
      const runs = await runsOf(agentId);
      expect(runs[0]?.status).toBe('running');
      expect(runs[0]?.errorKind).toBeNull();
    });

    it('ignores a stale trigger after a newer one already landed', async () => {
      const scheduleId = await insertSchedule({});
      const newer = fakeJob({ scheduleId });
      await processScheduleTrigger({ db, logger, runsQueue }, newer);
      const stale = fakeJob({ scheduleId }, (newer.opts.prevMillis ?? 0) - 60_000);
      expect(await processScheduleTrigger({ db, logger, runsQueue }, stale)).toBe('duplicate');
      expect(await runsOf(agentId)).toHaveLength(1);
    });
  });
});
