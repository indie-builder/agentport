import { repo, type schema } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { typed } from '../../types.js';

const runsRepo = repo.runs;

type RunStatusFilter = NonNullable<typeof schema.agentRuns.$inferInsert.status>;

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** 运行列表 + trace 详情。数据来源于 agent_runs 与 messages。 */
export function registerRunRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/runs',
    {
      ...auth,
      schema: {
        querystring: z.object({
          agentId: z.string().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
    },
    async (request) => {
      const { agentId, status } = request.query;
      const limit = request.query.limit ?? 50;
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
  app.post(
    '/api/runs/:id/approve',
    {
      ...auth,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ serverId: z.string().min(1), toolName: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const body = { data: request.body };
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
    },
  );
}
