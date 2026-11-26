import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const plugins = pgTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    runtimeName: text('runtime_name').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: text('version').notNull().default(''),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    sourceId: text('source_id'),
    ownerBusinessId: text('owner_business_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plugins_slug_idx').on(t.slug),
    uniqueIndex('plugins_runtime_name_idx').on(t.runtimeName),
    uniqueIndex('plugins_source_id_idx').on(t.sourceId),
  ],
);

export const pluginFiles = pgTable(
  'plugin_files',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    executable: boolean('executable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plugin_files_plugin_path_idx').on(t.pluginId, t.path),
    index('plugin_files_plugin_idx').on(t.pluginId),
  ],
);
