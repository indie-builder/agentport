import { runsContract } from '@agentport/contract/runs';
import { buildSkillDraft, fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { runStatusSchema, runTriggerSchema } from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { z } from 'zod';
import { accessFilter, actorOf } from '../../http/access.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { authorizeRun, RUN_MISSING } from './access.js';
import { runsQuestionsRouter } from './questions.js';

const runsRepo = repo.runs;
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
function toItem(run: Awaited<ReturnType<typeof runsRepo.listRuns>>[number]) {
  return { ...run, startedAt: toIso(run.startedAt), endedAt: toIso(run.endedAt) };
}
const os = implement(runsContract).$context<RequestContext>();
export const runsMainRouter = {
  list: os.list.handler(async ({ input, context }) => {
    const { agentId, status, trigger, limit } = input.query;
    const items = await runsRepo.listRuns(context.db, {
      ...(agentId === undefined ? {} : { agentId }),
      ...(status === undefined ? {} : { status }),
      ...(trigger === undefined ? {} : { trigger }),
      limit,
      access: accessFilter(context, 'runs.read'),
    });
    return { items: items.map(toItem) };
  }),
  detail: os.detail.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const detail = await runsRepo.getRunDetail(context.db, input.params.id);
    if (!detail) return fail('RUN_NOT_FOUND', RUN_MISSING);
    return {
      run: {
        ...detail.run,
        startedAt: toIso(detail.run.startedAt),
        endedAt: toIso(detail.run.endedAt),
      },
      steps: detail.steps,
      conversation: detail.conversation,
    };
  }),
  approvals: os.approvals.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const rows = await runsRepo.listApprovalRequests(context.db, input.params.id);
    const now = Date.now();
    return {
      items: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        serverName: row.serverName,
        toolName: row.toolName,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
        expiresAt: toIso(row.expiresAt),
        waiting: row.approvedAt === null && row.expiresAt !== null && row.expiresAt.getTime() > now,
      })),
    };
  }),
  approve: os.approve.handler(async ({ input, context }) => {
    const { serverId, toolName } = input.body;
    await authorizeRun(context, input.params.id, 'runs.approve');
    const approved = await runsRepo.approveTool(context.db, input.params.id, serverId, toolName);
    if (!approved) {
      return fail(
        'APPROVAL_NOT_FOUND',
        '这次工具调用没有待批准记录；它可能已批准或已失效，请刷新后重试',
      );
    }
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'agent.run.approved',
      target: input.params.id,
      input: { serverId: approved.serverId, toolName: approved.toolName },
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      serverId: approved.serverId,
      toolName: approved.toolName,
      approvedAt: approved.approvedAt.toISOString(),
      waiting: approved.waiting,
    };
  }),
  skillDraft: os.skillDraft.handler(async ({ input, context }) => {
    await authorizeRun(context, input.params.id, 'runs.read');
    const detail = await runsRepo.getRunDetail(context.db, input.params.id);
    if (!detail) return fail('NOT_FOUND', '运行不存在，可能已被删除');
    const steps = detail.steps.map((s) =>
      s.kind === 'tool' ? { kind: 'tool' as const, name: s.name } : { kind: s.kind, text: s.text },
    );
    const draft = buildSkillDraft({
      agentName: detail.run.agentName ?? '专家',
      runId: detail.run.id,
      steps,
    });
    try {
      const row = await repo.skills.createSkill(context.db, draft);
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'skill.created',
        target: row.id,
        input: { fromRun: detail.run.id, slug: row.slug },
        status: 'ok',
        requestId: context.requestId,
      });
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        body: row.body,
        sourceId: row.sourceId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    } catch (err) {
      if (isPgCode(err, '23505')) return fail('CONFLICT', '同名技能已存在，请先重命名或删除后重试');
      throw err;
    }
  }),
};
export const runExportQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  trigger: runTriggerSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

export function registerRunExportHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/runs/export',
    access({ kind: 'permission', permissionId: 'runs.export' }),
    async (c) => {
      const context = requestContext(c);
      const input = z
        .object({
          query: runExportQuerySchema,
        })
        .parse({ params: c.req.param(), query: c.req.query() });
      const { agentId, status, trigger, limit } = input.query;
      const items = await runsRepo.listRuns(context.db, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        limit: limit + 1,
        access: accessFilter(context, 'runs.export'),
      });
      if (items.length > limit) {
        return fail('CONFLICT', `运行记录超过 ${limit} 条，请先按智能体或状态缩小范围后再导出`);
      }
      c.header('content-disposition', 'attachment; filename="runs.json"');
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
      c.header('Content-Type', 'application/json');
      return c.body(
        JSON.stringify({
          format: 'agentport/runs@1',
          exportedAt: new Date().toISOString(),
          items: items.map(toItem),
        }),
      );
    },
  );
}

export const runsRouter = { ...runsMainRouter, ...runsQuestionsRouter };
