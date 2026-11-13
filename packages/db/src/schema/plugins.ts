import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * 插件：官方 `.claude-plugin/plugin.json` + 组件目录的完整快照（一个专家包里的插件根）。
 * `runtimeName` 是 SDK 看到的插件名（插件命名空间 `plugin:skill` 的前缀）；
 * 同一插件被多个智能体引用时只存一份，绑定走 `agent_plugins`。
 */
export const plugins = pgTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    /** 工作区目录名 `.claude/plugins/<slug>/`。 */
    slug: text('slug').notNull(),
    /** manifest 的 name；缺 manifest 时取 slug。 */
    runtimeName: text('runtime_name').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: text('version').notNull().default(''),
    /** 解析出的组件清单，供列表与详情展示，避免每次重扫文件。 */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    /** 原生市场来源 `name@marketplace`；ZIP 导入为 null。 */
    sourceId: text('source_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plugins_slug_idx').on(t.slug),
    uniqueIndex('plugins_runtime_name_idx').on(t.runtimeName),
    // 同一市场插件只纳入一次；多个 NULL（ZIP）不受影响。
    uniqueIndex('plugins_source_id_idx').on(t.sourceId),
  ],
);

/** 插件目录树；path 是相对插件根的安全相对路径。 */
export const pluginFiles = pgTable(
  'plugin_files',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    /** 保留 Unix 可执行位：插件 hooks 常直接执行 scripts/*.sh。 */
    executable: boolean('executable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plugin_files_plugin_path_idx').on(t.pluginId, t.path),
    index('plugin_files_plugin_idx').on(t.pluginId),
  ],
);
