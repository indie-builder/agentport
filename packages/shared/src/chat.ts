import { z } from 'zod';

export const chatRequestSchema = z.object({
  agentId: z.string(),
  conversationId: z.string().optional(),
  // 沙盒把 prompt 走 stdin，超大输入会拖垮 worker；在入口统一限制为 64KB。
  message: z
    .string()
    .min(1)
    .max(64 * 1024, 'message exceeds 64KB'),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** SSE 事件：前端按 `type` 分派。 */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), conversationId: z.string() }),
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_start'), toolUseId: z.string(), name: z.string() }),
  z.object({ type: z.literal('tool_input'), toolUseId: z.string(), json: z.string() }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.string() }),
  /** 已完成的 assistant 文本块；用于落库，前端可与 text_delta 去重。 */
  z.object({ type: z.literal('assistant_text'), text: z.string() }),
  z.object({
    type: z.literal('run_finished'),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
    costUsd: z.number().optional(),
    turns: z.number().optional(),
    sessionId: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof chatEventSchema>;

/** BullMQ job 载荷，producer 与 consumer 共用。 */
export const agentRunJobSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  prompt: z.string(),
  /** 已格式化的历史对话；沙盒是新容器，只能靠它恢复上下文。 */
  history: z.string().optional(),
});

export type AgentRunJob = z.infer<typeof agentRunJobSchema>;

/** 评估跑批队列：只传 id，worker 自己读用例，避免 API 重启丢失进程内状态。 */
export const EVAL_RUNS_QUEUE = 'eval-runs';

export const evalRunJobSchema = z.object({ evalRunId: z.string() });

export type EvalRunJob = z.infer<typeof evalRunJobSchema>;

/** 最小判定：expectation 非空则大小写不敏感包含；为空则只要求有文本。 */
export function judge(output: string, expectation: string): boolean {
  if (expectation.trim().length === 0) return output.trim().length > 0;
  return output.toLowerCase().includes(expectation.trim().toLowerCase());
}

/** 会话列表项：按 agent 过滤，按最近消息倒序。 */
export const conversationSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessage: z
    .object({ role: z.string(), text: z.string(), createdAt: z.string() })
    .nullable()
    .default(null),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** 会话详情中的单条消息。 */
export const conversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.string(),
  content: z.unknown(),
  runId: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationDetailSchema = z.object({
  conversation: z.object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    createdAt: z.string(),
  }),
  messages: z.array(conversationMessageSchema),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
