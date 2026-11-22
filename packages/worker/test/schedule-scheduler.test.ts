import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createDb, newId, schema } from '@agentport/db';
import type { AgentRunJob, ScheduleTriggerJob } from '@agentport/shared';
import { RUNS_QUEUE, SCHEDULE_TRIGGERS_QUEUE, scheduleTriggerArgs } from '@agentport/shared';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ScheduleTriggerJobLike } from '../src/scheduling/scheduler.js';
import { bunRedisConnection, probeBunRedis } from './fixtures/bun-redis.js';
import { waitFor } from './fixtures/native-test.js';
import { createIsolatedDatabase } from './isolated-db.js';

const access = { check: mock() };
const runAccessActual = await import('../src/runs/run-access.js');
mock.module('../src/runs/run-access.js', () => ({
  ...runAccessActual,
  checkUserAgentAccess: access.check,
}));

const { processScheduleTrigger, startScheduleScheduler } = await import(
  '../src/scheduling/scheduler.js'
);

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

const ready = await probeInfra();
const redisUrl = process.env.REDIS_URL ?? '';
const prefix = `sched-test-${crypto.randomUUID().slice(0, 8)}`;
const isolated = ready ? await createIsolatedDatabase('worker_sched_test') : null;
if (isolated) process.env.DATABASE_URL = isolated.url;
else if (ready) console.warn('schedule-scheduler: 无法建独立库，使用本轮测试库');
const databaseUrl = isolated?.url ?? process.env.DATABASE_URL ?? '';

describe.skipIf(!ready)('schedule scheduler against live redis and postgres', () => {
  let db: ReturnType<typeof createDb>['db'];
  let client: ReturnType<typeof createDb>['client'];
  let schedulerQueue: Queue<ScheduleTriggerJob>;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  const agentId = newId('agent');
  const disabledAgentId = newId('agent');
  const scheduleBusinessId = 'schedule-owner';
  let scheduleIds: string[] = [];
  let runsQueue: Queue<AgentRunJob>;
  let schedulerRedis: ReturnType<typeof bunRedisConnection>;
  let runsRedis: ReturnType<typeof bunRedisConnection>;

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
      createdBy: scheduleBusinessId,
      executeAsBusinessId: scheduleBusinessId,
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
    client = handle.client;
    schedulerRedis = bunRedisConnection(redisUrl);
    schedulerQueue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection: schedulerRedis.connection,
      prefix,
    });
    await db.insert(schema.agents).values([
      {
        id: agentId,
        slug: `sched-${agentId.slice(4, 12)}`,
        name: 'sched',
        model: 'test',
        createdBy: scheduleBusinessId,
        ownerBusinessId: scheduleBusinessId,
      },
      {
        id: disabledAgentId,
        slug: `sched-off-${disabledAgentId.slice(4, 12)}`,
        name: 'sched-off',
        model: 'test',
        enabled: false,
        createdBy: scheduleBusinessId,
        ownerBusinessId: scheduleBusinessId,
      },
    ]);
    runsRedis = bunRedisConnection(redisUrl);
    runsQueue = new Queue<AgentRunJob>(`${RUNS_QUEUE}-sched-test-${crypto.randomUUID()}`, {
      connection: runsRedis.connection,
    });
  });

  beforeEach(async () => {
    access.check.mockReset();
    access.check.mockResolvedValue(null);
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
    await runsRedis.close();
    await schedulerRedis.close();
    await db.delete(schema.agents).where(inArray(schema.agents.id, [agentId, disabledAgentId]));
    await client.close();
    await isolated?.close();
  });

  describe('sync', () => {
    it('registers a scheduler with a next run', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
      try {
        await scheduler.sync();
        const entry = await schedulerQueue.getJobScheduler(scheduleId);
        expect(entry?.next).toEqual(expect.any(Number));
        expect(entry?.pattern).toBe('*/5 * * * *');
        expect(entry?.tz).toBe('Asia/Shanghai');
      } finally {
        await scheduler.close();
      }
    });

    it('removes orphan schedulers that no longer exist in the database', async () => {
      await schedulerQueue.upsertJobScheduler(
        ...scheduleTriggerArgs('ghost-schedule', '* * * * *', 'Asia/Shanghai'),
      );
      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
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
      await schedulerQueue.upsertJobScheduler(
        ...scheduleTriggerArgs(scheduleId, '* * * * *', 'Asia/Shanghai'),
      );
      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
      try {
        await scheduler.sync();
        expect(await schedulerQueue.getJobScheduler(scheduleId)).toBeUndefined();
      } finally {
        await scheduler.close();
      }
    });

    it('does not reset an unchanged scheduler', async () => {
      const scheduleId = await insertSchedule({ cron: '*/5 * * * *' });
      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
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
      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
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
      const plannedJob = await schedulerQueue.upsertJobScheduler(
        ...scheduleTriggerArgs(scheduleId, '*/5 * * * *', 'Asia/Shanghai'),
      );
      const plannedAt = plannedJob.opts.prevMillis;
      if (plannedAt === undefined) throw new Error('planned job is missing prevMillis');
      expect((await schedulerQueue.getJobScheduler(scheduleId))?.next).toBe(plannedAt);
      await plannedJob.promote();

      const scheduler = startScheduleScheduler({
        db,
        logger,
        redisUrl,
        reconcileMs: 300_000,
        prefix,
      });
      try {
        await scheduler.sync();

        await waitFor(
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
      expect(access.check).toHaveBeenCalledWith(expect.anything(), {
        businessId: scheduleBusinessId,
        agentId,
        permissions: ['agents.use', 'schedules.manage'],
      });
    });

    it('skips without creating a run when the executor lost access', async () => {
      const scheduleId = await insertSchedule({});
      access.check.mockResolvedValue({
        reason: 'permission_denied',
        message: '当前账户没有该操作的专家权限，运行未启动',
      });
      expect(await processScheduleTrigger({ db, logger, runsQueue }, fakeJob({ scheduleId }))).toBe(
        'skipped',
      );
      expect(await runsOf(agentId)).toHaveLength(0);
      const audits = await db
        .select({ inputDigest: schema.auditLog.inputDigest })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, 'schedule.skipped'),
            eq(schema.auditLog.target, scheduleId),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(await lastRunAtOf(scheduleId)).toBeNull();
    });

    it('skips without creating a run when the executor account is disabled', async () => {
      const scheduleId = await insertSchedule({});
      access.check.mockResolvedValue({
        reason: 'account_inactive',
        message: '账户已停用或不存在，运行未启动',
      });
      expect(await processScheduleTrigger({ db, logger, runsQueue }, fakeJob({ scheduleId }))).toBe(
        'skipped',
      );
      expect(await runsOf(agentId)).toHaveLength(0);
      expect(await lastRunAtOf(scheduleId)).toBeNull();
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
