import { AppError, isAppError } from '@agentport/core';
import { type ErrorCode, errorCode, type Problem } from '@agentport/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/** 边界处重新导出，feature 层不必同时 import core 与 shared。 */
export { AppError, isAppError };

/**
 * 限流存储（Redis）不可用时 ioredis 的错误没有 statusCode：重试耗尽抛
 * MaxRetriesPerRequestError，连接关闭/命令超时抛固定文案的普通 Error。
 * 这些是依赖不可用（503、可重试），不是代码缺陷（500）。
 * 不能匹配 AbortError：外部 HTTP 超时（AbortSignal.timeout）也叫这个名字。
 */
function isRedisUnavailable(err: { name?: string; message?: string } | null): boolean {
  return (
    err?.name === 'MaxRetriesPerRequestError' ||
    err?.message === 'Command timed out' ||
    err?.message === 'Connection is closed.'
  );
}

/**
 * 把任意异常压成 AppError。分三步：
 * 1. 已经是 AppError → 原样返回
 * 2. 框架/插件抛出的可识别错误 → 映射成稳定 code
 * 3. 其余 → INTERNAL_ERROR，原始信息只进日志
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const err = error as { statusCode?: number; code?: string; message?: string } | null;
  const status = err?.statusCode ?? 500;
  const original = err?.message ?? 'unknown error';

  // Fastify 的 body 限制与 content-type 错误在解析阶段就发生，不属于业务输入校验。
  if (err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试', {
      cause: error,
    });
  }
  // 请求体不是合法 JSON：客户端输入问题，不是服务端缺陷。
  if (
    err?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    err?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
  ) {
    return new AppError('INVALID_INPUT', '请求体不是合法 JSON', { cause: error });
  }
  if (err?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err?.code === 'FST_ERR_CTP_EMPTY_TYPE') {
    return new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      '不支持的 Content-Type，请使用 application/json',
      {
        cause: error,
      },
    );
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试', {
      cause: error,
      retryable: true,
    });
  }
  if (status === 413) {
    return new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制', { cause: error });
  }
  if (status === 415) {
    return new AppError('UNSUPPORTED_MEDIA_TYPE', '不支持的 Content-Type', { cause: error });
  }
  if (status === 503) {
    return new AppError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试', { cause: error });
  }
  // 限流 Redis 的故障不带 statusCode；映射成可重试的 503，与普通 500 区分。
  if (isRedisUnavailable(err)) {
    return new AppError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试', {
      cause: error,
      retryable: true,
    });
  }

  // 旧代码里仍有 Object.assign(new Error(...), { statusCode, code })，逐条迁完后可删。
  if (status >= 400 && status < 500 && typeof err?.code === 'string' && err.code in errorCode) {
    return new AppError(err.code as ErrorCode, original, { cause: error });
  }

  return new AppError('INTERNAL_ERROR', 'Internal server error', { cause: error });
}

/** 客户端可见的文案：4xx 保留具体说明，5xx 一律固定，避免泄露内部细节。 */
function publicMessage(err: AppError): string {
  return err.status >= 500 ? 'Internal server error' : err.message;
}

export function problem(requestId: string, err: AppError, extra?: Partial<Problem>): Problem {
  return {
    code: err.code,
    message: publicMessage(err),
    status: err.status,
    requestId,
    retryable: err.retryable,
    ...(err.path === undefined ? {} : { path: err.path }),
    ...extra,
  };
}

/**
 * 错误响应只有一个形状（Problem）。zod 校验失败、响应序列化失败、
 * 框架错误都在这一层收敛，路由里因此不再需要手写 400。
 */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((issue) => ({
        path: (issue as { instancePath?: string }).instancePath ?? '',
        message: (issue as { message?: string }).message ?? 'invalid value',
      }));
      const first = issues[0];
      return reply.status(400).send(
        problem(
          request.id,
          new AppError('INVALID_INPUT', first?.message ?? 'invalid request', {
            ...(first?.path ? { path: first.path } : {}),
          }),
          { errors: issues },
        ),
      );
    }

    if (isResponseSerializationError(error)) {
      // 响应不符合声明的 schema 是服务端缺陷：细节只进日志。
      request.log.error({ err: error }, 'response serialization failed');
      return reply
        .status(500)
        .send(
          problem(
            request.id,
            new AppError('RESPONSE_INVALID', 'response did not match its schema'),
          ),
        );
    }

    const err = toAppError(error);
    if (err.status >= 500) request.log.error({ err: error, code: err.code }, 'unhandled error');
    else if (err.status !== 401)
      request.log.warn({ code: err.code, err: error }, 'request rejected');

    return reply.status(err.status).send(problem(request.id, err));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(
        problem(
          request.id,
          new AppError('NOT_FOUND', `Route ${request.method} ${request.url} not found`),
        ),
      );
  });
}

/** 路由里主动拒绝时用：省掉 status/message/requestId 的重复拼装。 */
export function reject(reply: FastifyReply, code: ErrorCode, message: string) {
  const err = new AppError(code, message);
  return reply.status(err.status).send(problem(reply.request.id, err));
}

/**
 * drizzle 把 pg 错误包在 DrizzleQueryError.cause 里，顶层没有 code；
 * 唯一约束（23505）与外键（23503）冲突都要沿 cause 链查。
 */
export function isPgCode(err: unknown, code: string): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('code' in cause && cause.code === code) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}
