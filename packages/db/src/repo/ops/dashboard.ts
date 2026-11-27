import { ACTIVE_RUN_STATUSES, FAILED_RUN_STATUSES } from '@agentport/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { agentRuns, agents, approvalRequests } from '../../schema.js';

export async function listPendingApprovals(db: Database) {
  const rows = await db
    .select({
      runId: approvalRequests.runId,
      agentId: agentRuns.agentId,
      agentName: agents.name,
      serverId: approvalRequests.serverId,
      toolName: approvalRequests.toolName,
      createdAt: approvalRequests.createdAt,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .innerJoin(agentRuns, eq(agentRuns.id, approvalRequests.runId))
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(
      and(
        isNotNull(approvalRequests.runId),
        isNotNull(approvalRequests.decisionHash),
        isNull(approvalRequests.supersededAt),
        isNull(approvalRequests.approvedAt),
        isNull(approvalRequests.deniedAt),
        sql`(${approvalRequests.expiresAt} is null or ${approvalRequests.expiresAt} > now())`,
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt));
  return rows.flatMap((row) => (row.runId === null ? [] : [{ ...row, runId: row.runId }]));
}

export async function listRecentFailedRuns(db: Database, limit = 20) {
  return db
    .select({
      runId: agentRuns.id,
      agentId: agentRuns.agentId,
      agentName: agents.name,
      error: agentRuns.error,
      endedAt: agentRuns.endedAt,
    })
    .from(agentRuns)
    .leftJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(inArray(agentRuns.status, [...FAILED_RUN_STATUSES]))
    .orderBy(desc(agentRuns.endedAt))
    .limit(limit);
}

export async function agentStats(db: Database, agentId: string, since: Date) {
  const utcDay = sql`date_trunc('day', ${agentRuns.createdAt} AT TIME ZONE 'UTC')`;
  const sinceUtc = since.toISOString();
  const sinceUtcDay = sql`${agentRuns.createdAt} >= ${sinceUtc}`;
  const [[agg], daily] = await Promise.all([
    db
      .select({
        runCount: sql<number>`count(*)::int`,
        running: sql<number>`count(*) filter (where ${agentRuns.status} = 'running')::int`,
        failed: sql<number>`count(*) filter (where ${inArray(agentRuns.status, [...FAILED_RUN_STATUSES])})::int`,
        succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
        totalCost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${agentRuns.inputTokens},0)::bigint + coalesce(${agentRuns.outputTokens},0)::bigint), 0)::float8`,
        latencyP50: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${agentRuns.latencyMs})`,
        latencyP99: sql<
          number | null
        >`percentile_cont(0.99) within group (order by ${agentRuns.latencyMs})`,
        lastRunStartTime: sql<Date | null>`max(${agentRuns.startedAt})`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), sinceUtcDay)),
    db
      .select({
        day: sql<string>`to_char(${utcDay}, 'YYYY-MM-DD')`,
        runs: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), sinceUtcDay))
      .groupBy(utcDay)
      .orderBy(utcDay),
  ]);
  const aggSafe = agg ?? {
    runCount: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
    totalCost: 0,
    totalTokens: 0,
    latencyP50: null,
    latencyP99: null,
    lastRunStartTime: null,
  };
  return { agg: aggSafe, daily };
}
