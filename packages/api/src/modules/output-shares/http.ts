import { fail } from '@agentport/core';
import type { Hono } from 'hono';
import { attachmentResponse } from '../../http/attachment.js';
import { type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { safeMediaType } from '../../lib/outputs.js';
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
      return attachmentResponse(
        new Uint8Array(shared.data),
        shared.file.path,
        safeMediaType(shared.file.mediaType),
      );
    },
  );
}
