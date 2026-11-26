import type { RouteAccess } from '@agentport/contract/access';
import type { MiddlewareHandler } from 'hono';
import { assertNever } from '../lib/assert-never.js';
import { authenticate } from '../modules/auth/session.js';
import { requirePermission, requireUser } from './access.js';
import type { HttpEnv, RequestContext } from './context.js';
import { requireTrustedOrigin } from './origin.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function enforceAccess(context: RequestContext, access: RouteAccess): Promise<void> {
  switch (access.kind) {
    case 'public':
    case 'service':
      return;
    case 'authenticated':
      await authenticate(context);
      requireUser(context);
      break;
    case 'permission':
      await authenticate(context);
      await requirePermission(context, access.permissionId);
      break;
    default:
      return assertNever(access);
  }
  if (!SAFE_METHODS.has(context.request.method)) {
    requireTrustedOrigin(context);
  }
}

export function access(access: RouteAccess): MiddlewareHandler<HttpEnv> {
  return async (context, next) => {
    await enforceAccess(context.get('context'), access);
    await next();
  };
}
