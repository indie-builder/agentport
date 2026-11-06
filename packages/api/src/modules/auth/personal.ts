import { authContract } from '@agentport/contract/auth';
import { AppError } from '@agentport/core';
import type { PersonalSession } from '@agentport/shared';
import { implement } from '@orpc/server';
import { APIError } from 'better-auth/api';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { writeAudit } from '../../plugins/audit.js';
import { forwardSetCookie, normalizeSession } from './session.js';

function rethrowAuthError(error: unknown): never {
  if (error instanceof APIError) {
    const code = error.body?.code;
    if (error.statusCode === 403)
      throw new AppError(
        'FORBIDDEN',
        code === 'SESSION_NOT_FRESH' ? '请重新登录后管理登录会话' : '没有该操作的权限',
      );
    if (error.statusCode === 401) throw new AppError('UNAUTHORIZED', 'not logged in');
    if (error.statusCode === 400) throw new AppError('INVALID_INPUT', '请求无效');
  }
  throw error;
}

async function currentSessionId(context: RequestContext): Promise<string> {
  const session = normalizeSession(
    await context.auth.api.getSession({
      headers: context.request.headers,
      query: { disableRefresh: true },
    }),
  );
  if (session === null) throw new AppError('UNAUTHORIZED', 'not logged in');
  return session.session.id;
}

function toPersonalSession(
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
  },
  currentId: string,
): PersonalSession {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
    current: session.id === currentId,
  };
}

const os = implement(authContract).$context<RequestContext>();

export const personalAuthRouter = {
  profile: os.profile.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const updated = await context.auth.api
      .updateUser({
        body: { name: input.body.name },
        headers: context.request.headers,
        returnHeaders: true,
      })
      .catch(rethrowAuthError);
    forwardSetCookie(updated.headers, context);
    const session = normalizeSession(
      await context.auth.api.getSession({
        headers: context.request.headers,
        query: { disableRefresh: true },
      }),
    );
    if (session === null) throw new AppError('UNAUTHORIZED', 'not logged in');
    const profile = {
      businessId: session.user.businessId,
      username: session.user.username ?? '',
      name: session.user.name,
    };
    await writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'auth.profile.updated',
      target: principal.businessId,
      status: 'ok',
      requestId: context.requestId,
    });
    return profile;
  }),
  sessions: os.sessions.handler(async ({ context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const currentId = await currentSessionId(context);
    const sessions = await context.auth.api
      .listSessions({ headers: context.request.headers })
      .catch(rethrowAuthError);
    const now = Date.now();
    return {
      items: sessions
        .filter((session) => session.expiresAt.getTime() > now)
        .map((session) => toPersonalSession(session, currentId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    };
  }),
  revokeSession: os.revokeSession.handler(async ({ input, context }) => {
    const principal = requireUser(context);
    const currentId = await currentSessionId(context);
    const sessions = await context.auth.api
      .listSessions({ headers: context.request.headers })
      .catch(rethrowAuthError);
    const target = sessions.find(
      (session) => session.id === input.params.id && session.expiresAt.getTime() > Date.now(),
    );
    if (!target) throw new AppError('NOT_FOUND', '会话不存在');
    if (target.id === currentId) throw new AppError('CONFLICT', '不能撤销当前登录会话');
    const revoked = await context.auth.api
      .revokeSession({
        body: { token: target.token },
        headers: context.request.headers,
        returnHeaders: true,
      })
      .catch(rethrowAuthError);
    forwardSetCookie(revoked.headers, context);
    await writeAudit(context.db, context.log, {
      actor: principal.businessId,
      action: 'auth.session.revoked',
      target: target.id,
      status: 'ok',
      requestId: context.requestId,
    });
  }),
};
