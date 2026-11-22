import { fail, isAppError } from '@agentport/core';
import {
  ACTIVE_RUN_STATUSES,
  type AccessFilter,
  FAILED_RUN_STATUSES,
  RETENTION_DEFAULTS,
  type RetentionUpdate,
} from '@agentport/shared';
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  agentSchedules,
  agents,
  approvalRequests,
  conversations,
  messages,
  platformSettings,
} from '../schema.js';
import { maintainedAgentScopeWhere } from './access.js';
import { getAgentVersion } from './agent-versions.js';
import { getAgentServerIds } from './agents.js';
import { notStale } from './freshness.js';
import { assertRunBudget, getDepartmentIdForBusinessId } from './governance.js';
import { lockRunResources } from './locks.js';
import { keysetPage } from './pagination.js';
import {
  consumePolicyApproval,
  linkPolicyApprovalToRun,
  POLICY_APPROVAL_STALE_MESSAGE,
} from './security.js';

export type ScheduleRow = typeof agentSchedules.$inferSelect;

export interface ScheduleWrite {
  agentId: string;
  name: string;
  cron: string;
  timezone: ScheduleRow['timezone'];
  missedPolicy: ScheduleRow['missedPolicy'];
  prompt: string;
  enabled: boolean;
  createdBy: string;
  executeAsBusinessId: string;
}

export async function createSchedule(db: DbHandle, input: ScheduleWrite): Promise<ScheduleRow> {
  const [row] = await db
    .insert(agentSchedules)
    .values({ id: newId('schedule'), ...input })
    .returning();
  if (!row) throw new Error('schedule insert returned no row');
  return row;
}

export async function listSchedules(
  db: Database,
  input: { access: AccessFilter; cursor?: string; limit: number },
) {
  return keysetPage(db, {
    table: agentSchedules,
    cursor: input.cursor,
    limit: input.limit,
    where: [maintainedAgentScopeWhere(input.access, agentSchedules.agentId)],
    load: ({ where, limit }) =>
      db
        .select({ ...getTableColumns(agentSchedules), agentName: agents.name })
        .from(agentSchedules)
        .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
        .where(where)
        .orderBy(desc(agentSchedules.createdAt), desc(agentSchedules.id))
        .limit(limit),
  });
}

export async function getSchedule(db: DbHandle, id: string): Promise<ScheduleRow | null> {
  const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).limit(1);
  return row ?? null;
}

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
      ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
      ...(patch.missedPolicy === undefined ? {} : { missedPolicy: patch.missedPolicy }),
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

export async function listSchedulesForSync(db: Database) {
  return db
    .select({
      id: agentSchedules.id,
      cron: agentSchedules.cron,
      enabled: agentSchedules.enabled,
      timezone: agentSchedules.timezone,
      missedPolicy: agentSchedules.missedPolicy,
      lastRunAt: agentSchedules.lastRunAt,
      createdAt: agentSchedules.createdAt,
    })
    .from(agentSchedules);
}

const scheduleRunColumns = {
  id: agentRuns.id,
  status: agentRuns.status,
  createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt,
  endedAt: agentRuns.endedAt,
  latencyMs: agentRuns.latencyMs,
  error: agentRuns.error,
  errorKind: agentRuns.errorKind,
  costUsd: agentRuns.costUsd,
};

export async function listScheduleRuns(db: Database, scheduleId: string, limit: number) {
  return db
    .select(scheduleRunColumns)
    .from(agentRuns)
    .where(eq(agentRuns.scheduleId, scheduleId))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(limit);
}

export async function getScheduleRun(db: Database, scheduleId: string, runId: string) {
  const [row] = await db
    .select(scheduleRunColumns)
    .from(agentRuns)
    .where(and(eq(agentRuns.scheduleId, scheduleId), eq(agentRuns.id, runId)))
    .limit(1);
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
  prompt: string;
  triggerAt: number;
  recordedAt?: number;
}

export async function claimScheduleTrigger(
  db: Database,
  input: ScheduleTriggerWrite,
): Promise<'claimed' | 'duplicate' | 'agent_disabled' | 'budget_exceeded'> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ agentId: agentSchedules.agentId })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, input.scheduleId))
      .limit(1);
    if (!owner) return 'duplicate';
    const [pre] = await tx
      .select({ publishedVersion: agents.publishedVersion })
      .from(agents)
      .where(eq(agents.id, owner.agentId))
      .limit(1);
    const preDefinition =
      pre?.publishedVersion === null || pre?.publishedVersion === undefined
        ? null
        : ((await getAgentVersion(tx, owner.agentId, pre.publishedVersion))?.definition ?? null);
    await lockRunResources(tx, owner.agentId, preDefinition?.agent.subAgentIds);

    const [agent] = await tx
      .select({
        enabled: agents.enabled,
        model: agents.model,
      })
      .from(agents)
      .where(eq(agents.id, owner.agentId))
      .limit(1);
    if (!agent?.enabled) return 'agent_disabled';

    const claimedAt = new Date(input.triggerAt);
    const claimedAtIso = claimedAt.toISOString();
    const claimed = await tx
      .update(agentSchedules)
      .set({ lastRunAt: new Date(input.recordedAt ?? input.triggerAt) })
      .where(
        and(
          eq(agentSchedules.id, input.scheduleId),
          eq(agentSchedules.enabled, true),
          sql`(${agentSchedules.lastRunAt} is null or ${agentSchedules.lastRunAt} < ${claimedAtIso})`,
        ),
      )
      .returning();
    const schedule = claimed[0];
    if (!schedule) return 'duplicate';

    try {
      await assertRunBudget(tx, {
        agentId: schedule.agentId,
        initiatedBy: schedule.executeAsBusinessId,
        definition: preDefinition,
      });
    } catch (error) {
      if (isAppError(error) && error.code === 'BUDGET_EXCEEDED') return 'budget_exceeded';
      throw error;
    }

    await tx.insert(conversations).values({
      id: input.conversationId,
      agentId: schedule.agentId,
      title: `定时: ${schedule.name}`.slice(0, 80),
      createdBy: schedule.executeAsBusinessId,
    });
    await tx.insert(agentRuns).values({
      id: input.runId,
      conversationId: input.conversationId,
      agentId: schedule.agentId,
      scheduleId: input.scheduleId,
      status: 'queued',
      trigger: 'schedule',
      subjectKind: 'user',
      initiatedBy: schedule.executeAsBusinessId,
      agentVersion: pre?.publishedVersion ?? null,
      model: preDefinition?.agent.model ?? agent.model,
      departmentId: await getDepartmentIdForBusinessId(tx, schedule.executeAsBusinessId),
      serverIds:
        preDefinition === null
          ? await getAgentServerIds(tx, schedule.agentId)
          : preDefinition.agent.serverIds,
    });
    await tx.insert(messages).values({
      id: input.messageId,
      conversationId: input.conversationId,
      role: 'user',
      senderBusinessId: schedule.executeAsBusinessId,
      content: { type: 'text', text: input.prompt },
      runId: input.runId,
    });
    return 'claimed';
  });
}

export async function scheduleRetryExists(db: DbHandle, previousRunId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.retryOfRunId, previousRunId))
    .limit(1);
  return row !== undefined;
}

export interface ScheduleRetryWrite {
  scheduleId: string;
  previousRunId: string;
  runId: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  consumePolicyApprovalId?: string;
}

export async function claimScheduleRetry(
  db: Database,
  input: ScheduleRetryWrite,
): Promise<'claimed' | 'duplicate' | 'agent_disabled' | 'budget_exceeded'> {
  return db.transaction(async (tx) => {
    const [schedule] = await tx
      .select({
        agentId: agentSchedules.agentId,
      })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, input.scheduleId), eq(agentSchedules.enabled, true)))
      .limit(1);
    if (!schedule) return 'duplicate';

    const [pre] = await tx
      .select({ publishedVersion: agents.publishedVersion })
      .from(agents)
      .where(eq(agents.id, schedule.agentId))
      .limit(1);
    const preDefinition =
      pre?.publishedVersion === null || pre?.publishedVersion === undefined
        ? null
        : ((await getAgentVersion(tx, schedule.agentId, pre.publishedVersion))?.definition ?? null);
    await lockRunResources(tx, schedule.agentId, preDefinition?.agent.subAgentIds);

    const [lockedSchedule] = await tx
      .select({
        agentId: agentSchedules.agentId,
        name: agentSchedules.name,
        executeAsBusinessId: agentSchedules.executeAsBusinessId,
      })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, input.scheduleId), eq(agentSchedules.enabled, true)))
      .limit(1)
      .for('share');
    if (!lockedSchedule) return 'duplicate';

    const [agent] = await tx
      .select({
        enabled: agents.enabled,
        model: agents.model,
      })
      .from(agents)
      .where(eq(agents.id, lockedSchedule.agentId))
      .limit(1);
    if (!agent?.enabled) return 'agent_disabled';

    try {
      await assertRunBudget(tx, {
        agentId: lockedSchedule.agentId,
        initiatedBy: lockedSchedule.executeAsBusinessId,
        definition: preDefinition,
      });
    } catch (error) {
      if (isAppError(error) && error.code === 'BUDGET_EXCEEDED') return 'budget_exceeded';
      throw error;
    }

    await tx.insert(conversations).values({
      id: input.conversationId,
      agentId: lockedSchedule.agentId,
      title: `定时: ${lockedSchedule.name}`.slice(0, 80),
      createdBy: lockedSchedule.executeAsBusinessId,
    });
    const inserted = await tx
      .insert(agentRuns)
      .values({
        id: input.runId,
        conversationId: input.conversationId,
        agentId: lockedSchedule.agentId,
        scheduleId: input.scheduleId,
        status: 'queued',
        trigger: 'schedule',
        subjectKind: 'user',
        initiatedBy: lockedSchedule.executeAsBusinessId,
        agentVersion: pre?.publishedVersion ?? null,
        model: preDefinition?.agent.model ?? agent.model,
        departmentId: await getDepartmentIdForBusinessId(tx, lockedSchedule.executeAsBusinessId),
        serverIds:
          preDefinition === null
            ? await getAgentServerIds(tx, lockedSchedule.agentId)
            : preDefinition.agent.serverIds,
        retryOfRunId: input.previousRunId,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    if (inserted.length === 0) {
      await tx.delete(conversations).where(eq(conversations.id, input.conversationId));
      return 'duplicate';
    }
    if (input.consumePolicyApprovalId !== undefined) {
      const consumed = await consumePolicyApproval(tx, input.consumePolicyApprovalId);
      if (consumed === null) fail('CONTENT_APPROVAL_REQUIRED', POLICY_APPROVAL_STALE_MESSAGE);
      await linkPolicyApprovalToRun(tx, input.consumePolicyApprovalId, input.runId);
    }
    await tx.insert(messages).values({
      id: input.messageId,
      conversationId: input.conversationId,
      role: 'user',
      senderBusinessId: lockedSchedule.executeAsBusinessId,
      content: { type: 'text', text: input.prompt },
      runId: input.runId,
    });
    return 'claimed';
  });
}

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

const SINGLETON_ID = 'singleton';

export interface RetentionSettingsRow {
  runDays: number;
  messageDays: number;
  agentVersions: number;
  updatedAt: Date;
  updatedBy: string | null;
}

const retentionColumns = {
  runDays: platformSettings.retentionRunDays,
  messageDays: platformSettings.retentionMessageDays,
  agentVersions: platformSettings.retentionAgentVersions,
  updatedAt: platformSettings.updatedAt,
  updatedBy: platformSettings.updatedBy,
};

export async function getRetentionSettings(db: DbHandle): Promise<RetentionSettingsRow | null> {
  const [row] = await db
    .select(retentionColumns)
    .from(platformSettings)
    .where(eq(platformSettings.id, SINGLETON_ID))
    .limit(1);
  return row ?? null;
}

export async function upsertRetentionSettings(
  db: Database,
  patch: RetentionUpdate,
  updatedBy: string,
): Promise<RetentionSettingsRow> {
  const existing = await getRetentionSettings(db);
  const next = {
    runDays: patch.runDays ?? existing?.runDays ?? RETENTION_DEFAULTS.runDays,
    messageDays: patch.messageDays ?? existing?.messageDays ?? RETENTION_DEFAULTS.messageDays,
    agentVersions:
      patch.agentVersions ?? existing?.agentVersions ?? RETENTION_DEFAULTS.agentVersions,
  };
  const [row] = await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      retentionRunDays: next.runDays,
      retentionMessageDays: next.messageDays,
      retentionAgentVersions: next.agentVersions,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: {
        retentionRunDays: next.runDays,
        retentionMessageDays: next.messageDays,
        retentionAgentVersions: next.agentVersions,
        updatedAt: new Date(),
        updatedBy,
      },
    })
    .returning(retentionColumns);
  if (!row) throw new Error('retention settings upsert returned no row');
  return row;
}

export async function ensureRetentionDefaults(
  db: Database,
  defaults: { runDays: number; messageDays: number; agentVersions: number },
): Promise<void> {
  await db
    .insert(platformSettings)
    .values({
      id: SINGLETON_ID,
      retentionRunDays: defaults.runDays,
      retentionMessageDays: defaults.messageDays,
      retentionAgentVersions: defaults.agentVersions,
    })
    .onConflictDoNothing();
}
