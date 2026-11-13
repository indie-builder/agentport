import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { knowledgeBases } from './knowledge-bases.js';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentVersions,
} from './knowledge-documents.js';

export const knowledgeWikiPages = pgTable(
  'knowledge_wiki_pages',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** 主题目录：同库父子；循环由事务内校验拒绝。 */
    parentId: text('parent_id').references((): AnyPgColumn => knowledgeWikiPages.id, {
      onDelete: 'set null',
    }),
    position: integer('position').notNull().default(0),
    status: text('status', { enum: ['draft', 'published', 'stale', 'failed'] })
      .notNull()
      .default('draft'),
    currentVersionId: text('current_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_wiki_pages_base_slug_idx').on(t.baseId, t.slug),
    index('knowledge_wiki_pages_base_parent_idx').on(t.baseId, t.parentId, t.position),
    check(
      'knowledge_wiki_pages_status_check',
      sql`${t.status} in ('draft', 'published', 'stale', 'failed')`,
    ),
  ],
);

export const knowledgeWikiVersions = pgTable(
  'knowledge_wiki_versions',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id')
      .notNull()
      .references(() => knowledgeWikiPages.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    markdown: text('markdown').notNull(),
    sourceChunkIds: jsonb('source_chunk_ids').$type<string[]>().notNull().default([]),
    model: text('model').notNull(),
    generatedBy: text('generated_by', { enum: ['sdk', 'manual'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_wiki_versions_page_version_idx').on(t.pageId, t.version),
    check('knowledge_wiki_versions_generated_by_check', sql`${t.generatedBy} in ('sdk', 'manual')`),
  ],
);

export const knowledgeWikiSources = pgTable(
  'knowledge_wiki_sources',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => knowledgeWikiPages.id, { onDelete: 'cascade' }),
    documentId: text('document_id').references(() => knowledgeDocuments.id, {
      onDelete: 'set null',
    }),
    versionId: text('version_id').references(() => knowledgeDocumentVersions.id, {
      onDelete: 'set null',
    }),
    chunkId: text('chunk_id').references(() => knowledgeChunks.id, { onDelete: 'set null' }),
    stale: boolean('stale').notNull().default(false),
  },
  (t) => [
    uniqueIndex('knowledge_wiki_sources_page_chunk_idx').on(t.pageId, t.chunkId),
    index('knowledge_wiki_sources_document_idx').on(t.documentId),
  ],
);
