import { errorCodeForStatus } from '@agentport/contract/errors';
import { AppError, fail, isAppError } from '@agentport/core';
import { isPgCode } from '@agentport/db';
import { ERROR_META, type ErrorCode, type Problem } from '@agentport/shared';
import { ORPCError, ValidationError } from '@orpc/contract';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export { AppError, isAppError } from '@agentport/core';

export const PAYLOAD_TOO_LARGE_MESSAGE = '请求体超出大小限制，请减少内容后重试';
export const FORBIDDEN_MESSAGE = '没有该操作的权限';
export const OBJECT_MISSING_MESSAGE = '对象不存在';
export const RUN_NOT_FOUND_MESSAGE = '运行不存在，可能已被删除';
export const INVALID_REQUEST_MESSAGE = '请求无效';
export const INVALID_REQUEST_FALLBACK_MESSAGE = 'invalid request';
export const INVALID_JSON_BODY_MESSAGE = '请求体必须是有效 JSON';
export const SERVICE_UNAVAILABLE_MESSAGE = '服务暂时不可用，请稍后重试';
export const NOT_LOGGED_IN_MESSAGE = 'not logged in';
export const ACCOUNT_DISABLED_MESSAGE = 'account disabled';
export const INVALID_BEARER_TOKEN_MESSAGE = 'invalid bearer token';
export const MCP_JSON_INVALID_MESSAGE = '.mcp.json 不是合法 JSON';
export const EVAL_RUN_MISSING_MESSAGE = '评估运行不存在，可能已被清理；请刷新列表';
export const CHANNEL_NOT_FOUND_MESSAGE = '频道不存在';
export const CHANNEL_MEMBER_MISSING_MESSAGE = '频道不存在或你不是频道成员';
export const RUN_NOT_IN_CHANNEL_MESSAGE = '运行不存在或不属于该频道';

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_META, code);
}

export function rethrowConflict(
  err: unknown,
  uniqueMessage: string,
  reference?: { code: 'INVALID_INPUT' | 'INVALID_REFERENCE'; message: string },
): never {
  if (isPgCode(err, '23505')) fail('CONFLICT', uniqueMessage);
  if (reference !== undefined && isPgCode(err, '23503')) fail(reference.code, reference.message);
  throw err;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return new AppError('INVALID_INPUT', first?.message ?? INVALID_REQUEST_MESSAGE, {
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
      first?.message ?? (code === 'INVALID_INPUT' ? INVALID_REQUEST_MESSAGE : error.message),
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
    return new AppError('SERVICE_UNAVAILABLE', SERVICE_UNAVAILABLE_MESSAGE, {
      cause: error,
      retryable: true,
    });
  }
  return new AppError('INTERNAL_ERROR', 'Internal server error', { cause: error });
}

function issuePath(path: readonly PropertyKey[]): string {
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

export function problem(requestId: string, error: AppError, extra?: Partial<Problem>): Problem {
  return {
    code: error.code,
    message:
      error.status >= 500 && error.status !== 502 && error.status !== 503
        ? 'Internal server error'
        : error.message,
    status: error.status,
    requestId,
    retryable: error.retryable,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.resource === undefined ? {} : { resource: error.resource }),
    ...(error.resourceId === undefined ? {} : { resourceId: error.resourceId }),
    hint: error.hint ?? ERROR_META[error.code].hint,
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

export { isPgCode };
