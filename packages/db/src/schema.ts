import type { Agent } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('servers_name_idx').on(t.name)],
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
    model: text('model').notNull(),
    description: text('description').notNull().default(''),
    systemPromptMd: text('system_prompt_md').notNull().default(''),
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
  (t) => [uniqueIndex('agents_slug_idx').on(t.slug), index('agents_parent_idx').on(t.parentId)],
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
  (t) => [uniqueIndex('agent_skills_pk').on(t.agentId, t.skillId)],
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
  (t) => [uniqueIndex('agent_servers_pk').on(t.agentId, t.serverId)],
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
  },
  (t) => [
    index('conversations_agent_idx').on(t.agentId),
    index('conversations_parent_idx').on(t.parentId),
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
    /** 可空：没有 run 的 user 消息；孤儿值由迁移清理。 */
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 会话消息按 (created_at, id) 排序，复合索引让 listMessages 免排序。
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id),
    index('messages_run_idx').on(t.runId),
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
    sessionId: text('session_id'),
    sandboxId: text('sandbox_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    turns: integer('turns'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** 本次 run 的短期 MCP token（sha256，不存明文）；run 结束即清空。 */
    mcpTokenHash: text('mcp_token_hash'),
    mcpTokenExpiresAt: timestamp('mcp_token_expires_at', { withTimezone: true }),
    /** 已废弃：审批改存 approval_requests，此列不再写入，仅为兼容旧数据保留。 */
    approvals: jsonb('approvals').$type<string[]>().notNull().default([]),
  },
  (t) => [
    index('agent_runs_conversation_idx').on(t.conversationId),
    // 列表与概览都按 started_at desc nulls last 排序；agentId 过滤时走复合索引。
    index('agent_runs_started_idx').on(t.startedAt.desc().nullsLast(), t.id.desc()),
    index('agent_runs_agent_started_idx').on(
      t.agentId,
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
  },
  (t) => [uniqueIndex('approval_requests_run_server_tool_idx').on(t.runId, t.serverId, t.toolName)],
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

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] })
      .notNull()
      .default('running'),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('eval_runs_agent_idx').on(t.agentId)],
);

export const evalResults = pgTable(
  'eval_results',
  {
    id: text('id').primaryKey(),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    passed: boolean('passed').notNull(),
    output: text('output').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_results_run_idx').on(t.evalRunId)],
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
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

export const schema = {
  servers,
  apiTools,
  agents,
  skills,
  agentSkills,
  agentServers,
  agentVersions,
  conversations,
  messages,
  agentRuns,
  approvalRequests,
  evalCases,
  evalRuns,
  evalResults,
  auditLog,
};

export { sql };
