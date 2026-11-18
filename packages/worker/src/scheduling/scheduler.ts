import { type createDb, newId, repo, schema } from '@agentport/db';
import {
  AGENT_RUNS_BACKLOG_LIMIT,
  type AgentRunJob,
  RUNS_QUEUE,
  runEnqueueOptions,
  SCHEDULE_TRIGGERS_QUEUE,
  type ScheduleTriggerJob,
  scheduleTriggerArgs,
  scheduleTriggerJobSchema,
} from '@agentport/shared';
import { createBunRedisClient, getNextMillis, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { and, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { checkUserAgentAccess } from '../runs/run-access.js';
import { startIntervalTicker } from './interval-ticker.js';

const RECONCILE_MS = z.coerce
  .number()
  .int()
  .positive()
  .default(5 * 60_000)
  .parse(process.env.SCHEDULE_RECONCILE_MS);
const ENQUEUE_ATTEMPTS = 3;
const TRIGGER_MISSED_GRACE_MS = 60_000;

type Db = ReturnType<typeof createDb>['db'];

/** runner 侧只用到这两个方法；测试用同一个形状的假队列，不碰真实 Redis。 */
interface RunsQueueLike {
  getWaitingCount: () => Promise<number>;
  add: (name: 'run', data: AgentRunJob, opts: { jobId: string }) => Promise<unknown>;
}

/** BullMQ Job 在本模块用到的部分：data 可在建运行前先落盘。 */
export interface ScheduleTriggerJobLike {
  data: ScheduleTriggerJob;
  /** Job Scheduler 每轮写入的计划触发时刻；job.timestamp 是创建时刻，不能当触发时刻。 */
  opts: { prevMillis?: number };
  updateData: (data: ScheduleTriggerJob) => Promise<void>;
}

type ScheduleTriggerOutcome = 'fired' | 'skipped' | 'duplicate' | 'failed';

interface ScheduleScheduler {
  /** 读库对账：补齐缺失/变化者，删除库里已不存在的孤儿。 */
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

async function audit(
  db: Db,
  logger: Logger,
  action: string,
  target: string,
  status: 'ok' | 'error',
  input?: unknown,
): Promise<void> {
  await repo.audit.writeAudit(db, logger, {
    actor: 'worker',
    actorKind: 'service',
    action,
    target,
    status,
    input,
  });
}

/** 提交后的入队最多重试 3 次；最终失败只动仍 queued 的运行。 */
async function enqueueRun(
  db: Db,
  logger: Logger,
  queue: RunsQueueLike,
  job: {
    runId: string;
    agentId: string;
    conversationId: string;
    prompt: string;
  },
  schedule: repo.ops.ScheduleRow,
): Promise<boolean> {
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await queue.add(
        'run',
        {
          runId: job.runId,
          agentId: job.agentId,
          conversationId: job.conversationId,
          prompt: job.prompt,
        },
        runEnqueueOptions(job.runId),
      );
      return true;
    } catch (err) {
      logger.warn({ err, runId: job.runId, attempt }, 'schedule enqueue failed');
    }
  }
  // 只改 queued：run 可能已被 worker 接手，running/succeeded 绝不能覆盖。
  const failed = await db.transaction(async (tx) => {
    const [failed] = await tx
      .update(schema.agentRuns)
      .set({ status: 'failed', endedAt: new Date(), error: '定时任务入队失败', errorKind: 'infra' })
      .where(and(eq(schema.agentRuns.id, job.runId), eq(schema.agentRuns.status, 'queued')))
      .returning({
        id: schema.agentRuns.id,
        agentId: schema.agentRuns.agentId,
        conversationId: schema.agentRuns.conversationId,
        initiatedBy: schema.agentRuns.initiatedBy,
      });
    if (failed === undefined) return undefined;
    if (failed.initiatedBy !== null) {
      await repo.integrations.enqueueWebhookEvent(tx, {
        eventType: 'run.failed',
        sourceId: `run:${failed.id}:failed`,
        ownerBusinessId: failed.initiatedBy,
        payload: JSON.stringify({
          runId: failed.id,
          agentId: failed.agentId,
          conversationId: failed.conversationId,
          status: 'failed',
          error: '定时任务入队失败',
        }),
      });
    }
    return failed;
  });
  if (failed !== undefined) {
    await repo.notifications
      .createNotification(db, {
        businessId: schedule.createdBy,
        kind: 'schedule_failed',
        title: '定时任务触发失败',
        body: `定时任务「${schedule.name}」未能启动运行，请打开定时任务查看`,
        link: '/schedules',
        sourceId: `schedule-failed:${schedule.id}:${job.runId}`,
      })
      .catch((err: unknown) => {
        logger.warn(
          { err, scheduleId: schedule.id, runId: job.runId },
          'schedule notification failed',
        );
      });
  }
  return false;
}

/**
 * 一次定时触发：先重读库（陈旧快照不能复活已禁用/删除项），预生成 id 落盘到 job.data，
 * 再由条件更新认领（last_run_at < 本轮计划时刻 prevMillis），最后提交后入队。
 */
export async function processScheduleTrigger(
  input: { db: Db; logger: Logger; runsQueue: RunsQueueLike },
  job: ScheduleTriggerJobLike,
): Promise<ScheduleTriggerOutcome> {
  const parsed = scheduleTriggerJobSchema.safeParse(job.data);
  if (!parsed.success) {
    input.logger.warn({ data: job.data }, 'skip schedule trigger: invalid payload');
    return 'skipped';
  }
  const data = parsed.data;
  const triggerAt = data.triggerAt ?? job.opts.prevMillis;
  if (triggerAt === undefined) {
    input.logger.warn({ data }, 'skip schedule trigger: missing planned time');
    return 'skipped';
  }
  const schedule = await repo.ops.getSchedule(input.db, data.scheduleId);
  if (!schedule?.enabled) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: schedule ? 'disabled' : 'missing',
    });
    return 'skipped';
  }
  const agent = await repo.agents.getAgent(input.db, schedule.agentId);
  if (!agent?.enabled) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'agent_disabled',
      agentId: schedule.agentId,
    });
    return 'skipped';
  }
  // 触发时按 DB 实时身份与授权重查：创建后撤权/停用不再启动，也不降级成管理员。
  const denial = await checkUserAgentAccess(input.db, {
    businessId: schedule.executeAsBusinessId,
    agentId: schedule.agentId,
    permissions: ['agents.use', 'schedules.manage'],
  });
  if (denial !== null) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: denial.reason,
      agentId: schedule.agentId,
      businessId: schedule.executeAsBusinessId,
    });
    return 'skipped';
  }

  let runId = data.runId;
  let conversationId = data.conversationId;
  let messageId = data.messageId;

  if (runId !== undefined) {
    const existing = await repo.chat.getRun(input.db, runId);
    // 上次已建好运行但没入队：补投即可，不再新建。
    if (existing?.status === 'queued') {
      const enqueued = await enqueueRun(
        input.db,
        input.logger,
        input.runsQueue,
        {
          runId,
          agentId: existing.agentId,
          conversationId: existing.conversationId,
          prompt: schedule.prompt,
        },
        schedule,
      );
      return enqueued ? 'fired' : 'failed';
    }
    // 入队耗尽把运行标成 failed(infra)：重投时重新排队补投，避免触发永久丢失。
    if (
      existing?.status === 'failed' &&
      existing.errorKind === 'infra' &&
      existing.startedAt === null
    ) {
      const requeued = await input.db
        .update(schema.agentRuns)
        .set({ status: 'queued', endedAt: null, error: null, errorKind: null })
        .where(
          and(
            eq(schema.agentRuns.id, runId),
            eq(schema.agentRuns.status, 'failed'),
            eq(schema.agentRuns.errorKind, 'infra'),
            isNull(schema.agentRuns.startedAt),
          ),
        )
        .returning({ id: schema.agentRuns.id });
      if (requeued.length === 1) {
        const enqueued = await enqueueRun(
          input.db,
          input.logger,
          input.runsQueue,
          {
            runId,
            agentId: existing.agentId,
            conversationId: existing.conversationId,
            prompt: schedule.prompt,
          },
          schedule,
        );
        return enqueued ? 'fired' : 'failed';
      }
      return 'duplicate';
    }
    // 运行已开始或已结束：同一触发不必再跑一次。
    if (existing) return 'duplicate';
  }

  if (schedule.lastRunAt !== null && triggerAt < schedule.lastRunAt.getTime()) return 'duplicate';
  const missed = Date.now() - triggerAt > TRIGGER_MISSED_GRACE_MS;
  if (schedule.missedPolicy === 'skip' && missed) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'missed',
    });
    return 'skipped';
  }

  const backlog = await input.runsQueue.getWaitingCount();
  if (backlog > AGENT_RUNS_BACKLOG_LIMIT) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'backlog',
      waiting: backlog,
    });
    return 'skipped';
  }

  runId ??= newId('run');
  conversationId ??= newId('conversation');
  messageId ??= newId('message');
  // 先落盘再建运行：崩溃后重投能靠 runId 识别已创建的运行。
  await job.updateData({ ...data, runId, conversationId, messageId });

  const claim = await repo.ops.claimScheduleTrigger(input.db, {
    scheduleId: data.scheduleId,
    runId,
    conversationId,
    messageId,
    triggerAt,
    ...(data.triggerAt !== undefined || missed ? { recordedAt: Date.now() } : {}),
  });
  if (claim === 'duplicate') return 'duplicate';
  if (claim === 'agent_disabled') {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'agent_disabled',
      agentId: schedule.agentId,
    });
    return 'skipped';
  }
  if (claim === 'budget_exceeded') {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'budget_exceeded',
      agentId: schedule.agentId,
    });
    return 'skipped';
  }

  const enqueued = await enqueueRun(
    input.db,
    input.logger,
    input.runsQueue,
    {
      runId,
      agentId: schedule.agentId,
      conversationId,
      prompt: schedule.prompt,
    },
    schedule,
  );
  if (!enqueued) return 'failed';
  await audit(input.db, input.logger, 'schedule.fired', data.scheduleId, 'ok', {
    runId,
    agentId: schedule.agentId,
  });
  input.logger.info({ scheduleId: data.scheduleId, runId }, 'schedule fired');
  return 'fired';
}

export function startScheduleScheduler(input: {
  db: Db;
  logger: Logger;
  redisUrl: string;
  /** 测试用独立 Redis 键前缀，避免对账删到同机真实的 scheduler。 */
  prefix?: string;
}): ScheduleScheduler {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const prefix = input.prefix;
  const queueOptions = { connection, ...(prefix === undefined ? {} : { prefix }) };
  const queue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, queueOptions);
  const runsQueue = new Queue<AgentRunJob>(RUNS_QUEUE, queueOptions);
  const worker = new Worker<ScheduleTriggerJob>(
    SCHEDULE_TRIGGERS_QUEUE,
    (job) => processScheduleTrigger({ db: input.db, logger: input.logger, runsQueue }, job),
    { ...queueOptions, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    input.logger.error({ jobId: job?.id, err }, 'schedule trigger failed');
  });
  queue.on('error', (err) => input.logger.error({ err }, 'schedule queue error'));

  async function syncOnce(): Promise<void> {
    const rows = await repo.ops.listSchedulesForSync(input.db);
    const desired = new Map(rows.filter((row) => row.enabled).map((row) => [row.id, row]));
    const existing = new Map((await queue.getJobSchedulers()).map((entry) => [entry.key, entry]));
    for (const [id, row] of desired) {
      const args = scheduleTriggerArgs(id, row.cron, row.timezone);
      const entry = existing.get(id);
      if (entry?.pattern !== row.cron || entry.tz !== row.timezone) {
        await queue.upsertJobScheduler(...args);
      }
      if (row.missedPolicy !== 'run_once') continue;
      try {
        const anchor = row.lastRunAt ?? row.createdAt;
        const next = getNextMillis(anchor.getTime(), { pattern: row.cron, tz: row.timezone });
        if (next !== undefined && next <= Date.now()) {
          await queue.add(
            args[2].name,
            { scheduleId: id, triggerAt: next },
            { ...args[2].opts, jobId: `catch-up:${id}:${anchor.getTime()}` },
          );
        }
      } catch (err) {
        input.logger.warn({ err, scheduleId: id }, 'schedule catch-up failed');
      }
    }
    for (const id of existing.keys()) {
      if (!desired.has(id)) await queue.removeJobScheduler(id);
    }
  }

  let inFlight: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = syncOnce()
      .catch((err: unknown) => {
        input.logger.error({ err }, 'schedule reconcile failed');
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const stopTicker = startIntervalTicker(() => sync(), RECONCILE_MS);

  return {
    sync,
    close: async () => {
      await stopTicker();
      // 等 inflight 的触发跑完；scheduler 本身保留，下次启动按库对账。
      await worker.close();
      await runsQueue.close();
      await queue.close();
      await connection.quit();
    },
  };
}
