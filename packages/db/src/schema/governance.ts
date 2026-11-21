import type { BudgetMetric, BudgetScopeKind, ResourceKind } from '@agentport/shared';
import { budgetMetricSchema, budgetScopeKindSchema, resourceKindSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const departments = pgTable(
  'departments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('departments_name_unique').on(t.name)],
);

export const departmentMembers = pgTable(
  'department_members',
  {
    departmentId: text('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    isManager: boolean('is_manager').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('department_members_department_business_unique').on(t.departmentId, t.businessId),
    uniqueIndex('department_members_business_idx').on(t.businessId),
  ],
);

export const resourceGrants = pgTable(
  'resource_grants',
  {
    id: text('id').primaryKey(),
    resourceKind: text('resource_kind', {
      enum: resourceKindSchema.options as [ResourceKind, ...ResourceKind[]],
    }).notNull(),
    resourceId: text('resource_id').notNull(),
    businessId: text('business_id').notNull(),
    canUse: boolean('can_use').notNull().default(false),
    canManage: boolean('can_manage').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('resource_grants_resource_business_unique').on(
      t.resourceKind,
      t.resourceId,
      t.businessId,
    ),
    index('resource_grants_business_kind_idx').on(t.businessId, t.resourceKind),
    check(
      'resource_grants_kind_check',
      sql`${t.resourceKind} in (${sql.raw(resourceKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check('resource_grants_flags_check', sql`${t.canUse} or ${t.canManage}`),
  ],
);

export const budgetLimits = pgTable(
  'budget_limits',
  {
    id: text('id').primaryKey(),
    scopeKind: text('scope_kind', {
      enum: budgetScopeKindSchema.options as [BudgetScopeKind, ...BudgetScopeKind[]],
    }).notNull(),
    scopeId: text('scope_id').notNull(),
    metric: text('metric', {
      enum: budgetMetricSchema.options as [BudgetMetric, ...BudgetMetric[]],
    }).notNull(),
    limitValue: numeric('limit_value', { precision: 14, scale: 4 }).notNull(),
    alertRatio: numeric('alert_ratio', { precision: 4, scale: 3 }).notNull().default('0.800'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('budget_limits_scope_metric_unique').on(t.scopeKind, t.scopeId, t.metric),
    index('budget_limits_scope_idx').on(t.scopeKind, t.scopeId),
    check(
      'budget_limits_scope_kind_check',
      sql`${t.scopeKind} in (${sql.raw(budgetScopeKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'budget_limits_metric_check',
      sql`${t.metric} in (${sql.raw(budgetMetricSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'budget_limits_scope_metric_check',
      sql`(${t.scopeKind} in ('user', 'department', 'agent') and ${t.metric} = 'cost_usd_month') or (${t.scopeKind} = 'knowledge_base' and ${t.metric} = 'documents') or (${t.scopeKind} = 'data_domain' and ${t.metric} = 'queries_month')`,
    ),
    check('budget_limits_value_check', sql`${t.limitValue} >= 0`),
    check('budget_limits_alert_ratio_check', sql`${t.alertRatio} >= 0 and ${t.alertRatio} <= 1`),
  ],
);
