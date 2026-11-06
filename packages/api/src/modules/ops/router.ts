import { opsContract } from '@agentport/contract/ops';
import { fail } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import { utcWindowStart } from '@agentport/shared';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { accessFilter, actorOf, authorizeObject, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../lib/cron.js';
import {
  getScheduleQueue,
  removeScheduler,
  schedulerNextRun,
  upsertScheduler,
} from './schedule-sync.js';

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
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: iso(row.lastRunAt),
    nextDueAt,
    createdAt: iso(row.createdAt) ?? '',
    updatedAt: iso(row.updatedAt) ?? '',
  };
}

function assertSchedulableCron(cron: string | undefined): void {
  if (cron !== undefined && !isSchedulableCron(cron)) {
    fail('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/cron' });
  }
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

  schedules: {
    list: os.schedules.list.handler(async ({ context }) => {
      const rows = await opsRepo.listSchedules(context.db, accessFilter(context, 'schedules.read'));
      const queue = getScheduleQueue(context.config.REDIS_URL);
      return Promise.all(
        rows.map(async (row) => toSchedule(row, await schedulerNextRun(queue, row.id))),
      );
    }),
    create: os.schedules.create.handler(async ({ input, context }) => {
      assertSchedulableCron(input.body.cron);
      const [agent] = await context.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, input.body.agentId))
        .limit(1);
      if (!agent) fail('AGENT_NOT_FOUND', '智能体不存在，无法创建定时任务');
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
          context.log.warn({ err, scheduleId: row.id }, 'schedule sync failed');
          await repo.audit.writeAudit(context.db, context.log, {
            actor: actorOf(context),
            action: 'schedule.sync_failed',
            target: row.id,
            status: 'error',
            requestId: context.requestId,
          });
        }
      }
      return toSchedule({ ...row, agentName: agent.name }, nextDueAt);
    }),
    update: os.schedules.update.handler(async ({ input, context }) => {
      assertSchedulableCron(input.body.cron);
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
      const patch = {
        ...(input.body.name === undefined ? {} : { name: input.body.name }),
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
          if (existing.enabled === false || existing.cron !== row.cron) {
            await upsertScheduler(queue, row);
          }
          nextDueAt = await schedulerNextRun(queue, row.id);
        }
      } catch (err) {
        context.log.warn({ err, scheduleId: row.id }, 'schedule sync failed');
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'schedule.sync_failed',
          target: row.id,
          status: 'error',
          requestId: context.requestId,
        });
      }
      return toSchedule(row, nextDueAt);
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
        context.log.warn({ err, scheduleId: input.params.id }, 'schedule sync failed');
        await repo.audit.writeAudit(context.db, context.log, {
          actor: actorOf(context),
          action: 'schedule.sync_failed',
          target: input.params.id,
          status: 'error',
          requestId: context.requestId,
        });
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
