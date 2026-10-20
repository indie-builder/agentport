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
export const errorCode = {
  // 输入与协议
  INVALID_INPUT: 400,
  INVALID_URL: 400,
  INVALID_REFERENCE: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFLICT_STALE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  // 资源
  AGENT_NOT_FOUND: 404,
  AGENT_DISABLED: 409,
  CONVERSATION_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  EVAL_RUN_IN_PROGRESS: 409,
  APPROVAL_NOT_FOUND: 404,
  // 服务端缺陷与依赖
  INTERNAL_ERROR: 500,
  RESPONSE_INVALID: 500,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_FAILED: 502,
} as const;

export type ErrorCode = keyof typeof errorCode;

export const errorCodeSchema = z.enum(Object.keys(errorCode) as [ErrorCode, ...ErrorCode[]]);

/** wire 形状；前端 `ApiError` 与 MCP 客户端都按它解析。 */
export const problemSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  status: z.number().int(),
  requestId: z.string(),
  /** 同一个请求重试是否可能成功。客户端据此决定自动重试还是提示用户。 */
  retryable: z.boolean(),
  /** 出错字段的 JSON Pointer，例如 `/name`。只有校验类错误才有。 */
  path: z.string().optional(),
  /** 字段级明细；批量导入等场景一次返回多条。 */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
