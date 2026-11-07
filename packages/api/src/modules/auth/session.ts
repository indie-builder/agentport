import { AppError } from '@agentport/core';
import { authSessions, repo } from '@agentport/db';
import type { Principal } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { generateCookie } from 'hono/cookie';
import { z } from 'zod';
import type { RequestContext } from '../../http/context.js';
import type { Auth } from './better-auth.js';

const sessionViewSchema = z.object({
  session: z.object({ id: z.string() }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    username: z.string().nullish(),
    businessId: z.string(),
    disabled: z.boolean().optional().default(false),
  }),
});

export type SessionView = z.infer<typeof sessionViewSchema>;

export function normalizeSession(value: unknown): SessionView | null {
  const result = sessionViewSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function forwardSetCookie(headers: Headers, context: RequestContext): void {
  for (const cookie of headers.getSetCookie()) context.responseHeaders.append('set-cookie', cookie);
}

export async function clearAuthCookie(context: RequestContext): Promise<void> {
  const { authCookies } = await context.auth.$context;
  const { name, attributes } = authCookies.sessionToken;
  const { domain, ...options } = attributes;
  context.responseHeaders.append(
    'set-cookie',
    generateCookie(name, '', {
      ...options,
      ...(domain === undefined ? {} : { domain }),
      maxAge: 0,
    }),
  );
}

export function issuedCookie(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

export async function readSession(context: RequestContext): Promise<SessionView | null> {
  const { response, headers } = await context.auth.api.getSession({
    headers: context.request.headers,
    returnHeaders: true,
  });
  forwardSetCookie(headers, context);
  return normalizeSession(response);
}

export async function principalOf(
  context: RequestContext,
  user: SessionView['user'],
): Promise<Extract<Principal, { kind: 'user' }>> {
  const { roles, grants } = await repo.access.getUserAccess(context.db, user.businessId);
  return {
    kind: 'user',
    authUserId: user.id,
    businessId: user.businessId,
    username: user.username ?? '',
    name: user.name,
    roles,
    grants,
  };
}

export async function revokeUserSessions(
  context: RequestContext,
  authUserId: string,
): Promise<void> {
  await context.db.delete(authSessions).where(eq(authSessions.userId, authUserId));
}

export async function authenticate(context: RequestContext): Promise<void> {
  if (context.principal !== null) return;
  const session = await readSession(context);
  if (!session) throw new AppError('UNAUTHORIZED', 'not logged in');
  if (session.user.disabled) {
    await revokeUserSessions(context, session.user.id);
    throw new AppError('UNAUTHORIZED', 'account disabled');
  }
  context.principal = await principalOf(context, session.user);
}

export async function sessionFromCookie(auth: Auth, cookie: string): Promise<SessionView | null> {
  if (cookie === '') return null;
  return normalizeSession(
    await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableRefresh: true },
    }),
  );
}
