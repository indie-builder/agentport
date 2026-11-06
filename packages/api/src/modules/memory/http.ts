import { PERSONAL_MEMORY_FILENAME } from '@agentport/shared';
import type { Hono } from 'hono';
import { requireUser } from '../../http/access.js';
import { type AppContext, type HttpEnv, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { readPersonalMemory } from './personal.js';

export function registerMemoryHttp(app: Hono<HttpEnv>, _deps: AppContext): void {
  app.get(
    '/api/me/memory/download',
    access({ kind: 'permission', permissionId: 'personal_memory.read' }),
    async (c) => {
      const context = requestContext(c);
      const { content } = await readPersonalMemory(context.db, requireUser(context).businessId);
      return new Response(content, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${PERSONAL_MEMORY_FILENAME}"`,
          'cache-control': 'no-store',
        },
      });
    },
  );
}
