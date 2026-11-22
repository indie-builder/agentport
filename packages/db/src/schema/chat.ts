import type {
  AgentDefinition,
  ChannelAgentStatus,
  ChannelMessageKind,
  ChannelRole,
  ChatEvent,
  ChatMessageRole,
  MessageAttachment,
  RunErrorKind,
  RunStatus,
  RunSubjectKind,
  RunTrigger,
  ServiceId,
} from '@agentport/shared';
import {
  channelAgentStatusSchema,
  channelMessageKindSchema,
  channelRoleSchema,
  chatMessageRoleSchema,
  runErrorKindSchema,
  runStatusSchema,
  runSubjectKindSchema,
  runTriggerSchema,
  serviceIdSchema,
  uiFormatSchema,
} from '@agentport/shared';
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
import { modelProviders } from './model-providers.js';

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    createdBy: text('created_by'),
    serviceId: text('service_id', {
      enum: serviceIdSchema.options as [ServiceId, ...ServiceId[]],
    }),
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => conversations.id, {
      onDelete: 'set null',
    }),
    branchOfMessageId: text('branch_of_message_id'),
    sdkSessionId: text('sdk_session_id'),
    forkFromSdkMessageUuid: text('fork_from_sdk_message_uuid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    dataDomainRestricted: boolean('data_domain_restricted').notNull().default(false),
    providerDestination: text('provider_destination'),
  },
  (t) => [
    index('conversations_agent_idx').on(t.agentId),
    index('conversations_parent_idx').on(t.parentId),
    index('conversations_last_message_idx').on(t.lastMessageAt.desc(), t.id.desc()),
    index('conversations_created_by_idx').on(t.createdBy),
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
    role: text('role', {
      enum: chatMessageRoleSchema.options as [ChatMessageRole, ...ChatMessageRole[]],
    }).notNull(),
    senderBusinessId: text('sender_business_id'),
    content: jsonb('content').$type<unknown>().notNull(),
    uiFormat: text('ui_format', {
      enum: uiFormatSchema.options as [
        (typeof uiFormatSchema.options)[number],
        ...(typeof uiFormatSchema.options)[number][],
      ],
    })
      .notNull()
      .default('markdown'),
    uiProgram: text('ui_program'),
    uiState: jsonb('ui_state').$type<unknown>(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    sdkMessageUuid: text('sdk_message_uuid'),
    channelMessageId: text('channel_message_id').references((): AnyPgColumn => channelMessages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id),
    index('messages_run_idx').on(t.runId),
    index('messages_sender_idx').on(t.senderBusinessId),
    check(
      'messages_role_check',
      sql`${t.role} in (${sql.raw(chatMessageRoleSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'messages_ui_format_check',
      sql`${t.uiFormat} in (${sql.raw(uiFormatSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: text('created_by').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    role: text('role', {
      enum: channelRoleSchema.options as [ChannelRole, ...ChannelRole[]],
    })
      .notNull()
      .default('member'),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'channel_members_pk', columns: [t.channelId, t.businessId] }),
    index('channel_members_business_idx').on(t.businessId),
    check(
      'channel_members_role_check',
      sql`${t.role} in (${sql.raw(channelRoleSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check('channel_members_last_read_seq_check', sql`${t.lastReadSeq} >= 0`),
  ],
);

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
    status: text('status', {
      enum: channelAgentStatusSchema.options as [ChannelAgentStatus, ...ChannelAgentStatus[]],
    })
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
    check(
      'channel_agent_bindings_status_check',
      sql`${t.status} in (${sql.raw(channelAgentStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const channelMessages = pgTable(
  'channel_messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    kind: text('kind', {
      enum: channelMessageKindSchema.options as [ChannelMessageKind, ...ChannelMessageKind[]],
    }).notNull(),
    authorBusinessId: text('author_business_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    body: text('body').notNull(),
    clientMessageId: text('client_message_id'),
    sourceMessageId: text('source_message_id'),
    attachments: jsonb('attachments').$type<MessageAttachment[]>(),
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
    check(
      'channel_messages_kind_check',
      sql`${t.kind} in (${sql.raw(channelMessageKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
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
    index('channel_wakes_message_agent_idx').on(t.channelMessageId, t.agentId),
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
    channelId: text('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    channelTriggerMessageId: text('channel_trigger_message_id').references(
      (): AnyPgColumn => channelMessages.id,
      { onDelete: 'set null' },
    ),
    evalRunId: text('eval_run_id'),
    scheduleId: text('schedule_id'),
    retryOfRunId: text('retry_of_run_id'),
    status: text('status', {
      enum: runStatusSchema.options as [RunStatus, ...RunStatus[]],
    })
      .notNull()
      .default('queued'),
    trigger: text('trigger', { enum: runTriggerSchema.options as [RunTrigger, ...RunTrigger[]] })
      .notNull()
      .default('chat'),
    subjectKind: text('subject_kind', {
      enum: runSubjectKindSchema.options as [RunSubjectKind, ...RunSubjectKind[]],
    }).notNull(),
    initiatedBy: text('initiated_by'),
    model: text('model'),
    providerId: text('provider_id').references(() => modelProviders.id, { onDelete: 'set null' }),
    servedProviderId: text('served_provider_id').references(() => modelProviders.id, {
      onDelete: 'set null',
    }),
    providerFailovers: integer('provider_failovers').notNull().default(0),
    departmentId: text('department_id'),
    serviceId: text('service_id', {
      enum: serviceIdSchema.options as [ServiceId, ...ServiceId[]],
    }),
    agentVersion: integer('agent_version'),
    definitionSnapshot: jsonb('definition_snapshot').$type<AgentDefinition>(),
    serverIds: jsonb('server_ids').$type<string[]>(),
    sessionId: text('session_id'),
    sandboxId: text('sandbox_id'),
    runtimeEnvironmentId: text('runtime_environment_id'),
    runtimeEnvironmentName: text('runtime_environment_name'),
    runtimeEnvironmentVersionId: text('runtime_environment_version_id'),
    runtimeEnvironmentImageId: text('runtime_environment_image_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
    pendingFinish: jsonb('pending_finish').$type<Extract<ChatEvent, { type: 'run_finished' }>>(),
    errorKind: text('error_kind', {
      enum: runErrorKindSchema.options as [RunErrorKind, ...RunErrorKind[]],
    }),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    turns: integer('turns'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    mcpTokenHash: text('mcp_token_hash'),
    mcpTokenExpiresAt: timestamp('mcp_token_expires_at', { withTimezone: true }),
    modelTokenHash: text('model_token_hash'),
  },
  (t) => [
    index('agent_runs_conversation_idx').on(t.conversationId),
    check(
      'agent_runs_status_check',
      sql`${t.status} in (${sql.raw(runStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'agent_runs_trigger_check',
      sql`${t.trigger} in (${sql.raw(runTriggerSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'agent_runs_subject_kind_check',
      sql`${t.subjectKind} in (${sql.raw(runSubjectKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check('agent_runs_provider_failovers_check', sql`${t.providerFailovers} >= 0`),
    check(
      'agent_runs_subject_check',
      sql`(${t.subjectKind} = 'user' and ${t.initiatedBy} is not null and ${t.serviceId} is null) or (${t.subjectKind} = 'service' and ${t.initiatedBy} is null and ${t.serviceId} in (${sql.raw(serviceIdSchema.options.map((option) => `'${option}'`).join(', '))}))`,
    ),
    index('agent_runs_initiated_by_idx').on(t.initiatedBy),
    index('agent_runs_trigger_idx').on(t.trigger),
    index('agent_runs_model_token_idx').on(t.modelTokenHash).where(isNotNull(t.modelTokenHash)),
    index('agent_runs_started_idx').on(t.startedAt.desc().nullsLast(), t.id.desc()),
    index('agent_runs_recent_idx').on(t.startedAt.desc().nullsFirst()),
    index('agent_runs_agent_started_idx').on(
      t.agentId,
      t.startedAt.desc().nullsLast(),
      t.id.desc(),
    ),
    index('agent_runs_running_idx').on(t.status).where(eq(t.status, 'running')),
    index('agent_runs_status_started_idx').on(
      t.status,
      t.startedAt.desc().nullsLast(),
      t.id.desc(),
    ),
    uniqueIndex('agent_runs_channel_trigger_idx')
      .on(t.channelId, t.channelTriggerMessageId, t.agentId)
      .where(isNotNull(t.channelId)),
    uniqueIndex('agent_runs_retry_of_idx')
      .on(t.retryOfRunId)
      .where(sql`${t.retryOfRunId} is not null`),
  ],
);

export const outputShares = pgTable(
  'output_shares',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
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
