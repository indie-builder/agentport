import type { NativeQuestions } from '@agentport/shared';
import { eq, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { agentRuns, channelMessages, channels, conversations, messages } from './chat.js';
import { evalCases } from './eval.js';
import { servers } from './servers.js';

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
    status: text('status', { enum: ['pending', 'answered', 'declined', 'closed', 'expired'] })
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
      sql`${t.status} in ('pending', 'answered', 'declined', 'closed', 'expired')`,
    ),
  ],
);

export const runInstructions = pgTable(
  'run_instructions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    channelMessageId: text('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('run_instructions_run_message_idx')
      .on(t.runId, t.channelMessageId)
      .where(sql`${t.channelMessageId} is not null`),
    index('run_instructions_run_delivered_idx').on(t.runId, t.deliveredAt),
  ],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    source: text('source', { enum: ['openui'] }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    argumentsSummary: jsonb('arguments_summary').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByBusinessId: text('approved_by_business_id'),
    deniedAt: timestamp('denied_at', { withTimezone: true }),
    deniedByBusinessId: text('denied_by_business_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    authorizationExpiresAt: timestamp('authorization_expires_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'approval_requests_decision_check',
      sql`not (${t.approvedAt} is not null and ${t.deniedAt} is not null)`,
    ),
    uniqueIndex('approval_requests_run_server_tool_idx').on(t.runId, t.serverId, t.toolName),
    uniqueIndex('approval_requests_openui_idx')
      .on(t.conversationId, t.serverId, t.toolName)
      .where(sql`${t.runId} is null`),
    index('approval_requests_conversation_idx').on(t.conversationId).where(sql`${t.runId} is null`),
  ],
);

export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    executeAsBusinessId: text('execute_as_business_id').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    missedPolicy: text('missed_policy', { enum: ['skip', 'run_once'] })
      .notNull()
      .default('skip'),
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

export const runFeedback = pgTable(
  'run_feedback',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    outputPath: text('output_path'),
    outputSha256: text('output_sha256'),
    decision: text('decision', { enum: ['accepted', 'rejected'] }).notNull(),
    rating: smallint('rating'),
    comment: text('comment').notNull().default(''),
    reason: text('reason').notNull().default(''),
    evalCaseId: text('eval_case_id').references(() => evalCases.id, { onDelete: 'set null' }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('run_feedback_run_created_idx').on(t.runId, t.createdAt, t.id),
    index('run_feedback_eval_case_idx').on(t.evalCaseId).where(sql`${t.evalCaseId} is not null`),
    check('run_feedback_decision_check', sql`${t.decision} in ('accepted', 'rejected')`),
    check(
      'run_feedback_rating_check',
      sql`${t.rating} is null or (${t.rating} >= 1 and ${t.rating} <= 5)`,
    ),
    check(
      'run_feedback_output_version_check',
      sql`(${t.outputPath} is null) = (${t.outputSha256} is null)`,
    ),
  ],
);
