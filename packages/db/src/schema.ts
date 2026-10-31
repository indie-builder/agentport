import type {
  Agent,
  ChatEvent,
  KnowledgeBaseSettings,
  MemoryContentSnapshot,
  MemoryReviewProposal,
  MemoryReviewSource,
  MemoryReviewTarget,
  NativeQuestions,
  ResolvedRuntimeEnvironment,
} from '@agentport/shared';
import { DEFAULT_RUNTIME_DOCKERFILE } from '@agentport/shared';
import { eq, isNotNull, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** pgvector 列：drizzle 无原生类型，写入时转 `[a,b]` 字面量，读取时还原数组。 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector(1024)',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value as string) as number[],
});

/** 由 search_text 派生的 tsvector；应用不写这一列。 */
const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
  fromDriver: (value) => value as string,
});

export const servers = pgTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['stdio', 'http', 'generated', 'knowledge'] }).notNull(),
    description: text('description').notNull().default(''),
    // command / args / url / headers 等非敏感字段
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    // AES-256-GCM 加密后的 env / headers
    secretsEncrypted: text('secrets_encrypted'),
    /** 最近一次「测试连接」的结果快照；刷新后仍能显示连接健康度。 */
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastToolCount: integer('last_tool_count'),
    /** 最近一次试连实际解析到的环境版本身份；不能把一次成功当成其他环境也成功。 */
    lastTestRuntimeEnvironment: jsonb(
      'last_test_runtime_environment',
    ).$type<ResolvedRuntimeEnvironment>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('servers_name_idx').on(t.name),
    check('servers_kind_check', sql`${t.kind} in ('stdio', 'http', 'generated', 'knowledge')`),
  ],
);

export const apiTools = pgTable(
  'api_tools',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    method: text('method').notNull(),
    pathTemplate: text('path_template').notNull(),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    paramsIn: text('params_in', { enum: ['query', 'body'] })
      .notNull()
      .default('query'),
    enabled: boolean('enabled').notNull().default(true),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tools_server_name_idx').on(t.serverId, t.name)],
);

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
    permissionMode: text('permission_mode').notNull().default('default'),
    /** 助手回复格式：markdown 或生成式 UI（OpenUI Lang 围栏）。 */
    uiFormat: text('ui_format').notNull().default('markdown'),
    effort: text('effort'),
    enabled: boolean('enabled').notNull().default(true),
    maxTurns: integer('max_turns').notNull().default(20),
    maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 4 }).notNull().default('2'),
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    /** 业务身份；创建后不变，不引用可删除的 authUsers。 */
    createdBy: text('created_by').notNull(),
    /** 当前负责人；成员授权与转交都看它。 */
    ownerBusinessId: text('owner_business_id').notNull(),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: text('parent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'set null',
    }),
    /** 绑定的命名运行环境；null 表示平台默认环境。 */
    runtimeEnvironmentId: text('runtime_environment_id').references(
      (): AnyPgColumn => runtimeEnvironments.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_slug_idx').on(t.slug),
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

/**
 * 运行环境构建版本：一次构建一行，不可覆盖。先于 runtime_environments 声明，
 * 是为了让 environments.online_version_id 能建到本表 (id, environment_id) 的复合外键；
 * environment_id 的引用由 Drizzle 延迟解析，初始化顺序不受影响。
 */
export const runtimeEnvironmentVersions = pgTable(
  'runtime_environment_versions',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references((): AnyPgColumn => runtimeEnvironments.id, { onDelete: 'restrict' }),
    /** 入队时冻结的完整 Dockerfile。 */
    dockerfile: text('dockerfile').notNull(),
    /** 固定基座身份（本地 tag/ID），构建时传入。 */
    baseImageId: text('base_image_id').notNull(),
    status: text('status', { enum: ['queued', 'building', 'ready', 'failed'] })
      .notNull()
      .default('queued'),
    /** 仅用于定位本地镜像；创建容器使用 imageId。 */
    imageTag: text('image_tag'),
    /** 构建成功后的镜像内容 ID。 */
    imageId: text('image_id'),
    buildLog: text('build_log').notNull().default(''),
    logTruncated: boolean('log_truncated').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 复合外键的引用目标：版本只能被自己所属环境的线上指针引用。
    unique('runtime_environment_versions_id_environment_idx').on(t.id, t.environmentId),
    // 升序复合索引由 PostgreSQL 反向扫描满足 (created_at, id) 倒序分页。
    index('runtime_environment_versions_environment_created_idx').on(
      t.environmentId,
      t.createdAt,
      t.id,
    ),
    check(
      'runtime_environment_versions_status_check',
      sql`${t.status} in ('queued', 'building', 'ready', 'failed')`,
    ),
  ],
);

/** 命名的运行环境：智能体绑定环境，不绑定构建版本。 */
export const runtimeEnvironments = pgTable(
  'runtime_environments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Dockerfile 草稿；每次构建入队时快照到版本行。 */
    dockerfile: text('dockerfile').notNull().default(DEFAULT_RUNTIME_DOCKERFILE),
    /** 平台默认环境；至多一个，由 partial unique index 保证。 */
    isDefault: boolean('is_default').notNull().default(false),
    /** 线上版本指针；发布与回退都只改这里。 */
    onlineVersionId: text('online_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_environments_name_idx').on(t.name),
    uniqueIndex('runtime_environments_default_idx')
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
    // 线上版本必须属于本环境：复合外键让跨环境的指针写不进来。
    foreignKey({
      columns: [t.onlineVersionId, t.id],
      foreignColumns: [runtimeEnvironmentVersions.id, runtimeEnvironmentVersions.environmentId],
      name: 'runtime_environments_online_version_fk',
    }),
  ],
);

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    body: text('body').notNull().default(''),
    /** SKILL.md frontmatter 的来源描述字段，导入/安装时原样保留。 */
    license: text('license'),
    compatibility: text('compatibility'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** skills.sh 来源 `owner/repo/skill`；内部自建为 null。 */
    sourceId: text('source_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skills_slug_idx').on(t.slug),
    // 同一市场技能只允许装一次；Postgres 唯一索引允许多个 NULL，内部技能不受影响。
    uniqueIndex('skills_source_id_idx').on(t.sourceId),
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
 * 技能的支持资源文件（官方 SKILL.md 目录里的 scripts/、references/ 等）。
 * 每个文件落到工作区 `.claude/skills/<slug>/<path>`；path 是相对技能目录的安全相对路径。
 */
export const skillFiles = pgTable(
  'skill_files',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    /** 相对技能目录的路径，如 `scripts/run.sh`、`references/api.md`。 */
    path: text('path').notNull(),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skill_files_skill_path_idx').on(t.skillId, t.path),
    index('skill_files_skill_idx').on(t.skillId),
  ],
);

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

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    /** 自然人发起的会话；与 serviceId 恰有一个非空。 */
    createdBy: text('created_by'),
    /** 服务发起的会话；与 createdBy 恰有一个非空。 */
    serviceId: text('service_id', { enum: ['system', 'mcp'] }),
    /** 分支来源会话；原会话删除后分支仍独立存在。 */
    parentId: text('parent_id').references((): AnyPgColumn => conversations.id, {
      onDelete: 'set null',
    }),
    /** 分支点消息：新会话复制到这条消息（含）为止。 */
    branchOfMessageId: text('branch_of_message_id'),
    /** 当前有效的 SDK session（transcript 在 sdk-sessions/<id>/）；null 表示还没有可续的会话。 */
    sdkSessionId: text('sdk_session_id'),
    /**
     * 待执行的按点分叉：非空表示下次运行要先在 sdkSessionId 里 fork 到该消息 uuid。
     * 分支创建时写入，fork 成功后清空。
     */
    forkFromSdkMessageUuid: text('fork_from_sdk_message_uuid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * 最后一条消息时间，由 messages 上的语句级触发器维护；无消息时等于 createdAt。
     * 冗余一列是为了让会话列表能按它索引排序，否则要先全表算 max 再排序。
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_agent_idx').on(t.agentId),
    index('conversations_parent_idx').on(t.parentId),
    index('conversations_last_message_idx').on(t.lastMessageAt.desc(), t.id.desc()),
    index('conversations_created_by_idx').on(t.createdBy),
    check(
      'conversations_subject_check',
      sql`(${t.createdBy} is not null) <> (${t.serviceId} is not null)`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    /** 自然人消息直接存业务 ID；assistant/tool 与服务输入为 null。 */
    senderBusinessId: text('sender_business_id'),
    content: jsonb('content').$type<unknown>().notNull(),
    /** 落下这条消息时智能体的回复格式；历史渲染按它而不是当前开关。 */
    uiFormat: text('ui_format').notNull().default('markdown'),
    /** OpenUI editMode 合并后的程序文本；null 表示用原始文本围栏。 */
    uiProgram: text('ui_program'),
    /** 消息级表单/绑定快照：`{ version: 1, blocks: { [blockKey]: state } }`。 */
    uiState: jsonb('ui_state').$type<unknown>(),
    /** 可空：用户输入或分支副本；分支副本由会话级保留规则保护。 */
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    /** SDK transcript 里的消息 uuid；用于按历史点 fork，缺失表示这条还没进 transcript。 */
    sdkMessageUuid: text('sdk_message_uuid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 会话消息按 (created_at, id) 排序，复合索引让 listMessages 免排序。
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id),
    index('messages_run_idx').on(t.runId),
    index('messages_sender_idx').on(t.senderBusinessId),
    check('messages_role_check', sql`${t.role} in ('user', 'assistant', 'tool')`),
    check('messages_ui_format_check', sql`${t.uiFormat} in ('markdown', 'openui')`),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'],
    })
      .notNull()
      .default('queued'),
    /** 本次运行由谁发起：对话 / 外部 MCP / 定时 / 事件 / 记忆审核。 */
    trigger: text('trigger', { enum: ['chat', 'mcp', 'schedule', 'event', 'review'] })
      .notNull()
      .default('chat'),
    /** 执行主体：自然人（initiatedBy）或服务（serviceId）。 */
    subjectKind: text('subject_kind', { enum: ['user', 'service'] }).notNull(),
    initiatedBy: text('initiated_by'),
    serviceId: text('service_id', { enum: ['system', 'mcp'] }),
    /** 入队时锁定的智能体版本号，让「用什么配置跑的」可追溯。 */
    agentVersion: integer('agent_version'),
    sessionId: text('session_id'),
    sandboxId: text('sandbox_id'),
    /**
     * 容器实际使用的运行环境/版本身份（存活容器可能落后于当前线上指针）。
     * 故意不加外键：环境或版本删除后，历史运行仍要显示当时身份。
     */
    runtimeEnvironmentId: text('runtime_environment_id'),
    runtimeEnvironmentName: text('runtime_environment_name'),
    runtimeEnvironmentVersionId: text('runtime_environment_version_id'),
    runtimeEnvironmentImageId: text('runtime_environment_image_id'),
    /** 入队时刻：queued 从未启动时 startedAt 为 NULL，只能靠它判断陈旧。 */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
    /**
     * stop 未确认且容器销毁失败时暂存的终态事件：运行保持 running、endedAt 为 NULL，
     * 重启后原样重放；清理成功才写终态并清空。null 表示没有待重放的终态。
     */
    pendingFinish: jsonb('pending_finish').$type<Extract<ChatEvent, { type: 'run_finished' }>>(),
    /** 失败分类：决定 BullMQ 是否重试，也用于运行详情展示。 */
    errorKind: text('error_kind', {
      enum: ['cancelled', 'timeout', 'sandbox', 'agent', 'infra'],
    }),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    turns: integer('turns'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** 本次 run 的短期 MCP token（sha256，不存明文）；run 结束即清空。 */
    mcpTokenHash: text('mcp_token_hash'),
    mcpTokenExpiresAt: timestamp('mcp_token_expires_at', { withTimezone: true }),
    /** 模型代理 token 的 sha256（明文即 runId）；run 结束清空。 */
    modelTokenHash: text('model_token_hash'),
  },
  (t) => [
    index('agent_runs_conversation_idx').on(t.conversationId),
    check(
      'agent_runs_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')`,
    ),
    check(
      'agent_runs_trigger_check',
      sql`${t.trigger} in ('chat', 'mcp', 'schedule', 'event', 'review')`,
    ),
    check('agent_runs_subject_kind_check', sql`${t.subjectKind} in ('user', 'service')`),
    check(
      'agent_runs_subject_check',
      sql`(${t.subjectKind} = 'user' and ${t.initiatedBy} is not null and ${t.serviceId} is null) or (${t.subjectKind} = 'service' and ${t.initiatedBy} is null and ${t.serviceId} in ('system', 'mcp'))`,
    ),
    index('agent_runs_initiated_by_idx').on(t.initiatedBy),
    // 任务看板按 trigger 过滤并统计各来源的运行量。
    index('agent_runs_trigger_idx').on(t.trigger),
    // 模型代理每个请求都按 hash 查一次；只索引仍持有 token 的行。
    index('agent_runs_model_token_idx').on(t.modelTokenHash).where(isNotNull(t.modelTokenHash)),
    // 列表与概览都按 started_at desc nulls last 排序；agentId 过滤时走复合索引。
    index('agent_runs_started_idx').on(t.startedAt.desc().nullsLast(), t.id.desc()),
    index('agent_runs_agent_started_idx').on(
      t.agentId,
      t.startedAt.desc().nullsLast(),
      t.id.desc(),
    ),
    // 概览的「正在运行」计数：running 行极少，部分索引比全表 status 索引小得多。
    index('agent_runs_running_idx').on(t.status).where(eq(t.status, 'running')),
    // runs 页按 status 过滤 + started_at 排序；也覆盖按 status 的计数（前缀列），
    // 但 running 计数仍用上面的部分索引——索引体积差两个数量级。
    index('agent_runs_status_started_idx').on(
      t.status,
      t.startedAt.desc().nullsLast(),
      t.id.desc(),
    ),
  ],
);

/**
 * 原生 AskUserQuestion 的运行记录：问题属于一次 run，不是智能体定义。
 * requestId 是 SDK 回调的外部标识，同一 run 内唯一；answers 以问题文本为键。
 */
export const runQuestions = pgTable(
  'run_questions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    toolUseId: text('tool_use_id').notNull(),
    questions: jsonb('questions').$type<NativeQuestions>().notNull(),
    status: text('status', { enum: ['pending', 'answered', 'declined', 'closed'] })
      .notNull()
      .default('pending'),
    answers: jsonb('answers').$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closeReason: text('close_reason'),
  },
  (t) => [
    uniqueIndex('run_questions_run_request_idx').on(t.runId, t.requestId),
    check(
      'run_questions_status_check',
      sql`${t.status} in ('pending', 'answered', 'declined', 'closed')`,
    ),
  ],
);

/**
 * 结构化的工具审批。行在工具被拒绝时由 MCP 端点写入（pending），用户批准后置 approved_at。
 * (run_id, server_id, tool_name) 唯一，审批因此不会跨 server 复用。
 * 生成式 UI 的工具调用没有 run：这些行 run_id 为空，改挂 conversation_id。
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    /** 沙盒内调用所属的 run；生成式 UI 的调用没有 run。 */
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** 生成式 UI 调用的会话归属；run 级审批为空。 */
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    /** 触发这次调用的助手消息，供 UI 回到原位置展示。 */
    messageId: text('message_id'),
    /** 审批来源：openui 表示 UI 按钮/工具桥发起。 */
    source: text('source', { enum: ['openui'] }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('approval_requests_run_server_tool_idx').on(t.runId, t.serverId, t.toolName),
    // 同一会话对同一 server 工具只保留一条待批/已批记录；run 级行不受影响。
    uniqueIndex('approval_requests_openui_idx')
      .on(t.conversationId, t.serverId, t.toolName)
      .where(sql`${t.runId} is null`),
    index('approval_requests_conversation_idx').on(t.conversationId).where(sql`${t.runId} is null`),
  ],
);

/**
 * 自主工作的定时任务。每行是一个 cron 触发：到点由 worker 用 admitChatRun 起一条
 * trigger='schedule' 的运行。多 worker 部署时靠 nextDueAt 条件更新抢占，避免重复触发。
 */
export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 创建人；普通编辑不能改执行主体。 */
    createdBy: text('created_by').notNull(),
    /** 触发时的执行主体；创建时等于 createdBy。 */
    executeAsBusinessId: text('execute_as_business_id').notNull(),
    /** 5 段 cron（分 时 日 月 周），UTC。 */
    cron: text('cron').notNull(),
    /** 每次触发时作为用户消息发给智能体的提示词。 */
    prompt: text('prompt').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_schedules_due_idx').on(t.nextDueAt).where(eq(t.enabled, true)),
    index('agent_schedules_agent_idx').on(t.agentId),
  ],
);

export const evalCases = pgTable(
  'eval_cases',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    expectation: text('expectation').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_cases_agent_idx').on(t.agentId)],
);

/** 评估用例快照：源用例删除后，历史跑批仍能展示当时测了什么。 */
export type EvalCaseSnapshot = {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
};

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('running'),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    error: text('error'),
    caseSnapshot: jsonb('case_snapshot').$type<EvalCaseSnapshot[]>(),
    /** 评估执行主体就是创建人；worker 触发时重新校验其权限。 */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 认领时刻：BullMQ 重复投递时，只有抢到认领的 worker 才执行。 */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // 分页按 (created_at, id) 倒序取前 N 行；升序索引即可反向扫描，避免 DESC NULLS LAST 与查询排序不匹配。
    index('eval_runs_agent_created_idx').on(t.agentId, t.createdAt, t.id),
    index('eval_runs_created_idx').on(t.createdAt, t.id),
    check(
      'eval_runs_status_check',
      sql`${t.status} in ('running', 'succeeded', 'failed', 'cancelled')`,
    ),
    // 同一智能体同时最多一个在跑的评估；DB 层兜底 API 的 409 检查并发竞态。
    uniqueIndex('eval_runs_agent_running_idx').on(t.agentId).where(eq(t.status, 'running')),
  ],
);

export const evalResults = pgTable(
  'eval_results',
  {
    id: text('id').primaryKey(),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id').references(() => evalCases.id, { onDelete: 'set null' }),
    caseSnapshot: jsonb('case_snapshot').$type<EvalCaseSnapshot>(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    passed: boolean('passed').notNull(),
    output: text('output').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('eval_results_run_idx').on(t.evalRunId),
    // 重复投递的 eval job 会重写同一 run/case 的结果，唯一键让写入幂等。
    uniqueIndex('eval_results_run_case_idx').on(t.evalRunId, t.caseId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    /** actor 为已认证 businessId；anonymous 时可在 metadata 记录脱敏用户名。 */
    actor: text('actor').notNull().default('system'),
    actorKind: text('actor_kind', { enum: ['user', 'service', 'anonymous'] })
      .notNull()
      .default('service'),
    /** 跨用户读取的目标业务身份。 */
    subjectBusinessId: text('subject_business_id'),
    action: text('action').notNull(),
    target: text('target'),
    inputDigest: text('input_digest'),
    status: text('status').notNull(),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    // action LIKE 'x%' 走 text_pattern_ops（C collation 下才能用前缀索引）；
    // 尾随列让「前缀 + 时间倒序 + id 游标」整个查询都在索引里完成。
    index('audit_log_action_created_idx').on(
      sql`${t.action} text_pattern_ops`,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

/** 平台首次初始化标记与角色矩阵 revision；只有一行。 */
export const platformBootstrap = pgTable(
  'platform_bootstrap',
  {
    id: text('id').primaryKey(),
    /** 首次初始化使用的业务身份；值不连 authUsers，账户可删除后重建。 */
    adminBusinessId: text('admin_business_id'),
    rolesRevision: integer('roles_revision').notNull().default(0),
    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('platform_bootstrap_revision_check', sql`${t.rolesRevision} >= 0`)],
);

export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** 四默认角色；自定义角色为 null。 */
    systemKey: text('system_key', { enum: ['admin', 'user', 'owner', 'maintainer'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_name_idx').on(t.name),
    uniqueIndex('roles_system_key_idx').on(t.systemKey),
    check(
      'roles_system_key_check',
      sql`${t.systemKey} is null or ${t.systemKey} in ('admin', 'user', 'owner', 'maintainer')`,
    ),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id').notNull(),
    scope: text('scope', {
      enum: ['own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform'],
    }).notNull(),
  },
  (t) => [
    uniqueIndex('role_permissions_pk').on(t.roleId, t.permissionId, t.scope),
    index('role_permissions_permission_idx').on(t.permissionId),
    check(
      'role_permissions_scope_check',
      sql`${t.scope} in ('own_data', 'authorized_agents', 'maintained_agents', 'owned_agents', 'platform')`,
    ),
  ],
);

/** 业务身份到角色的分配；离线身份（无 authUsers 行）仍保留。 */
export const userRoles = pgTable(
  'user_roles',
  {
    businessId: text('business_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('user_roles_pk').on(t.businessId, t.roleId),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

export const agentMembers = pgTable(
  'agent_members',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    canUse: boolean('can_use').notNull().default(false),
    canMaintain: boolean('can_maintain').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_members_pk').on(t.agentId, t.businessId),
    index('agent_members_business_idx').on(t.businessId),
    check('agent_members_flags_check', sql`${t.canUse} or ${t.canMaintain}`),
  ],
);

/** better-auth 核心表；列名与官方 Drizzle schema 一致（属性 camelCase、DB 列 snake_case）。 */
export const authUsers = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    username: text('username'),
    /** 稳定业务身份；技术 ID 每次重建都变，业务关联只认这一列。 */
    businessId: text('business_id').notNull(),
    /** 停用账户：拒绝登录与鉴权，撤销现有会话；删除认证资料不置位。 */
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_email_idx').on(t.email),
    uniqueIndex('user_username_idx').on(t.username),
    uniqueIndex('user_business_id_idx').on(t.businessId),
  ],
);

export const authSessions = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('session_token_idx').on(t.token), index('session_user_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_provider_account_idx').on(t.providerId, t.accountId),
    index('account_user_idx').on(t.userId),
  ],
);

export const authVerifications = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/**
 * 交付物公开分享。token 只存哈希与密文，撤销即失效。
 * runId 不加外键：运行/会话删除后分享行由 conversationId 级联清理，历史已发布快照另存。
 */
export const outputShares = pgTable(
  'output_shares',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    /** 相对运行快照根的安全路径，与 `outputPathSchema` 一致。 */
    path: text('path').notNull(),
    sha256: text('sha256').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenEncrypted: text('token_encrypted').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('output_shares_conversation_idx').on(t.conversationId),
    uniqueIndex('output_shares_token_hash_idx').on(t.tokenHash),
  ],
);

/** 个人记忆：唯一一行文本，revision 做乐观并发控制；空内容时行可以不存在。 */
export const userPreferences = pgTable('user_preferences', {
  businessId: text('business_id').primaryKey(),
  content: text('content').notNull().default(''),
  revision: integer('revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 记忆审核：一次审核对应一条运行（runId 即主键），提案由模型生成、用户决定是否采纳。
 * userId + requestKey 唯一让重复提交幂等。
 */
export const memoryReviews = pgTable(
  'memory_reviews',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** 执行审核的专家；运行与模型配置都取自它。 */
    modelAgentId: text('model_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    sources: jsonb('sources').$type<MemoryReviewSource[]>().notNull(),
    instruction: text('instruction').notNull().default(''),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    proposal: jsonb('proposal').$type<MemoryReviewProposal>(),
    decision: text('decision', { enum: ['pending', 'applied', 'rejected'] })
      .notNull()
      .default('pending'),
    appliedChangeId: text('applied_change_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memory_reviews_business_request_idx').on(t.businessId, t.requestKey)],
);

/** 记忆变更账本：采纳提案或撤销时各写一行，before/after 保留完整快照。 */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id').notNull(),
    /** 个人记忆为 null；专家记忆/规则记录归属的智能体。 */
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    after: jsonb('after').$type<MemoryContentSnapshot>().notNull(),
    sourceReviewRunId: text('source_review_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    reversesChangeId: text('reverses_change_id'),
    state: text('state', { enum: ['applied'] })
      .notNull()
      .default('applied'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_changes_business_created_idx').on(t.businessId, t.createdAt),
    index('memory_changes_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);

/**
 * 模型端点（embedding/rerank）。API 只回 hasSecret；worker 用 decryptSecrets 取密钥。
 */
export const knowledgeModelProfiles = pgTable(
  'knowledge_model_profiles',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['embedding', 'rerank'] }).notNull(),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    model: text('model').notNull(),
    /** embedding 固定 1024 维；rerank 为 null。 */
    dimensions: integer('dimensions'),
    /** 文本/图片共用同一模型的向量协议；rerank 行保持默认 openai。 */
    embeddingProtocol: text('embedding_protocol', { enum: ['openai', 'cohere_v2'] })
      .notNull()
      .default('openai'),
    /** 只有 cohere_v2 + embed-v4.0 才能开启，见下方 check。 */
    imageInputEnabled: boolean('image_input_enabled').notNull().default(false),
    /** AES-256-GCM；API 永不回传密文。 */
    secretsEncrypted: text('secrets_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_model_profiles_kind_name_idx').on(t.kind, t.name),
    check('knowledge_model_profiles_kind_check', sql`${t.kind} in ('embedding', 'rerank')`),
    check(
      'knowledge_model_profiles_dimensions_check',
      sql`(${t.kind} = 'embedding' and ${t.dimensions} = 1024) or (${t.kind} = 'rerank' and ${t.dimensions} is null)`,
    ),
    check(
      'knowledge_model_profiles_embedding_protocol_check',
      sql`${t.embeddingProtocol} in ('openai', 'cohere_v2')`,
    ),
    check(
      'knowledge_model_profiles_image_input_check',
      sql`${t.imageInputEnabled} = false or (${t.kind} = 'embedding' and ${t.embeddingProtocol} = 'cohere_v2' and ${t.model} = 'embed-v4.0')`,
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
    status: text('status', { enum: ['active', 'disabled'] })
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
    settings: jsonb('settings').$type<KnowledgeBaseSettings>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_bases_slug_idx').on(t.slug),
    uniqueIndex('knowledge_bases_server_idx').on(t.serverId),
    check('knowledge_bases_status_check', sql`${t.status} in ('active', 'disabled')`),
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
    /** 物化路径，如 `/a/b`；改名/移动时整棵子树重写。 */
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
      enum: ['upload', 'url', 'feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'manual'],
    }).notNull(),
    /** 外部稳定 ID（飞书 token / `project:ref:path` / `feedURL:itemId`）；upload/manual 为 null。 */
    sourceId: text('source_id'),
    sourceUrl: text('source_url'),
    sourcePath: text('source_path'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    status: text('status', {
      enum: ['pending', 'processing', 'ready', 'failed', 'disabled'],
    })
      .notNull()
      .default('pending'),
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
    // 外部来源只按 sourceId 匹配，绝不用标题；upload/manual 的 null 不受约束。
    uniqueIndex('knowledge_documents_source_idx')
      .on(t.baseId, t.sourceType, t.sourceId)
      .where(isNotNull(t.sourceId)),
    check(
      'knowledge_documents_source_type_check',
      sql`${t.sourceType} in ('upload', 'url', 'feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed', 'manual')`,
    ),
    check(
      'knowledge_documents_status_check',
      sql`${t.status} in ('pending', 'processing', 'ready', 'failed', 'disabled')`,
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
    check(
      'knowledge_document_versions_parse_status_check',
      sql`${t.parseStatus} in ('parsed', 'parse_failed')`,
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
    embedding: vector('embedding'),
    enabled: boolean('enabled').notNull().default(true),
    editedByUser: boolean('edited_by_user').notNull().default(false),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
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
  ],
);

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed'],
    }).notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM，复用 core 的 encryptSecrets。 */
    secretsEncrypted: text('secrets_encrypted'),
    status: text('status', {
      enum: ['active', 'paused', 'auth_error', 'disabled'],
    })
      .notNull()
      .default('active'),
    /** 5 段 cron（UTC）；null 表示不自动同步。 */
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
      sql`${t.type} in ('feishu_wiki', 'feishu_drive', 'gitlab', 'github', 'feed')`,
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
      enum: ['wiki_space', 'wiki_node', 'drive_folder', 'gitlab_project', 'github_repo', 'feed'],
    }).notNull(),
    externalId: text('external_id').notNull(),
    ref: text('ref'),
    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    // ref 可空，coalesce 成 '' 才能参与唯一约束。
    uniqueIndex('knowledge_source_ranges_scope_idx').on(
      t.sourceId,
      t.kind,
      t.externalId,
      sql`coalesce(${t.ref}, '')`,
    ),
    check(
      'knowledge_source_ranges_kind_check',
      sql`${t.kind} in ('wiki_space', 'wiki_node', 'drive_folder', 'gitlab_project', 'github_repo', 'feed')`,
    ),
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
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
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
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

/** 任务账本；BullMQ jobId = 本表 id，worker 只认领 queued 行。 */
export const knowledgeJobs = pgTable(
  'knowledge_jobs',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: ['ingest', 'reindex', 'sync', 'wiki_generate', 'cleanup'],
    }).notNull(),
    baseId: text('base_id').references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: text('document_id').references(() => knowledgeDocuments.id, {
      onDelete: 'cascade',
    }),
    sourceId: text('source_id').references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    step: text('step'),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
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
      sql`${t.type} in ('ingest', 'reindex', 'sync', 'wiki_generate', 'cleanup')`,
    ),
    check(
      'knowledge_jobs_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);

export const knowledgeWikiPages = pgTable(
  'knowledge_wiki_pages',
  {
    id: text('id').primaryKey(),
    baseId: text('base_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: ['draft', 'published', 'stale', 'failed'] })
      .notNull()
      .default('draft'),
    currentVersionId: text('current_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_wiki_pages_base_slug_idx').on(t.baseId, t.slug),
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

export const schema = {
  servers,
  apiTools,
  agents,
  skills,
  agentSkills,
  skillFiles,
  agentRules,
  agentOutputStyles,
  agentServers,
  agentVersions,
  runtimeEnvironmentVersions,
  runtimeEnvironments,
  conversations,
  messages,
  agentRuns,
  approvalRequests,
  agentSchedules,
  evalCases,
  evalRuns,
  evalResults,
  auditLog,
  platformBootstrap,
  roles,
  rolePermissions,
  userRoles,
  agentMembers,
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  outputShares,
  userPreferences,
  memoryReviews,
  memoryChanges,
  knowledgeModelProfiles,
  knowledgeBases,
  knowledgeFolders,
  knowledgeTags,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceRanges,
  knowledgeSyncRuns,
  knowledgeJobs,
  knowledgeWikiPages,
  knowledgeWikiVersions,
  knowledgeWikiSources,
  knowledgeDocumentTags,
};

export { sql };
