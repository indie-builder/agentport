import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  agentSchedules,
  agents,
  approvalRequests,
  conversations,
  messages,
} from '../schema.js';
import { latestAgentVersion } from './agent-versions.js';
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

/** 创建定时任务；下次触发时间由 BullMQ 原生 scheduler 展示，不在库里自算。 */
export async function createSchedule(db: Database, input: ScheduleWrite): Promise<ScheduleRow> {
  const [row] = await db
    .insert(agentSchedules)
    .values({ id: newId('schedule'), ...input })
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

/** 更新：带乐观锁；调度同步由调用方在提交后完成。 */
export async function updateSchedule(
  db: Database,
  id: string,
  patch: Partial<Omit<ScheduleWrite, 'agentId'>>,
  expectedUpdatedAt?: string,
): Promise<ScheduleRow | null> {
  const [row] = await db
    .update(agentSchedules)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.cron === undefined ? {} : { cron: patch.cron }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
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

export interface ScheduleTriggerWrite {
  scheduleId: string;
  runId: string;
  conversationId: string;
  messageId: string;
  /** job.timestamp：只允许比上次更新更晚的触发落库，重复投递自然被挡掉。 */
  triggerAt: number;
}

/**
 * 原子地认领一次定时触发：条件更新 last_run_at 后建会话/运行/消息。
 * 未命中说明同一触发已落地或任务刚被禁用，返回 duplicate，调用方不再补跑。
 */
export async function claimScheduleTrigger(
  db: Database,
  input: ScheduleTriggerWrite,
): Promise<'claimed' | 'duplicate' | 'agent_disabled'> {
  return db.transaction(async (tx) => {
    const claimedAt = new Date(input.triggerAt);
    const claimed = await tx
      .update(agentSchedules)
      .set({ lastRunAt: claimedAt })
      .where(
        and(
          eq(agentSchedules.id, input.scheduleId),
          eq(agentSchedules.enabled, true),
          sql`(${agentSchedules.lastRunAt} is null or ${agentSchedules.lastRunAt} < ${claimedAt})`,
        ),
      )
      .returning();
    const schedule = claimed[0];
    if (!schedule) return 'duplicate';

    // 提交前再读一次：触发可能是几分钟前投递的，期间 agent 可能被停用。
    const [agent] = await tx
      .select({ enabled: agents.enabled })
      .from(agents)
      .where(eq(agents.id, schedule.agentId))
      .limit(1);
    if (!agent?.enabled) return 'agent_disabled';

    const agentVersion = await latestAgentVersion(tx, schedule.agentId);
    await tx.insert(conversations).values({
      id: input.conversationId,
      agentId: schedule.agentId,
      title: `定时: ${schedule.name}`.slice(0, 80),
    });
    await tx.insert(agentRuns).values({
      id: input.runId,
      conversationId: input.conversationId,
      agentId: schedule.agentId,
      status: 'queued',
      trigger: 'schedule',
      agentVersion,
    });
    await tx.insert(messages).values({
      id: input.messageId,
      conversationId: input.conversationId,
      role: 'user',
      content: { type: 'text', text: schedule.prompt },
      runId: input.runId,
    });
    return 'claimed';
  });
}

/** 需要人处理的待批工具调用：未批准且未过期。生成式 UI 的会话级审批不在运行待办里。 */
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
        isNull(approvalRequests.approvedAt),
        sql`(${approvalRequests.expiresAt} is null or ${approvalRequests.expiresAt} > now())`,
        inArray(agentRuns.status, ['queued', 'running']),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt));
  // 查询已排除空 run_id；这里收窄类型，不引入哨兵值。
  return rows.flatMap((row) => (row.runId === null ? [] : [{ ...row, runId: row.runId }]));
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
