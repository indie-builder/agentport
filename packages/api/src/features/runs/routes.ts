import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';

const runsRepo = repo.runs;

const idParams = z.object({ id: z.string().min(1) });
const listQuery = z.object({
  agentId: z.string().min(1).optional(),
  status: z.enum(repo.runs.RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** 运行列表 + trace 详情。数据来源于 agent_runs 与 messages。 */
export function registerRunRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get('/api/runs', { ...auth, schema: { querystring: listQuery } }, async (request) => {
    const { agentId, status, limit } = request.query;
    const items = await runsRepo.listRuns(app.db, {
      ...(agentId === undefined ? {} : { agentId }),
      ...(status === undefined ? {} : { status }),
      limit,
    });

    return {
      items: items.map((run) => ({
        ...run,
        startedAt: toIso(run.startedAt),
        endedAt: toIso(run.endedAt),
      })),
    };
  });

  app.get('/api/runs/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    const detail = await runsRepo.getRunDetail(app.db, request.params.id);
    if (!detail) return reject(reply, 'RUN_NOT_FOUND', `run ${request.params.id} not found`);

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
  app.get(
    '/api/runs/:id/approvals',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const agentId = await runsRepo.getRunAgentId(app.db, request.params.id);
      if (!agentId) return reject(reply, 'RUN_NOT_FOUND', `run ${request.params.id} not found`);
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
      if (!agentId) return reject(reply, 'RUN_NOT_FOUND', `run ${request.params.id} not found`);
      const approved = await runsRepo.approveTool(app.db, request.params.id, serverId, toolName);
      if (!approved) {
        return reject(
          reply,
          'APPROVAL_NOT_FOUND',
          `no pending approval for tool ${toolName} on this server in this run`,
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
      };
    },
  );
}
