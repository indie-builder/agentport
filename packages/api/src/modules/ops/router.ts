import { opsContract } from '@agentport/contract/ops';
import { fail, notFound } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  describeScheduleCron,
  RETENTION_DEFAULTS,
  type ScheduleTriggerJob,
  scheduleTriggerArgs,
  utcWindowStart,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { accessFilter, authorizeObject, requireUser } from '../../http/access.js';
import { actorOf, type RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../lib/cron.js';
import { toIso } from '../../lib/iso.js';
import { getScheduleQueue } from '../../queue/schedule.js';
import { enqueueRunOrRollback } from '../runs/enqueue.js';
import { enforceContentPolicy } from '../security/policy-gate.js';

async function upsertScheduler(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'upsertJobScheduler'>,
  schedule: { id: string; cron: string; timezone: string },
): Promise<void> {
  await queueLike.upsertJobScheduler(
    ...scheduleTriggerArgs(schedule.id, schedule.cron, schedule.timezone),
  );
}

async function schedulerNextRun(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'getJobScheduler'>,
  scheduleId: string,
): Promise<string | null> {
  const entry = await queueLike.getJobScheduler(scheduleId);
  return entry?.next === undefined ? null : new Date(entry.next).toISOString();
}

const os = implement(opsContract).$context<RequestContext>();
const opsRepo = repo.ops;

type ScheduleLike = Awaited<ReturnType<typeof opsRepo.createSchedule>> & {
  agentName?: string | null;
};

function toSchedule(row: ScheduleLike, nextDueAt: string | null = null) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName ?? null,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    missedPolicy: row.missedPolicy,
    description: describeScheduleCron(row.cron),
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: toIso(row.lastRunAt),
    nextDueAt,
    createdAt: toIso(row.createdAt) ?? '',
    updatedAt: toIso(row.updatedAt) ?? '',
  };
}

function toScheduleRun(row: NonNullable<Awaited<ReturnType<typeof opsRepo.getScheduleRun>>>) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
  };
}

function assertSchedulableCron(cron: string, timezone: string): void {
  if (!isSchedulableCron(cron, timezone)) {
    fail('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/cron' });
  }
}

async function reportScheduleSyncFailure(
  context: RequestContext,
  scheduleId: string,
  err: unknown,
): Promise<void> {
  context.log.warn({ err, scheduleId }, 'schedule sync failed');
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: 'schedule.sync_failed',
    target: scheduleId,
    status: 'error',
    requestId: context.requestId,
  });
}

const SCHEDULE_NOT_FOUND = '定时任务不存在';
const SCHEDULE_AGENT_MISSING = '智能体不存在，无法创建定时任务';

async function requireSchedule(context: RequestContext, id: string, manage: boolean) {
  const schedule = await opsRepo.getSchedule(context.db, id);
  if (!schedule) fail('NOT_FOUND', SCHEDULE_NOT_FOUND);
  await authorizeObject(
    context,
    'schedules.read',
    { agentId: schedule.agentId },
    SCHEDULE_NOT_FOUND,
  );
  if (manage) {
    await authorizeObject(
      context,
      'schedules.manage',
      { agentId: schedule.agentId },
      SCHEDULE_NOT_FOUND,
    );
  }
  return schedule;
}

export const opsRouter = os.router({
  attention: os.attention.handler(async ({ context }) => {
    const [approvals, failed] = await Promise.all([
      opsRepo.listPendingApprovals(context.db),
      opsRepo.listRecentFailedRuns(context.db, 20),
    ]);
    const approvalItems = approvals.map((a) => ({
      kind: 'approval' as const,
      runId: a.runId,
      agentId: a.agentId,
      agentName: a.agentName,
      serverId: a.serverId,
      toolName: a.toolName,
      createdAt: toIso(a.createdAt) ?? '',
      expiresAt: toIso(a.expiresAt),
    }));
    const failedItems = failed.map((f) => ({
      kind: 'failed_run' as const,
      runId: f.runId,
      agentId: f.agentId,
      agentName: f.agentName,
      error: f.error,
      endedAt: toIso(f.endedAt),
    }));
    return {
      approvals: approvalItems,
      failedRuns: failedItems,
      total: approvalItems.length + failedItems.length,
    };
  }),

  retention: os.retention.handler(async ({ context }) => {
    const row = await opsRepo.getRetentionSettings(context.db);
    return row
      ? {
          runDays: row.runDays,
          messageDays: row.messageDays,
          agentVersions: row.agentVersions,
          updatedAt: toIso(row.updatedAt),
          updatedBy: row.updatedBy,
        }
      : { ...RETENTION_DEFAULTS, updatedAt: null, updatedBy: null };
  }),

  updateRetention: os.updateRetention.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const row = await opsRepo.upsertRetentionSettings(context.db, input.body, principal.businessId);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'ops.retention.updated',
      target: 'retention',
      input: input.body,
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      runDays: row.runDays,
      messageDays: row.messageDays,
      agentVersions: row.agentVersions,
      updatedAt: toIso(row.updatedAt),
      updatedBy: row.updatedBy,
    };
  }),

  schedules: {
    list: os.schedules.list.handler(async ({ input, context }) => {
      const page = requireCursorPage(
        await opsRepo.listSchedules(context.db, {
          access: accessFilter(context, 'schedules.read'),
          ...cursorOption(input.query.cursor),
          limit: input.query.limit,
        }),
      );
      const queue = getScheduleQueue(context.config.REDIS_URL, context.config.NODE_ENV);
      return {
        items: await Promise.all(
          page.items.map(async (row) => toSchedule(row, await schedulerNextRun(queue, row.id))),
        ),
        nextCursor: page.nextCursor,
      };
    }),
    create: os.schedules.create.handler(async ({ input, context }) => {
      assertSchedulableCron(input.body.cron, input.body.timezone);
      const [agent] = await context.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, input.body.agentId))
        .limit(1);
      if (!agent) notFound('agent', SCHEDULE_AGENT_MISSING);
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: agent.id },
        SCHEDULE_AGENT_MISSING,
      );
      await authorizeObject(
        context,
        'schedules.manage',
        { agentId: agent.id },
        SCHEDULE_AGENT_MISSING,
      );
      const businessId = requireUser(context).businessId;
      const row = await opsRepo.createSchedule(context.db, {
        ...input.body,
        createdBy: businessId,
        executeAsBusinessId: businessId,
      });
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'schedule.created',
        target: row.id,
        input: { agentId: row.agentId, cron: row.cron },
        status: 'ok',
        requestId: context.requestId,
      });
      let nextDueAt: string | null = null;
      if (row.enabled) {
        const queue = getScheduleQueue(context.config.REDIS_URL, context.config.NODE_ENV);
        try {
          await upsertScheduler(queue, row);
          nextDueAt = await schedulerNextRun(queue, row.id);
        } catch (err) {
          await reportScheduleSyncFailure(context, row.id, err);
        }
      }
      return toSchedule({ ...row, agentName: agent.name }, nextDueAt);
    }),
    update: os.schedules.update.handler(async ({ input, context }) => {
      const existing = await requireSchedule(context, input.params.id, true);
      assertSchedulableCron(
        input.body.cron ?? existing.cron,
        input.body.timezone ?? existing.timezone,
      );
      const patch = {
        ...(input.body.name === undefined ? {} : { name: input.body.name }),
        ...(input.body.timezone === undefined ? {} : { timezone: input.body.timezone }),
        ...(input.body.missedPolicy === undefined ? {} : { missedPolicy: input.body.missedPolicy }),
        ...(input.body.cron === undefined ? {} : { cron: input.body.cron }),
        ...(input.body.prompt === undefined ? {} : { prompt: input.body.prompt }),
        ...(input.body.enabled === undefined ? {} : { enabled: input.body.enabled }),
      };
      const row = await opsRepo.updateSchedule(
        context.db,
        input.params.id,
        patch,
        input.body.expectedUpdatedAt,
      );
      if (!row) fail('CONFLICT_STALE', '该定时任务已被修改，请刷新后重试');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'schedule.updated',
        target: row.id,
        input: Object.keys(input.body),
        status: 'ok',
        requestId: context.requestId,
      });
      const queue = getScheduleQueue(context.config.REDIS_URL, context.config.NODE_ENV);
      let nextDueAt: string | null = null;
      try {
        if (!row.enabled) {
          await queue.removeJobScheduler(row.id);
        } else {
          if (
            existing.enabled === false ||
            existing.cron !== row.cron ||
            existing.timezone !== row.timezone
          ) {
            await upsertScheduler(queue, row);
          }
          nextDueAt = await schedulerNextRun(queue, row.id);
        }
      } catch (err) {
        await reportScheduleSyncFailure(context, row.id, err);
      }
      return toSchedule(row, nextDueAt);
    }),
    runs: os.schedules.runs.handler(async ({ input, context }) => {
      const schedule = await requireSchedule(context, input.params.id, false);
      const runs = await opsRepo.listScheduleRuns(context.db, schedule.id, input.query.limit);
      return runs.map(toScheduleRun);
    }),
    retry: os.schedules.retry.handler(async ({ input, context }) => {
      const schedule = await requireSchedule(context, input.params.id, true);
      const previous = await opsRepo.getScheduleRun(context.db, schedule.id, input.params.runId);
      if (!previous) fail('NOT_FOUND', '运行记录不存在');
      if (previous.status !== 'failed' && previous.status !== 'timeout') {
        fail('CONFLICT', '仅失败或超时的运行可以重试');
      }
      if (!schedule.enabled) fail('CONFLICT', '定时任务已停用，无法重试');
      if (await opsRepo.scheduleRetryExists(context.db, previous.id)) {
        fail('CONFLICT', '任务已触发或已停用，请刷新后重试');
      }
      const policyDecision = await enforceContentPolicy({
        db: context.db,
        log: context.log,
        requestId: context.requestId,
        actor: actorOf(context),
        anthropicBaseUrl: context.config.ANTHROPIC_BASE_URL,
        agentId: schedule.agentId,
        origin: 'schedule',
        sourceKind: 'run_prompt',
        sourceId: `schedule:${schedule.id}`,
        texts: [schedule.prompt],
        payload: ([text]) => ({
          data: text,
          binding: { scheduleId: schedule.id, previousRunId: previous.id, prompt: text },
        }),
      });
      const runId = newId('run');
      const conversationId = newId('conversation');
      const claimed = await opsRepo.claimScheduleRetry(context.db, {
        scheduleId: schedule.id,
        previousRunId: previous.id,
        runId,
        conversationId,
        messageId: newId('message'),
        prompt: policyDecision.payload,
        ...(policyDecision.approvalId === null
          ? {}
          : { consumePolicyApprovalId: policyDecision.approvalId }),
      });
      if (claimed === 'agent_disabled') fail('CONFLICT', '智能体已停用，无法重试');
      if (claimed === 'budget_exceeded') fail('CONFLICT', '智能体本月预算已用尽，无法重试');
      if (claimed === 'duplicate') fail('CONFLICT', '任务已触发或已停用，请刷新后重试');
      await enqueueRunOrRollback(
        context,
        {
          runId,
          agentId: schedule.agentId,
          conversationId,
          prompt: policyDecision.payload,
        },
        {
          errorMessage: '重试入队失败，请稍后重试',
          onEnqueueError: (err) => {
            context.log.warn(
              { err, runId, scheduleId: schedule.id },
              'schedule retry enqueue failed',
            );
          },
          onRolledBack: async () => {
            await repo.notifications
              .createScheduleFailedNotification(context.db, {
                businessId: schedule.createdBy,
                scheduleId: schedule.id,
                runId,
                title: '定时任务重试失败',
                body: `定时任务「${schedule.name}」重试入队失败，请稍后重试`,
              })
              .catch((notifyErr: unknown) => {
                context.log.warn(
                  { err: notifyErr, scheduleId: schedule.id, runId },
                  'schedule notification failed',
                );
              });
            await repo.audit.writeAudit(context.db, context.log, {
              actor: actorOf(context),
              action: 'schedule.retry_failed',
              target: schedule.id,
              input: { runId, previousRunId: previous.id },
              status: 'error',
              requestId: context.requestId,
            });
          },
        },
      );
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'schedule.retried',
        target: schedule.id,
        input: { runId, previousRunId: previous.id },
        status: 'ok',
        requestId: context.requestId,
      });
      const run = await opsRepo.getScheduleRun(context.db, schedule.id, runId);
      if (!run) fail('NOT_FOUND', '运行记录不存在');
      return toScheduleRun(run);
    }),
    remove: os.schedules.remove.handler(async ({ input, context }) => {
      await requireSchedule(context, input.params.id, true);
      const removed = await opsRepo.deleteSchedule(context.db, input.params.id);
      if (!removed) fail('NOT_FOUND', SCHEDULE_NOT_FOUND);
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'schedule.deleted',
        target: input.params.id,
        status: 'ok',
        requestId: context.requestId,
      });
      try {
        await getScheduleQueue(
          context.config.REDIS_URL,
          context.config.NODE_ENV,
        ).removeJobScheduler(input.params.id);
      } catch (err) {
        await reportScheduleSyncFailure(context, input.params.id, err);
      }
      return undefined;
    }),
  },

  agentStats: os.agentStats.handler(async ({ input, context }) => {
    const [agent] = await context.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, input.params.id))
      .limit(1);
    if (!agent) fail('NOT_FOUND', '智能体不存在');
    await authorizeObject(context, 'agents.read', { agentId: agent.id }, '智能体不存在');
    const since = utcWindowStart(input.query.days);
    const { agg, daily } = await opsRepo.agentStats(context.db, input.params.id, since);
    return {
      agentId: input.params.id,
      runCount: agg.runCount,
      running: agg.running,
      failed: agg.failed,
      succeeded: agg.succeeded,
      totalCost: agg.totalCost,
      totalTokens: agg.totalTokens,
      errorRate: agg.runCount > 0 ? agg.failed / agg.runCount : 0,
      latencyP50: agg.latencyP50 === null ? null : Math.round(Number(agg.latencyP50)),
      latencyP99: agg.latencyP99 === null ? null : Math.round(Number(agg.latencyP99)),
      lastRunStartTime: toIso(agg.lastRunStartTime),
      daily: daily.map((d) => ({ day: d.day, runs: d.runs, cost: d.cost })),
    };
  }),
});
