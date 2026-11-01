import { schema } from '@agentport/db';
import { overviewSchema, overviewTimeseriesSchema, utcWindowStart } from '@agentport/shared';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typed } from '../../types.js';
import { accessFilter } from '../access.js';

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

  app.get(
    '/api/overview',
    {
      config: { access: { kind: 'permission', permissionId: 'overview.read' } },
      schema: {
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(3650).default(7),
        }),
        response: { 200: overviewSchema },
      },
    },
    async (request) => {
      const { days } = request.query;
      const since = utcWindowStart(days);
      const access = accessFilter(request, 'overview.read');
      // O 只统计本人发起/创建的记录；全局资源（servers）不在本人数据范围。
      const ownOnly = !access.scopes.includes('platform');
      const runScope = ownOnly ? eq(schema.agentRuns.initiatedBy, access.businessId) : undefined;
      const agentScope = ownOnly ? eq(schema.agents.createdBy, access.businessId) : undefined;

      const inWindow = sql`${schema.agentRuns.startedAt} >= ${since}`;
      const runWindow =
        runScope === undefined
          ? or(inWindow, eq(schema.agentRuns.status, 'running'))
          : and(or(inWindow, eq(schema.agentRuns.status, 'running')), runScope);
      const [[runAgg], agentRows, recent] = await Promise.all([
        app.db
          .select({
            // 知识库连接器由知识库生命周期管理，与 /api/servers 列表同一口径。
            servers: ownOnly
              ? sql<number>`0::int`
              : sql<number>`(select count(*)::int from ${schema.servers} where ${schema.servers.kind} <> 'knowledge')`,
            agents: ownOnly
              ? sql<number>`(select count(*)::int from ${schema.agents} where ${schema.agents.createdBy} = ${access.businessId})`
              : sql<number>`(select count(*)::int from ${schema.agents})`,
            running: sql<number>`count(*) filter (where ${schema.agentRuns.status} = 'running')::int`,
            total: sql<number>`count(*) filter (where ${inWindow})::int`,
            failed: sql<number>`count(*) filter (where ${inWindow} and ${schema.agentRuns.status} in ('failed','timeout'))::int`,
            tokens: sql<number>`coalesce(sum(coalesce(${schema.agentRuns.inputTokens},0)::bigint + coalesce(${schema.agentRuns.outputTokens},0)::bigint) filter (where ${inWindow}), 0)::float8`,
            cost: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}) filter (where ${inWindow}), 0)::float`,
            avgLatency: sql<
              string | null
            >`avg(${schema.agentRuns.latencyMs}) filter (where ${inWindow})`,
          })
          .from(schema.agentRuns)
          .where(runWindow),
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
            totalTokens: sql<number>`coalesce(sum(coalesce(${schema.agentRuns.inputTokens},0)::bigint + coalesce(${schema.agentRuns.outputTokens},0)::bigint), 0)::float8`,
          })
          .from(schema.agents)
          .leftJoin(
            schema.agentRuns,
            and(
              eq(schema.agentRuns.agentId, schema.agents.id),
              sql`${schema.agentRuns.startedAt} >= ${since}`,
              // 运行范围必须进 JOIN：放进 WHERE 会把没有本人运行的专家整行过滤掉。
              runScope,
            ),
          )
          .where(agentScope)
          .groupBy(schema.agents.id)
          .orderBy(desc(sql`max(${schema.agentRuns.startedAt})`)),
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
          .where(runScope)
          .orderBy(desc(schema.agentRuns.startedAt))
          .limit(20),
      ]);

      return {
        window: { days, since: since.toISOString() },
        counts: {
          servers: runAgg?.servers ?? 0,
          agents: runAgg?.agents ?? 0,
          runs: Number(runAgg?.total ?? 0),
          running: runAgg?.running ?? 0,
          failed: Number(runAgg?.failed ?? 0),
          tokens: Number(runAgg?.tokens ?? 0),
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

  // 运行趋势：单条查询用 generate_series 补齐没有运行的日期，避免前端补洞。
  app.get(
    '/api/overview/timeseries',
    {
      config: { access: { kind: 'permission', permissionId: 'overview.read' } },
      schema: {
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(3650).default(7),
        }),
        response: { 200: overviewTimeseriesSchema },
      },
    },
    async (request) => {
      const { days } = request.query;
      const since = utcWindowStart(days);
      const access = accessFilter(request, 'overview.read');
      const ownFilter = access.scopes.includes('platform')
        ? sql``
        : sql`and r.initiated_by = ${access.businessId}`;

      // 与 /api/overview 同一个 UTC 自然日窗口：起点 days-1 天前的 UTC 零点，恰好 N 个点。
      const result = await app.db.execute(sql`
        with days as (
          select generate_series(
            date_trunc('day', ${since}::timestamptz at time zone 'UTC'),
            date_trunc('day', now() at time zone 'UTC'),
            interval '1 day'
          ) as day
        )
        select
          to_char(d.day, 'YYYY-MM-DD') as date,
          count(r.id)::int as runs,
          count(r.id) filter (where r.status in ('failed', 'timeout'))::int as failed,
          coalesce(sum(r.cost_usd), 0)::float as "costUsd",
          coalesce(
            sum(coalesce(r.input_tokens, 0)::bigint + coalesce(r.output_tokens, 0)::bigint), 0
          )::float8 as tokens
        from days d
        left join ${schema.agentRuns} r
          on date_trunc('day', r.started_at at time zone 'UTC') = d.day
         and r.started_at >= ${since}
         ${ownFilter}
        group by d.day
        order by d.day
      `);

      return result.rows.map((row) => ({
        date: String(row.date),
        runs: Number(row.runs),
        failed: Number(row.failed),
        costUsd: Number(row.costUsd),
        tokens: Number(row.tokens),
      }));
    },
  );
}
