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

/** 由 search_text 派生的 tsvector；应用不写这一列。 */
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
    /** 语料角色；FAQ 与 Wiki 索引共用文档/版本/分块，不另造执行引擎。 */
    contentKind: text('content_kind', { enum: ['document', 'faq', 'wiki'] })
      .notNull()
      .default('document'),
    /** 外部稳定 ID（飞书 token / `project:ref:path` / `feedURL:itemId`）；upload/manual 为 null。 */
    sourceId: text('source_id'),
    /** 指向 knowledge_sources；保留已删除来源 ID，不级联清空。 */
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
    /** 停用原因；source/range/remote 只能由后续成功同步重新证明权限后恢复。 */
    disabledReason: text('disabled_reason', { enum: ['manual', 'source', 'range', 'remote'] }),
    /** 不做 FK：版本表引用文档，反向引用会在删版本时成环。切版本前先在事务里写这里。 */
    currentVersionId: text('current_version_id'),
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
    // 外部来源只按 sourceId 匹配，绝不用标题；upload/manual 的 null 不受约束。
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
    /** 原件按内容寻址：`blobs/<前2位>/<sha256>`。 */
    blobSha256: text('blob_sha256').notNull(),
    markdownSha256: text('markdown_sha256').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /** 源端版本指纹：commit sha / 飞书 edit_time / feed 条目指纹。 */
    sourceRevision: text('source_revision'),
    /** 版本来源；人工 chunk 编辑也产生 manual 版本。 */
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
    /** FAQ 是文档版本数据，不新增 FAQ 执行引擎。 */
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
    /** 同版本父块序号；父块只作上下文，不参加排名。 */
    parentOrdinal: integer('parent_ordinal'),
    indexRole: text('index_role', { enum: ['leaf', 'parent'] })
      .notNull()
      .default('leaf'),
    kind: text('kind', { enum: ['text', 'table', 'image'] })
      .notNull()
      .default('text'),
    heading: text('heading'),
    content: text('content').notNull().default(''),
    /** 应用侧 Intl.Segmenter 分词后空格拼接，检索走 simple 词典。 */
    searchText: text('search_text').notNull().default(''),
    // 生成列：索引与查询都只依赖它，应用永远不写。
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', search_text)`,
    ),
    embedding: vector('embedding', { dimensions: 1024 }),
    enabled: boolean('enabled').notNull().default(true),
    editedByUser: boolean('edited_by_user').notNull().default(false),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    /** 解析器结构化定位；人工改正文后置空。 */
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

/** 文档与标签的多对多关系。 */
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
