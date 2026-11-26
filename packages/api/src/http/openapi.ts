import { ERROR_META, problemSchema } from '@agentport/shared';
import type { AnyContractRouter, OpenAPI } from '@orpc/contract';
import {
  OpenAPIGenerator,
  type OpenAPIGeneratorGenerateOptions,
  toOpenAPISchema,
} from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { Scalar } from '@scalar/hono-api-reference';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AUTH_COOKIE } from '../modules/auth/types.js';
import { type HttpEnv, requestContext } from './context.js';
import { access } from './middleware.js';
import { nativeOpenAPISchemas } from './native-openapi.js';

const { version }: { version: string } = await Bun.file(
  new URL('../../../../package.json', import.meta.url),
).json();

const DOCS_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' https: data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self' https://cdn.jsdelivr.net",
].join('; ');

const BODYLESS_RESPONSE_STATUSES = new Set(['204', '205', '304']);

function omitBodylessResponseContent(document: OpenAPI.Document): OpenAPI.Document {
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (typeof operation !== 'object' || operation === null || !('responses' in operation)) {
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (BODYLESS_RESPONSE_STATUSES.has(status) && typeof response === 'object' && response) {
          delete (response as { content?: unknown }).content;
        }
      }
    }
  }
  return document;
}

export function registerOpenApi(
  app: Hono<HttpEnv>,
  contract: AnyContractRouter,
  paths: OpenAPIGeneratorGenerateOptions['paths'] = {},
): void {
  const converter = new ZodToJsonSchemaConverter();
  const generator = new OpenAPIGenerator({ schemaConverters: [converter] });
  const [, errorSchema] = converter.convert(problemSchema, { strategy: 'output' });
  const errorCodeCatalogSchema = z.object(
    Object.fromEntries(
      Object.entries(ERROR_META).map(([code, { status, retryable, hint }]) => [
        code,
        z.object({
          status: z.literal(status),
          retryable: z.literal(retryable),
          hint: z.literal(hint),
        }),
      ]),
    ),
  );
  const [, errorCodeCatalog] = converter.convert(errorCodeCatalogSchema, { strategy: 'output' });
  let document: ReturnType<typeof generator.generate> | undefined;
  app.use('/api/docs/*', access({ kind: 'authenticated' }));
  app.on(
    'GET',
    ['/api/openapi.json', '/api/docs/openapi.json'],
    access({ kind: 'authenticated' }),
    async (c) => {
      document ??= generator
        .generate(contract, {
          info: { title: 'Agentport API', version },
          servers: [{ url: '/api' }],
          paths,
          components: {
            schemas: {
              ...nativeOpenAPISchemas,
              ErrorCodeCatalog: toOpenAPISchema(errorCodeCatalog),
            },
            securitySchemes: {
              sessionCookie: { type: 'apiKey', in: 'cookie', name: AUTH_COOKIE },
              shareToken: {
                type: 'http',
                scheme: 'bearer',
                description: '分享链接 token，独立于用户登录会话。',
              },
              apiToken: {
                type: 'http',
                scheme: 'bearer',
                description:
                  '应用级 API token，作为 Authorization: Bearer 发送，scope 为 runs.create 或 runs.read。',
              },
            },
          },
          externalDocs: {
            url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports',
            description:
              '/mcp 与 /mcp/{serverId} 是 MCP Streamable HTTP 传输，不属于 REST JSON 契约。平台端点使用 PLATFORM_MCP_TOKEN，连接器端点使用自身 Bearer/run token；知识 MCP 经同一连接器端点暴露。',
          },
          customErrorResponseBodySchema: (errors) =>
            errors.length === 0
              ? errorSchema
              : { ...errorSchema, anyOf: errors.map(([, , , schema]) => schema) },
        })
        .then(omitBodylessResponseContent)
        .catch((error) => {
          document = undefined;
          throw error;
        });
      return c.json(await document);
    },
  );
  app.on(
    'GET',
    ['/api/docs', '/api/docs/'],
    access({ kind: 'authenticated' }),
    async (c, next) => {
      requestContext(c).responseHeaders.set('content-security-policy', DOCS_CSP);
      await next();
    },
    Scalar({ url: '/api/openapi.json' }),
  );
}
