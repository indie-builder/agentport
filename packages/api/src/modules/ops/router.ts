import { opsContract } from '@agentport/contract/ops';
import { fail, notFound } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  describeScheduleCron,
  RETENTION_DEFAULTS,
  runEnqueueOptions,
  utcWindowStart,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { accessFilter, actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../lib/cron.js';
import { getQueue } from '../../queue/producer.js';
import { getScheduleQueue } from '../../queue/schedule.js';
import { failQueuedRunEnqueue } from '../runs/enqueue.js';
import { enforceContentPolicy } from '../security/policy-gate.js';
import { removeScheduler, schedulerNextRun, upsertScheduler } from './schedule-sync.js';

const os = implement(opsContract).$context<RequestContext>();
const opsRepo = repo.ops;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

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
    lastRunAt: iso(row.lastRunAt),
    nextDueAt,
    createdAt: iso(row.createdAt) ?? '',
    updatedAt: iso(row.updatedAt) ?? '',
  };
}

function toScheduleRun(row: NonNullable<Awaited<ReturnType<typeof opsRepo.getScheduleRun>>>) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
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
      createdAt: iso(a.createdAt) ?? '',
      expiresAt: iso(a.expiresAt),
    }));
    const failedItems = failed.map((f) => ({
      kind: 'failed_run' as const,
      runId: f.runId,
      agentId: f.agentId,
      agentName: f.agentName,
      error: f.error,
      endedAt: iso(f.endedAt),
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
          updatedAt: iso(row.updatedAt),
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
      updatedAt: iso(row.updatedAt),
      updatedBy: row.updatedBy,
    };
  }),

  schedules: {
    list: os.schedules.list.handler(async ({ context }) => {
      const rows = await opsRepo.listSchedules(context.db, accessFilter(context, 'schedules.read'));
      const queue = getScheduleQueue(context.config.REDIS_URL);
      return Promise.all(
        rows.map(async (row) => toSchedule(row, await schedulerNextRun(queue, row.id))),
      );
    }),
    create: os.schedules.create.handler(async ({ input, context }) => {
      assertSchedulableCron(input.body.cron, input.body.timezone);
      const [agent] = await context.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, input.body.agentId))
        .limit(1);
      if (!agent) notFound('agent', '智能体不存在，无法创建定时任务');
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: agent.id },
        '智能体不存在，无法创建定时任务',
      );
      await authorizeObject(
        context,
        'schedules.manage',
        { agentId: agent.id },
        '智能体不存在，无法创建定时任务',
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
        const queue = getScheduleQueue(context.config.REDIS_URL);
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
      const existing = await opsRepo.getSchedule(context.db, input.params.id);
      if (!existing) fail('NOT_FOUND', '定时任务不存在');
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: existing.agentId },
        '定时任务不存在',
      );
      await authorizeObject(
        context,
        'schedules.manage',
        { agentId: existing.agentId },
        '定时任务不存在',
      );
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
      const queue = getScheduleQueue(context.config.REDIS_URL);
      let nextDueAt: string | null = null;
      try {
        if (!row.enabled) {
          await removeScheduler(queue, row.id);
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
      const schedule = await opsRepo.getSchedule(context.db, input.params.id);
      if (!schedule) fail('NOT_FOUND', '定时任务不存在');
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: schedule.agentId },
        '定时任务不存在',
      );
      const runs = await opsRepo.listScheduleRuns(context.db, schedule.id, input.query.limit);
      return runs.map(toScheduleRun);
    }),
    retry: os.schedules.retry.handler(async ({ input, context }) => {
      const schedule = await opsRepo.getSchedule(context.db, input.params.id);
      if (!schedule) fail('NOT_FOUND', '定时任务不存在');
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: schedule.agentId },
        '定时任务不存在',
      );
      await authorizeObject(
        context,
        'schedules.manage',
        { agentId: schedule.agentId },
        '定时任务不存在',
      );
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
      try {
        await getQueue().add(
          'run',
          {
            runId,
            agentId: schedule.agentId,
            conversationId,
            prompt: policyDecision.payload,
          },
          runEnqueueOptions(runId),
        );
      } catch (err) {
        context.log.warn({ err, runId, scheduleId: schedule.id }, 'schedule retry enqueue failed');
        const failed = await failQueuedRunEnqueue(context.db, runId);
        if (failed) {
          await repo.notifications
            .createNotification(context.db, {
              businessId: schedule.createdBy,
              kind: 'schedule_failed',
              title: '定时任务重试失败',
              body: `定时任务「${schedule.name}」重试入队失败，请稍后重试`,
              link: '/schedules',
              sourceId: `schedule-failed:${schedule.id}:${runId}`,
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
        }
        fail('SERVICE_UNAVAILABLE', '重试入队失败，请稍后重试');
      }
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
      const existing = await opsRepo.getSchedule(context.db, input.params.id);
      if (!existing) fail('NOT_FOUND', '定时任务不存在');
      await authorizeObject(
        context,
        'schedules.read',
        { agentId: existing.agentId },
        '定时任务不存在',
      );
      await authorizeObject(
        context,
        'schedules.manage',
        { agentId: existing.agentId },
        '定时任务不存在',
      );
      const removed = await opsRepo.deleteSchedule(context.db, input.params.id);
      if (!removed) fail('NOT_FOUND', '定时任务不存在');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'schedule.deleted',
        target: input.params.id,
        status: 'ok',
        requestId: context.requestId,
      });
      try {
        await removeScheduler(getScheduleQueue(context.config.REDIS_URL), input.params.id);
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
      lastRunStartTime: iso(agg.lastRunStartTime as Date | null),
      daily: daily.map((d) => ({ day: d.day, runs: d.runs, cost: d.cost })),
    };
  }),
});
