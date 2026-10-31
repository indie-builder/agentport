import {
  type PersonalProfile,
  type PersonalSession,
  personalProfileSchema,
  personalSessionListSchema,
  updatePersonalProfileInputSchema,
} from '@agentport/shared';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { userPrincipal } from '../access.js';
import type { Auth } from './better-auth.js';

const sessionParams = z.object({ id: z.string().min(1).max(200) });

/** better-auth 一次可能下发多条 Set-Cookie；数组会被 Fastify 序列成多个同名头。 */
export function forwardSetCookie(headers: Headers, reply: FastifyReply): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
}

/** Better Auth 错误只按状态收敛到统一 Problem，不透传上游响应与堆栈。 */
function rethrowAuthError(error: unknown): never {
  if (error instanceof APIError) {
    const code = (error.body as { code?: unknown } | undefined)?.code;
    if (error.statusCode === 403) {
      throw new AppError(
        'FORBIDDEN',
        code === 'SESSION_NOT_FRESH' ? '请重新登录后管理登录会话' : '没有该操作的权限',
      );
    }
    if (error.statusCode === 401) throw new AppError('UNAUTHORIZED', 'not logged in');
    if (error.statusCode === 400) throw new AppError('INVALID_INPUT', '请求无效');
  }
  throw error;
}

async function currentSessionId(auth: Auth, request: FastifyRequest): Promise<string> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
    query: { disableRefresh: true },
  });
  const id = (session as { session?: { id?: unknown } } | null)?.session?.id;
  if (typeof id !== 'string') throw new AppError('UNAUTHORIZED', 'not logged in');
  return id;
}

type NativeSession = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
};

/** 只投影展示字段；token、userId 等认证载体留在服务端。 */
function toPersonalSession(session: NativeSession, currentId: string): PersonalSession {
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

export function registerPersonalAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  origin: preHandlerHookHandler,
): void {
  const routes = typed(app);
  const authenticated = { config: { access: { kind: 'authenticated' as const } } };

  routes.patch(
    '/api/me/profile',
    {
      ...authenticated,
      preHandler: [origin],
      schema: { body: updatePersonalProfileInputSchema, response: { 200: personalProfileSchema } },
    },
    async (request, reply) => {
      const principal = userPrincipal(request);
      const updated = await auth.api
        .updateUser({
          body: { name: request.body.name },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        })
        .catch((error: unknown) => rethrowAuthError(error));
      forwardSetCookie(updated.headers, reply);

      // updateUser 只返回 { status }；再读一次原生会话，返回实际存储的身份三字段。
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
        query: { disableRefresh: true },
      });
      const user = (session as { user?: Record<string, unknown> } | null)?.user;
      if (!user || typeof user.businessId !== 'string' || typeof user.name !== 'string') {
        throw new AppError('UNAUTHORIZED', 'not logged in');
      }
      const profile: PersonalProfile = {
        businessId: user.businessId,
        username: typeof user.username === 'string' ? user.username : '',
        name: user.name,
      };

      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'auth.profile.updated',
        target: principal.businessId,
        status: 'ok',
        requestId: request.id,
      });
      return profile;
    },
  );

  routes.get(
    '/api/me/sessions',
    { ...authenticated, schema: { response: { 200: personalSessionListSchema } } },
    async (request, reply) => {
      userPrincipal(request);
      reply.header('cache-control', 'no-store');
      const currentId = await currentSessionId(auth, request);
      const sessions = await auth.api
        .listSessions({ headers: fromNodeHeaders(request.headers) })
        .catch((error: unknown) => rethrowAuthError(error));
      const now = Date.now();
      const items = sessions
        .filter((session) => session.expiresAt.getTime() > now)
        .map((session) => toPersonalSession(session, currentId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return { items };
    },
  );

  routes.delete(
    '/api/me/sessions/:id',
    { ...authenticated, preHandler: [origin], schema: { params: sessionParams } },
    async (request, reply) => {
      const principal = userPrincipal(request);
      const currentId = await currentSessionId(auth, request);
      const sessions = await auth.api
        .listSessions({ headers: fromNodeHeaders(request.headers) })
        .catch((error: unknown) => rethrowAuthError(error));
      const now = Date.now();
      const target = sessions.find(
        (session) => session.id === request.params.id && session.expiresAt.getTime() > now,
      );
      if (!target) return reject(reply, 'NOT_FOUND', '会话不存在');
      if (target.id === currentId) return reject(reply, 'CONFLICT', '不能撤销当前登录会话');

      // token 只在服务端交给原生撤销接口；原生会再次按 userId 校验归属。
      const revoked = await auth.api
        .revokeSession({
          body: { token: target.token },
          headers: fromNodeHeaders(request.headers),
          returnHeaders: true,
        })
        .catch((error: unknown) => rethrowAuthError(error));
      forwardSetCookie(revoked.headers, reply);

      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'auth.session.revoked',
        target: target.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );
}
