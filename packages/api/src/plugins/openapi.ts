import fastifySwagger from '@fastify/swagger';
import fastifyApiReference from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

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
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Agentport API', version: API_VERSION },
    },
    transform: jsonSchemaTransform,
  });

  app.get('/api/openapi.json', async () => app.swagger());

  await app.register(fastifyApiReference, { routePrefix: '/api/docs' });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/docs')) {
      reply.header('content-security-policy', DOCS_CSP);
    }
    return payload;
  });
}
