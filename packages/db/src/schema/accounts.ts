import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** 四默认角色；自定义角色为 null。 */
    systemKey: text('system_key', { enum: ['admin', 'user', 'owner', 'maintainer'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_name_idx').on(t.name),
    uniqueIndex('roles_system_key_idx').on(t.systemKey),
    check(
      'roles_system_key_check',
      sql`${t.systemKey} is null or ${t.systemKey} in ('admin', 'user', 'owner', 'maintainer')`,
    ),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id').notNull(),
    scope: text('scope', {
      enum: ['own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform'],
    }).notNull(),
  },
  (t) => [
    uniqueIndex('role_permissions_pk').on(t.roleId, t.permissionId, t.scope),
    index('role_permissions_permission_idx').on(t.permissionId),
    check(
      'role_permissions_scope_check',
      sql`${t.scope} in ('own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform')`,
    ),
  ],
);

/** 业务身份到角色的分配；离线身份（无 authUsers 行）仍保留。 */
export const userRoles = pgTable(
  'user_roles',
  {
    businessId: text('business_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('user_roles_pk').on(t.businessId, t.roleId),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

export const agentMembers = pgTable(
  'agent_members',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    canUse: boolean('can_use').notNull().default(false),
    canMaintain: boolean('can_maintain').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_members_pk').on(t.agentId, t.businessId),
    index('agent_members_business_idx').on(t.businessId),
    check('agent_members_flags_check', sql`${t.canUse} or ${t.canMaintain}`),
  ],
);
