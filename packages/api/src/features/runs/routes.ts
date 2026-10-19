import { repo, type schema } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';

const runsRepo = repo.runs;

type RunStatusFilter = NonNullable<typeof schema.agentRuns.$inferInsert.status>;

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** 运行列表 + trace 详情。数据来源于 agent_runs 与 messages。 */
export function registerRunRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get<{ Querystring: { agentId?: string; status?: string; limit?: string } }>(
    '/api/runs',
    auth,
    async (request) => {
      const { agentId, status } = request.query;
      const limit = Number(request.query.limit ?? 50);
      const items = await runsRepo.listRuns(app.db, {
        ...(agentId ? { agentId } : {}),
        ...(status !== undefined && (repo.runs.RUN_STATUSES as readonly string[]).includes(status)
          ? { status: status as RunStatusFilter }
          : {}),
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      });

      return {
        items: items.map((run) => ({
          ...run,
          startedAt: toIso(run.startedAt),
          endedAt: toIso(run.endedAt),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id', auth, async (request, reply) => {
    const detail = await runsRepo.getRunDetail(app.db, request.params.id);
    if (!detail) {
      return reply
        .status(404)
        .send({ code: 'RUN_NOT_FOUND', message: `run ${request.params.id} not found` });
    }

    return {
      run: {
        ...detail.run,
        startedAt: toIso(detail.run.startedAt),
        endedAt: toIso(detail.run.endedAt),
      },
      steps: detail.steps,
      conversation: detail.conversation,
    };
  });

  /** 结构化审批请求：pending 由 MCP 端点写入，批准后 approvedAt 非空。 */
  app.get<{ Params: { id: string } }>('/api/runs/:id/approvals', auth, async (request, reply) => {
    const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
    if (!agentId) {
      return reply
        .status(404)
        .send({ code: 'RUN_NOT_FOUND', message: `run ${request.params.id} not found` });
    }
    const rows = await runsRepo.listApprovalRequests(app.db, request.params.id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        serverId: row.serverId,
        serverName: row.serverName,
        toolName: row.toolName,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt === null ? null : row.approvedAt.toISOString(),
      })),
    };
  });

  /**
   * 批准必须对应一条已存在的 (run, server, tool) 请求：
   * 既防止 typo，也防止把别的 server 的批准挪用到本 run。
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/approve', auth, async (request, reply) => {
    const body = z
      .object({ serverId: z.string().min(1), toolName: z.string().min(1) })
      .safeParse(request.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ code: 'INVALID_INPUT', message: body.error.issues[0]?.message ?? 'invalid body' });
    }
    const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
    if (!agentId) {
      return reply
        .status(404)
        .send({ code: 'RUN_NOT_FOUND', message: `run ${request.params.id} not found` });
    }
    const approved = await runsRepo.approveTool(
      app.db,
      request.params.id,
      body.data.serverId,
      body.data.toolName,
    );
    if (!approved) {
      return reply.status(404).send({
        code: 'APPROVAL_NOT_FOUND',
        message: `no pending approval for tool ${body.data.toolName} on this server in this run`,
      });
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
    };
  });
}
