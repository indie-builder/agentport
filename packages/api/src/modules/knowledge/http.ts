import { AppError, isAppError } from '@agentport/core';
import type { PermissionId } from '@agentport/shared';
import type { Hono } from 'hono';
import { actorOf, authorize, requirePermission } from '../../http/access.js';
import type { AppContext, HttpContext, HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { problem, toAppError } from '../../http/errors.js';
import { requireTrustedOrigin } from '../auth/origin.js';
import { authenticate } from '../auth/session.js';
import * as useCases from './use-cases.js';

function contextOf(c: HttpContext, deps: AppContext): RequestContext {
  const context = requestContext(c);
  if (context !== undefined) return context;
  return {
    ...deps,
    principal: null,
    requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
    request: c.req.raw,
    responseHeaders: new Headers(),
    remoteAddress: c.env.remoteAddress ?? '',
    limit: async () => undefined,
  };
}

function param(c: HttpContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new AppError('INVALID_INPUT', '缺少路径参数');
  }
  return value;
}

function depsOf(context: RequestContext): useCases.KnowledgeDeps {
  return {
    db: context.db,
    config: context.config,
    log: context.log,
    requestId: context.requestId,
    actor: actorOf(context),
  };
}

async function scoped(
  context: RequestContext,
  permissionId: PermissionId,
  objectId: string,
): Promise<void> {
  try {
    await authorize(context, permissionId, { objectId });
  } catch (err) {
    if (isAppError(err) && err.code === 'FORBIDDEN') {
      throw new AppError('NOT_FOUND', '对象不存在');
    }
    throw err;
  }
}

function native(
  deps: AppContext,
  handler: (context: RequestContext, c: HttpContext) => Promise<Response>,
) {
  return async (c: HttpContext): Promise<Response> => {
    const context = contextOf(c, deps);
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

export function registerKnowledgeHttp(app: Hono<HttpEnv>, deps: AppContext): void {
  app.get(
    '/api/knowledge/versions/:versionId/images/:name',
    native(deps, async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const image = await useCases.getVersionImage(
        depsOf(context),
        param(c, 'versionId'),
        param(c, 'name'),
      );
      return new Response(new Uint8Array(image.data), {
        headers: {
          'content-type': image.mimeType,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private',
        },
      });
    }),
  );

  app.get(
    '/api/knowledge/versions/:versionId/content',
    native(deps, async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const content = await useCases.getVersionContent(depsOf(context), param(c, 'versionId'));
      return new Response(new Uint8Array(content.data), {
        headers: {
          'content-type': content.mimeType,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(content.filename)}`,
          'x-content-type-options': 'nosniff',
        },
      });
    }),
  );

  app.get(
    '/api/knowledge/versions/:versionId/markdown',
    native(deps, async (context, c) => {
      await requirePermission(context, 'knowledge.read');
      const markdown = await useCases.getVersionMarkdown(depsOf(context), param(c, 'versionId'));
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
    native(deps, async (context, c) => {
      await requirePermission(context, 'knowledge.export');
      await scoped(context, 'knowledge.export', param(c, 'id'));
      const pkg = await useCases.exportPackage(depsOf(context), param(c, 'id'));
      return new Response(new Uint8Array(pkg.body), {
        headers: {
          'content-disposition': `attachment; filename="${pkg.filename}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-type': 'application/zip',
        },
      });
    }),
  );

  app.post(
    '/api/knowledge/bases/import',
    native(deps, async (context, c) => {
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
    native(deps, async (context, c) => {
      await requirePermission(context, 'knowledge.export');
      await scoped(context, 'knowledge.export', param(c, 'id'));
      const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
      const version = c.req.query('version') === 'draft' ? 'draft' : 'published';
      const exported = await useCases.exportFaqs(depsOf(context), param(c, 'id'), {
        format,
        version,
      });
      return new Response(exported.content, {
        headers: {
          'content-type': exported.contentType,
          'content-disposition': `attachment; filename="${exported.filename}"`,
        },
      });
    }),
  );
}
