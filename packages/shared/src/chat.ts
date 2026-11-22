import { z } from 'zod';
import { effortSchema, permissionModeSchema, uiFormatSchema } from './agent.js';
import { ATTACHMENT_LIMITS, chatAttachmentInputsSchema } from './attachments.js';
import { DEFAULT_MEMORY_POLICY, memoryPolicySchema } from './memory.js';
import { openUiActionSchema } from './openui/protocol.js';
import { outputRefSchema } from './outputs.js';
import { nativeQuestionsSchema, publicRunQuestionSchema } from './questions.js';
import {
  type RunErrorKind,
  runStatusSchema,
  terminalRunStatusSchema,
  type WireFailureKind,
  wireFailureKindSchema,
} from './run-state.js';
import { utf8Bytes } from './utf8.js';

export const PORTABLE_TODO_ENV = {
  CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
  CLAUDE_CODE_ENABLE_TASKS: '0',
} as const;

export const SANDBOX_RUNTIME_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  // 启用原生 TodoWrite（而非四个 Task 工具），平台据此渲染任务进度。
  ...PORTABLE_TODO_ENV,
} as const;

export const CHAT_AGENT_DISABLED_MESSAGE =
  '该智能体已停用，无法发起新对话；请到智能体页面启用后再试';

export const CONVERSATION_NOT_IN_AGENT_MESSAGE = '会话不存在或不属于该智能体；请从会话列表重新打开';

export const REGENERATE_MISSING_MESSAGE = '该会话没有可重新生成的回复';

export const chatRequestSchema = z
  .object({
    agentId: z.string().optional(),
    conversationId: z.string().optional(),
    message: z
      .string()
      .refine(
        (value) => utf8Bytes(value) <= ATTACHMENT_LIMITS.messageBytes,
        `消息超过 ${ATTACHMENT_LIMITS.messageBytes / 1024} KiB（UTF-8 编码）`,
      )
      .nullable(),
    attachments: chatAttachmentInputsSchema.optional(),
    openuiAction: openUiActionSchema.optional(),
    output: outputRefSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.message !== null && value.message.trim().length > 0) ||
      (value.attachments?.length ?? 0) > 0,
    { message: '消息正文或附件至少提供一项', path: ['message'] },
  );

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatMessageRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;

export const progressTodoSchema = z.object({
  content: z.string(),
  activeForm: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export type ProgressTodo = z.infer<typeof progressTodoSchema>;

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), conversationId: z.string() }),
  z.object({
    type: z.literal('replay_truncated'),
    reason: z.enum(['retention', 'bytes', 'budget', 'terminal_missing']),
  }),
  z.object({
    type: z.literal('assistant_block_start'),
    blockIndex: z.number().int().nonnegative(),
    kind: z.enum(['text', 'tool_use']),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
    streamBlockId: z.string().optional(),
  }),
  z.object({
    type: z.literal('assistant_block_stop'),
    blockIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('text_delta'),
    text: z.string(),
    blockIndex: z.number().int().nonnegative().optional(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
    streamBlockId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_start'),
    toolUseId: z.string(),
    name: z.string(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_input'),
    toolUseId: z.string(),
    json: z.string(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    todos: z.array(progressTodoSchema).optional(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal('assistant_text'),
    text: z.string(),
    sdkUuid: z.string().optional(),
    parentToolUseId: z.string().optional(),
    blockIndex: z.number().int().nonnegative().optional(),
    streamBlockId: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('question_requested'),
    requestId: z.string(),
    toolUseId: z.string(),
    questions: nativeQuestionsSchema,
  }),
  z.object({ type: z.literal('question_closed'), requestId: z.string() }),
  z.object({ type: z.literal('question_updated'), question: publicRunQuestionSchema }),
  z.object({
    type: z.literal('session_forked'),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('run_finished'),
    status: terminalRunStatusSchema,
    messageIds: z
      .array(
        z.object({
          id: z.string(),
          blockIndex: z.number(),
          streamBlockId: z.string().optional(),
          parentToolUseId: z.string().optional(),
          uiFormat: uiFormatSchema.optional(),
          uiProgram: z.string().nullable().optional(),
          uiState: z.unknown().optional(),
        }),
      )
      .optional(),
    costUsd: z.number().optional(),
    turns: z.number().optional(),
    sessionId: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    error: z.string().optional(),
    failureKind: wireFailureKindSchema.optional(),
  }),
  z.object({ type: z.literal('run_unavailable'), message: z.string() }),
  z.object({ type: z.literal('run_warning'), message: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

export function streamBlockIdOf(event: ChatEvent): string | undefined {
  if (!('streamBlockId' in event)) return undefined;
  return typeof event.streamBlockId === 'string' ? event.streamBlockId : undefined;
}

export function wireFailureKind(reason: RunErrorKind): WireFailureKind {
  if (reason === 'cancelled') return 'cancelled';
  if (reason === 'infra') return 'infra';
  return 'agent';
}

export const agentRunJobSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  prompt: z.string(),
  requestId: z.string().optional(),
  replacesRunId: z.string().optional(),
  regenerateContent: z
    .object({ openuiAction: z.array(z.record(z.string(), z.unknown())).optional() })
    .optional(),
  forkFromMessageUuid: z.uuid().optional(),
});

export type AgentRunJob = z.infer<typeof agentRunJobSchema>;

export const sandboxTaskSchema = z
  .object({
    prompt: z.string(),
    model: z.string(),
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    permissionMode: permissionModeSchema.optional(),
    mcpServers: z.array(z.string()).default([]),
    mcpServerIds: z.record(z.string(), z.string()).default({}),
    mcpApprovalTools: z.array(z.object({ server: z.string(), tool: z.string() })).default([]),
    skills: z.array(z.string()).default([]),
    hasWorkflows: z.boolean().default(false),
    extraAllowedTools: z.array(z.string()).default([]),
    extraDisallowedTools: z.array(z.string()).default([]),
    effort: effortSchema.optional(),
    allowSubAgents: z.boolean().default(false),
    maxFieldBytes: z.number().int().positive().optional(),
    plugins: z
      .array(
        z.object({
          path: z.string().min(1),
          runtimeName: z.string().min(1),
          skills: z.array(z.string()).default([]),
          mcpServers: z.array(z.string()).default([]),
          hasAgents: z.boolean().default(false),
        }),
      )
      .default([]),
    subAgents: z
      .array(
        z.object({
          slug: z.string(),
          servers: z.array(z.string()).default([]),
          skills: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    resumeSessionId: z.string().optional(),
    userMessageUuid: z.uuid(),
    forkFromMessageUuid: z.uuid().optional(),
    memoryPolicy: memoryPolicySchema.default(DEFAULT_MEMORY_POLICY),
  })
  .strict();

export type SandboxTask = z.infer<typeof sandboxTaskSchema>;
export type SandboxTaskInput = z.input<typeof sandboxTaskSchema>;

export const evalRunJobSchema = z.object({ evalRunId: z.string() });

export type EvalRunJob = z.infer<typeof evalRunJobSchema>;

export function judge(output: string, expectation: string): boolean {
  if (expectation.trim().length === 0) return output.trim().length > 0;
  return output.toLowerCase().includes(expectation.trim().toLowerCase());
}

export const conversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(128),
});

export const conversationSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessage: z
    .object({ role: z.string(), text: z.string(), createdAt: z.string() })
    .nullable()
    .default(null),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const publicConversationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});

export const conversationBranchSchema = publicConversationSchema.extend({
  parentId: z.string().nullable(),
  branchOfMessageId: z.string().nullable(),
});

export type ConversationBranch = z.infer<typeof conversationBranchSchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.string(),
  content: z.unknown(),
  runId: z.string().nullable().default(null),
  createdAt: z.string(),
  uiFormat: uiFormatSchema.default('markdown'),
  uiProgram: z.string().nullable().default(null),
  uiState: z.unknown().nullable().default(null),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationRunMetricsSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  turns: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  tokens: z.number().nullable().default(null),
  costUsd: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});

export type ConversationRunMetrics = z.infer<typeof conversationRunMetricsSchema>;

export const conversationDetailSchema = z.object({
  conversation: publicConversationSchema,
  messages: z.array(conversationMessageSchema),
  runMetrics: z.array(conversationRunMetricsSchema).default([]),
  nextCursor: z.string().nullable(),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

export const conversationSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export const conversationSearchMatchSchema = z.object({
  kind: z.enum(['id', 'title', 'message']),
  excerpt: z.string().nullable(),
});

export const conversationSearchItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  match: conversationSearchMatchSchema.nullable(),
});

export type ConversationSearchItem = z.infer<typeof conversationSearchItemSchema>;

export const conversationSearchResponseSchema = z.object({
  items: z.array(conversationSearchItemSchema),
  nextCursor: z.string().nullable(),
});

export type ConversationSearchResponse = z.infer<typeof conversationSearchResponseSchema>;
