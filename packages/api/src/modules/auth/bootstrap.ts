import { randomUUID } from 'node:crypto';
import {
  authAccounts,
  authUsers,
  type Database,
  newId,
  platformBootstrap,
  repo,
  rolePermissions,
  roles,
  type Transaction,
  userRoles,
} from '@agentport/db';
import { DEFAULT_ROLES, PERMISSIONS } from '@agentport/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { BOOTSTRAP_ADMIN_BUSINESS_ID } from './types.js';

async function seedDefaultRoles(tx: Transaction): Promise<string> {
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

async function ensureAdminRolePermissions(tx: Transaction): Promise<void> {
  const [admin] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.systemKey, 'admin'))
    .limit(1);
  if (!admin) return;

  await tx
    .insert(rolePermissions)
    .values(
      PERMISSIONS.map((permission) => ({
        roleId: admin.id,
        permissionId: permission.id,
        scope: 'platform' as const,
      })),
    )
    .onConflictDoNothing();
}

export async function ensureDefaultAssistant(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentport:bootstrap'))`);
    await repo.agents.ensureDefaultAgent(tx, BOOTSTRAP_ADMIN_BUSINESS_ID);
    await ensureAdminRolePermissions(tx);
  });
}

export async function ensureBootstrap(db: Database, config: Config): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentport:bootstrap'))`);

    await repo.agents.ensureDefaultAgent(tx, BOOTSTRAP_ADMIN_BUSINESS_ID);
    await ensureAdminRolePermissions(tx);

    const [initialized] = await tx
      .select({
        id: platformBootstrap.id,
        adminBusinessId: platformBootstrap.adminBusinessId,
      })
      .from(platformBootstrap)
      .where(eq(platformBootstrap.id, repo.access.BOOTSTRAP_ID))
      .limit(1);
    if (initialized !== undefined && initialized.adminBusinessId !== null) return;

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

    const initializedAt = new Date();
    await tx
      .insert(platformBootstrap)
      .values({ id: repo.access.BOOTSTRAP_ID, adminBusinessId, initializedAt })
      .onConflictDoUpdate({
        target: platformBootstrap.id,
        set: { adminBusinessId, initializedAt },
      });
  });
}
