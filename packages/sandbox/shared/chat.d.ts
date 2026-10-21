import { z } from 'zod';
export declare const chatRequestSchema: z.ZodObject<{
    agentId: z.ZodString;
    conversationId: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
}, z.core.$strip>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
/** SSE 事件：前端按 `type` 分派。 */
export declare const chatEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"run_started">;
    runId: z.ZodString;
    conversationId: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"text_delta">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_start">;
    toolUseId: z.ZodString;
    name: z.ZodString;
    parentToolUseId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_input">;
    toolUseId: z.ZodString;
    json: z.ZodString;
    parentToolUseId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    content: z.ZodString;
    parentToolUseId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"assistant_text">;
    text: z.ZodString;
    parentToolUseId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"run_finished">;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        failed: "failed";
        succeeded: "succeeded";
        timeout: "timeout";
    }>;
    costUsd: z.ZodOptional<z.ZodNumber>;
    turns: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    inputTokens: z.ZodOptional<z.ZodNumber>;
    outputTokens: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
    failureKind: z.ZodOptional<z.ZodEnum<{
        agent: "agent";
        cancelled: "cancelled";
        infra: "infra";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"error">;
    message: z.ZodString;
}, z.core.$strip>], "type">;
export type ChatEvent = z.infer<typeof chatEventSchema>;
/** 事件里的失败分类只有三档；sandbox 与 timeout 都归入不可重试的服务端失败。 */
export declare function wireFailureKind(reason: 'cancelled' | 'timeout' | 'sandbox' | 'agent' | 'infra'): 'agent' | 'infra' | 'cancelled';
/** BullMQ job 载荷，producer 与 consumer 共用。 */
export declare const agentRunJobSchema: z.ZodObject<{
    runId: z.ZodString;
    agentId: z.ZodString;
    conversationId: z.ZodString;
    prompt: z.ZodString;
    history: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type AgentRunJob = z.infer<typeof agentRunJobSchema>;
export declare const RUNS_QUEUE = "agent-runs";
/** 评估跑批队列：只传 id，worker 自己读用例，避免 API 重启丢失进程内状态。 */
export declare const EVAL_RUNS_QUEUE = "eval-runs";
export declare const evalRunJobSchema: z.ZodObject<{
    evalRunId: z.ZodString;
}, z.core.$strip>;
export type EvalRunJob = z.infer<typeof evalRunJobSchema>;
/** 最小判定：expectation 非空则大小写不敏感包含；为空则只要求有文本。 */
export declare function judge(output: string, expectation: string): boolean;
/** 会话列表项：按 agent 过滤，按最近消息倒序。 */
export declare const conversationSummarySchema: z.ZodObject<{
    id: z.ZodString;
    agentId: z.ZodString;
    title: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    lastMessage: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        role: z.ZodString;
        text: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
/** 会话详情中的单条消息。 */
export declare const conversationMessageSchema: z.ZodObject<{
    id: z.ZodString;
    conversationId: z.ZodString;
    role: z.ZodString;
    content: z.ZodUnknown;
    runId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodString;
}, z.core.$strip>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export declare const conversationDetailSchema: z.ZodObject<{
    conversation: z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        title: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>;
    messages: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        conversationId: z.ZodString;
        role: z.ZodString;
        content: z.ZodUnknown;
        runId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        createdAt: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
//# sourceMappingURL=chat.d.ts.map