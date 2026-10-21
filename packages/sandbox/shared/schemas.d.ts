import { z } from 'zod';
/**
 * 前端真正解析的响应形状。路由声明 `response` 后，Fastify 会按 schema 序列化：
 * 漏声明的字段会被静默丢弃，多余字段同样被丢弃，类型不符则 500 RESPONSE_INVALID。
 * 只覆盖前端消费的端点，不追求覆盖全部路由。
 */
export declare const runStatusSchema: z.ZodEnum<{
    cancelled: "cancelled";
    failed: "failed";
    queued: "queued";
    running: "running";
    succeeded: "succeeded";
    timeout: "timeout";
}>;
/** /api/runs 列表项；costUsd 是 numeric，pg 驱动返回字符串。 */
export declare const runListItemSchema: z.ZodObject<{
    id: z.ZodString;
    agentId: z.ZodString;
    agentName: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        failed: "failed";
        queued: "queued";
        running: "running";
        succeeded: "succeeded";
        timeout: "timeout";
    }>;
    startedAt: z.ZodNullable<z.ZodString>;
    endedAt: z.ZodNullable<z.ZodString>;
    latencyMs: z.ZodNullable<z.ZodNumber>;
    costUsd: z.ZodNullable<z.ZodString>;
    turns: z.ZodNullable<z.ZodNumber>;
    inputTokens: z.ZodNullable<z.ZodNumber>;
    outputTokens: z.ZodNullable<z.ZodNumber>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type RunListItem = z.infer<typeof runListItemSchema>;
export declare const runListSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        agentName: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            failed: "failed";
            queued: "queued";
            running: "running";
            succeeded: "succeeded";
            timeout: "timeout";
        }>;
        startedAt: z.ZodNullable<z.ZodString>;
        endedAt: z.ZodNullable<z.ZodString>;
        latencyMs: z.ZodNullable<z.ZodNumber>;
        costUsd: z.ZodNullable<z.ZodString>;
        turns: z.ZodNullable<z.ZodNumber>;
        inputTokens: z.ZodNullable<z.ZodNumber>;
        outputTokens: z.ZodNullable<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const runStepSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"user">;
    at: z.ZodString;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"assistant">;
    at: z.ZodString;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"tool">;
    at: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    toolUseId: z.ZodNullable<z.ZodString>;
    content: z.ZodUnknown;
    result: z.ZodOptional<z.ZodUnknown>;
    parentToolUseId: z.ZodNullable<z.ZodString>;
}, z.core.$strip>], "kind">;
export declare const runDetailSchema: z.ZodObject<{
    run: z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        agentName: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            failed: "failed";
            queued: "queued";
            running: "running";
            succeeded: "succeeded";
            timeout: "timeout";
        }>;
        startedAt: z.ZodNullable<z.ZodString>;
        endedAt: z.ZodNullable<z.ZodString>;
        latencyMs: z.ZodNullable<z.ZodNumber>;
        costUsd: z.ZodNullable<z.ZodString>;
        turns: z.ZodNullable<z.ZodNumber>;
        inputTokens: z.ZodNullable<z.ZodNumber>;
        outputTokens: z.ZodNullable<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
        conversationId: z.ZodString;
        sessionId: z.ZodNullable<z.ZodString>;
        sandboxId: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    steps: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"user">;
        at: z.ZodString;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"assistant">;
        at: z.ZodString;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"tool">;
        at: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        toolUseId: z.ZodNullable<z.ZodString>;
        content: z.ZodUnknown;
        result: z.ZodOptional<z.ZodUnknown>;
        parentToolUseId: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>], "kind">>;
    conversation: z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        title: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
/** /api/overview 的 recent：没有 tokens 两列。 */
export declare const recentRunSchema: z.ZodObject<{
    id: z.ZodString;
    agentId: z.ZodString;
    agentName: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        failed: "failed";
        queued: "queued";
        running: "running";
        succeeded: "succeeded";
        timeout: "timeout";
    }>;
    startedAt: z.ZodNullable<z.ZodString>;
    endedAt: z.ZodNullable<z.ZodString>;
    costUsd: z.ZodNullable<z.ZodString>;
    turns: z.ZodNullable<z.ZodNumber>;
    latencyMs: z.ZodNullable<z.ZodNumber>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const overviewSchema: z.ZodObject<{
    window: z.ZodObject<{
        days: z.ZodNumber;
        since: z.ZodString;
    }, z.core.$strip>;
    counts: z.ZodObject<{
        servers: z.ZodNumber;
        agents: z.ZodNumber;
        runs: z.ZodNumber;
        running: z.ZodNumber;
        costUsd: z.ZodNumber;
        avgLatencyMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    agents: z.ZodArray<z.ZodObject<{
        agentId: z.ZodString;
        name: z.ZodString;
        slug: z.ZodString;
        createdAt: z.ZodNullable<z.ZodString>;
        enabled: z.ZodBoolean;
        lastRunStartTime: z.ZodNullable<z.ZodString>;
        runCount: z.ZodNumber;
        totalCost: z.ZodNumber;
        errorRate: z.ZodNumber;
        latencyP50: z.ZodNullable<z.ZodNumber>;
        latencyP99: z.ZodNullable<z.ZodNumber>;
        totalTokens: z.ZodNumber;
    }, z.core.$strip>>;
    recent: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        agentName: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            failed: "failed";
            queued: "queued";
            running: "running";
            succeeded: "succeeded";
            timeout: "timeout";
        }>;
        startedAt: z.ZodNullable<z.ZodString>;
        endedAt: z.ZodNullable<z.ZodString>;
        costUsd: z.ZodNullable<z.ZodString>;
        turns: z.ZodNullable<z.ZodNumber>;
        latencyMs: z.ZodNullable<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** 评估运行：worker 崩溃时把原因写进 error；前端据此说明失败原因。 */
export declare const evalRunSchema: z.ZodObject<{
    id: z.ZodString;
    agentId: z.ZodString;
    status: z.ZodEnum<{
        failed: "failed";
        running: "running";
        succeeded: "succeeded";
    }>;
    total: z.ZodNumber;
    passed: z.ZodNumber;
    error: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    finishedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type EvalRun = z.infer<typeof evalRunSchema>;
export declare const evalResultSchema: z.ZodObject<{
    caseId: z.ZodString;
    name: z.ZodString;
    prompt: z.ZodString;
    expectation: z.ZodString;
    passed: z.ZodBoolean;
    output: z.ZodString;
    runId: z.ZodString;
}, z.core.$strip>;
export declare const evalRunDetailSchema: z.ZodObject<{
    evalRun: z.ZodObject<{
        id: z.ZodString;
        agentId: z.ZodString;
        status: z.ZodEnum<{
            failed: "failed";
            running: "running";
            succeeded: "succeeded";
        }>;
        total: z.ZodNumber;
        passed: z.ZodNumber;
        error: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodString;
        finishedAt: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    results: z.ZodArray<z.ZodObject<{
        caseId: z.ZodString;
        name: z.ZodString;
        prompt: z.ZodString;
        expectation: z.ZodString;
        passed: z.ZodBoolean;
        output: z.ZodString;
        runId: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
//# sourceMappingURL=schemas.d.ts.map