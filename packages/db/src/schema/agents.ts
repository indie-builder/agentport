import type { Agent, AgentDefinition, AgentInput, MemoryPolicy } from '@agentport/shared';
import { DEFAULT_MEMORY_POLICY } from '@agentport/shared';
import { eq, isNotNull, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { plugins } from './plugins.js';
import { runtimeEnvironments } from './runtime-environments.js';
import { servers } from './servers.js';
import { skills } from './skills.js';

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull().default('通用助手'),
    model: text('model').notNull(),
    description: text('description').notNull().default(''),
    systemPromptMd: text('system_prompt_md').notNull().default(''),
    allowedTools: jsonb('allowed_tools').$type<string[]>().notNull().default([]),
    disallowedTools: jsonb('disallowed_tools').$type<string[]>().notNull().default([]),
    permissionMode: text('permission_mode')
      .$type<AgentInput['permissionMode']>()
      .notNull()
      .default('default'),
    uiFormat: text('ui_format').$type<AgentInput['uiFormat']>().notNull().default('markdown'),
    effort: text('effort').$type<NonNullable<AgentInput['effort']>>(),
    enabled: boolean('enabled').notNull().default(true),
    visibility: text('visibility').$type<AgentInput['visibility']>().notNull().default('private'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    publishedVersion: integer('published_version'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    maxTurns: integer('max_turns').notNull().default(20),
    maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 4 }).notNull().default('2'),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 10, scale: 4 }),
    budgetAlertRatio: numeric('budget_alert_ratio', { precision: 4, scale: 3 })
      .notNull()
      .default('0.800'),
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    createdBy: text('created_by').notNull(),
    ownerBusinessId: text('owner_business_id').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    parentId: text('parent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'restrict',
    }),
    runtimeEnvironmentId: text('runtime_environment_id').references(
      (): AnyPgColumn => runtimeEnvironments.id,
      { onDelete: 'restrict' },
    ),
    memoryPolicy: jsonb('memory_policy')
      .$type<MemoryPolicy>()
      .notNull()
      .default(DEFAULT_MEMORY_POLICY),
    hooksEnabled: boolean('hooks_enabled').notNull().default(false),
    hooksConfig: jsonb('hooks_config').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_slug_idx').on(t.slug),
    uniqueIndex('agents_single_default_idx').on(t.isDefault).where(sql`${t.isDefault} = true`),
    index('agents_owner_idx').on(t.ownerBusinessId),
    index('agents_parent_idx').on(t.parentId),
    index('agents_runtime_environment_idx')
      .on(t.runtimeEnvironmentId)
      .where(isNotNull(t.runtimeEnvironmentId)),
    index('agents_visibility_idx').on(t.visibility),
    index('agents_archived_idx').on(t.archivedAt).where(isNotNull(t.archivedAt)),
    check('agents_visibility_check', sql`${t.visibility} in ('private', 'organization')`),
    check(
      'agents_tags_check',
      sql`jsonb_typeof(${t.tags}) = 'array' and not jsonb_path_exists(${t.tags}, '$[*] ? (@.type() != "string")')`,
    ),
    check(
      'agents_permission_mode_check',
      sql`${t.permissionMode} in ('dontAsk', 'plan', 'default', 'acceptEdits')`,
    ),
    check('agents_ui_format_check', sql`${t.uiFormat} in ('markdown', 'openui')`),
    check(
      'agents_allowed_tools_check',
      sql`jsonb_typeof(${t.allowedTools}) = 'array' and not jsonb_path_exists(${t.allowedTools}, '$[*] ? (@.type() != "string")')`,
    ),
  ],
);

export const agentFavorites = pgTable(
  'agent_favorites',
  {
    businessId: text('business_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.businessId, t.agentId] }),
    index('agent_favorites_business_idx').on(t.businessId),
  ],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('agent_skills_pk').on(t.agentId, t.skillId),
    index('agent_skills_skill_idx').on(t.skillId),
  ],
);

/**
 * 智能体绑定插件。插件是会话级能力（SDK `plugins` 没有按子智能体隔离的入口），
 * 因此只允许顶层智能体绑定，子智能体的关联由应用层拒绝。
 */
export const agentPlugins = pgTable(
  'agent_plugins',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    allowHooks: boolean('allow_hooks').notNull().default(false),
    allowMcp: boolean('allow_mcp').notNull().default(false),
  },
  (t) => [
    uniqueIndex('agent_plugins_pk').on(t.agentId, t.pluginId),
    index('agent_plugins_plugin_idx').on(t.pluginId),
  ],
);

/**
 * 智能体项目规则。渲染到工作区 `.claude/rules/<slug>.md`，由 Claude Code
 * project source 随会话加载；`globs` 写入 frontmatter 的 `paths` 做路径作用域。
 */
export const agentRules = pgTable(
  'agent_rules',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    content: text('content').notNull().default(''),
    globs: text('globs').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_rules_agent_slug_idx').on(t.agentId, t.slug),
    index('agent_rules_agent_idx').on(t.agentId),
  ],
);

/**
 * 智能体自定义输出风格（官方 `.claude/output-styles/*.md`）。至多一个 isSelected，
 * 选中者写进 `.claude/settings.json` 的 `outputStyle`，由 project source 激活。
 */
export const agentOutputStyles = pgTable(
  'agent_output_styles',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    keepCodingInstructions: boolean('keep_coding_instructions').notNull().default(false),
    body: text('body').notNull().default(''),
    isSelected: boolean('is_selected').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_output_styles_agent_slug_idx').on(t.agentId, t.slug),
    uniqueIndex('agent_output_styles_selected_idx').on(t.agentId).where(eq(t.isSelected, true)),
  ],
);

/**
 * 智能体工作流（官方 `.claude/workflows/<slug>.js`）。
 * content 是完整脚本，name/description 由保存时解析的 meta 填充。
 */
export const agentWorkflows = pgTable(
  'agent_workflows',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_workflows_agent_slug_idx').on(t.agentId, t.slug),
    index('agent_workflows_agent_idx').on(t.agentId),
  ],
);

export const agentHookFiles = pgTable(
  'agent_hook_files',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    executable: boolean('executable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_hook_files_agent_path_idx').on(t.agentId, t.path),
    index('agent_hook_files_agent_idx').on(t.agentId),
  ],
);

export const agentServers = pgTable(
  'agent_servers',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('agent_servers_pk').on(t.agentId, t.serverId),
    index('agent_servers_server_idx').on(t.serverId),
  ],
);

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<Agent>().notNull(),
    definition: jsonb('definition').$type<AgentDefinition>(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_versions_agent_version_idx').on(t.agentId, t.version)],
);
