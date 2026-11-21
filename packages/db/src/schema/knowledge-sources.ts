import type {
  KnowledgeJob,
  KnowledgeSourceConfigType,
  KnowledgeSourceProbeResult,
  KnowledgeSourceRangeKind,
} from '@agentport/shared';
import {
  knowledgeJobStatusSchema,
  knowledgeSourceConfigTypeSchema,
  knowledgeSourceRangeKindSchema,
} from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { knowledgeBases } from './knowledge-bases.js';
import { knowledgeDocuments } from './knowledge-documents.js';

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: knowledgeSourceConfigTypeSchema.options as [
        KnowledgeSourceConfigType,
        ...KnowledgeSourceConfigType[],
      ],
    }).notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secretsEncrypted: text('secrets_encrypted'),
    status: text('status', {
      enum: ['active', 'paused', 'auth_error', 'disabled'],
    })
      .notNull()
      .default('active'),
    syncCron: text('sync_cron'),
    cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncStatus: text('last_sync_status'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_sources_base_idx').on(t.baseId),
    check(
      'knowledge_sources_type_check',
      sql`${t.type} in ('feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'lark_wiki', 'lark_drive', 'notion', 'confluence', 'yuque', 'dingtalk', 'ima', 'seafile', 'nextcloud')`,
    ),
    check(
      'knowledge_sources_status_check',
      sql`${t.status} in ('active', 'paused', 'auth_error', 'disabled')`,
    ),
  ],
);

export const knowledgeSourceRanges = pgTable(
  'knowledge_source_ranges',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: knowledgeSourceRangeKindSchema.options as [
        KnowledgeSourceRangeKind,
        ...KnowledgeSourceRangeKind[],
      ],
    }).notNull(),
    externalId: text('external_id').notNull(),
    ref: text('ref'),
    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    uniqueIndex('knowledge_source_ranges_scope_idx').on(
      t.sourceId,
      t.kind,
      t.externalId,
      sql`coalesce(${t.ref}, '')`,
    ),
    check(
      'knowledge_source_ranges_kind_check',
      sql`${t.kind} in ('wiki_space', 'wiki_node', 'drive_folder', 'gitlab_project', 'github_repo', 'feed', 'notion_page', 'notion_database', 'notion_data_source', 'confluence_space', 'confluence_page', 'yuque_repo', 'dingtalk_workspace', 'dingtalk_node', 'ima_kb', 'seafile_repo', 'nextcloud_path')`,
    ),
  ],
);

export const knowledgeDocumentSourceRanges = pgTable(
  'knowledge_document_source_ranges',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    rangeId: text('range_id')
      .notNull()
      .references(() => knowledgeSourceRanges.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'knowledge_document_source_ranges_pk', columns: [t.documentId, t.rangeId] }),
    index('knowledge_document_source_ranges_range_idx').on(t.rangeId),
  ],
);

export const knowledgeSyncRuns = pgTable(
  'knowledge_sync_runs',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: knowledgeJobStatusSchema.options as [
        KnowledgeJob['status'],
        ...KnowledgeJob['status'][],
      ],
    })
      .notNull()
      .default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    cursorBefore: jsonb('cursor_before').$type<Record<string, unknown>>(),
    cursorAfter: jsonb('cursor_after').$type<Record<string, unknown>>(),
    stats: jsonb('stats')
      .$type<{
        listed: number;
        created: number;
        updated: number;
        disabled: number;
        failed: number;
      }>()
      .notNull()
      .default({ listed: 0, created: 0, updated: 0, disabled: 0, failed: 0 }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_sync_runs_source_idx').on(t.sourceId, t.createdAt.desc()),
    check(
      'knowledge_sync_runs_status_check',
      sql`${t.status} in (${sql.raw(knowledgeJobStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const knowledgeSyncItems = pgTable(
  'knowledge_sync_items',
  {
    id: text('id').primaryKey(),
    syncRunId: text('sync_run_id')
      .notNull()
      .references(() => knowledgeSyncRuns.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    rangeId: text('range_id').references(() => knowledgeSourceRanges.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    documentId: text('document_id').references(() => knowledgeDocuments.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: ['failed', 'skipped'] }).notNull(),
    code: text('code').notNull(),
    message: text('message').notNull().default(''),
    retryable: boolean('retryable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_sync_items_run_idx').on(t.syncRunId, t.createdAt),
    index('knowledge_sync_items_source_idx').on(t.sourceId, t.createdAt),
    check('knowledge_sync_items_status_check', sql`${t.status} in ('failed', 'skipped')`),
    check('knowledge_sync_items_message_check', sql`char_length(${t.message}) <= 500`),
  ],
);

export const knowledgeJobs = pgTable(
  'knowledge_jobs',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: [
        'ingest',
        'reindex',
        'sync',
        'source_probe',
        'wiki_generate',
        'summary',
        'tag_generate',
        'cleanup',
      ],
    }).notNull(),
    baseId: text('base_id').references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: text('document_id').references(() => knowledgeDocuments.id, {
      onDelete: 'cascade',
    }),
    sourceId: text('source_id').references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: knowledgeJobStatusSchema.options as [
        KnowledgeJob['status'],
        ...KnowledgeJob['status'][],
      ],
    })
      .notNull()
      .default('queued'),
    step: text('step'),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    result: jsonb('result').$type<KnowledgeSourceProbeResult>(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('knowledge_jobs_status_created_idx').on(t.status, t.createdAt),
    index('knowledge_jobs_base_created_idx').on(t.baseId, t.createdAt.desc()),
    index('knowledge_jobs_document_idx').on(t.documentId),
    check(
      'knowledge_jobs_type_check',
      sql`${t.type} in ('ingest', 'reindex', 'sync', 'source_probe', 'wiki_generate', 'summary', 'tag_generate', 'cleanup')`,
    ),
    check(
      'knowledge_jobs_status_check',
      sql`${t.status} in (${sql.raw(knowledgeJobStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);
