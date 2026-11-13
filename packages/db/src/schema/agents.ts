import type { Agent, AgentInput, MemoryPolicy } from '@agentport/shared';
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
    /** 角色/岗位仅用于列表与详情展示。 */
    role: text('role').notNull().default('通用助手'),
    model: text('model').notNull(),
    description: text('description').notNull().default(''),
    systemPromptMd: text('system_prompt_md').notNull().default(''),
    /** [] 继承所有已绑定 MCP server 的工具；非空为显式自动批准规则，禁用用 disallowedTools。 */
    allowedTools: jsonb('allowed_tools').$type<string[]>().notNull().default([]),
    disallowedTools: jsonb('disallowed_tools').$type<string[]>().notNull().default([]),
    permissionMode: text('permission_mode')
      .$type<AgentInput['permissionMode']>()
      .notNull()
      .default('default'),
    /** 助手回复格式：markdown 或生成式 UI（OpenUI Lang 围栏）。 */
    uiFormat: text('ui_format').$type<AgentInput['uiFormat']>().notNull().default('markdown'),
    effort: text('effort').$type<NonNullable<AgentInput['effort']>>(),
    enabled: boolean('enabled').notNull().default(true),
    maxTurns: integer('max_turns').notNull().default(20),
    maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 4 }).notNull().default('2'),
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    /** 业务身份；创建后不变，不引用可删除的 authUsers。 */
    createdBy: text('created_by').notNull(),
    /** 当前负责人；成员授权与转交都看它。 */
    ownerBusinessId: text('owner_business_id').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: text('parent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'restrict',
    }),
    /** 绑定的命名运行环境；null 表示平台默认环境。 */
    runtimeEnvironmentId: text('runtime_environment_id').references(
      (): AnyPgColumn => runtimeEnvironments.id,
      { onDelete: 'restrict' },
    ),
    /** 专家记忆策略：运行期挂载/注入方式与主题数量上限；不进专家版本快照。 */
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
    // agent_skills_pk 只覆盖 (agent_id, skill_id)：删除 skill 或按 skill 反查要单独一条。
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
    /** hooks / MCP 默认关闭；管理员逐项授权后才随插件加载。 */
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
    /** 路径作用域（逗号分隔的 glob）；空表示对所有文件生效。 */
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
    // 每个智能体至多一个选中风格。
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
    // 同上：server 级联删除与按 server 反查需要 server_id 前导索引。
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
    /** 写入时的完整 Agent 配置，含 serverIds / skillIds。 */
    snapshot: jsonb('snapshot').$type<Agent>().notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_versions_agent_version_idx').on(t.agentId, t.version)],
);
