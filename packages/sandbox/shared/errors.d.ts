import { z } from 'zod';
/**
 * 错误契约（RFC 9457 Problem Details 的最小扩展）。
 *
 * 为什么不是 `{ error: string }`：客户端要能按 `code` 分支、按 `retryable`
 * 决定是否重试、按 `requestId` 关联日志。HTTP 状态码只表达类别，不表达原因。
 *
 * 哪些字段进 wire、哪些只进日志：
 * - 进 wire：code / message / status / requestId / retryable / path / errors
 * - 不进 wire：堆栈、SQL、上游响应体、内部标识。500 一律换成固定文案。
 */
/**
 * 稳定错误码。加新码是兼容变更；改语义或删除是破坏性变更——
 * 前端与外部 MCP 客户端都可能依赖它。
 */
export declare const errorCode: {
    readonly INVALID_INPUT: 400;
    readonly INVALID_URL: 400;
    readonly INVALID_REFERENCE: 400;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly NOT_FOUND: 404;
    readonly CONFLICT: 409;
    readonly CONFLICT_STALE: 409;
    readonly PAYLOAD_TOO_LARGE: 413;
    readonly UNSUPPORTED_MEDIA_TYPE: 415;
    readonly RATE_LIMITED: 429;
    readonly AGENT_NOT_FOUND: 404;
    readonly AGENT_DISABLED: 409;
    readonly CONVERSATION_NOT_FOUND: 404;
    readonly RUN_NOT_FOUND: 404;
    readonly EVAL_RUN_IN_PROGRESS: 409;
    readonly APPROVAL_NOT_FOUND: 404;
    readonly INTERNAL_ERROR: 500;
    readonly RESPONSE_INVALID: 500;
    readonly SERVICE_UNAVAILABLE: 503;
    readonly UPSTREAM_FAILED: 502;
};
export type ErrorCode = keyof typeof errorCode;
export declare const errorCodeSchema: z.ZodEnum<{
    AGENT_DISABLED: "AGENT_DISABLED";
    AGENT_NOT_FOUND: "AGENT_NOT_FOUND";
    APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND";
    CONFLICT: "CONFLICT";
    CONFLICT_STALE: "CONFLICT_STALE";
    CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND";
    EVAL_RUN_IN_PROGRESS: "EVAL_RUN_IN_PROGRESS";
    FORBIDDEN: "FORBIDDEN";
    INTERNAL_ERROR: "INTERNAL_ERROR";
    INVALID_INPUT: "INVALID_INPUT";
    INVALID_REFERENCE: "INVALID_REFERENCE";
    INVALID_URL: "INVALID_URL";
    NOT_FOUND: "NOT_FOUND";
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE";
    RATE_LIMITED: "RATE_LIMITED";
    RESPONSE_INVALID: "RESPONSE_INVALID";
    RUN_NOT_FOUND: "RUN_NOT_FOUND";
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE";
    UNAUTHORIZED: "UNAUTHORIZED";
    UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE";
    UPSTREAM_FAILED: "UPSTREAM_FAILED";
}>;
/** wire 形状；前端 `ApiError` 与 MCP 客户端都按它解析。 */
export declare const problemSchema: z.ZodObject<{
    code: z.ZodEnum<{
        AGENT_DISABLED: "AGENT_DISABLED";
        AGENT_NOT_FOUND: "AGENT_NOT_FOUND";
        APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND";
        CONFLICT: "CONFLICT";
        CONFLICT_STALE: "CONFLICT_STALE";
        CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND";
        EVAL_RUN_IN_PROGRESS: "EVAL_RUN_IN_PROGRESS";
        FORBIDDEN: "FORBIDDEN";
        INTERNAL_ERROR: "INTERNAL_ERROR";
        INVALID_INPUT: "INVALID_INPUT";
        INVALID_REFERENCE: "INVALID_REFERENCE";
        INVALID_URL: "INVALID_URL";
        NOT_FOUND: "NOT_FOUND";
        PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE";
        RATE_LIMITED: "RATE_LIMITED";
        RESPONSE_INVALID: "RESPONSE_INVALID";
        RUN_NOT_FOUND: "RUN_NOT_FOUND";
        SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE";
        UNAUTHORIZED: "UNAUTHORIZED";
        UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE";
        UPSTREAM_FAILED: "UPSTREAM_FAILED";
    }>;
    message: z.ZodString;
    status: z.ZodNumber;
    requestId: z.ZodString;
    retryable: z.ZodBoolean;
    path: z.ZodOptional<z.ZodString>;
    errors: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type Problem = z.infer<typeof problemSchema>;
//# sourceMappingURL=errors.d.ts.map