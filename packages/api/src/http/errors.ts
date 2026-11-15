import { errorCodeForStatus } from '@agentport/contract/errors';
import { AppError, isAppError } from '@agentport/core';
import { type ErrorCode, errorCode, type Problem } from '@agentport/shared';
import { ORPCError, ValidationError } from '@orpc/contract';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export { AppError, isAppError } from '@agentport/core';

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(errorCode, code);
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return new AppError('INVALID_INPUT', first?.message ?? '请求无效', {
      ...(first === undefined ? {} : { path: issuePath(first.path) }),
      cause: error,
    });
  }
  if (error instanceof ORPCError) {
    if (error.code === 'INTERNAL_SERVER_ERROR' && error.cause instanceof ValidationError) {
      return new AppError('RESPONSE_INVALID', 'response did not match its schema', {
        cause: error,
      });
    }
    if (isErrorCode(error.code)) return new AppError(error.code, error.message, { cause: error });
    const code = errorCodeForStatus(error.status);
    const first = error.cause instanceof ValidationError ? error.cause.issues[0] : undefined;
    return new AppError(
      code,
      first?.message ?? (code === 'INVALID_INPUT' ? '请求无效' : error.message),
      {
        ...(first?.path === undefined
          ? {}
          : {
              path: issuePath(
                first.path.map((part) => (typeof part === 'object' ? part.key : part)),
              ),
            }),
        cause: error,
      },
    );
  }
  if (error instanceof HTTPException) {
    return new AppError(errorCodeForStatus(error.status), error.message, {
      cause: error,
    });
  }
  if (
    error instanceof Error &&
    error.name === 'RedisError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('ERR_REDIS_CONNECTION_')
  ) {
    return new AppError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试', {
      cause: error,
      retryable: true,
    });
  }
  return new AppError('INTERNAL_ERROR', 'Internal server error', { cause: error });
}

function issuePath(path: readonly PropertyKey[]): string {
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

const CODE_HINTS: Partial<Record<ErrorCode, string>> = {
  NOT_FOUND:
    '确认 resource/resourceId 指向的对象存在且属于当前主体；必要时刷新列表，或用 requestId 查服务日志。',
  INVALID_INPUT: '按 path/errors 修正请求字段后重试。',
  UNAUTHORIZED: '重新登录后重试。',
  FORBIDDEN: '当前主体无该操作权限；确认账号角色或申请授权。',
  CONFLICT_STALE: '重新拉取最新数据后重试。',
  RATE_LIMITED: '按退避策略稍后重试。',
  SERVICE_UNAVAILABLE: '稍后重试；持续出现请检查依赖(DB/Redis)与队列积压。',
  UPSTREAM_FAILED: '稍后重试；持续出现请检查上游服务。',
  INTERNAL_ERROR: '用 requestId 查服务日志定位缺陷。',
  RESPONSE_INVALID: '服务端响应不符合契约，用 requestId 查服务日志。',
};

export function problem(requestId: string, error: AppError, extra?: Partial<Problem>): Problem {
  const hint = error.hint ?? CODE_HINTS[error.code];
  return {
    code: error.code,
    message: error.status >= 500 ? 'Internal server error' : error.message,
    status: error.status,
    requestId,
    retryable: error.retryable,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.resource === undefined ? {} : { resource: error.resource }),
    ...(error.resourceId === undefined ? {} : { resourceId: error.resourceId }),
    ...(hint === undefined ? {} : { hint }),
    ...extra,
  };
}

export function errorProblem(requestId: string, error: unknown): Problem {
  const normalized = toAppError(error);
  const issues =
    error instanceof z.ZodError
      ? error.issues
      : error instanceof ORPCError && error.status === 400 && error.cause instanceof ValidationError
        ? error.cause.issues
        : undefined;
  return problem(
    requestId,
    normalized,
    issues === undefined
      ? undefined
      : {
          errors: issues.map((issue) => ({
            path: issuePath(
              (issue.path ?? []).map((part) => (typeof part === 'object' ? part.key : part)),
            ),
            message: issue.message,
          })),
        },
  );
}

export { isPgCode } from '@agentport/db';
