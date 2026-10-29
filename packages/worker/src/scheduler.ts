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
import { Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

/** 每 5 分钟与库对账一次：补缺失的 scheduler、删孤儿，不动已存在且未变的。 */
const RECONCILE_MS = 5 * 60_000;
const ENQUEUE_ATTEMPTS = 3;

type Db = ReturnType<typeof createDb>['db'];

/** runner 侧只用到这两个方法；测试用同一个形状的假队列，不碰真实 Redis。 */
export interface RunsQueueLike {
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

export type ScheduleTriggerOutcome = 'fired' | 'skipped' | 'duplicate' | 'failed';

export interface ScheduleScheduler {
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
  await repo.audit.writeAudit(db, logger, { actor: 'worker', action, target, status, input });
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
  await db
    .update(schema.agentRuns)
    .set({ status: 'failed', endedAt: new Date(), error: '定时任务入队失败', errorKind: 'infra' })
    .where(and(eq(schema.agentRuns.id, job.runId), eq(schema.agentRuns.status, 'queued')));
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
  const triggerAt = job.opts.prevMillis;
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

  const backlog = await input.runsQueue.getWaitingCount();
  if (backlog > AGENT_RUNS_BACKLOG_LIMIT) {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'backlog',
      waiting: backlog,
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
      const enqueued = await enqueueRun(input.db, input.logger, input.runsQueue, {
        runId,
        agentId: existing.agentId,
        conversationId: existing.conversationId,
        prompt: schedule.prompt,
      });
      return enqueued ? 'fired' : 'failed';
    }
    // 运行已开始或已结束：同一触发不必再跑一次。
    if (existing) return 'duplicate';
  }

  runId ??= newId('run');
  conversationId ??= newId('conversation');
  messageId ??= newId('message');
  // 先落盘再建运行：崩溃后重投能靠 runId 识别已创建的运行。
  await job.updateData({ scheduleId: data.scheduleId, runId, conversationId, messageId });

  const claim = await repo.ops.claimScheduleTrigger(input.db, {
    scheduleId: data.scheduleId,
    runId,
    conversationId,
    messageId,
    triggerAt,
  });
  if (claim === 'duplicate') return 'duplicate';
  if (claim === 'agent_disabled') {
    await audit(input.db, input.logger, 'schedule.skipped', data.scheduleId, 'ok', {
      reason: 'agent_disabled',
      agentId: schedule.agentId,
    });
    return 'skipped';
  }

  const enqueued = await enqueueRun(input.db, input.logger, input.runsQueue, {
    runId,
    agentId: schedule.agentId,
    conversationId,
    prompt: schedule.prompt,
  });
  if (!enqueued) return 'failed';
  await audit(input.db, input.logger, 'schedule.fired', data.scheduleId, 'ok', {
    runId,
    agentId: schedule.agentId,
  });
  input.logger.info({ scheduleId: data.scheduleId, runId }, 'schedule fired');
  return 'fired';
}

/**
 * 定时任务的权威来源是 API/DB，worker 负责把 Redis 里的 scheduler 对齐到库：
 * 启动同步一次，之后每 5 分钟对账；已存在且 cron/tz 未变的不重置（保留 next）。
 */
export function startScheduleScheduler(input: {
  db: Db;
  logger: Logger;
  redisUrl: string;
  /** 测试用独立 Redis 键前缀，避免对账删到同机真实的 scheduler。 */
  prefix?: string;
}): ScheduleScheduler {
  const connection = { url: input.redisUrl, maxRetriesPerRequest: null };
  const prefix = input.prefix === undefined ? undefined : input.prefix;
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

  let timer: NodeJS.Timeout | null = null;

  async function sync(): Promise<void> {
    const rows = await input.db
      .select({
        id: schema.agentSchedules.id,
        cron: schema.agentSchedules.cron,
        enabled: schema.agentSchedules.enabled,
      })
      .from(schema.agentSchedules);
    const desired = new Map(rows.filter((row) => row.enabled).map((row) => [row.id, row.cron]));
    const existing = new Map(
      (await queue.getJobSchedulers()).map((entry) => [entry.key, entry.pattern]),
    );
    for (const [id, cron] of desired) {
      if (existing.get(id) === cron) continue;
      await queue.upsertJobScheduler(...scheduleTriggerArgs(id, cron));
    }
    for (const id of existing.keys()) {
      if (!desired.has(id)) await queue.removeJobScheduler(id);
    }
  }

  timer = setInterval(() => {
    void sync().catch((err: unknown) => input.logger.error({ err }, 'schedule reconcile failed'));
  }, RECONCILE_MS);
  timer.unref();

  return {
    sync,
    close: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      // 等 inflight 的触发跑完；scheduler 本身保留，下次启动按库对账。
      await worker.close();
      await runsQueue.close();
      await queue.close();
    },
  };
}
