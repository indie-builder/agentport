import type {
  DataDomainEnrichmentStatus,
  DataDomainQueryApprovalMode,
  DataDomainQueryApprovalStatus,
  DataDomainQueryLogStatus,
  DataDomainVersionStatus,
} from '@agentport/shared';
import {
  dataDomainEnrichmentStatusSchema,
  dataDomainQueryApprovalModeSchema,
  dataDomainQueryApprovalStatusSchema,
  dataDomainQueryLogStatusSchema,
  dataDomainVersionStatusSchema,
} from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const dataDomainVersions = pgTable(
  'data_domain_versions',
  {
    id: text('id').primaryKey(),
    dataDomainId: text('data_domain_id')
      .notNull()
      .references((): AnyPgColumn => dataDomains.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: dataDomainVersionStatusSchema.options as [
        DataDomainVersionStatus,
        ...DataDomainVersionStatus[],
      ],
    })
      .notNull()
      .default('queued'),
    projectFiles: jsonb('project_files').$type<Record<string, string>>().notNull(),
    mdlManifest: text('mdl_manifest'),
    logTail: text('log_tail').notNull().default(''),
    logTruncated: boolean('log_truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('data_domain_versions_id_domain_idx').on(t.id, t.dataDomainId),
    index('data_domain_versions_domain_created_idx').on(t.dataDomainId, t.createdAt, t.id),
    check(
      'data_domain_versions_status_check',
      sql`${t.status} in (${sql.raw(dataDomainVersionStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'data_domain_versions_ready_manifest_check',
      sql`${t.status} <> 'ready' or ${t.mdlManifest} is not null`,
    ),
  ],
);

export const dataDomains = pgTable(
  'data_domains',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    datasource: text('datasource').notNull(),
    connectionEncrypted: text('connection_encrypted').notNull(),
    onlineVersionId: text('online_version_id'),
    queryApprovalMode: text('query_approval_mode', {
      enum: dataDomainQueryApprovalModeSchema.options as [
        DataDomainQueryApprovalMode,
        ...DataDomainQueryApprovalMode[],
      ],
    })
      .notNull()
      .default('off'),
    createdBy: text('created_by').notNull(),
    ownerBusinessId: text('owner_business_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('data_domains_slug_idx').on(t.slug),
    check('data_domains_datasource_check', sql`length(${t.datasource}) > 0`),
    check(
      'data_domains_query_approval_mode_check',
      sql`${t.queryApprovalMode} in (${sql.raw(dataDomainQueryApprovalModeSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    foreignKey({
      columns: [t.onlineVersionId, t.id],
      foreignColumns: [dataDomainVersions.id, dataDomainVersions.dataDomainId],
      name: 'data_domains_online_version_fk',
    }),
  ],
);

export const dataDomainIdentities = pgTable(
  'data_domain_identities',
  {
    id: text('id').primaryKey(),
    dataDomainId: text('data_domain_id')
      .notNull()
      .references((): AnyPgColumn => dataDomains.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    properties: jsonb('properties').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('data_domain_identities_domain_business_idx').on(t.dataDomainId, t.businessId),
    index('data_domain_identities_domain_idx').on(t.dataDomainId),
    check('data_domain_identities_business_check', sql`length(${t.businessId}) > 0`),
  ],
);

export const dataDomainQueryLogs = pgTable(
  'data_domain_query_logs',
  {
    id: text('id').primaryKey(),
    dataDomainId: text('data_domain_id')
      .notNull()
      .references((): AnyPgColumn => dataDomains.id, { onDelete: 'cascade' }),
    versionId: text('version_id'),
    serverId: text('server_id').notNull(),
    runId: text('run_id').notNull(),
    actorBusinessId: text('actor_business_id'),
    sqlSummary: text('sql_summary').notNull().default(''),
    rowCount: integer('row_count'),
    status: text('status', {
      enum: dataDomainQueryLogStatusSchema.options as [
        DataDomainQueryLogStatus,
        ...DataDomainQueryLogStatus[],
      ],
    }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('data_domain_query_logs_domain_created_idx').on(t.dataDomainId, t.createdAt, t.id),
    index('data_domain_query_logs_run_idx').on(t.runId),
    check(
      'data_domain_query_logs_status_check',
      sql`${t.status} in (${sql.raw(dataDomainQueryLogStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const dataDomainQueryApprovals = pgTable(
  'data_domain_query_approvals',
  {
    id: text('id').primaryKey(),
    dataDomainId: text('data_domain_id')
      .notNull()
      .references((): AnyPgColumn => dataDomains.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    runId: text('run_id').notNull(),
    actorBusinessId: text('actor_business_id'),
    sqlText: text('sql_text').notNull(),
    sqlHash: text('sql_hash').notNull(),
    status: text('status', {
      enum: dataDomainQueryApprovalStatusSchema.options as [
        DataDomainQueryApprovalStatus,
        ...DataDomainQueryApprovalStatus[],
      ],
    })
      .notNull()
      .default('pending'),
    decisionNote: text('decision_note').notNull().default(''),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByBusinessId: text('decided_by_business_id'),
  },
  (t) => [
    index('data_domain_query_approvals_domain_created_idx').on(t.dataDomainId, t.requestedAt, t.id),
    uniqueIndex('data_domain_query_approvals_pending_uniq')
      .on(t.dataDomainId, t.runId, t.sqlHash)
      .where(sql`${t.status} = 'pending'`),
    check(
      'data_domain_query_approvals_status_check',
      sql`${t.status} in (${sql.raw(dataDomainQueryApprovalStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'data_domain_query_approvals_decision_check',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`,
    ),
  ],
);

export const dataDomainEnrichmentProposals = pgTable(
  'data_domain_enrichment_proposals',
  {
    id: text('id').primaryKey(),
    dataDomainId: text('data_domain_id')
      .notNull()
      .references((): AnyPgColumn => dataDomains.id, { onDelete: 'cascade' }),
    sourceVersionId: text('source_version_id').notNull(),
    status: text('status', {
      enum: dataDomainEnrichmentStatusSchema.options as [
        DataDomainEnrichmentStatus,
        ...DataDomainEnrichmentStatus[],
      ],
    })
      .notNull()
      .default('generating'),
    instruction: text('instruction').notNull(),
    summary: text('summary').notNull().default(''),
    projectFiles: jsonb('project_files').$type<Record<string, string>>(),
    error: text('error').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByBusinessId: text('decided_by_business_id'),
  },
  (t) => [
    index('data_domain_enrichment_proposals_domain_created_idx').on(
      t.dataDomainId,
      t.createdAt,
      t.id,
    ),
    check(
      'data_domain_enrichment_proposals_status_check',
      sql`${t.status} in (${sql.raw(dataDomainEnrichmentStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);
