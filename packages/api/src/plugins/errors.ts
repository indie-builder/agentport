import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

type ErrorLike = Error & { statusCode?: number; code?: string };

/**
 * 错误响应只有一个形状：{ code, message, requestId }。
 *
 * zod 校验失败与响应序列化失败也在这一层收敛，路由里因此不再需要
 * safeParse + 手写 400；schema 声明即是唯一校验点。
 */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issue = error.validation[0] as { message?: string; instancePath?: string } | undefined;
      return reply.status(400).send({
        code: 'INVALID_INPUT',
        message: issue?.message ?? 'invalid request',
        requestId: request.id,
        ...(issue?.instancePath ? { path: issue.instancePath } : {}),
      });
    }

    if (isResponseSerializationError(error)) {
      // 响应不符合声明的 schema 是服务端缺陷，按 500 处理并保留细节给日志。
      request.log.error({ err: error }, 'response serialization failed');
      return reply.status(500).send({
        code: 'RESPONSE_INVALID',
        message: 'response did not match its schema',
        requestId: request.id,
      });
    }

    const err = error as ErrorLike;
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'unhandled error');
    return reply.status(status).send({
      code: err.code ?? 'INTERNAL_ERROR',
      message: status >= 500 ? 'Internal server error' : err.message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });
}
