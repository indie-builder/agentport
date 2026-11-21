import type { KnowledgeFaq, KnowledgeLocator, KnowledgeSourceType } from '@agentport/shared';
import { knowledgeSourceTypeSchema } from '@agentport/shared';
import { isNotNull, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import {
  knowledgeBases,
  knowledgeFolders,
  knowledgeModelProfiles,
  knowledgeTags,
} from './knowledge-bases.js';

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
  fromDriver: (value) => value as string,
});

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => knowledgeFolders.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    sourceType: text('source_type', {
      enum: knowledgeSourceTypeSchema.options as [KnowledgeSourceType, ...KnowledgeSourceType[]],
    }).notNull(),
    contentKind: text('content_kind', { enum: ['document', 'faq', 'wiki'] })
      .notNull()
      .default('document'),
    sourceId: text('source_id'),
    sourceConnectionId: text('source_connection_id'),
    sourceUrl: text('source_url'),
    sourcePath: text('source_path'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    status: text('status', {
      enum: ['pending', 'processing', 'ready', 'failed', 'disabled'],
    })
      .notNull()
      .default('pending'),
    disabledReason: text('disabled_reason', { enum: ['manual', 'source', 'range', 'remote'] }),
    currentVersionId: text('current_version_id'),
    summary: text('summary'),
    summaryStatus: text('summary_status', {
      enum: ['none', 'pending', 'generating', 'ready', 'failed'],
    })
      .notNull()
      .default('none'),
    summaryVersionId: text('summary_version_id'),
    summaryGeneratedAt: timestamp('summary_generated_at', { withTimezone: true }),
    summaryError: text('summary_error'),
    contentHash: text('content_hash'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_documents_base_status_idx').on(t.baseId, t.status, t.updatedAt.desc()),
    index('knowledge_documents_base_folder_idx').on(t.baseId, t.folderId),
    index('knowledge_documents_base_kind_updated_idx').on(t.baseId, t.contentKind, t.updatedAt),
    index('knowledge_documents_source_connection_idx').on(t.sourceConnectionId),
    uniqueIndex('knowledge_documents_source_idx')
      .on(t.baseId, t.sourceType, t.sourceId)
      .where(isNotNull(t.sourceId)),
    check(
      'knowledge_documents_source_type_check',
      sql`${t.sourceType} in ('upload', 'url', 'feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'manual', 'lark_wiki', 'lark_drive', 'notion', 'confluence', 'yuque', 'dingtalk', 'ima', 'seafile', 'nextcloud')`,
    ),
    check(
      'knowledge_documents_status_check',
      sql`${t.status} in ('pending', 'processing', 'ready', 'failed', 'disabled')`,
    ),
    check(
      'knowledge_documents_content_kind_check',
      sql`${t.contentKind} in ('document', 'faq', 'wiki')`,
    ),
    check(
      'knowledge_documents_disabled_reason_check',
      sql`${t.disabledReason} is null or ${t.disabledReason} in ('manual', 'source', 'range', 'remote')`,
    ),
    check(
      'knowledge_documents_disabled_status_check',
      sql`(${t.status} = 'disabled') = (${t.disabledReason} is not null)`,
    ),
    check(
      'knowledge_documents_summary_status_check',
      sql`${t.summaryStatus} in ('none', 'pending', 'generating', 'ready', 'failed')`,
    ),
  ],
);

export const knowledgeDocumentVersions = pgTable(
  'knowledge_document_versions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    blobSha256: text('blob_sha256').notNull(),
    markdownSha256: text('markdown_sha256').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sourceRevision: text('source_revision'),
    origin: text('origin', { enum: ['source', 'manual', 'faq', 'wiki'] })
      .notNull()
      .default('source'),
    parentVersionId: text('parent_version_id').references(
      (): AnyPgColumn => knowledgeDocumentVersions.id,
      {
        onDelete: 'set null',
      },
    ),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    faq: jsonb('faq').$type<KnowledgeFaq>(),
    parseStatus: text('parse_status', { enum: ['parsed', 'parse_failed'] }).notNull(),
    pageMap: jsonb('page_map')
      .$type<Array<{ page: number; startOffset: number; endOffset: number }>>()
      .notNull()
      .default([]),
    images: jsonb('images')
      .$type<
        Array<{ name: string; sha256: string; mimeType: string; page: number; warnings: string[] }>
      >()
      .notNull()
      .default([]),
    embeddingProfileId: text('embedding_profile_id')
      .notNull()
      .references(() => knowledgeModelProfiles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_document_versions_document_version_idx').on(t.documentId, t.version),
    index('knowledge_document_versions_blob_idx').on(t.blobSha256),
    index('knowledge_document_versions_parent_idx').on(t.parentVersionId),
    check(
      'knowledge_document_versions_parse_status_check',
      sql`${t.parseStatus} in ('parsed', 'parse_failed')`,
    ),
    check(
      'knowledge_document_versions_origin_check',
      sql`${t.origin} in ('source', 'manual', 'faq', 'wiki')`,
    ),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => knowledgeDocumentVersions.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => knowledgeFolders.id, {
      onDelete: 'set null',
    }),
    ordinal: integer('ordinal').notNull(),
    parentOrdinal: integer('parent_ordinal'),
    indexRole: text('index_role', { enum: ['leaf', 'parent'] })
      .notNull()
      .default('leaf'),
    kind: text('kind', { enum: ['text', 'table', 'image'] })
      .notNull()
      .default('text'),
    heading: text('heading'),
    content: text('content').notNull().default(''),
    searchText: text('search_text').notNull().default(''),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', search_text)`,
    ),
    embedding: vector('embedding', { dimensions: 1024 }),
    enabled: boolean('enabled').notNull().default(true),
    editedByUser: boolean('edited_by_user').notNull().default(false),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    locator: jsonb('locator').$type<KnowledgeLocator>(),
    tokenCount: integer('token_count').notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_chunks_version_ordinal_idx').on(t.versionId, t.ordinal),
    index('knowledge_chunks_search_idx').using('gin', t.searchVector),
    index('knowledge_chunks_base_document_idx').on(t.baseId, t.documentId),
    check('knowledge_chunks_kind_check', sql`${t.kind} in ('text', 'table', 'image')`),
    check('knowledge_chunks_index_role_check', sql`${t.indexRole} in ('leaf', 'parent')`),
  ],
);

export const knowledgeDocumentTags = pgTable(
  'knowledge_document_tags',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => knowledgeTags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('knowledge_document_tags_pk').on(t.documentId, t.tagId),
    index('knowledge_document_tags_tag_idx').on(t.tagId),
  ],
);
