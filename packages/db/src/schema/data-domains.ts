import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
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
    status: text('status', { enum: ['queued', 'building', 'ready', 'failed'] })
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
      sql`${t.status} in ('queued', 'building', 'ready', 'failed')`,
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
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('data_domains_slug_idx').on(t.slug),
    check('data_domains_datasource_check', sql`length(${t.datasource}) > 0`),
    foreignKey({
      columns: [t.onlineVersionId, t.id],
      foreignColumns: [dataDomainVersions.id, dataDomainVersions.dataDomainId],
      name: 'data_domains_online_version_fk',
    }),
  ],
);
