import { type ErrorCode, errorCode } from '@agentport/shared';

/**
 * 业务异常：只表达「什么错了」，不关心 HTTP。
 *
 * 分层规则（对应 NestJS 的 DomainError + 全局 filter、Spring 的 ErrorResponse）：
 * - core / db / 业务代码抛 AppError，`code` 自身带状态码，不必再写 `statusCode: 409`
 * - 非 AppError 的一切（数据库断开、上游超时、代码缺陷）都归为系统异常，
 *   细节只进日志，响应固定 500
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly path?: string;
  readonly resource?: string;
  readonly resourceId?: string;
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      path?: string;
      resource?: string;
      resourceId?: string;
      hint?: string;
      cause?: unknown;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = errorCode[code];
    // 默认 5xx 可重试；并发冲突/限流由调用方显式声明。
    this.retryable = options?.retryable ?? this.status >= 500;
    if (options?.path !== undefined) this.path = options.path;
    if (options?.resource !== undefined) this.resource = options.resource;
    if (options?.resourceId !== undefined) this.resourceId = options.resourceId;
    if (options?.hint !== undefined) this.hint = options.hint;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** 业务异常的简写；读起来像断言，不像在构造对象。 */
export function fail(
  code: ErrorCode,
  message: string,
  options?: {
    path?: string;
    resource?: string;
    resourceId?: string;
    hint?: string;
    cause?: unknown;
    retryable?: boolean;
  },
): never {
  throw new AppError(code, message, options);
}

export const NOT_FOUND_MESSAGES = {
  agent: '智能体不存在，可能已被删除；请刷新后重试',
  conversation: '会话不存在，可能已被删除；请刷新后重试',
  run: '运行记录不存在，可能已被清理；请刷新后重试',
  approval: '审批记录不存在，可能已被处理或失效；请刷新后重试',
} as const;
export type NotFoundResource = keyof typeof NOT_FOUND_MESSAGES;

export function notFound(resource: NotFoundResource, message?: string, resourceId?: string): never {
  throw new AppError('NOT_FOUND', message ?? NOT_FOUND_MESSAGES[resource], {
    resource,
    ...(resourceId === undefined ? {} : { resourceId }),
  });
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
