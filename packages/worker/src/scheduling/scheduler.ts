import { type createDb, newId, repo, schema } from '@agentport/db';
import {
  AGENT_RUNS_BACKLOG_LIMIT,
  type AgentRunJob,
  RUNS_QUEUE,
  type RunErrorKind,
  runEnqueueOptions,
  SCHEDULE_TRIGGERS_QUEUE,
  type ScheduleTriggerJob,
  scheduleTriggerArgs,
  scheduleTriggerJobSchema,
} from '@agentport/shared';
import { createBunRedisClient, getNextMillis, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { checkRunPromptPolicy } from '../content-policy.js';
import { checkUserAgentAccess } from '../runs/run-access.js';
import { startIntervalTicker } from './interval-ticker.js';

const ENQUEUE_ATTEMPTS = 3;
const TRIGGER_MISSED_GRACE_MS = 60_000;

type Db = ReturnType<typeof createDb>['db'];

interface RunsQueueLike {
  getWaitingCount: () => Promise<number>;
  add: (name: 'run', data: AgentRunJob, opts: { jobId: string }) => Promise<unknown>;
}

export interface ScheduleTriggerJobLike {
  data: ScheduleTriggerJob;
  /** Job Scheduler 每轮写入的计划触发时刻；job.timestamp 是创建时刻，不能当触发时刻。 */
  opts: { prevMillis?: number };
  updateData: (data: ScheduleTriggerJob) => Promise<void>;
}

type ScheduleTriggerOutcome = 'fired' | 'skipped' | 'duplicate' | 'failed';

interface ScheduleScheduler {
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

async function failScheduleRun(
  db: Db,
  runId: string,
  error: string,
  errorKind: Extract<RunErrorKind, 'agent' | 'infra'>,
) {
  return (
    (await repo.runs.failUnstartedRun(db, runId, {
      error,
      errorKind,
      includeNeverStarted: errorKind === 'agent',
    })) !== undefined
  );
}

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
  if (await failScheduleRun(db, job.runId, '定时任务入队失败', 'infra')) {
    await repo.notifications
      .createScheduleFailedNotification(db, {
        businessId: schedule.createdBy,
        scheduleId: schedule.id,
        runId: job.runId,
        title: '定时任务触发失败',
        body: `定时任务「${schedule.name}」未能启动运行，请打开定时任务查看`,
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

  const existing = data.runId === undefined ? null : await repo.chat.getRun(input.db, data.runId);
  const retryingFailed = repo.runPredicates.isNeverStartedFailure(existing);
  if (existing !== null && existing.status !== 'queued' && !retryingFailed) return 'duplicate';

  const missed = Date.now() - triggerAt > TRIGGER_MISSED_GRACE_MS;
  if (existing === null) {
    if (schedule.lastRunAt !== null && triggerAt < schedule.lastRunAt.getTime()) return 'duplicate';
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
  }

  let originalPrompt = schedule.prompt;
  if (existing !== null) {
    const message = await repo.chat.getLastUserMessage(input.db, existing.conversationId);
    const storedPrompt =
      message?.runId === existing.id ? repo.chat.messageText(message.content) : null;
    if (storedPrompt === null) {
      await failScheduleRun(input.db, existing.id, '定时任务运行正文不存在', 'agent');
      await audit(input.db, input.logger, 'schedule.skipped', schedule.id, 'ok', {
        reason: 'missing_run_prompt',
        runId: existing.id,
      });
      return 'skipped';
    }
    originalPrompt = storedPrompt;
  }
  const prompt = await checkRunPromptPolicy(input.db, {
    agentId: schedule.agentId,
    prompt: originalPrompt,
    sourceId: `schedule:${schedule.id}`,
    subject: { kind: 'agent', id: schedule.agentId },
  });
  if (prompt === null) {
    if (existing !== null) {
      await failScheduleRun(input.db, existing.id, '定时任务正文命中安全策略', 'agent');
    }
    await audit(input.db, input.logger, 'schedule.skipped', schedule.id, 'ok', {
      reason: 'content_policy',
      agentId: schedule.agentId,
    });
    return 'skipped';
  }

  if (existing !== null) {
    if (retryingFailed || prompt !== originalPrompt) {
      const ready = await input.db.transaction(async (tx) => {
        if (retryingFailed) {
          const requeued = await tx
            .update(schema.agentRuns)
            .set({ status: 'queued', endedAt: null, error: null, errorKind: null })
            .where(
              and(
                eq(schema.agentRuns.id, existing.id),
                repo.runPredicates.neverStartedFailureFilter(),
              ),
            )
            .returning({ id: schema.agentRuns.id });
          if (requeued.length !== 1) return false;
        }
        if (prompt !== originalPrompt) {
          return repo.chat.updateRunUserMessageText(tx, existing.id, prompt);
        }
        return true;
      });
      if (!ready) return 'duplicate';
    }
    const enqueued = await enqueueRun(
      input.db,
      input.logger,
      input.runsQueue,
      {
        runId: existing.id,
        agentId: existing.agentId,
        conversationId: existing.conversationId,
        prompt,
      },
      schedule,
    );
    return enqueued ? 'fired' : 'failed';
  }

  const runId = data.runId ?? newId('run');
  const conversationId = data.conversationId ?? newId('conversation');
  const messageId = data.messageId ?? newId('message');
  await job.updateData({ ...data, runId, conversationId, messageId });

  const claim = await repo.ops.claimScheduleTrigger(input.db, {
    scheduleId: data.scheduleId,
    runId,
    conversationId,
    messageId,
    prompt,
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
      prompt,
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
  reconcileMs: number;
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

  const stopTicker = startIntervalTicker(() => sync(), input.reconcileMs);

  return {
    sync,
    close: async () => {
      await stopTicker();
      await worker.close();
      await runsQueue.close();
      await queue.close();
      await connection.quit();
    },
  };
}
