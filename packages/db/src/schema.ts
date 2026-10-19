import { sql } from 'drizzle-orm';
import {
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agents_slug_idx').on(t.slug)],
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

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_agent_idx').on(t.agentId)],
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
    runId: text('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    agentId: text('agent_id').notNull(),
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
  },
  (t) => [index('agent_runs_conversation_idx').on(t.conversationId)],
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
  conversations,
  messages,
  agentRuns,
  auditLog,
};

export { sql };
