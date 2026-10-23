import type { Agent } from '@agentport/shared';
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

export const servers = pgTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['stdio', 'http', 'generated'] }).notNull(),
    description: text('description').notNull().default(''),
    // command / args / url / headers 等非敏感字段
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    // AES-256-GCM 加密后的 env / headers
    secretsEncrypted: text('secrets_encrypted'),
    /** 最近一次「测试连接」的结果快照；刷新后仍能显示连接健康度。 */
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastToolCount: integer('last_tool_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('servers_name_idx').on(t.name),
    check('servers_kind_check', sql`${t.kind} in ('stdio', 'http', 'generated')`),
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
    permissionMode: text('permission_mode').notNull().default('dontAsk'),
    effort: text('effort'),
    maxThinkingTokens: integer('max_thinking_tokens'),
    enabled: boolean('enabled').notNull().default(true),
    maxTurns: integer('max_turns').notNull().default(20),
    maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 4 }).notNull().default('2'),
    timeoutMs: integer('timeout_ms').notNull().default(600_000),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: text('parent_id').references((): AnyPgColumn => agents.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_slug_idx').on(t.slug),
    index('agents_parent_idx').on(t.parentId),
    check(
      'agents_permission_mode_check',
      sql`${t.permissionMode} in ('dontAsk', 'plan', 'default', 'acceptEdits')`,
    ),
    check(
      'agents_allowed_tools_check',
      sql`jsonb_typeof(${t.allowedTools}) = 'array' and not jsonb_path_exists(${t.allowedTools}, '$[*] ? (@.type() != "string")')`,
    ),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_slug_idx').on(t.slug)],
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
    /** 分支来源会话；原会话删除后分支仍独立存在。 */
    parentId: text('parent_id').references((): AnyPgColumn => conversations.id, {
      onDelete: 'set null',
    }),
    /** 分支点消息：新会话复制到这条消息（含）为止。 */
    branchOfMessageId: text('branch_of_message_id'),
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
    content: jsonb('content').$type<unknown>().notNull(),
    /** 可空：用户输入或分支副本；分支副本由会话级保留规则保护。 */
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 会话消息按 (created_at, id) 排序，复合索引让 listMessages 免排序。
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id),
    index('messages_run_idx').on(t.runId),
    check('messages_role_check', sql`${t.role} in ('user', 'assistant', 'tool')`),
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
    /** 本次运行由谁发起：对话 / 外部 MCP / 定时 / 事件。 */
    trigger: text('trigger', { enum: ['chat', 'mcp', 'schedule', 'event'] })
      .notNull()
      .default('chat'),
    /** 入队时锁定的智能体版本号，让「用什么配置跑的」可追溯。 */
    agentVersion: integer('agent_version'),
    sessionId: text('session_id'),
    sandboxId: text('sandbox_id'),
    /** 入队时刻：queued 从未启动时 startedAt 为 NULL，只能靠它判断陈旧。 */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
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
    check('agent_runs_trigger_check', sql`${t.trigger} in ('chat', 'mcp', 'schedule', 'event')`),
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
 * 结构化的工具审批。行在工具被拒绝时由 MCP 端点写入（pending），用户批准后置 approved_at。
 * (run_id, server_id, tool_name) 唯一，审批因此不会跨 server 复用。
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('approval_requests_run_server_tool_idx').on(t.runId, t.serverId, t.toolName)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 认领时刻：BullMQ 重复投递时，只有抢到认领的 worker 才执行。 */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('eval_runs_agent_idx').on(t.agentId),
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
    actor: text('actor').notNull().default('system'),
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
  conversations,
  messages,
  agentRuns,
  approvalRequests,
  agentSchedules,
  evalCases,
  evalRuns,
  evalResults,
  auditLog,
};

export { sql };
