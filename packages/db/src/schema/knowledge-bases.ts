import type {
  KnowledgeBaseSettings,
  KnowledgeBaseStatus,
  KnowledgeEmbeddingProtocol,
  KnowledgeModelProfileKind,
} from '@agentport/shared';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeBaseStatusSchema,
  knowledgeEmbeddingProtocolSchema,
  knowledgeModelProfileKindSchema,
} from '@agentport/shared';
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
import { servers } from './servers.js';

export const knowledgeModelProfiles = pgTable(
  'knowledge_model_profiles',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: knowledgeModelProfileKindSchema.options as [
        KnowledgeModelProfileKind,
        ...KnowledgeModelProfileKind[],
      ],
    }).notNull(),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions'),
    embeddingProtocol: text('embedding_protocol', {
      enum: knowledgeEmbeddingProtocolSchema.options as [
        KnowledgeEmbeddingProtocol,
        ...KnowledgeEmbeddingProtocol[],
      ],
    })
      .notNull()
      .default('openai'),
    imageInputEnabled: boolean('image_input_enabled').notNull().default(false),
    secretsEncrypted: text('secrets_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_model_profiles_kind_name_idx').on(t.kind, t.name),
    check(
      'knowledge_model_profiles_kind_check',
      sql`${t.kind} in (${sql.raw(knowledgeModelProfileKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'knowledge_model_profiles_dimensions_check',
      sql`(${t.kind} = 'embedding' and ${t.dimensions} = ${sql.raw(String(KNOWLEDGE_EMBEDDING_DIMENSIONS))}) or (${t.kind} in ('rerank', 'asr') and ${t.dimensions} is null)`,
    ),
    check(
      'knowledge_model_profiles_embedding_protocol_check',
      sql`${t.embeddingProtocol} in (${sql.raw(knowledgeEmbeddingProtocolSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'knowledge_model_profiles_image_input_check',
      sql`${t.imageInputEnabled} = false or (${t.kind} = 'embedding' and ${t.embeddingProtocol} = 'cohere_v2' and ${t.model} = 'embed-v4.0')`,
    ),
    check(
      'knowledge_model_profiles_asr_fields_check',
      sql`${t.kind} <> 'asr' or (${t.embeddingProtocol} = 'openai' and ${t.imageInputEnabled} = false)`,
    ),
  ],
);

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', {
      enum: knowledgeBaseStatusSchema.options as [KnowledgeBaseStatus, ...KnowledgeBaseStatus[]],
    })
      .notNull()
      .default('active'),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    embeddingProfileId: text('embedding_profile_id')
      .notNull()
      .references(() => knowledgeModelProfiles.id, { onDelete: 'restrict' }),
    rerankProfileId: text('rerank_profile_id').references(() => knowledgeModelProfiles.id, {
      onDelete: 'set null',
    }),
    asrProfileId: text('asr_profile_id').references(() => knowledgeModelProfiles.id, {
      onDelete: 'restrict',
    }),
    settings: jsonb('settings').$type<KnowledgeBaseSettings>().notNull(),
    ownerBusinessId: text('owner_business_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_bases_slug_idx').on(t.slug),
    uniqueIndex('knowledge_bases_server_idx').on(t.serverId),
    index('knowledge_bases_asr_profile_idx').on(t.asrProfileId),
    check(
      'knowledge_bases_status_check',
      sql`${t.status} in (${sql.raw(knowledgeBaseStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const knowledgeBasePins = pgTable(
  'knowledge_base_pins',
  {
    businessId: text('business_id').notNull(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_base_pins_pk').on(t.businessId, t.baseId),
    index('knowledge_base_pins_business_idx').on(t.businessId, t.pinnedAt.desc()),
  ],
);

export const knowledgeFolders = pgTable(
  'knowledge_folders',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => knowledgeFolders.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_folders_base_path_idx').on(t.baseId, t.path),
    index('knowledge_folders_base_parent_idx').on(t.baseId, t.parentId),
  ],
);

export const knowledgeTags = pgTable(
  'knowledge_tags',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knowledge_tags_base_name_idx').on(t.baseId, t.name)],
);
