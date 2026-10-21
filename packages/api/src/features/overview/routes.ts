import { schema } from '@agentport/db';
import { and, avg, count, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typed } from '../../types.js';

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

/** drizzle 的 sql<Date> 在运行时可能是字符串（pg 驱动按列类型返回），统一归一。 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 智能体聚合视图：参考 LangSmith 的 agents 表。
 * 一次查询聚合，避免前端拉全量运行再算。
 */
export function registerOverviewRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/overview',
    {
      ...auth,
      schema: {
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(3650).default(7),
        }),
      },
    },
    async (request) => {
      const { days } = request.query;
      const since = daysAgo(days);

      // 三个互不依赖的查询并行：串行会把连接池占用时间乘以 3。
      const [[serverCount], [agentCount], agentRows] = await Promise.all([
        app.db.select({ value: sql<number>`count(*)::int` }).from(schema.servers),
        app.db.select({ value: sql<number>`count(*)::int` }).from(schema.agents),
        // 每个智能体的聚合指标。FILTER 子句让「失败率」与「延迟」一次扫描完成。
        app.db
          .select({
            agentId: schema.agents.id,
            name: schema.agents.name,
            slug: schema.agents.slug,
            createdAt: schema.agents.createdAt,
            enabled: schema.agents.enabled,
            lastRunStartTime: sql<Date | null>`max(${schema.agentRuns.startedAt})`,
            runCount: sql<number>`count(${schema.agentRuns.id})::int`,
            totalCost: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)::float`,
            errorRate: sql<number>`coalesce(
          count(*) filter (where ${schema.agentRuns.status} in ('failed','timeout'))::float
          / nullif(count(${schema.agentRuns.id}), 0), 0)::float`,
            latencyP50: sql<
              number | null
            >`percentile_cont(0.5) within group (order by ${schema.agentRuns.latencyMs})`,
            latencyP99: sql<
              number | null
            >`percentile_cont(0.99) within group (order by ${schema.agentRuns.latencyMs})`,
            totalTokens: sql<number>`coalesce(sum(coalesce(${schema.agentRuns.inputTokens},0) + coalesce(${schema.agentRuns.outputTokens},0)), 0)::int`,
          })
          .from(schema.agents)
          .leftJoin(
            schema.agentRuns,
            and(
              eq(schema.agentRuns.agentId, schema.agents.id),
              sql`${schema.agentRuns.startedAt} >= ${since}`,
            ),
          )
          .groupBy(schema.agents.id)
          .orderBy(desc(sql`max(${schema.agentRuns.startedAt})`)),
      ]);

      const [[runningCount], [runAgg], recent] = await Promise.all([
        app.db
          .select({ value: sql<number>`count(*)::int` })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.status, 'running')),
        app.db
          .select({
            total: count(),
            cost: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)::float`,
            avgLatency: avg(schema.agentRuns.latencyMs),
          })
          .from(schema.agentRuns)
          .where(sql`${schema.agentRuns.startedAt} >= ${since}`),
        app.db
          .select({
            id: schema.agentRuns.id,
            agentId: schema.agentRuns.agentId,
            agentName: schema.agents.name,
            status: schema.agentRuns.status,
            startedAt: schema.agentRuns.startedAt,
            endedAt: schema.agentRuns.endedAt,
            costUsd: schema.agentRuns.costUsd,
            turns: schema.agentRuns.turns,
            latencyMs: schema.agentRuns.latencyMs,
            error: schema.agentRuns.error,
          })
          .from(schema.agentRuns)
          .leftJoin(schema.agents, eq(schema.agents.id, schema.agentRuns.agentId))
          .orderBy(desc(schema.agentRuns.startedAt))
          .limit(20),
      ]);

      return {
        window: { days, since: since.toISOString() },
        counts: {
          servers: serverCount?.value ?? 0,
          agents: agentCount?.value ?? 0,
          runs: Number(runAgg?.total ?? 0),
          running: runningCount?.value ?? 0,
          costUsd: Number(runAgg?.cost ?? 0),
          avgLatencyMs: runAgg?.avgLatency === null ? null : Number(runAgg?.avgLatency ?? 0),
        },
        agents: agentRows.map((row) => ({
          ...row,
          createdAt: toIso(row.createdAt),
          lastRunStartTime: toIso(row.lastRunStartTime),
          latencyP50: row.latencyP50 === null ? null : Math.round(Number(row.latencyP50)),
          latencyP99: row.latencyP99 === null ? null : Math.round(Number(row.latencyP99)),
        })),
        recent: recent.map((row) => ({
          ...row,
          startedAt: toIso(row.startedAt),
          endedAt: toIso(row.endedAt),
        })),
      };
    },
  );
}
