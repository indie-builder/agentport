import { buildSkillDraft } from '@agentport/core';
import { repo } from '@agentport/db';
import { idParams, runDetailSchema, runListSchema, runStatusSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

const runsRepo = repo.runs;

const listQuery = z.object({
  agentId: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  trigger: z.enum(['chat', 'mcp', 'schedule', 'event']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const exportQuerySchema = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** 列表与导出共用同一形状：只暴露 RunListItem，不含 steps/messages。 */
function toItem(run: Awaited<ReturnType<typeof runsRepo.listRuns>>[number]) {
  return { ...run, startedAt: toIso(run.startedAt), endedAt: toIso(run.endedAt) };
}

/** 运行列表 + trace 详情。数据来源于 agent_runs 与 messages。 */
export function registerRunRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/runs',
    { ...auth, schema: { querystring: listQuery, response: { 200: runListSchema } } },
    async (request) => {
      const { agentId, status, trigger, limit } = request.query;
      const items = await runsRepo.listRuns(app.db, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        limit,
      });

      return { items: items.map(toItem) };
    },
  );

  /** 导出完整列表；超限明确 409，绝不把截断后的结果当完整导出发出。 */
  app.get(
    '/api/runs/export',
    { ...auth, schema: { querystring: exportQuerySchema } },
    async (request, reply) => {
      const { agentId, status, trigger, limit } = request.query;
      const items = await runsRepo.listRuns(app.db, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        limit: limit + 1,
      });
      if (items.length > limit) {
        return reject(
          reply,
          'CONFLICT',
          `运行记录超过 ${limit} 条，请先按智能体或状态缩小范围后再导出`,
        );
      }
      return reply
        .header('content-disposition', 'attachment; filename="runs.json"')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .type('application/json')
        .send(
          JSON.stringify({
            format: 'agentport/runs@1',
            exportedAt: new Date().toISOString(),
            items: items.map(toItem),
          }),
        );
    },
  );

  app.get(
    '/api/runs/:id',
    { ...auth, schema: { params: idParams, response: { 200: runDetailSchema } } },
    async (request, reply) => {
      const detail = await runsRepo.getRunDetail(app.db, request.params.id);
      if (!detail)
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新运行列表');

      return {
        run: {
          ...detail.run,
          startedAt: toIso(detail.run.startedAt),
          endedAt: toIso(detail.run.endedAt),
        },
        steps: detail.steps,
        conversation: detail.conversation,
      };
    },
  );

  /** 结构化审批请求：pending 由 MCP 端点写入，批准后 approvedAt 非空。 */
  app.get(
    '/api/runs/:id/approvals',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
      if (!agentId) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新运行列表');
      }
      const rows = await runsRepo.listApprovalRequests(app.db, request.params.id);
      // 一次取时钟，避免同一响应里的行用不同“现在”判断。
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
          // 没有截止时间（立即拒绝）的请求不等待：批准后需模型重新发起。
          waiting:
            row.approvedAt === null && row.expiresAt !== null && row.expiresAt.getTime() > now,
        })),
      };
    },
  );

  /**
   * 批准必须对应一条已存在的 (run, server, tool) 请求：
   * 既防止 typo，也防止把别的 server 的批准挪用到本 run。
   */
  app.post(
    '/api/runs/:id/approve',
    {
      ...auth,
      schema: {
        params: idParams,
        body: z.object({ serverId: z.string().min(1), toolName: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const { serverId, toolName } = request.body;
      const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
      if (!agentId) {
        return reject(reply, 'RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新运行列表');
      }
      const approved = await runsRepo.approveTool(app.db, request.params.id, serverId, toolName);
      if (!approved) {
        return reject(
          reply,
          'APPROVAL_NOT_FOUND',
          '这次工具调用没有待批准记录；它可能已批准或已失效，请刷新后重试',
        );
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'agent.run.approved',
        target: request.params.id,
        input: { serverId: approved.serverId, toolName: approved.toolName },
        status: 'ok',
        requestId: request.id,
      });
      return {
        serverId: approved.serverId,
        toolName: approved.toolName,
        approvedAt: approved.approvedAt.toISOString(),
        waiting: approved.waiting,
      };
    },
  );

  // 「录制学习」：把一个已完成的运行沉淀成技能草稿。只生成草稿并落库为技能（不自动绑定到专家）。
  app.post(
    '/api/runs/:id/skill-draft',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const detail = await runsRepo.getRunDetail(app.db, request.params.id);
      if (!detail) return reject(reply, 'NOT_FOUND', '运行不存在，可能已被删除');
      const steps = detail.steps.map((s) =>
        s.kind === 'tool'
          ? { kind: 'tool' as const, name: s.name }
          : { kind: s.kind, text: s.text },
      );
      const draft = buildSkillDraft({
        agentName: detail.run.agentName ?? '专家',
        runId: detail.run.id,
        steps,
      });
      try {
        const row = await repo.skills.createSkill(app.db, draft);
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'skill.created',
          target: row.id,
          input: { fromRun: detail.run.id, slug: row.slug },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send({
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        });
      } catch (err) {
        if (isPgCode(err, '23505'))
          return reject(reply, 'CONFLICT', '同名技能已存在，请先重命名或删除后重试');
        throw err;
      }
    },
  );
}
