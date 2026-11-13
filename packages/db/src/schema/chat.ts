import type { ChatEvent, RunErrorKind, RunStatus, RunTrigger } from '@agentport/shared';
import { runErrorKindSchema, runStatusSchema, runTriggerSchema } from '@agentport/shared';
import { eq, isNotNull, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
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
import { agents } from './agents.js';

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
    /** 频道 agent lane；非空时不出现在私有会话列表，访问走频道成员校验。 */
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
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
    // 一个 agent 在一个频道只有一个 lane；私有对话 channel_id 为空，不受约束。
    uniqueIndex('conversations_channel_agent_idx')
      .on(t.channelId, t.agentId)
      .where(isNotNull(t.channelId)),
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
    /** 频道消息与 lane 内 user message 的关联；私有对话为空。 */
    channelMessageId: text('channel_message_id').references((): AnyPgColumn => channelMessages.id, {
      onDelete: 'set null',
    }),
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

/** 频道是一等对象；M1 全部私有，归档后只读。 */
export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: text('created_by').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 频道成员只放人；未读游标就是 last_read_seq，不单设表。 */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] })
      .notNull()
      .default('member'),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'channel_members_pk', columns: [t.channelId, t.businessId] }),
    index('channel_members_business_idx').on(t.businessId),
    check('channel_members_role_check', sql`${t.role} in ('owner', 'admin', 'member', 'viewer')`),
    check('channel_members_last_read_seq_check', sql`${t.lastReadSeq} >= 0`),
  ],
);

/** 一条绑定 = 一个 agent lane；conversationId 在 M2 才有值。 */
export const channelAgentBindings = pgTable(
  'channel_agent_bindings',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: ['active', 'disconnected'] })
      .notNull()
      .default('active'),
    contextSeq: bigint('context_seq', { mode: 'number' }).notNull().default(0),
    autoWakeOnAll: boolean('auto_wake_on_all').notNull().default(false),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_agent_bindings_channel_agent_idx').on(t.channelId, t.agentId),
    index('channel_agent_bindings_agent_idx').on(t.agentId),
    index('channel_agent_bindings_conversation_idx').on(t.conversationId),
    check('channel_agent_bindings_status_check', sql`${t.status} in ('active', 'disconnected')`),
  ],
);

/** 频道时间线唯一来源；seq 全局递增，事件回放就是 seq > cursor。 */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: ['human', 'agent', 'system'] }).notNull(),
    authorBusinessId: text('author_business_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    body: text('body').notNull(),
    clientMessageId: text('client_message_id'),
    /** agent 回复对应的 messages.id；一条消息只投影一次。 */
    sourceMessageId: text('source_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('channel_messages_channel_seq_idx').on(t.channelId, t.seq),
    uniqueIndex('channel_messages_client_message_idx')
      .on(t.channelId, t.clientMessageId)
      .where(isNotNull(t.clientMessageId)),
    uniqueIndex('channel_messages_source_message_idx')
      .on(t.sourceMessageId)
      .where(isNotNull(t.sourceMessageId)),
    uniqueIndex('channel_messages_agent_run_uniq')
      .on(t.channelId, t.runId)
      .where(sql`${t.kind} = 'agent' and ${t.runId} is not null`),
    check('channel_messages_kind_check', sql`${t.kind} in ('human', 'agent', 'system')`),
  ],
);

export const channelWakes = pgTable(
  'channel_wakes',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    channelMessageId: text('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['pending', 'dispatching', 'enqueued', 'skipped', 'failed'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_wakes_message_agent_idx').on(t.channelMessageId, t.agentId),
    index('channel_wakes_status_next_idx').on(t.status, t.nextAttemptAt),
    check(
      'channel_wakes_status_check',
      sql`${t.status} in ('pending', 'dispatching', 'enqueued', 'skipped', 'failed')`,
    ),
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
    /** 频道触发的运行所属频道；私有对话为空。 */
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    /** 触发本次运行的频道消息（人 @agent 的那条）。 */
    channelTriggerMessageId: text('channel_trigger_message_id').references(
      (): AnyPgColumn => channelMessages.id,
      { onDelete: 'set null' },
    ),
    status: text('status', {
      enum: runStatusSchema.options as [RunStatus, ...RunStatus[]],
    })
      .notNull()
      .default('queued'),
    /** 本次运行由谁发起：对话 / 外部 MCP / 定时 / 事件 / 记忆审核 / 频道。 */
    trigger: text('trigger', { enum: runTriggerSchema.options as [RunTrigger, ...RunTrigger[]] })
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
      enum: runErrorKindSchema.options as [RunErrorKind, ...RunErrorKind[]],
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
      sql`${t.trigger} in ('chat', 'mcp', 'schedule', 'event', 'review', 'channel')`,
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
    index('agent_runs_started_idx').on(t.startedAt.desc().nullsLast(), t.id.desc()),
    index('agent_runs_recent_idx').on(t.startedAt.desc().nullsFirst()),
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
    uniqueIndex('agent_runs_channel_trigger_idx')
      .on(t.channelId, t.channelTriggerMessageId, t.agentId)
      .where(isNotNull(t.channelId)),
  ],
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
