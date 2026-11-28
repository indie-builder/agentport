import { fail, isAppError } from '@agentport/core';
import type { AccessFilter } from '@agentport/shared';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import { agentRuns, agentSchedules, agents, conversations, messages } from '../../schema.js';
import { maintainedAgentScopeWhere } from '../access.js';
import { isAgentInactive } from '../agent-lifecycle.js';
import { getAgentVersion } from '../agent-versions.js';
import { getAgentServerIds } from '../agents.js';
import { notStale, touchUpdatedAt } from '../freshness.js';
import { assertRunBudget, getDepartmentIdForBusinessId } from '../governance.js';
import { lockRunResources } from '../locks.js';
import { keysetPage } from '../pagination.js';
import {
  consumePolicyApproval,
  linkPolicyApprovalToRun,
  POLICY_APPROVAL_STALE_MESSAGE,
} from '../security.js';

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
      updatedAt: touchUpdatedAt(agentSchedules.updatedAt),
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

type ScheduleClaimResult = 'claimed' | 'duplicate' | 'agent_disabled' | 'budget_exceeded';

async function admitScheduleRun(
  db: Database,
  input: ({ mode: 'trigger' } & ScheduleTriggerWrite) | ({ mode: 'retry' } & ScheduleRetryWrite),
): Promise<ScheduleClaimResult> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ agentId: agentSchedules.agentId })
      .from(agentSchedules)
      .where(
        input.mode === 'retry'
          ? and(eq(agentSchedules.id, input.scheduleId), eq(agentSchedules.enabled, true))
          : eq(agentSchedules.id, input.scheduleId),
      )
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
        archivedAt: agents.archivedAt,
        deletedAt: agents.deletedAt,
        model: agents.model,
        publishedVersion: agents.publishedVersion,
      })
      .from(agents)
      .where(eq(agents.id, owner.agentId))
      .limit(1);

    let schedule: { agentId: string; name: string; executeAsBusinessId: string };
    if (input.mode === 'retry') {
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
      if (!agent || isAgentInactive(agent) || !agent.enabled) return 'agent_disabled';
      schedule = lockedSchedule;
    } else {
      if (!agent || isAgentInactive(agent) || !agent.enabled) return 'agent_disabled';
      const claimedAtIso = new Date(input.triggerAt).toISOString();
      const [claimed] = await tx
        .update(agentSchedules)
        .set({ lastRunAt: new Date(input.recordedAt ?? input.triggerAt) })
        .where(
          and(
            eq(agentSchedules.id, input.scheduleId),
            eq(agentSchedules.enabled, true),
            sql`(${agentSchedules.lastRunAt} is null or ${agentSchedules.lastRunAt} < ${claimedAtIso})`,
          ),
        )
        .returning({
          agentId: agentSchedules.agentId,
          name: agentSchedules.name,
          executeAsBusinessId: agentSchedules.executeAsBusinessId,
        });
      if (!claimed) return 'duplicate';
      schedule = claimed;
    }

    const definition =
      agent.publishedVersion === pre?.publishedVersion
        ? preDefinition
        : agent.publishedVersion === null
          ? null
          : ((await getAgentVersion(tx, owner.agentId, agent.publishedVersion))?.definition ??
            null);

    try {
      await assertRunBudget(tx, {
        agentId: schedule.agentId,
        initiatedBy: schedule.executeAsBusinessId,
        definition,
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
    const runValues = {
      id: input.runId,
      conversationId: input.conversationId,
      agentId: schedule.agentId,
      scheduleId: input.scheduleId,
      status: 'queued' as const,
      trigger: 'schedule' as const,
      subjectKind: 'user' as const,
      initiatedBy: schedule.executeAsBusinessId,
      agentVersion: agent.publishedVersion,
      model: definition?.agent.model ?? agent.model,
      departmentId: await getDepartmentIdForBusinessId(tx, schedule.executeAsBusinessId),
      serverIds:
        definition === null
          ? await getAgentServerIds(tx, schedule.agentId)
          : definition.agent.serverIds,
      ...(input.mode === 'retry' ? { retryOfRunId: input.previousRunId } : {}),
    };
    if (input.mode === 'retry') {
      const inserted = await tx
        .insert(agentRuns)
        .values(runValues)
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
    } else {
      await tx.insert(agentRuns).values(runValues);
    }
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

export async function claimScheduleTrigger(
  db: Database,
  input: ScheduleTriggerWrite,
): Promise<ScheduleClaimResult> {
  return admitScheduleRun(db, { mode: 'trigger', ...input });
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
): Promise<ScheduleClaimResult> {
  return admitScheduleRun(db, { mode: 'retry', ...input });
}
