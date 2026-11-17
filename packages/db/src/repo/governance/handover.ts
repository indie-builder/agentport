import { fail } from '@agentport/core';
import {
  agentPermissionAllows,
  type HandoverTransferResult,
  type PermissionId,
  type ResourceKind,
} from '@agentport/shared';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import {
  agentSchedules,
  agents,
  authUsers,
  departmentMembers,
  departments,
  knowledgeBases,
  servers,
} from '../../schema.js';
import { getAgentRelation, getUserAccess } from '../access.js';
import { getIdentity } from '../accounts.js';
import { resourceTables } from './resources.js';

export async function handoverChecklist(db: DbHandle, businessId: string) {
  const identity = await getIdentity(db, businessId);
  if (!identity) fail('NOT_FOUND', '业务身份不存在');
  const [account] = await db
    .select({ disabled: authUsers.disabled })
    .from(authUsers)
    .where(eq(authUsers.businessId, businessId))
    .limit(1);
  const [agentRows, resourceRows, schedules, membership] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.ownerBusinessId, businessId))
      .orderBy(asc(agents.name)),
    Promise.all(
      [
        resourceTables.knowledge_base,
        resourceTables.data_domain,
        resourceTables.skill,
        resourceTables.server,
        resourceTables.plugin,
        resourceTables.runtime_environment,
      ].map((table) =>
        db
          .select({ id: table.id, name: table.name })
          .from(table)
          .where(eq(table.ownerBusinessId, businessId))
          .orderBy(asc(table.name)),
      ),
    ),
    db
      .select({
        id: agentSchedules.id,
        name: agentSchedules.name,
        agentName: agents.name,
        agentId: agentSchedules.agentId,
      })
      .from(agentSchedules)
      .innerJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(
        or(
          eq(agentSchedules.createdBy, businessId),
          eq(agentSchedules.executeAsBusinessId, businessId),
        ),
      )
      .orderBy(asc(agentSchedules.name)),
    db
      .select({
        id: departments.id,
        name: departments.name,
        isManager: departmentMembers.isManager,
      })
      .from(departmentMembers)
      .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
      .where(eq(departmentMembers.businessId, businessId)),
  ]);
  const items = {
    agents: agentRows,
    knowledgeBases: resourceRows[0] ?? [],
    dataDomains: resourceRows[1] ?? [],
    skills: resourceRows[2] ?? [],
    servers: resourceRows[3] ?? [],
    plugins: resourceRows[4] ?? [],
    runtimeEnvironments: resourceRows[5] ?? [],
    schedules,
  };
  return {
    businessId,
    name: identity.name,
    status: account
      ? account.disabled
        ? ('disabled' as const)
        : ('active' as const)
      : ('deleted' as const),
    counts: {
      agents: items.agents.length,
      knowledgeBases: items.knowledgeBases.length,
      dataDomains: items.dataDomains.length,
      skills: items.skills.length,
      servers: items.servers.length,
      plugins: items.plugins.length,
      runtimeEnvironments: items.runtimeEnvironments.length,
      schedules: items.schedules.length,
    },
    items,
    departments: membership,
  };
}

export async function transferAll(
  db: Database,
  fromBusinessId: string,
  toBusinessId: string,
): Promise<HandoverTransferResult> {
  if (fromBusinessId === toBusinessId) fail('INVALID_INPUT', '接收人不能与原负责人相同');
  return db.transaction(async (tx) => {
    if (!(await getIdentity(tx, fromBusinessId))) fail('NOT_FOUND', '原业务身份不存在');
    const [target] = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(eq(authUsers.businessId, toBusinessId), eq(authUsers.disabled, false)))
      .for('share');
    if (!target) fail('INVALID_INPUT', '接收人必须是启用账户');
    const checklist = await handoverChecklist(tx, fromBusinessId);
    const domainIds = checklist.items.dataDomains.map((row) => row.id);
    const baseIds = checklist.items.knowledgeBases.map((row) => row.id);
    const companionConditions = [
      ...(baseIds.length === 0
        ? []
        : [
            inArray(
              servers.id,
              tx
                .select({ id: knowledgeBases.serverId })
                .from(knowledgeBases)
                .where(inArray(knowledgeBases.id, baseIds)),
            ),
          ]),
      ...(domainIds.length === 0
        ? []
        : [
            and(
              eq(servers.kind, 'data_domain'),
              inArray(sql<string>`${servers.config}->>'dataDomainId'`, domainIds),
            ),
          ]),
    ];
    const companionRows =
      companionConditions.length === 0
        ? []
        : await tx
            .select({ id: servers.id })
            .from(servers)
            .where(or(...companionConditions));
    const serverIds = [
      ...new Set([
        ...checklist.items.servers.map((row) => row.id),
        ...companionRows.map((row) => row.id),
      ]),
    ];
    const { grants } = await getUserAccess(tx, toBusinessId);
    const required: { count: number; permissionId: PermissionId }[] = [
      { count: checklist.counts.agents, permissionId: 'agents.create' },
      { count: checklist.counts.knowledgeBases, permissionId: 'knowledge.update' },
      { count: checklist.counts.dataDomains, permissionId: 'data_domains.update' },
      { count: checklist.counts.skills, permissionId: 'skills.update' },
      { count: serverIds.length, permissionId: 'servers.update' },
      { count: checklist.counts.plugins, permissionId: 'plugins.update' },
      { count: checklist.counts.runtimeEnvironments, permissionId: 'runtime_environments.update' },
    ];
    if (
      required.some(
        (entry) =>
          entry.count > 0 &&
          !grants.some(
            (grant) =>
              grant.permissionId === entry.permissionId &&
              (grant.scope === 'own_data' || grant.scope === 'platform'),
          ),
      )
    )
      fail('INVALID_INPUT', '接收人缺少待转资源的本人或平台管理权限');
    const transferredAgentIds = new Set(checklist.items.agents.map((row) => row.id));
    const scheduleAllowed = await Promise.all(
      checklist.items.schedules.map(async (schedule) => {
        const relation = await getAgentRelation(tx, schedule.agentId, toBusinessId);
        const effectiveRelation = transferredAgentIds.has(schedule.agentId)
          ? { ...relation, ownerBusinessId: toBusinessId, canUse: true, canMaintain: true }
          : relation;
        return (
          agentPermissionAllows(grants, 'agents.use', effectiveRelation, toBusinessId) &&
          agentPermissionAllows(grants, 'schedules.manage', effectiveRelation, toBusinessId)
        );
      }),
    );
    if (scheduleAllowed.some((allowed) => !allowed))
      fail('INVALID_INPUT', '接收人缺少执行待转定时任务所需的专家权限');
    const owner = { ownerBusinessId: toBusinessId, updatedAt: new Date() };
    const [agentRows, resources, transferredSchedules] = await Promise.all([
      tx
        .update(agents)
        .set(owner)
        .where(
          and(
            eq(agents.ownerBusinessId, fromBusinessId),
            checklist.items.agents.length === 0
              ? sql`false`
              : inArray(
                  agents.id,
                  checklist.items.agents.map((row) => row.id),
                ),
          ),
        )
        .returning({ id: agents.id }),
      Promise.all(
        Object.entries(resourceTables).map(async ([resourceKind, table]) => {
          const items =
            resourceKind === 'knowledge_base'
              ? checklist.items.knowledgeBases
              : resourceKind === 'data_domain'
                ? checklist.items.dataDomains
                : resourceKind === 'skill'
                  ? checklist.items.skills
                  : resourceKind === 'plugin'
                    ? checklist.items.plugins
                    : checklist.items.runtimeEnvironments;
          const ids = resourceKind === 'server' ? serverIds : items.map((row) => row.id);
          const rows = await tx
            .update(table)
            .set(owner)
            .where(
              and(
                ids.length === 0 ? sql`false` : inArray(table.id, ids),
                resourceKind === 'server'
                  ? inArray(table.id, serverIds)
                  : eq(table.ownerBusinessId, fromBusinessId),
              ),
            )
            .returning({ id: table.id });
          return { resourceKind: resourceKind as ResourceKind, count: rows.length };
        }),
      ),
      tx
        .update(agentSchedules)
        .set({ executeAsBusinessId: toBusinessId, updatedAt: new Date() })
        .where(eq(agentSchedules.executeAsBusinessId, fromBusinessId))
        .returning({ id: agentSchedules.id }),
    ]);
    const transferred: HandoverTransferResult['transferred'] = [
      { resourceKind: 'agent', count: agentRows.length },
      ...resources,
      { resourceKind: 'schedule', count: transferredSchedules.length },
    ];
    return { transferred, total: transferred.reduce((total, row) => total + row.count, 0) };
  });
}
