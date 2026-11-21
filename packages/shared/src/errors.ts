import { z } from 'zod';

/**
 * 错误契约（RFC 9457 Problem Details 的最小扩展）。
 *
 * 为什么不是 `{ error: string }`：客户端要能按 `code` 分支、按 `retryable`
 * 决定是否重试、按 `requestId` 关联日志。HTTP 状态码只表达类别，不表达原因。
 *
 * 哪些字段进 wire、哪些只进日志：
 * - 进 wire：code / message / status / requestId / retryable / path / resource / resourceId / hint / errors
 * - 不进 wire：堆栈、SQL、上游响应体、内部标识。500 一律换成固定文案。
 */

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * 稳定错误码。加新码是兼容变更；改语义或删除是破坏性变更——
 * 前端与外部 MCP 客户端都可能依赖它。
 */
export const ERROR_META = {
  INVALID_INPUT: { status: 400, retryable: false, hint: '根据出错字段和校验明细修正请求。' },
  INVALID_URL: {
    status: 400,
    retryable: false,
    hint: '检查地址格式和可达性，改用当前环境允许的地址。',
  },
  INVALID_REFERENCE: {
    status: 400,
    retryable: false,
    hint: '重新查询被引用的资源，换成当前操作可用的引用。',
  },
  UNAUTHORIZED: { status: 401, retryable: false, hint: '重新认证并更新请求凭证。' },
  FORBIDDEN: {
    status: 403,
    retryable: false,
    hint: '核对当前身份的角色和资源权限，必要时申请授权。',
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    hint: '刷新资源列表，按资源类别和标识核对对象是否存在且可访问。',
  },
  CONFLICT: { status: 409, retryable: false, hint: '查询已有记录和当前状态，解决冲突后再提交。' },
  CONFLICT_STALE: { status: 409, retryable: false, hint: '读取最新版本并合并变更后重新提交。' },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    hint: '根据大小限制缩减内容、减少所选条目或分批提交。',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    retryable: false,
    hint: '按接口支持的格式转换内容并设置对应的媒体类型。',
  },
  RATE_LIMITED: {
    status: 429,
    retryable: true,
    hint: '等待响应指定的时长后重试，未指定时逐步延长等待时间。',
  },
  AGENT_DISABLED: {
    status: 409,
    retryable: false,
    hint: '改用已启用的智能体，或请管理员核实后启用当前智能体。',
  },
  AGENT_BUDGET_EXCEEDED: {
    status: 409,
    retryable: false,
    hint: '核对该智能体的用量和预算，申请调整额度或等待额度恢复。',
  },
  BUDGET_EXCEEDED: {
    status: 409,
    retryable: false,
    hint: '查看本次操作受限的预算和用量，申请增加额度或等待额度恢复。',
  },
  CONTENT_BLOCKED: {
    status: 403,
    retryable: false,
    hint: '根据内容策略移除或脱敏受限内容，必要时请管理员核对规则。',
  },
  CONTENT_APPROVAL_REQUIRED: {
    status: 409,
    retryable: false,
    hint: '查找对应审批并等待处理，通过后按审批结果继续。',
  },
  EVAL_RUN_IN_PROGRESS: {
    status: 409,
    retryable: false,
    hint: '查询正在进行的评估，等待其结束后再发起。',
  },
  BASE_MISMATCH: {
    status: 400,
    retryable: false,
    hint: '核对当前绑定的知识库，从该库重新选择目标资源。',
  },
  BASE_DISABLED: {
    status: 409,
    retryable: false,
    hint: '改用已启用的知识库，或请管理员核实后启用当前知识库。',
  },
  DOCUMENT_NOT_FOUND: {
    status: 404,
    retryable: false,
    hint: '刷新知识库文档列表，核对目标文档及其访问权限。',
  },
  WIKI_NOT_FOUND: {
    status: 404,
    retryable: false,
    hint: '刷新知识库页面列表，核对页面标识和所属知识库。',
  },
  VERSION_NOT_CURRENT: {
    status: 409,
    retryable: false,
    hint: '重新查询当前有效版本，使用最新的版本标识。',
  },
  INTERNAL_ERROR: {
    status: 500,
    retryable: false,
    hint: '凭请求标识查询服务日志，核对操作结果并定位故障。',
  },
  RESPONSE_INVALID: {
    status: 500,
    retryable: false,
    hint: '凭请求标识查询服务日志，修正响应中不符合接口契约的字段。',
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    retryable: false,
    hint: '检查依赖服务和任务积压，恢复后先确认原操作的结果。',
  },
  UPSTREAM_FAILED: {
    status: 502,
    retryable: false,
    hint: '凭请求标识排查上游故障，确认原操作是否已经执行。',
  },
} as const satisfies Record<string, { status: number; retryable: boolean; hint: string }>;

export type ErrorCode = keyof typeof ERROR_META;

export const errorCodeSchema = z.enum(Object.keys(ERROR_META) as ErrorCode[]);

/** wire 形状；前端 `ApiError` 与 MCP 客户端都按它解析。 */
export const problemSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  status: z.number().int(),
  requestId: z.string(),
  retryable: z.boolean(),
  /** 出错字段的 JSON Pointer，例如 `/name`。只有校验类错误才有。 */
  path: z.string().optional(),
  /** `NOT_FOUND` 的具体资源类别，例如 `agent`、`conversation`。 */
  resource: z.string().optional(),
  /** 出错资源的标识；仅在调用方持有且适合外发时带上。 */
  resourceId: z.string().optional(),
  /** 面向智能体/运维的排查建议（不面向终端用户）；按 code 若能给出默认值则填充。 */
  hint: z.string().optional(),
  /** 字段级明细；批量导入等场景一次返回多条。 */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
