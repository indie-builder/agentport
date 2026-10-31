import { AppError, fail } from '@agentport/core';
import {
  type AccessScope,
  type AgentMember,
  type PermissionGrant,
  type PermissionId,
  type Role,
  type RoleMatrix,
  type RoleMatrixInput,
  type RoleSummary,
  validateGrants,
} from '@agentport/shared';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agentMembers,
  agents,
  authUsers,
  platformBootstrap,
  rolePermissions,
  roles,
  userRoles,
} from '../schema.js';
import { hasBusinessHistory } from './identities.js';

/** 事务句柄：仓库函数在调用方事务内复用同一连接。 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbHandle = Database | Tx;

const BOOTSTRAP_ID = 'initial';

function transaction<T>(db: DbHandle, run: (tx: Tx) => Promise<T>): Promise<T> {
  // Tx 自身也有 transaction（保存点）；矩阵与管理员守卫需要同一把 revision 锁。
  return (db as Database).transaction(run);
}

/**
 * 矩阵 revision 行是所有角色/管理员写操作的串行化点。
 * 账户停用/删除、角色分配与矩阵保存都必须先拿同一行的锁，再读取管理员数量。
 */
export async function lockAdminMutation(tx: Tx): Promise<number> {
  await tx.insert(platformBootstrap).values({ id: BOOTSTRAP_ID }).onConflictDoNothing();
  const [row] = await tx
    .select({ revision: platformBootstrap.rolesRevision })
    .from(platformBootstrap)
    .where(eq(platformBootstrap.id, BOOTSTRAP_ID))
    .for('update');
  return row?.revision ?? 0;
}

type RoleRow = typeof roles.$inferSelect;
type MatrixRow = { roleId: string; permissionId: string; scope: string };

function toSummary(row: RoleRow): RoleSummary {
  return { id: row.id, name: row.name, systemKey: row.systemKey ?? null };
}

function toGrant(row: MatrixRow): PermissionGrant {
  return {
    permissionId: row.permissionId as PermissionId,
    scope: row.scope as AccessScope,
  };
}

async function loadRoles(db: DbHandle): Promise<Role[]> {
  const [roleRows, grantRows] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.createdAt), asc(roles.id)),
    db
      .select({
        roleId: rolePermissions.roleId,
        permissionId: rolePermissions.permissionId,
        scope: rolePermissions.scope,
      })
      .from(rolePermissions)
      .orderBy(asc(rolePermissions.permissionId), asc(rolePermissions.scope)),
  ]);
  const grantsByRole = new Map<string, PermissionGrant[]>();
  for (const row of grantRows) {
    const list = grantsByRole.get(row.roleId);
    if (list) list.push(toGrant(row));
    else grantsByRole.set(row.roleId, [toGrant(row)]);
  }
  return roleRows.map((row) => ({
    ...toSummary(row),
    grants: grantsByRole.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getUserAccess(
  db: DbHandle,
  businessId: string,
): Promise<{ roles: RoleSummary[]; grants: PermissionGrant[] }> {
  const rows = await db
    .select({
      roleId: roles.id,
      name: roles.name,
      systemKey: roles.systemKey,
      permissionId: rolePermissions.permissionId,
      scope: rolePermissions.scope,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(eq(userRoles.businessId, businessId))
    .orderBy(asc(roles.createdAt), asc(roles.id));

  const roleMap = new Map<string, RoleSummary>();
  const grantMap = new Map<string, PermissionGrant>();
  for (const row of rows) {
    if (!roleMap.has(row.roleId)) {
      roleMap.set(row.roleId, {
        id: row.roleId,
        name: row.name,
        systemKey: row.systemKey ?? null,
      });
    }
    if (row.permissionId !== null && row.scope !== null) {
      const grant = toGrant(row as MatrixRow);
      grantMap.set(`${grant.permissionId}\u0000${grant.scope}`, grant);
    }
  }
  return { roles: [...roleMap.values()], grants: [...grantMap.values()] };
}

export async function getAgentRelation(
  db: DbHandle,
  agentId: string,
  businessId: string,
): Promise<{
  exists: boolean;
  ownerBusinessId: string | null;
  canUse: boolean;
  canMaintain: boolean;
}> {
  const [agent] = await db
    .select({ id: agents.id, ownerBusinessId: agents.ownerBusinessId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) {
    return { exists: false, ownerBusinessId: null, canUse: false, canMaintain: false };
  }
  if (agent.ownerBusinessId === businessId) {
    return {
      exists: true,
      ownerBusinessId: agent.ownerBusinessId,
      canUse: true,
      canMaintain: true,
    };
  }
  const [member] = await db
    .select({ canUse: agentMembers.canUse, canMaintain: agentMembers.canMaintain })
    .from(agentMembers)
    .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.businessId, businessId)))
    .limit(1);
  return {
    exists: true,
    ownerBusinessId: agent.ownerBusinessId,
    canUse: member?.canUse ?? false,
    canMaintain: member?.canMaintain ?? false,
  };
}

export async function getRoleMatrix(db: DbHandle): Promise<RoleMatrix> {
  const [bootstrap] = await db
    .select({ revision: platformBootstrap.rolesRevision })
    .from(platformBootstrap)
    .where(eq(platformBootstrap.id, BOOTSTRAP_ID))
    .limit(1);
  return { revision: bootstrap?.revision ?? 0, roles: await loadRoles(db) };
}

async function replaceGrants(tx: Tx, roleId: string, grants: readonly PermissionGrant[]) {
  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (grants.length > 0) {
    await tx.insert(rolePermissions).values(
      grants.map((grant) => ({
        roleId,
        permissionId: grant.permissionId,
        scope: grant.scope,
      })),
    );
  }
}

function assertValidGrants(grants: readonly PermissionGrant[]) {
  const message = validateGrants(grants);
  if (message) fail('INVALID_INPUT', message);
}

/** 账户存在时必须至少有一个未停用账户持有系统 admin。 */
async function assertActiveAdminRemains(tx: Tx) {
  const [accounts] = await tx.select({ total: count() }).from(authUsers);
  if ((accounts?.total ?? 0) === 0) return;
  const [admins] = await tx
    .select({ total: count() })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(authUsers, eq(authUsers.businessId, userRoles.businessId))
    .where(and(eq(roles.systemKey, 'admin'), eq(authUsers.disabled, false)));
  if ((admins?.total ?? 0) === 0) {
    fail('CONFLICT', '至少需要一个启用中的平台管理员');
  }
}

export async function replaceRoleMatrix(db: DbHandle, input: RoleMatrixInput): Promise<RoleMatrix> {
  return transaction(db, async (tx) => {
    const revision = await lockAdminMutation(tx);
    if (input.expectedRevision !== revision) {
      fail('CONFLICT', '角色矩阵已被其他修改更新，请刷新后重试');
    }

    const existing = await loadRoles(tx);
    const byId = new Map(existing.map((role) => [role.id, role]));
    const inputIds = new Set(input.roles.flatMap((role) => (role.id ? [role.id] : [])));
    const names = new Set<string>();
    for (const role of input.roles) {
      if (names.has(role.name)) fail('INVALID_INPUT', `角色名称 ${role.name} 重复`);
      names.add(role.name);
      if (role.id !== undefined && !byId.has(role.id)) {
        fail('INVALID_INPUT', `角色 ${role.id} 不存在`);
      }
    }

    const admin = existing.find((role) => role.systemKey === 'admin');
    const keep = new Set(inputIds);
    if (admin) keep.add(admin.id);

    // 先删省略的角色，避免改名撞上即将删除的旧名称。
    for (const role of existing) {
      if (!keep.has(role.id) && role.systemKey !== 'admin') {
        await tx.delete(roles).where(eq(roles.id, role.id));
      }
    }

    // 先临时改名，再写最终名：两个角色互换名称时不会撞 roles.name 唯一约束。
    // 临时名避开用户已占用的同名角色与全部最终名，冲突时递增后缀。
    const pending = input.roles.flatMap((role) => {
      const current = role.id === undefined ? undefined : byId.get(role.id);
      return current && current.name !== role.name ? [current] : [];
    });
    if (pending.length > 0) {
      const used = new Set(input.roles.map((role) => role.name));
      for (const role of existing) {
        if (keep.has(role.id)) used.add(role.name);
      }
      for (const current of pending) {
        const base = `__pending_${current.id}`;
        let name = base;
        for (let suffix = 1; used.has(name); suffix += 1) name = `${base}_${suffix}`;
        used.add(name);
        await tx.update(roles).set({ name }).where(eq(roles.id, current.id));
      }
    }

    const now = new Date();
    for (const role of input.roles) {
      const current = role.id === undefined ? undefined : byId.get(role.id);
      if (current?.systemKey === 'admin') {
        // 管理员矩阵只改显示名；grants 固定为目录种子。
        await tx
          .update(roles)
          .set({ name: role.name, updatedAt: now })
          .where(eq(roles.id, current.id));
        continue;
      }
      assertValidGrants(role.grants);
      if (current) {
        await tx
          .update(roles)
          .set({ name: role.name, updatedAt: now })
          .where(eq(roles.id, current.id));
        await replaceGrants(tx, current.id, role.grants);
      } else {
        const id = newId('role');
        await tx.insert(roles).values({ id, name: role.name, createdAt: now, updatedAt: now });
        await replaceGrants(tx, id, role.grants);
      }
    }

    await assertActiveAdminRemains(tx);
    await tx
      .update(platformBootstrap)
      .set({ rolesRevision: revision + 1 })
      .where(eq(platformBootstrap.id, BOOTSTRAP_ID));
    return { revision: revision + 1, roles: await loadRoles(tx) };
  });
}

async function isActiveAdmin(db: DbHandle, businessId: string): Promise<boolean> {
  const [row] = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(authUsers, eq(authUsers.businessId, userRoles.businessId))
    .where(
      and(
        eq(userRoles.businessId, businessId),
        eq(roles.systemKey, 'admin'),
        eq(authUsers.disabled, false),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function countOtherActiveAdmins(db: DbHandle, businessId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(authUsers, eq(authUsers.businessId, userRoles.businessId))
    .where(
      and(
        eq(roles.systemKey, 'admin'),
        eq(authUsers.disabled, false),
        ne(userRoles.businessId, businessId),
      ),
    );
  return row?.total ?? 0;
}

export async function setUserRoles(
  db: DbHandle,
  businessId: string,
  roleIds: string[],
): Promise<void> {
  return transaction(db, async (tx) => {
    await lockAdminMutation(tx);
    const unique = [...new Set(roleIds)];
    const rows =
      unique.length === 0
        ? []
        : await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, unique));
    if (rows.length !== unique.length) {
      fail('INVALID_INPUT', 'roleIds 必须引用存在的角色');
    }

    const [admin] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.systemKey, 'admin'))
      .limit(1);
    if (admin && !unique.includes(admin.id) && (await isActiveAdmin(tx, businessId))) {
      if ((await countOtherActiveAdmins(tx, businessId)) === 0) {
        fail('CONFLICT', '至少需要一个启用中的平台管理员');
      }
    }

    await tx.delete(userRoles).where(eq(userRoles.businessId, businessId));
    if (unique.length > 0) {
      await tx.insert(userRoles).values(unique.map((roleId) => ({ businessId, roleId })));
    }
  });
}

export async function listAgentMembers(db: DbHandle, agentId: string): Promise<AgentMember[]> {
  const rows = await db
    .select({
      businessId: agentMembers.businessId,
      name: authUsers.name,
      userId: authUsers.id,
      disabled: authUsers.disabled,
      canUse: agentMembers.canUse,
      canMaintain: agentMembers.canMaintain,
    })
    .from(agentMembers)
    .leftJoin(authUsers, eq(authUsers.businessId, agentMembers.businessId))
    .where(eq(agentMembers.agentId, agentId))
    .orderBy(asc(agentMembers.businessId));
  return rows.map((row) => ({
    businessId: row.businessId,
    name: row.name ?? row.businessId,
    accountActive: row.userId !== null && row.disabled === false,
    canUse: row.canUse,
    canMaintain: row.canMaintain,
  }));
}

async function getMember(db: DbHandle, agentId: string, businessId: string): Promise<AgentMember> {
  const [row] = await db
    .select({
      businessId: agentMembers.businessId,
      name: authUsers.name,
      userId: authUsers.id,
      disabled: authUsers.disabled,
      canUse: agentMembers.canUse,
      canMaintain: agentMembers.canMaintain,
    })
    .from(agentMembers)
    .leftJoin(authUsers, eq(authUsers.businessId, agentMembers.businessId))
    .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', '成员不存在');
  return {
    businessId: row.businessId,
    name: row.name ?? row.businessId,
    accountActive: row.userId !== null && row.disabled === false,
    canUse: row.canUse,
    canMaintain: row.canMaintain,
  };
}

export async function setAgentMember(
  db: DbHandle,
  agentId: string,
  input: { businessId: string; canUse: boolean; canMaintain: boolean },
): Promise<AgentMember> {
  return transaction(db, async (tx) => {
    if (!input.canUse && !input.canMaintain) {
      fail('INVALID_INPUT', '至少授予使用或维护权限');
    }
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) fail('NOT_FOUND', '专家不存在');
    if (!(await hasBusinessHistory(tx, input.businessId))) {
      fail('INVALID_INPUT', '成员必须是已登记的业务身份');
    }
    await tx
      .insert(agentMembers)
      .values({
        agentId,
        businessId: input.businessId,
        canUse: input.canUse,
        canMaintain: input.canMaintain,
      })
      .onConflictDoUpdate({
        target: [agentMembers.agentId, agentMembers.businessId],
        set: { canUse: input.canUse, canMaintain: input.canMaintain },
      });
    return getMember(tx, agentId, input.businessId);
  });
}

export async function deleteAgentMember(
  db: DbHandle,
  agentId: string,
  businessId: string,
): Promise<boolean> {
  const rows = await db
    .delete(agentMembers)
    .where(and(eq(agentMembers.agentId, agentId), eq(agentMembers.businessId, businessId)))
    .returning({ businessId: agentMembers.businessId });
  return rows.length > 0;
}

export async function transferAgent(
  db: DbHandle,
  agentId: string,
  ownerBusinessId: string,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ ownerBusinessId, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (rows.length === 0) return false;
  // 原负责人不自动保留成员权；显式成员行不因转交而删除。
  return true;
}
