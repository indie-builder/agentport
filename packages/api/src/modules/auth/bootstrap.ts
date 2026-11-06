import { randomUUID } from 'node:crypto';
import {
  authAccounts,
  authUsers,
  type Database,
  newId,
  platformBootstrap,
  rolePermissions,
  roles,
  userRoles,
} from '@agentport/db';
import { DEFAULT_ROLES } from '@agentport/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { BOOTSTRAP_ADMIN_BUSINESS_ID, BOOTSTRAP_ID } from './types.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** 插入缺失的四默认角色，返回 admin 角色 ID；已存在的同 systemKey 角色复用。 */
async function seedDefaultRoles(tx: Tx): Promise<string> {
  const now = new Date();
  for (const role of DEFAULT_ROLES) {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.systemKey, role.systemKey))
      .limit(1);
    if (existing) continue;

    const id = newId('role');
    await tx.insert(roles).values({
      id,
      name: role.name,
      systemKey: role.systemKey,
      createdAt: now,
      updatedAt: now,
    });
    if (role.grants.length > 0) {
      await tx.insert(rolePermissions).values(
        role.grants.map((grant) => ({
          roleId: id,
          permissionId: grant.permissionId,
          scope: grant.scope,
        })),
      );
    }
  }

  const [admin] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.systemKey, 'admin'))
    .limit(1);
  if (!admin) throw new Error('default admin role seed failed');
  return admin.id;
}

/**
 * 仅首次安装时播种管理员。marker 一旦存在就永不重播环境密码；
 * 已有启用中的系统管理员时只记初始化完成，不改其密码/身份/角色。
 */
export async function ensureBootstrap(db: Database, config: Config): Promise<void> {
  await db.transaction(async (tx) => {
    // 并发首登时只有一个事务能看见「未初始化」。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentport:bootstrap'))`);

    const [initialized] = await tx
      .select({ id: platformBootstrap.id })
      .from(platformBootstrap)
      .where(eq(platformBootstrap.id, BOOTSTRAP_ID))
      .limit(1);
    if (initialized) return;

    const [existingAdmin] = await tx
      .select({ businessId: authUsers.businessId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(authUsers, eq(authUsers.businessId, userRoles.businessId))
      .where(and(eq(roles.systemKey, 'admin'), eq(authUsers.disabled, false)))
      .limit(1);

    const adminBusinessId = existingAdmin?.businessId ?? BOOTSTRAP_ADMIN_BUSINESS_ID;
    if (!existingAdmin) {
      const adminRoleId = await seedDefaultRoles(tx);
      const now = new Date();
      const authUserId = randomUUID();
      const password = await hashPassword(config.ADMIN_PASSWORD);

      await tx.insert(authUsers).values({
        id: authUserId,
        name: config.ADMIN_USER,
        email: `${authUserId}@agentport.invalid`,
        emailVerified: true,
        username: config.ADMIN_USER,
        businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(authAccounts).values({
        id: randomUUID(),
        accountId: authUserId,
        providerId: 'credential',
        userId: authUserId,
        password,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(userRoles).values({
        businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
        roleId: adminRoleId,
      });
    }

    await tx
      .insert(platformBootstrap)
      .values({ id: BOOTSTRAP_ID, adminBusinessId, initializedAt: new Date() })
      .onConflictDoNothing();
  });
}
