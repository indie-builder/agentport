import type { RouteAccess } from '@agentport/contract/access';
import type { MiddlewareHandler } from 'hono';
import { authenticate } from '../modules/auth/session.js';
import { requirePermission, requireUser } from './access.js';
import type { HttpEnv, RequestContext } from './context.js';

export async function enforceAccess(context: RequestContext, access: RouteAccess): Promise<void> {
  switch (access.kind) {
    case 'public':
    case 'service':
      return;
    case 'authenticated':
      await authenticate(context);
      requireUser(context);
      return;
    case 'permission':
      await authenticate(context);
      await requirePermission(context, access.permissionId);
      return;
  }
}

export function access(access: RouteAccess): MiddlewareHandler<HttpEnv> {
  return async (context, next) => {
    await enforceAccess(context.get('context'), access);
    await next();
  };
}
