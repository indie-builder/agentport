import { randomUUID } from 'node:crypto';
import { AppError, fail } from '@agentport/core';
import type { Account, RoleSummary } from '@agentport/shared';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { and, asc, count, eq, ilike, inArray, ne, or, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { authAccounts, authSessions, authUsers, roles, userRoles } from '../schema.js';
import { type DbHandle, lockAdminMutation, setUserRoles, type Tx } from './access.js';
import { hasBusinessHistory, listIdentities } from './identities.js';

export { hasBusinessHistory, listIdentities };

type AccountRow = typeof authUsers.$inferSelect;
type TxLike = DbHandle;

function transaction<T>(db: TxLike, run: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Database).transaction(run);
}

function toSummary(row: { id: string; name: string; systemKey: string | null }): RoleSummary {
  return {
    id: row.id,
    name: row.name,
    systemKey: row.systemKey as RoleSummary['systemKey'],
  };
}

async function rolesFor(db: TxLike, businessIds: string[]): Promise<Map<string, RoleSummary[]>> {
  const map = new Map<string, RoleSummary[]>();
  if (businessIds.length === 0) return map;
  const rows = await db
    .select({
      businessId: userRoles.businessId,
      id: roles.id,
      name: roles.name,
      systemKey: roles.systemKey,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.businessId, businessIds))
    .orderBy(asc(roles.createdAt), asc(roles.id));
  for (const row of rows) {
    const list = map.get(row.businessId);
    if (list) list.push(toSummary(row));
    else map.set(row.businessId, [toSummary(row)]);
  }
  return map;
}

function toAccount(row: AccountRow, roles: RoleSummary[]): Account {
  return {
    businessId: row.businessId,
    username: row.username ?? '',
    name: row.name,
    status: row.disabled ? 'disabled' : 'active',
    roles,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getAccountRow(db: TxLike, businessId: string): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(authUsers)
    .where(eq(authUsers.businessId, businessId))
    .limit(1);
  return row ?? null;
}

async function accountFromRow(db: TxLike, row: AccountRow): Promise<Account> {
  const rolesByBusiness = await rolesFor(db, [row.businessId]);
  return toAccount(row, rolesByBusiness.get(row.businessId) ?? []);
}

export async function listAccounts(
  db: TxLike,
  input: { q?: string; limit: number; offset: number },
): Promise<{ items: Account[]; total: number }> {
  // 含启用与停用账户；已删除认证资料的行不存在。
  const filters: SQL[] = [];
  if (input.q !== undefined && input.q !== '') {
    const pattern = `%${input.q}%`;
    const search = or(
      ilike(authUsers.businessId, pattern),
      ilike(authUsers.username, pattern),
      ilike(authUsers.name, pattern),
    );
    if (search) filters.push(search);
  }
  const where = and(...filters);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(authUsers)
      .where(where)
      .orderBy(asc(authUsers.businessId))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(authUsers).where(where),
  ]);
  const rolesByBusiness = await rolesFor(
    db,
    rows.map((row) => row.businessId),
  );
  return {
    items: rows.map((row) => toAccount(row, rolesByBusiness.get(row.businessId) ?? [])),
    total: total[0]?.total ?? 0,
  };
}

export async function getIdentity(
  db: TxLike,
  businessId: string,
): Promise<{ businessId: string; name: string; accountActive: boolean } | null> {
  const [row] = await db
    .select({
      businessId: authUsers.businessId,
      name: authUsers.name,
      disabled: authUsers.disabled,
    })
    .from(authUsers)
    .where(eq(authUsers.businessId, businessId))
    .limit(1);
  if (row) {
    return { businessId: row.businessId, name: row.name, accountActive: !row.disabled };
  }
  if (!(await hasBusinessHistory(db, businessId))) return null;
  return { businessId, name: businessId, accountActive: false };
}

async function assertRoleIds(db: TxLike, roleIds: readonly string[]) {
  const unique = [...new Set(roleIds)];
  if (unique.length === 0) return unique;
  const rows = await db.select({ id: roles.id }).from(roles).where(inArray(roles.id, unique));
  if (rows.length !== unique.length) {
    fail('INVALID_INPUT', 'roleIds 必须引用存在的角色');
  }
  return unique;
}

async function assignRoles(tx: Tx, businessId: string, roleIds: readonly string[]) {
  const unique = await assertRoleIds(tx, roleIds);
  await tx.delete(userRoles).where(eq(userRoles.businessId, businessId));
  if (unique.length > 0) {
    await tx.insert(userRoles).values(unique.map((roleId) => ({ businessId, roleId })));
  }
}

export async function createAccount(
  db: TxLike,
  input: {
    businessId: string;
    username: string;
    name: string;
    passwordHash: string;
    restore: boolean;
    roleIds?: string[];
  },
): Promise<Account> {
  return transaction(db, async (tx) => {
    const existing = await getAccountRow(tx, input.businessId);
    if (existing) fail('CONFLICT', '该业务 ID 已有账户');
    const [usernameTaken] = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.username, input.username))
      .limit(1);
    if (usernameTaken) fail('CONFLICT', '用户名已存在');

    const history = await hasBusinessHistory(tx, input.businessId);
    if (history && !input.restore) {
      fail('CONFLICT', '该业务 ID 有历史记录，确认恢复原身份后才能重建账户');
    }
    if (!history && input.restore) {
      fail('CONFLICT', '该业务 ID 没有可恢复的历史记录');
    }

    const now = new Date();
    const userId = randomUUID();
    await tx.insert(authUsers).values({
      id: userId,
      name: input.name,
      email: `${userId}@agentport.invalid`,
      emailVerified: true,
      username: input.username,
      businessId: input.businessId,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(authAccounts).values({
      id: randomUUID(),
      accountId: userId,
      providerId: 'credential',
      userId,
      password: input.passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    if (input.roleIds !== undefined) {
      await assignRoles(tx, input.businessId, input.roleIds);
    } else if (!history) {
      const [defaultRole] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.systemKey, 'user'))
        .limit(1);
      if (!defaultRole) fail('CONFLICT', '默认用户角色尚未初始化');
      await tx.insert(userRoles).values({ businessId: input.businessId, roleId: defaultRole.id });
    }

    const row = await getAccountRow(tx, input.businessId);
    if (!row) throw new AppError('INTERNAL_ERROR', 'account insert returned no row');
    return accountFromRow(tx, row);
  });
}

export async function updateAccount(
  db: TxLike,
  businessId: string,
  input: { username?: string; name?: string },
): Promise<Account | null> {
  const row = await getAccountRow(db, businessId);
  if (!row) return null;
  if (input.username !== undefined && input.username !== row.username) {
    const [taken] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(eq(authUsers.username, input.username), ne(authUsers.id, row.id)))
      .limit(1);
    if (taken) fail('CONFLICT', '用户名已存在');
  }
  const [updated] = await db
    .update(authUsers)
    .set({
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.name === undefined ? {} : { name: input.name }),
      updatedAt: new Date(),
    })
    .where(eq(authUsers.id, row.id))
    .returning();
  if (!updated) return null;
  return accountFromRow(db, updated);
}

export async function setAccountStatus(
  db: TxLike,
  businessId: string,
  status: Account['status'],
): Promise<Account | null> {
  return transaction(db, async (tx) => {
    const disabling = status === 'disabled';
    // 停用与角色/矩阵保存共用同一把锁，再读管理员数量，避免并发把管理员清零。
    if (disabling) await lockAdminMutation(tx);
    const row = await getAccountRow(tx, businessId);
    if (!row) return null;
    if (disabling && !row.disabled) {
      const [admin] = await tx
        .select({ id: userRoles.roleId })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.businessId, businessId), eq(roles.systemKey, 'admin')))
        .limit(1);
      if (admin) {
        const [others] = await tx
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
        if ((others?.total ?? 0) === 0) {
          fail('CONFLICT', '至少需要一个启用中的平台管理员');
        }
      }
    }
    const [updated] = await tx
      .update(authUsers)
      .set({ disabled: disabling, updatedAt: new Date() })
      .where(eq(authUsers.id, row.id))
      .returning();
    if (!updated) return null;
    if (disabling) {
      await tx.delete(authSessions).where(eq(authSessions.userId, row.id));
    }
    return accountFromRow(tx, updated);
  });
}

export async function changeOwnPassword(
  db: TxLike,
  authUserId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<boolean> {
  return transaction(db, async (tx) => {
    const [user] = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, authUserId))
      .limit(1);
    if (!user) return false;
    const [account] = await tx
      .select({ id: authAccounts.id, hash: authAccounts.password })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, authUserId), eq(authAccounts.providerId, 'credential')))
      .limit(1);
    if (!account?.hash) return false;
    if (!(await verifyPassword({ hash: account.hash, password: input.currentPassword }))) {
      return false;
    }
    const nextHash = await hashPassword(input.newPassword);
    await tx
      .update(authAccounts)
      .set({ password: nextHash, updatedAt: new Date() })
      .where(eq(authAccounts.id, account.id));
    await tx.update(authUsers).set({ updatedAt: new Date() }).where(eq(authUsers.id, authUserId));
    await tx.delete(authSessions).where(eq(authSessions.userId, authUserId));
    return true;
  });
}

export async function resetPassword(
  db: TxLike,
  businessId: string,
  passwordHash: string,
): Promise<boolean> {
  return transaction(db, async (tx) => {
    const row = await getAccountRow(tx, businessId);
    if (!row) return false;
    const updated = await tx
      .update(authAccounts)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(and(eq(authAccounts.userId, row.id), eq(authAccounts.providerId, 'credential')))
      .returning({ id: authAccounts.id });
    if (updated.length === 0) return false;
    await tx.delete(authSessions).where(eq(authSessions.userId, row.id));
    return true;
  });
}

export async function deleteAccount(db: TxLike, businessId: string): Promise<boolean> {
  return transaction(db, async (tx) => {
    await lockAdminMutation(tx);
    const row = await getAccountRow(tx, businessId);
    if (!row) return false;
    if (!row.disabled) {
      const [admin] = await tx
        .select({ id: userRoles.roleId })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.businessId, businessId), eq(roles.systemKey, 'admin')))
        .limit(1);
      if (admin) {
        const [others] = await tx
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
        if ((others?.total ?? 0) === 0) {
          fail('CONFLICT', '至少需要一个启用中的平台管理员');
        }
      }
    }
    // 只删认证资料；业务记录、角色、成员和个人记忆都按 businessId 保留。
    await tx.delete(authUsers).where(eq(authUsers.id, row.id));
    return true;
  });
}

export { setUserRoles };
