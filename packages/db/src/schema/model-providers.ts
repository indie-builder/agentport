import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const modelProviders = pgTable(
  'model_providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    protocol: text('protocol', { enum: ['anthropic'] })
      .notNull()
      .default('anthropic'),
    baseUrl: text('base_url').notNull(),
    credentialEncrypted: text('credential_encrypted').notNull(),
    models: jsonb('models').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 14, scale: 4 }),
    alertRatio: numeric('alert_ratio', { precision: 4, scale: 3 }).notNull().default('0.800'),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_providers_name_idx').on(t.name),
    index('model_providers_enabled_priority_idx').on(t.enabled, t.priority),
    check('model_providers_priority_check', sql`${t.priority} >= 0`),
    check('model_providers_alert_ratio_check', sql`${t.alertRatio} >= 0 and ${t.alertRatio} <= 1`),
    check(
      'model_providers_budget_check',
      sql`${t.monthlyBudgetUsd} is null or ${t.monthlyBudgetUsd} >= 0`,
    ),
    check('model_providers_protocol_check', sql`${t.protocol} = 'anthropic'`),
  ],
);

export const providerRequestLogs = pgTable(
  'provider_request_logs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    providerId: text('provider_id')
      .notNull()
      .references(() => modelProviders.id, { onDelete: 'restrict' }),
    model: text('model'),
    statusCode: integer('status_code'),
    errorKind: text('error_kind', {
      enum: ['network', 'timeout', 'rate_limit', 'auth', 'upstream', 'content_blocked'],
    }),
    durationMs: integer('duration_ms').notNull(),
    upstreamRequestId: text('upstream_request_id'),
    failoverFromProviderId: text('failover_from_provider_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('provider_request_logs_provider_created_idx').on(t.providerId, t.createdAt),
    index('provider_request_logs_run_idx').on(t.runId),
    index('provider_request_logs_created_idx').on(t.createdAt),
    check(
      'provider_request_logs_error_kind_check',
      sql`${t.errorKind} is null or ${t.errorKind} in ('network', 'timeout', 'rate_limit', 'auth', 'upstream', 'content_blocked')`,
    ),
  ],
);
