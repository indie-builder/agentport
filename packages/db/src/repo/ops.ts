import { nextCronRun } from '@agentport/core';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentRuns, agentSchedules, agents, approvalRequests } from '../schema.js';
import { notStale } from './freshness.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ScheduleRow = typeof agentSchedules.$inferSelect;

export interface ScheduleWrite {
  agentId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

/** 创建定时任务：立即算出下一次触发时间，避免刚建好要等一个周期才调度。 */
export async function createSchedule(db: Database, input: ScheduleWrite): Promise<ScheduleRow> {
  const nextDueAt = input.enabled ? nextCronRun(input.cron) : null;
  const [row] = await db
    .insert(agentSchedules)
    .values({ id: newId('schedule'), ...input, nextDueAt })
    .returning();
  if (!row) throw new Error('schedule insert returned no row');
  return row;
}

export async function listSchedules(
  db: Database,
): Promise<Array<ScheduleRow & { agentName: string | null }>> {
  return db
    .select({ ...getTableColumns(agentSchedules), agentName: agents.name })
    .from(agentSchedules)
    .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
    .orderBy(desc(agentSchedules.createdAt));
}

export async function getSchedule(db: Database | Tx, id: string): Promise<ScheduleRow | null> {
  const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).limit(1);
  return row ?? null;
}

/** 更新：cron 或 enabled 变化时重算 nextDueAt；带乐观锁。 */
export async function updateSchedule(
  db: Database,
  id: string,
  patch: Partial<Omit<ScheduleWrite, 'agentId'>>,
  expectedUpdatedAt?: string,
): Promise<ScheduleRow | null> {
  const current = await getSchedule(db, id);
  if (!current) return null;
  const enabled = patch.enabled ?? current.enabled;
  const cron = patch.cron ?? current.cron;
  const timesChanged = patch.cron !== undefined || patch.enabled !== undefined;
  const nextDueAt = timesChanged ? (enabled ? nextCronRun(cron) : null) : current.nextDueAt;
  const [row] = await db
    .update(agentSchedules)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.cron === undefined ? {} : { cron: patch.cron }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      nextDueAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentSchedules.id, id),
        ...(expectedUpdatedAt === undefined
          ? []
          : [notStale(agentSchedules.updatedAt, new Date(expectedUpdatedAt))]),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteSchedule(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(agentSchedules).where(eq(agentSchedules.id, id)).returning({
    id: agentSchedules.id,
  });
  return rows.length > 0;
}

/**
 * 领取到期的定时任务：条件更新 nextDueAt 并写入 lastRunAt，只有一个调度者能拿到。
 * 返回被领取的快照（agentId/prompt），调用方据此起一次运行。
 */
export async function claimDueSchedules(db: Database): Promise<ScheduleRow[]> {
  const now = new Date();
  const due = await db
    .select()
    .from(agentSchedules)
    .where(and(eq(agentSchedules.enabled, true), sql`${agentSchedules.nextDueAt} <= ${now}`));
  const claimed: ScheduleRow[] = [];
  for (const row of due) {
    const nextDueAt = nextCronRun(row.cron, now);
    const updated = await db
      .update(agentSchedules)
      .set({ lastRunAt: now, nextDueAt })
      .where(
        and(
          eq(agentSchedules.id, row.id),
          eq(agentSchedules.enabled, true),
          sql`${agentSchedules.nextDueAt} <= ${now}`,
        ),
      )
      .returning();
    if (updated[0]) claimed.push(updated[0]);
  }
  return claimed;
}

/** 需要人处理的待批工具调用：未批准且未过期。 */
export async function listPendingApprovals(db: Database) {
  return db
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
        isNull(approvalRequests.approvedAt),
        sql`(${approvalRequests.expiresAt} is null or ${approvalRequests.expiresAt} > now())`,
        inArray(agentRuns.status, ['queued', 'running']),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt));
}

/** 近期失败的运行（用于待办列表）。 */
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
    .where(inArray(agentRuns.status, ['failed', 'timeout']))
    .orderBy(desc(agentRuns.endedAt))
    .limit(limit);
}

/** 任务看板汇总：按 status 与 trigger 统计窗口内的运行。 */
export async function boardSummary(db: Database, since: Date) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      running: sql<number>`count(*) filter (where ${agentRuns.status} = 'running')::int`,
      needsAction: sql<number>`count(*) filter (where ${agentRuns.status} in ('failed','timeout'))::int`,
      finished: sql<number>`count(*) filter (where ${agentRuns.status} in ('succeeded'))::int`,
      chat: sql<number>`count(*) filter (where ${agentRuns.trigger} = 'chat')::int`,
      mcp: sql<number>`count(*) filter (where ${agentRuns.trigger} = 'mcp')::int`,
      schedule: sql<number>`count(*) filter (where ${agentRuns.trigger} = 'schedule')::int`,
      event: sql<number>`count(*) filter (where ${agentRuns.trigger} = 'event')::int`,
    })
    .from(agentRuns)
    .where(sql`${agentRuns.createdAt} >= ${since}`);
  return (
    row ?? {
      total: 0,
      running: 0,
      needsAction: 0,
      finished: 0,
      chat: 0,
      mcp: 0,
      schedule: 0,
      event: 0,
    }
  );
}

/** 单个智能体的运行统计（含按天分布，供热力图/工龄页）。 */
export async function agentStats(db: Database, agentId: string, since: Date) {
  const [[agg], daily] = await Promise.all([
    db
      .select({
        runCount: sql<number>`count(*)::int`,
        running: sql<number>`count(*) filter (where ${agentRuns.status} = 'running')::int`,
        failed: sql<number>`count(*) filter (where ${agentRuns.status} in ('failed','timeout'))::int`,
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
      .where(and(eq(agentRuns.agentId, agentId), sql`${agentRuns.createdAt} >= ${since}`)),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${agentRuns.createdAt}), 'YYYY-MM-DD')`,
        runs: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), sql`${agentRuns.createdAt} >= ${since}`))
      .groupBy(sql`date_trunc('day', ${agentRuns.createdAt})`)
      .orderBy(sql`date_trunc('day', ${agentRuns.createdAt})`),
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
