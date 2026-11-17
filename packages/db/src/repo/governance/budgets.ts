import { fail } from '@agentport/core';
import type { AgentDefinition, BudgetInput, BudgetScopeKind } from '@agentport/shared';
import { and, count, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../../client.js';
import { newId } from '../../id.js';
import {
  agentRuns,
  agents,
  authUsers,
  budgetLimits,
  dataDomainQueryLogs,
  departmentMembers,
  departments,
  knowledgeDocuments,
} from '../../schema.js';
import { getIdentity } from '../accounts.js';
import { createNotification } from '../notifications.js';
import { getDepartmentIdForBusinessId } from './departments.js';
import { listAlertRecipientBusinessIds } from './reporting.js';
import { resourceTables } from './resources.js';

function monthWindow(now = new Date()) {
  return {
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    key: now.toISOString().slice(0, 7),
  };
}

async function budgetScopeName(db: DbHandle, kind: BudgetScopeKind, id: string) {
  if (kind === 'user') return (await getIdentity(db, id))?.name ?? null;
  const table =
    kind === 'department' ? departments : kind === 'agent' ? agents : resourceTables[kind];
  const [row] = await db.select({ name: table.name }).from(table).where(eq(table.id, id)).limit(1);
  return row?.name ?? null;
}

async function usedBudget(db: DbHandle, kind: BudgetScopeKind, id: string) {
  if (kind === 'knowledge_base') {
    const [row] = await db
      .select({ used: count() })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.baseId, id));
    return row?.used ?? 0;
  }
  const { since, until } = monthWindow();
  if (kind === 'data_domain') {
    const [row] = await db
      .select({ used: count() })
      .from(dataDomainQueryLogs)
      .where(
        and(
          eq(dataDomainQueryLogs.dataDomainId, id),
          gte(dataDomainQueryLogs.createdAt, since),
          lt(dataDomainQueryLogs.createdAt, until),
        ),
      );
    return row?.used ?? 0;
  }
  const scope =
    kind === 'agent'
      ? eq(agentRuns.agentId, id)
      : kind === 'user'
        ? eq(agentRuns.initiatedBy, id)
        : eq(agentRuns.departmentId, id);
  const [row] = await db
    .select({ used: sql<number>`coalesce(sum(${agentRuns.costUsd}),0)::float` })
    .from(agentRuns)
    .where(and(scope, gte(agentRuns.startedAt, since), lt(agentRuns.startedAt, until)));
  return row?.used ?? 0;
}

export async function listBudgetStatuses(db: DbHandle) {
  const rows = await db.select().from(budgetLimits);
  return Promise.all(
    rows.map(async (row) => {
      const [scopeName, used] = await Promise.all([
        budgetScopeName(db, row.scopeKind, row.scopeId),
        usedBudget(db, row.scopeKind, row.scopeId),
      ]);
      return {
        ...row,
        scopeName: scopeName ?? row.scopeId,
        limitValue: Number(row.limitValue),
        alertRatio: Number(row.alertRatio),
        used,
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
  );
}

export async function upsertBudget(db: Database, input: BudgetInput) {
  const expected =
    input.scopeKind === 'knowledge_base'
      ? 'documents'
      : input.scopeKind === 'data_domain'
        ? 'queries_month'
        : 'cost_usd_month';
  if (input.metric !== expected) fail('INVALID_INPUT', '预算范围与指标不匹配');
  if (
    !Number.isFinite(input.limitValue) ||
    input.limitValue < 0 ||
    !Number.isFinite(input.alertRatio) ||
    input.alertRatio < 0 ||
    input.alertRatio > 1
  )
    fail('INVALID_INPUT', '预算限额或告警比例无效');
  const scopeName = await budgetScopeName(db, input.scopeKind, input.scopeId);
  if (scopeName === null) fail('INVALID_INPUT', '预算范围不存在');
  const values = {
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    metric: input.metric,
    limitValue: String(input.limitValue),
    alertRatio: String(input.alertRatio),
    enabled: input.enabled,
  };
  const [row] = await db
    .insert(budgetLimits)
    .values({ id: newId('budgetLimit'), ...values })
    .onConflictDoUpdate({
      target: [budgetLimits.scopeKind, budgetLimits.scopeId, budgetLimits.metric],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  if (!row) fail('INTERNAL_ERROR', '预算保存失败');
  return {
    ...row,
    scopeName,
    limitValue: Number(row.limitValue),
    alertRatio: Number(row.alertRatio),
    used: await usedBudget(db, row.scopeKind, row.scopeId),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteBudget(db: Database, id: string) {
  const rows = await db
    .delete(budgetLimits)
    .where(eq(budgetLimits.id, id))
    .returning({ id: budgetLimits.id });
  if (rows.length === 0) fail('NOT_FOUND', '预算不存在');
}

export async function assertRunBudget(
  tx: Transaction,
  input: { agentId: string; initiatedBy: string | null; definition?: AgentDefinition | null },
) {
  const departmentId =
    input.initiatedBy === null ? null : await getDepartmentIdForBusinessId(tx, input.initiatedBy);
  const scopes = [
    and(eq(budgetLimits.scopeKind, 'agent'), eq(budgetLimits.scopeId, input.agentId)),
  ];
  if (input.initiatedBy !== null)
    scopes.push(
      and(eq(budgetLimits.scopeKind, 'user'), eq(budgetLimits.scopeId, input.initiatedBy)),
    );
  if (departmentId !== null)
    scopes.push(
      and(eq(budgetLimits.scopeKind, 'department'), eq(budgetLimits.scopeId, departmentId)),
    );
  const rows = await tx
    .select()
    .from(budgetLimits)
    .where(and(or(...scopes), eq(budgetLimits.metric, 'cost_usd_month')))
    .orderBy(budgetLimits.id)
    .for('update');
  await Promise.all(
    rows
      .filter((row) => row.enabled)
      .map(async (row) => {
        const used = await usedBudget(tx, row.scopeKind, row.scopeId);
        const limit = Number(row.limitValue);
        if (used >= limit)
          fail(
            'BUDGET_EXCEEDED',
            `${row.scopeKind === 'agent' ? '专家' : row.scopeKind === 'user' ? '用户' : '部门'}本月预算已用尽（已用 $${used.toFixed(2)} / 上限 $${limit.toFixed(2)}）`,
          );
      }),
  );
  if (!rows.some((row) => row.scopeKind === 'agent')) {
    const [agent] = await tx
      .select({ limit: agents.monthlyBudgetUsd })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    const limit = input.definition
      ? input.definition.agent.monthlyBudgetUsd
      : agent?.limit === null || agent?.limit === undefined
        ? null
        : Number(agent.limit);
    if (limit !== null) {
      const used = await usedBudget(tx, 'agent', input.agentId);
      if (used >= limit)
        fail(
          'BUDGET_EXCEEDED',
          `专家本月预算已用尽（已用 $${used.toFixed(2)} / 上限 $${limit.toFixed(2)}）`,
        );
    }
  }
}

async function assertQuota(
  db: DbHandle,
  kind: 'knowledge_base' | 'data_domain',
  id: string,
  additional = 1,
) {
  const metric = kind === 'knowledge_base' ? 'documents' : 'queries_month';
  const [row] = await db
    .select({ limit: budgetLimits.limitValue })
    .from(budgetLimits)
    .where(
      and(
        eq(budgetLimits.scopeKind, kind),
        eq(budgetLimits.scopeId, id),
        eq(budgetLimits.metric, metric),
        eq(budgetLimits.enabled, true),
      ),
    )
    .limit(1);
  if (row) {
    const used = await usedBudget(db, kind, id);
    const limit = Number(row.limit);
    if (used + additional > limit)
      fail(
        'BUDGET_EXCEEDED',
        kind === 'knowledge_base'
          ? `知识库文档配额已用尽（已用 ${used} / 上限 ${limit}）`
          : `数据域本月查询配额已用尽（已用 ${used} / 上限 ${limit}）`,
      );
  }
}

export async function assertKnowledgeDocumentQuota(
  db: DbHandle,
  baseId: string,
  additionalDocs = 1,
) {
  await assertQuota(db, 'knowledge_base', baseId, additionalDocs);
}

export async function assertDataDomainQueryQuota(db: DbHandle, dataDomainId: string) {
  await assertQuota(db, 'data_domain', dataDomainId);
}

async function notifyBudget(db: Database, kind: BudgetScopeKind, id: string) {
  const [row] = await db
    .select()
    .from(budgetLimits)
    .where(
      and(
        eq(budgetLimits.scopeKind, kind),
        eq(budgetLimits.scopeId, id),
        eq(budgetLimits.enabled, true),
      ),
    )
    .limit(1);
  if (!row) return;
  const used = await usedBudget(db, kind, id);
  const limit = Number(row.limitValue);
  if (used < limit * Number(row.alertRatio)) return;
  const tier = used >= limit ? 'exceeded' : 'alert';
  const label =
    kind === 'user'
      ? '用户'
      : kind === 'department'
        ? '部门'
        : kind === 'agent'
          ? '专家'
          : kind === 'knowledge_base'
            ? '知识库'
            : '数据域';
  const name = (await budgetScopeName(db, kind, id)) ?? id;
  const [admins, managers, owners] = await Promise.all([
    listAlertRecipientBusinessIds(db),
    kind === 'department'
      ? db
          .select({ businessId: departmentMembers.businessId })
          .from(departmentMembers)
          .innerJoin(authUsers, eq(authUsers.businessId, departmentMembers.businessId))
          .where(
            and(
              eq(departmentMembers.departmentId, id),
              eq(departmentMembers.isManager, true),
              eq(authUsers.disabled, false),
            ),
          )
      : Promise.resolve([]),
    kind === 'knowledge_base' || kind === 'data_domain'
      ? db
          .select({ businessId: authUsers.businessId })
          .from(resourceTables[kind])
          .innerJoin(authUsers, eq(authUsers.businessId, resourceTables[kind].ownerBusinessId))
          .where(and(eq(resourceTables[kind].id, id), eq(authUsers.disabled, false)))
      : Promise.resolve([]),
  ]);
  const recipients = new Set([
    ...admins,
    ...managers.map((manager) => manager.businessId),
    ...owners.map((owner) => owner.businessId),
    ...(kind === 'user' ? [id] : []),
  ]);
  await Promise.all(
    [...recipients].map((businessId) =>
      createNotification(db, {
        businessId,
        kind: 'budget_alert',
        title: `${label}${tier === 'exceeded' ? '预算或配额已用尽' : '预算或配额即将用尽'}`,
        body: `「${name}」已使用 ${used}，限额 ${limit}`,
        link: '/governance?tab=budgets',
        sourceId: `budget:${kind}:${id}:${row.metric}:${monthWindow().key}:${tier}`,
      }),
    ),
  );
}

export async function notifyKnowledgeDocumentQuota(db: Database, baseId: string) {
  await notifyBudget(db, 'knowledge_base', baseId);
}

export async function notifyDataDomainQueryQuota(db: Database, dataDomainId: string) {
  await notifyBudget(db, 'data_domain', dataDomainId);
}

export async function notifyRunBudgets(
  db: Database,
  input: { initiatedBy: string | null; departmentId: string | null },
) {
  await Promise.all([
    ...(input.initiatedBy === null ? [] : [notifyBudget(db, 'user', input.initiatedBy)]),
    ...(input.departmentId === null ? [] : [notifyBudget(db, 'department', input.departmentId)]),
  ]);
}
