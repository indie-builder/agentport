import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * 所有路由都用 ZodTypeProvider：schema 即类型来源，handler 里的
 * request.body / params / querystring 由 schema 推导，不再手写 safeParse。
 */
export type TypedApp = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  import('fastify').FastifyBaseLogger,
  ZodTypeProvider
>;

export function typed(app: FastifyInstance): TypedApp {
  return app.withTypeProvider<ZodTypeProvider>();
}
