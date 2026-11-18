import { AppError } from '@agentport/core';
import type { Hono } from 'hono';
import { requirePermission } from '../../http/access.js';
import { attachmentResponse } from '../../http/attachment.js';
import { requestBodyLimit } from '../../http/body-limit.js';
import type { HttpContext, HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { problem, toAppError } from '../../http/errors.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { authenticate } from '../auth/session.js';
import { authorizeBase, authorizeVersion } from './access.js';
import { FAQ_MAX_BYTES } from './faq.js';
import { KNOWLEDGE_PACKAGE_MAX_BYTES } from './package.js';
import * as useCases from './use-cases.js';
import { depsOf, KNOWLEDGE_UPLOAD_BODY_LIMIT } from './use-cases.js';

function param(c: HttpContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new AppError('INVALID_INPUT', '缺少路径参数');
  }
  return value;
}

function native(handler: (context: RequestContext, c: HttpContext) => Promise<Response>) {
  return async (c: HttpContext): Promise<Response> => {
    const context = requestContext(c);
    try {
      await authenticate(context);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)) {
        requireTrustedOrigin(context);
      }
      return await handler(context, c);
    } catch (err) {
      const appError = toAppError(err);
      if (appError.status >= 500) {
        context.log.error({ err, code: appError.code }, 'unhandled knowledge error');
      }
      return new Response(JSON.stringify(problem(context.requestId, appError)), {
        status: appError.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  };
}

export function registerKnowledgeHttp(app: Hono<HttpEnv>): void {
  app.on(
    'PUT',
    '/api/knowledge/bases/:id/documents/upload',
    requestBodyLimit(KNOWLEDGE_UPLOAD_BODY_LIMIT),
  );
  app.on(
    'POST',
    '/api/knowledge/bases/:id/faqs/import',
    requestBodyLimit(FAQ_MAX_BYTES * 8 + 1024),
  );
  app.on('POST', '/api/knowledge/bases/import', requestBodyLimit(KNOWLEDGE_PACKAGE_MAX_BYTES));
  app.get(
    '/api/knowledge/versions/:versionId/images/:name',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const name = param(c, 'name');
      const image = await useCases.getVersionImage(depsOf(context), versionId, name);
      const response = attachmentResponse(new Uint8Array(image.data), name, image.mimeType);
      response.headers.set('cache-control', 'private');
      return response;
    }),
  );

  app.get(
    '/api/knowledge/versions/:versionId/content',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const content = await useCases.getVersionContent(depsOf(context), versionId);
      return attachmentResponse(new Uint8Array(content.data), content.filename, content.mimeType);
    }),
  );

  app.get(
    '/api/knowledge/versions/:versionId/markdown',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const versionId = param(c, 'versionId');
      await authorizeVersion(context, versionId, 'knowledge.read', 'read');
      const markdown = await useCases.getVersionMarkdown(depsOf(context), versionId);
      return new Response(markdown.markdown, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'x-knowledge-document-status': markdown.status,
        },
      });
    }),
  );

  app.get(
    '/api/knowledge/bases/:id/export',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.export');
      const id = param(c, 'id');
      await authorizeBase(context, id, 'knowledge.export', 'read');

      const pkg = await useCases.exportPackage(depsOf(context), id);
      return attachmentResponse(new Uint8Array(pkg.body), pkg.filename, 'application/zip');
    }),
  );

  app.post(
    '/api/knowledge/bases/import',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.import');
      const body = Buffer.from(await c.req.arrayBuffer());
      const result = await useCases.importPackage(depsOf(context), body);
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }),
  );

  app.get(
    '/api/knowledge/bases/:id/faqs/export',
    native(async (context, c) => {
      await requirePermission(context, 'knowledge.export');
      const id = param(c, 'id');
      await authorizeBase(context, id, 'knowledge.export', 'read');

      const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
      const version = c.req.query('version') === 'draft' ? 'draft' : 'published';
      const exported = await useCases.exportFaqs(depsOf(context), id, {
        format,
        version,
      });
      return attachmentResponse(exported.content, exported.filename, exported.contentType);
    }),
  );
}
