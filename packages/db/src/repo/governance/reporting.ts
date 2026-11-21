import type { AlertSettings, CostGroupBy, SloSettings } from '@agentport/shared';
import { FAILED_RUN_STATUSES, utcWindowStart } from '@agentport/shared';
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import {
  agentRuns,
  authUsers,
  departments,
  platformSettings,
  roles,
  userRoles,
} from '../../schema.js';

export async function costSummary(db: DbHandle, input: { days: number; groupBy: CostGroupBy }) {
  const since = utcWindowStart(input.days);
  const key =
    input.groupBy === 'user'
      ? agentRuns.initiatedBy
      : input.groupBy === 'department'
        ? agentRuns.departmentId
        : agentRuns.model;
  const label =
    input.groupBy === 'user'
      ? sql<string>`coalesce(${authUsers.name}, ${agentRuns.initiatedBy}, '未分配')`
      : input.groupBy === 'department'
        ? sql<string>`coalesce(${departments.name}, ${agentRuns.departmentId}, '未分配')`
        : sql<string>`coalesce(${agentRuns.model}, '未知模型')`;
  const groups = await db
    .select({
      key,
      label,
      runs: count(),
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}),0)::float`,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}),0)::float`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}),0)::float`,
    })
    .from(agentRuns)
    .leftJoin(authUsers, eq(authUsers.businessId, agentRuns.initiatedBy))
    .leftJoin(departments, eq(departments.id, agentRuns.departmentId))
    .where(and(gte(agentRuns.startedAt, since), lt(agentRuns.startedAt, new Date())))
    .groupBy(key, label)
    .orderBy(sql`coalesce(sum(${agentRuns.costUsd}),0) desc`);
  return {
    ...input,
    since: since.toISOString(),
    groups: groups.map((row) => ({ ...row, key: row.key === null ? 'null:' : `value:${row.key}` })),
  };
}

export async function getAlertSettings(db: DbHandle): Promise<AlertSettings> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, 'singleton'))
    .limit(1);
  return {
    runFailures: {
      enabled: row?.alertRunFailuresEnabled ?? true,
      threshold: row?.alertRunFailuresThreshold ?? 5,
      windowMinutes: row?.alertRunFailuresWindowMinutes ?? 30,
    },
    queueFailed: {
      enabled: row?.alertQueueFailedEnabled ?? true,
      threshold: row?.alertQueueFailedThreshold ?? 1,
    },
    queueWaiting: {
      enabled: row?.alertQueueWaitingEnabled ?? true,
      threshold: row?.alertQueueWaitingThreshold ?? 100,
    },
    updatedAt: row?.updatedAt.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function updateAlertSettings(db: Database, input: AlertSettings, updatedBy?: string) {
  const values = {
    alertRunFailuresEnabled: input.runFailures.enabled,
    alertRunFailuresThreshold: input.runFailures.threshold,
    alertRunFailuresWindowMinutes: input.runFailures.windowMinutes,
    alertQueueFailedEnabled: input.queueFailed.enabled,
    alertQueueFailedThreshold: input.queueFailed.threshold,
    alertQueueWaitingEnabled: input.queueWaiting.enabled,
    alertQueueWaitingThreshold: input.queueWaiting.threshold,
    updatedAt: new Date(),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
  await db
    .insert(platformSettings)
    .values({ id: 'singleton', ...values })
    .onConflictDoUpdate({ target: platformSettings.id, set: values });
  return getAlertSettings(db);
}

export async function getSloSettings(db: DbHandle): Promise<SloSettings> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.id, 'singleton'))
    .limit(1);
  return {
    enabled: row?.sloEnabled ?? true,
    windowMinutes: row?.sloWindowMinutes ?? 60,
    runSuccessTarget: Number(row?.sloRunSuccessTarget ?? '0.950'),
    runP95LatencyMs: row?.sloRunP95LatencyMs ?? 120_000,
    queueOldestWaitMs: row?.sloQueueOldestWaitMs ?? 60_000,
    providerErrorRateTarget: Number(row?.sloProviderErrorRateTarget ?? '0.050'),
  };
}

export async function updateSloSettings(
  db: Database,
  input: SloSettings,
  updatedBy?: string,
): Promise<SloSettings> {
  const values = {
    sloEnabled: input.enabled,
    sloWindowMinutes: input.windowMinutes,
    sloRunSuccessTarget: String(input.runSuccessTarget),
    sloRunP95LatencyMs: input.runP95LatencyMs,
    sloQueueOldestWaitMs: input.queueOldestWaitMs,
    sloProviderErrorRateTarget: String(input.providerErrorRateTarget),
    updatedAt: new Date(),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
  await db
    .insert(platformSettings)
    .values({ id: 'singleton', ...values })
    .onConflictDoUpdate({ target: platformSettings.id, set: values });
  return getSloSettings(db);
}

export async function listAlertRecipientBusinessIds(db: DbHandle) {
  const rows = await db
    .selectDistinct({ businessId: authUsers.businessId })
    .from(authUsers)
    .innerJoin(userRoles, eq(userRoles.businessId, authUsers.businessId))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.systemKey, 'admin'), eq(authUsers.disabled, false)));
  return rows.map((row) => row.businessId);
}

export async function countRecentFailedRuns(db: DbHandle, since: Date) {
  const [row] = await db
    .select({ total: count() })
    .from(agentRuns)
    .where(and(inArray(agentRuns.status, [...FAILED_RUN_STATUSES]), gte(agentRuns.endedAt, since)));
  return row?.total ?? 0;
}
