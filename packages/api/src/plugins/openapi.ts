import fastifySwagger from '@fastify/swagger';
import fastifyApiReference from '@scalar/fastify-api-reference';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { errorHandler } from './errors.js';

/** 版本跟随根 package.json；独立发版前不必为它引入运行时读文件的复杂度。 */
const API_VERSION = '0.13.0';

/** Scalar 的初始化脚本是内联的；Helmet 的全局 CSP 会把它拦掉，导致白屏。 */
const DOCS_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' https: data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

/**
 * 文档路由必须早于业务路由注册：@fastify/swagger 只收集注册在它之后的路由。
 * Scalar 通过 hasPlugin('@fastify/swagger') 自动取文档，不需要额外配置源。
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  // requireAuth 由 registerAuth（业务路由阶段）decorate；文档路由先注册，故请求时再取。
  const requireAuth = (request: FastifyRequest, reply: FastifyReply) =>
    app.requireAuth(request, reply);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Agentport API', version: API_VERSION },
    },
    transform: jsonSchemaTransform,
  });

  // 文档路由放在独立作用域：先装统一错误出口，401 才会渲染成 Problem；
  // 与 registerRoutes 在根作用域安装的是同一个实现，互不覆盖。
  await app.register(async (docs) => {
    docs.setErrorHandler(errorHandler);

    docs.get('/api/openapi.json', { preHandler: requireAuth }, async () => app.swagger());

    // Scalar 页面与其 `./openapi.json` 都由浏览器同源请求，带得上会话 cookie。
    await docs.register(fastifyApiReference, {
      routePrefix: '/api/docs',
      hooks: { preHandler: requireAuth },
    });
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/docs')) {
      reply.header('content-security-policy', DOCS_CSP);
    }
    return payload;
  });
}
