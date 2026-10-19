import { z } from 'zod';

export const chatRequestSchema = z.object({
  agentId: z.string(),
  conversationId: z.string().optional(),
  message: z.string().min(1),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** SSE 事件：前端按 `type` 分派。 */
export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), runId: z.string(), conversationId: z.string() }),
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_start'), toolUseId: z.string(), name: z.string() }),
  z.object({ type: z.literal('tool_input'), toolUseId: z.string(), json: z.string() }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.string() }),
  z.object({
    type: z.literal('run_finished'),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
    costUsd: z.number().optional(),
    turns: z.number().optional(),
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
});

export type AgentRunJob = z.infer<typeof agentRunJobSchema>;
