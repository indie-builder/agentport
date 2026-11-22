import { fail } from '@agentport/core';
import type { GovernanceResource, ResourceGrantInput, ResourceKind } from '@agentport/shared';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { Database, DbHandle } from '../../client.js';
import { newId } from '../../id.js';
import {
  authUsers,
  dataDomains,
  knowledgeBases,
  plugins,
  resourceGrants,
  runtimeEnvironments,
  servers,
  skills,
} from '../../schema.js';
import { hasBusinessHistory } from '../accounts.js';
import { ilikeContains } from '../like.js';
import { type CursorPage, keysetPage } from '../pagination.js';

export const resourceTables = {
  knowledge_base: knowledgeBases,
  data_domain: dataDomains,
  skill: skills,
  server: servers,
  plugin: plugins,
  runtime_environment: runtimeEnvironments,
};

export async function listGovernanceResources(
  db: DbHandle,
  kind: ResourceKind,
  input: { q?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<CursorPage<GovernanceResource> | null> {
  const table = resourceTables[kind];
  const page = await keysetPage(db, {
    table,
    cursor: input.cursor,
    limit: input.limit,
    column: table.name,
    direction: 'asc',
    valueCursor: (row: { cursorValue: string }) => row.cursorValue,
    cursorKind: 'text',
    where: [input.q ? ilikeContains(table.name, input.q) : undefined],
    load: ({ where, limit }: { where: SQL | undefined; limit: number }) =>
      db
        .select({
          id: table.id,
          name: table.name,
          ownerBusinessId: table.ownerBusinessId,
          ownerName: authUsers.name,
          cursorValue: table.name,
        })
        .from(table)
        .leftJoin(authUsers, eq(authUsers.businessId, table.ownerBusinessId))
        .where(where)
        .orderBy(asc(table.name), asc(table.id))
        .limit(limit),
  });
  if (!page) return null;
  return {
    items: page.items.map(({ cursorValue, ...row }) => ({ resourceKind: kind, ...row })),
    nextCursor: page.nextCursor,
  };
}

export async function listResourceGrants(db: DbHandle, kind: ResourceKind, resourceId: string) {
  const rows = await db
    .select({
      resourceKind: resourceGrants.resourceKind,
      resourceId: resourceGrants.resourceId,
      businessId: resourceGrants.businessId,
      name: authUsers.name,
      userId: authUsers.id,
      disabled: authUsers.disabled,
      canUse: resourceGrants.canUse,
      canManage: resourceGrants.canManage,
    })
    .from(resourceGrants)
    .leftJoin(authUsers, eq(authUsers.businessId, resourceGrants.businessId))
    .where(and(eq(resourceGrants.resourceKind, kind), eq(resourceGrants.resourceId, resourceId)))
    .orderBy(asc(resourceGrants.businessId));
  return rows.map(({ userId, disabled, ...row }) => ({
    ...row,
    name: row.name ?? row.businessId,
    accountActive: userId !== null && disabled === false,
  }));
}

export async function upsertResourceGrant(db: Database, input: ResourceGrantInput) {
  if (!input.canUse && !input.canManage) fail('INVALID_INPUT', '至少授予使用或管理权限');
  return db.transaction(async (tx) => {
    const table = resourceTables[input.resourceKind];
    const [resource] = await tx
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, input.resourceId))
      .limit(1);
    if (!resource) fail('NOT_FOUND', '资源不存在');
    if (!(await hasBusinessHistory(tx, input.businessId)))
      fail('INVALID_INPUT', '成员必须是已登记的业务身份');
    await tx
      .insert(resourceGrants)
      .values({ id: newId('resourceGrant'), ...input })
      .onConflictDoUpdate({
        target: [resourceGrants.resourceKind, resourceGrants.resourceId, resourceGrants.businessId],
        set: { canUse: input.canUse, canManage: input.canManage, updatedAt: new Date() },
      });
    const member = (await listResourceGrants(tx, input.resourceKind, input.resourceId)).find(
      (row) => row.businessId === input.businessId,
    );
    if (!member) fail('NOT_FOUND', '资源授权不存在');
    return member;
  });
}

export async function deleteResourceGrant(
  db: Database,
  kind: ResourceKind,
  resourceId: string,
  businessId: string,
) {
  const rows = await db
    .delete(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceKind, kind),
        eq(resourceGrants.resourceId, resourceId),
        eq(resourceGrants.businessId, businessId),
      ),
    )
    .returning({ id: resourceGrants.id });
  if (rows.length === 0) fail('NOT_FOUND', '资源授权不存在');
}
