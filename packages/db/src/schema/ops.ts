import type { AuditActorKind, NotificationKind } from '@agentport/shared';
import { auditActorKindSchema, notificationKindSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
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

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull().default('system'),
    actorKind: text('actor_kind', {
      enum: auditActorKindSchema.options as [AuditActorKind, ...AuditActorKind[]],
    })
      .notNull()
      .default('service'),
    subjectBusinessId: text('subject_business_id'),
    action: text('action').notNull(),
    target: text('target'),
    inputDigest: text('input_digest'),
    detail: jsonb('detail').$type<unknown>(),
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    chainSeq: bigserial('chain_seq', { mode: 'number' }).notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_chain_seq_idx').on(t.chainSeq),
    // action LIKE 'x%' 走 text_pattern_ops（C collation 下才能用前缀索引）；
    // 尾随列让「前缀 + 时间倒序 + id 游标」整个查询都在索引里完成。
    index('audit_log_action_created_idx').on(
      sql`${t.action} text_pattern_ops`,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

export const platformBootstrap = pgTable(
  'platform_bootstrap',
  {
    id: text('id').primaryKey(),
    adminBusinessId: text('admin_business_id'),
    rolesRevision: integer('roles_revision').notNull().default(0),
    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('platform_bootstrap_revision_check', sql`${t.rolesRevision} >= 0`)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id').notNull(),
    kind: text('kind', {
      enum: notificationKindSchema.options as [NotificationKind, ...NotificationKind[]],
    }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link').notNull(),
    sourceId: text('source_id').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_idx').on(t.businessId, t.kind, t.sourceId),
    index('notifications_list_idx').on(t.businessId, t.createdAt, t.id),
    index('notifications_unread_idx').on(t.businessId, t.createdAt).where(sql`${t.readAt} is null`),
    check(
      'notifications_kind_check',
      sql`${t.kind} in (${sql.raw(notificationKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const platformSettings = pgTable(
  'platform_settings',
  {
    id: text('id').primaryKey(),
    retentionRunDays: integer('retention_run_days').notNull().default(90),
    retentionMessageDays: integer('retention_message_days').notNull().default(30),
    retentionAgentVersions: integer('retention_agent_versions').notNull().default(50),
    alertRunFailuresEnabled: boolean('alert_run_failures_enabled').notNull().default(true),
    alertRunFailuresThreshold: integer('alert_run_failures_threshold').notNull().default(5),
    alertRunFailuresWindowMinutes: integer('alert_run_failures_window_minutes')
      .notNull()
      .default(30),
    alertQueueFailedEnabled: boolean('alert_queue_failed_enabled').notNull().default(true),
    alertQueueFailedThreshold: integer('alert_queue_failed_threshold').notNull().default(1),
    alertQueueWaitingEnabled: boolean('alert_queue_waiting_enabled').notNull().default(true),
    alertQueueWaitingThreshold: integer('alert_queue_waiting_threshold').notNull().default(100),
    sloEnabled: boolean('slo_enabled').notNull().default(true),
    sloWindowMinutes: integer('slo_window_minutes').notNull().default(60),
    sloRunSuccessTarget: numeric('slo_run_success_target', { precision: 4, scale: 3 })
      .notNull()
      .default('0.950'),
    sloRunP95LatencyMs: integer('slo_run_p95_latency_ms').notNull().default(120000),
    sloQueueOldestWaitMs: integer('slo_queue_oldest_wait_ms').notNull().default(60000),
    sloProviderErrorRateTarget: numeric('slo_provider_error_rate_target', {
      precision: 4,
      scale: 3,
    })
      .notNull()
      .default('0.050'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    check(
      'platform_settings_run_failures_threshold_check',
      sql`${t.alertRunFailuresThreshold} > 0`,
    ),
    check(
      'platform_settings_run_failures_window_check',
      sql`${t.alertRunFailuresWindowMinutes} > 0`,
    ),
    check(
      'platform_settings_queue_failed_threshold_check',
      sql`${t.alertQueueFailedThreshold} > 0`,
    ),
    check(
      'platform_settings_queue_waiting_threshold_check',
      sql`${t.alertQueueWaitingThreshold} > 0`,
    ),
    check(
      'platform_settings_slo_window_check',
      sql`${t.sloWindowMinutes} >= 5 and ${t.sloWindowMinutes} <= 1440`,
    ),
    check(
      'platform_settings_slo_run_success_check',
      sql`${t.sloRunSuccessTarget} >= 0 and ${t.sloRunSuccessTarget} <= 1`,
    ),
    check('platform_settings_slo_p95_check', sql`${t.sloRunP95LatencyMs} > 0`),
    check('platform_settings_slo_queue_wait_check', sql`${t.sloQueueOldestWaitMs} > 0`),
    check(
      'platform_settings_slo_provider_error_check',
      sql`${t.sloProviderErrorRateTarget} >= 0 and ${t.sloProviderErrorRateTarget} <= 1`,
    ),
  ],
);
