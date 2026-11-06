import { fail } from '@agentport/core';
import type { Hono } from 'hono';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { contentDisposition, safeMediaType } from '../chat/outputs.js';
import { resolveSharedFile } from './router.js';

export function registerOutputSharesHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/public/output-shares/:id/download',
    access({
      kind: 'service',
      boundary: 'share-token',
      reason: 'public share authenticates with the link token, not a session',
    }),
    async (c) => {
      const context = requestContext(c);
      const shared = await resolveSharedFile(context, c.req.param('id'));
      if (shared === null) fail('NOT_FOUND', '分享不存在或已失效');
      return new Response(new Uint8Array(shared.data), {
        status: 200,
        headers: {
          'content-type': safeMediaType(shared.file.mediaType),
          'content-disposition': contentDisposition(shared.file.path),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  );
}
