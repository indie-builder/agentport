import { AppError } from '@agentport/core';
import type { RequestContext } from '../../http/context.js';
import { getTrustedOrigins, isTrustedOrigin } from '../../config.js';

export function isOriginAllowed(context: RequestContext): boolean {
  const origin = context.request.headers.get('origin');
  if (!origin) return true;
  if (origin === new URL(context.request.url).origin) return true;
  return isTrustedOrigin(origin, getTrustedOrigins(context.config));
}

export function requireTrustedOrigin(context: RequestContext): void {
  if (!isOriginAllowed(context)) throw new AppError('FORBIDDEN', 'origin not allowed');
}
