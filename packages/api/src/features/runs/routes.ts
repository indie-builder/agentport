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

  /** 单机交互的最小闭环：批准后由用户重新发消息，不恢复已结束的 run。 */
  app.post<{ Params: { id: string } }>('/api/runs/:id/approve', auth, async (request, reply) => {
    const body = z.object({ toolName: z.string().min(1) }).safeParse(request.body);
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
    // 只允许批准该智能体实际绑定、启用且标记了要求的工具，避免 typo 产生无效批准。
    const approvable = await repo.servers.listApprovableToolNames(app.db, agentId);
    if (!approvable.includes(body.data.toolName)) {
      return reply.status(404).send({
        code: 'TOOL_NOT_FOUND',
        message: `tool ${body.data.toolName} is not an approvable tool of this run's agent`,
      });
    }
    const approvals = await runsRepo.approveTool(app.db, request.params.id, body.data.toolName);
    if (!approvals) {
      return reply
        .status(404)
        .send({ code: 'RUN_NOT_FOUND', message: `run ${request.params.id} not found` });
    }
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: 'agent.run.approved',
      target: request.params.id,
      input: { toolName: body.data.toolName },
      status: 'ok',
      requestId: request.id,
    });
    return { approvals };
  });
}
