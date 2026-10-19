import { repo, type schema } from '@agentport/db';
import type { FastifyInstance } from 'fastify';

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
}
