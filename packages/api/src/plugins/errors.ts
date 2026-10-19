import type { FastifyInstance } from 'fastify';

type ErrorLike = Error & { statusCode?: number; code?: string };

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as ErrorLike;
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
    }
    reply.status(status).send({
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
