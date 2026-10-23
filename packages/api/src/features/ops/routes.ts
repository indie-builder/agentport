import { repo, schema } from '@agentport/db';
import {
  agentStatsSchema,
  attentionSchema,
  boardSummarySchema,
  scheduleInputSchema,
  schedulePatchSchema,
  scheduleSchema,
} from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import {
  getScheduleQueue,
  isSchedulableCron,
  removeScheduler,
  schedulerNextRun,
  upsertScheduler,
} from './schedule-sync.js';

const opsRepo = repo.ops;

const INVALID_CRON = 'cron 表达式无法解析或不产生触发时间';

/** 5 段之外还要真的能算出下一次触发；校验放在 schema 里，handler 不做业务 safeParse。 */
const scheduleBodySchema = scheduleInputSchema.refine((value) => isSchedulableCron(value.cron), {
  message: INVALID_CRON,
  path: ['cron'],
});

const schedulePatchBodySchema = schedulePatchSchema.refine(
  (value) => value.cron === undefined || isSchedulableCron(value.cron),
  { message: INVALID_CRON, path: ['cron'] },
);

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

const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/** 运营层：待办队列、任务看板汇总、定时任务与智能体统计。不进入智能体定义文件。 */
export function registerOpsRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  // 需要人处理：待批工具调用 + 近期失败运行。
  app.get(
    '/api/attention',
    { ...auth, schema: { response: { 200: attentionSchema } } },
    async () => {
      const [approvals, failed] = await Promise.all([
        opsRepo.listPendingApprovals(app.db),
        opsRepo.listRecentFailedRuns(app.db, 20),
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
    },
  );

  // 任务看板汇总（按状态与来源）。
  app.get(
    '/api/runs/board',
    { ...auth, schema: { querystring: daysQuery, response: { 200: boardSummarySchema } } },
    async (request) => {
      const since = new Date(Date.now() - request.query.days * 86_400_000);
      const row = await opsRepo.boardSummary(app.db, since);
      return {
        total: row.total,
        running: row.running,
        needsAction: row.needsAction,
        finished: row.finished,
        byTrigger: {
          chat: row.chat,
          mcp: row.mcp,
          schedule: row.schedule,
          event: row.event,
        },
      };
    },
  );

  app.get(
    '/api/schedules',
    { ...auth, schema: { response: { 200: z.array(scheduleSchema) } } },
    async () => {
      const rows = await opsRepo.listSchedules(app.db);
      const queue = getScheduleQueue(app.config.REDIS_URL);
      return Promise.all(
        rows.map(async (row) => toSchedule(row, await schedulerNextRun(queue, row.id))),
      );
    },
  );

  app.post(
    '/api/schedules',
    { ...auth, schema: { body: scheduleBodySchema, response: { 201: scheduleSchema } } },
    async (request, reply) => {
      const [agent] = await app.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, request.body.agentId))
        .limit(1);
      if (!agent) return reject(reply, 'AGENT_NOT_FOUND', '智能体不存在，无法创建定时任务');
      const row = await opsRepo.createSchedule(app.db, request.body);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'schedule.created',
        target: row.id,
        input: { agentId: row.agentId, cron: row.cron },
        status: 'ok',
        requestId: request.id,
      });
      // CRUD 已提交，同步失败只记审计：worker 的 reconcile 会把 scheduler 补上。
      let nextDueAt: string | null = null;
      if (row.enabled) {
        const queue = getScheduleQueue(app.config.REDIS_URL);
        try {
          await upsertScheduler(queue, row);
          nextDueAt = await schedulerNextRun(queue, row.id);
        } catch (err) {
          request.log.warn({ err, scheduleId: row.id }, 'schedule sync failed');
          await writeAudit(app.db, request.log, {
            actor: 'admin',
            action: 'schedule.sync_failed',
            target: row.id,
            status: 'error',
            requestId: request.id,
          });
        }
      }
      reply.status(201);
      return toSchedule({ ...row, agentName: agent.name }, nextDueAt);
    },
  );

  app.patch(
    '/api/schedules/:id',
    {
      ...auth,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        body: schedulePatchBodySchema,
        response: { 200: scheduleSchema },
      },
    },
    async (request, reply) => {
      const existing = await opsRepo.getSchedule(app.db, request.params.id);
      if (!existing) return reject(reply, 'NOT_FOUND', '定时任务不存在');
      const patch = {
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.cron === undefined ? {} : { cron: request.body.cron }),
        ...(request.body.prompt === undefined ? {} : { prompt: request.body.prompt }),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
      };
      const row = await opsRepo.updateSchedule(
        app.db,
        request.params.id,
        patch,
        request.body.expectedUpdatedAt,
      );
      if (!row) return reject(reply, 'CONFLICT_STALE', '该定时任务已被修改，请刷新后重试');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'schedule.updated',
        target: row.id,
        input: Object.keys(request.body),
        status: 'ok',
        requestId: request.id,
      });
      const queue = getScheduleQueue(app.config.REDIS_URL);
      let nextDueAt: string | null = null;
      try {
        if (row.enabled) {
          await upsertScheduler(queue, row);
          nextDueAt = await schedulerNextRun(queue, row.id);
        } else {
          await removeScheduler(queue, row.id);
        }
      } catch (err) {
        request.log.warn({ err, scheduleId: row.id }, 'schedule sync failed');
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'schedule.sync_failed',
          target: row.id,
          status: 'error',
          requestId: request.id,
        });
      }
      return toSchedule(row, nextDueAt);
    },
  );

  app.delete(
    '/api/schedules/:id',
    { ...auth, schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request, reply) => {
      const removed = await opsRepo.deleteSchedule(app.db, request.params.id);
      if (!removed) return reject(reply, 'NOT_FOUND', '定时任务不存在');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'schedule.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      try {
        await removeScheduler(getScheduleQueue(app.config.REDIS_URL), request.params.id);
      } catch (err) {
        request.log.warn({ err, scheduleId: request.params.id }, 'schedule sync failed');
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'schedule.sync_failed',
          target: request.params.id,
          status: 'error',
          requestId: request.id,
        });
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/agents/:id/stats',
    {
      ...auth,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        querystring: daysQuery,
        response: { 200: agentStatsSchema },
      },
    },
    async (request, reply) => {
      const [agent] = await app.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.id, request.params.id))
        .limit(1);
      if (!agent) return reject(reply, 'NOT_FOUND', '智能体不存在');
      const since = new Date(Date.now() - request.query.days * 86_400_000);
      const { agg, daily } = await opsRepo.agentStats(app.db, request.params.id, since);
      return {
        agentId: request.params.id,
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
    },
  );
}
