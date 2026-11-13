import type { NativeQuestions } from '@agentport/shared';
import { eq, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { agentRuns, channels, conversations } from './chat.js';
import { servers } from './servers.js';

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

/**
 * 结构化的工具审批。行在工具被拒绝时由 MCP 端点写入（pending），用户批准或拒绝后置 approved_at / denied_at。
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
    /** 频道内审批所属频道；私有对话为空。 */
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    /** 触发这次调用的助手消息，供 UI 回到原位置展示。 */
    messageId: text('message_id'),
    /** 审批来源：openui 表示 UI 按钮/工具桥发起。 */
    source: text('source', { enum: ['openui'] }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    argumentsSummary: jsonb('arguments_summary').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** 频道内批准人的业务 ID；不是外键，与现有审计列保持同样的纯文本身份。 */
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
