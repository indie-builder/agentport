import { authSessions, repo } from '@agentport/db';
import { type AuthMe, changeOwnPasswordSchema, type Principal } from '@agentport/shared';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, reject } from '../../plugins/errors.js';
import { authRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import { type Auth, createAuth } from './better-auth.js';
import { ensureBootstrap } from './bootstrap.js';
import { requireTrustedOrigin } from './origin.js';
import { AUTH_COOKIE } from './types.js';

/** 其他业务的成员/授权写入复用同一 Origin 校验。 */
export { requireTrustedOrigin };

/** 登录是唯一未认证的写入口：用户名进审计表，所以长度有上限。 */
const loginBody = z.object({
  username: z
    .string({ error: '请输入用户名' })
    .min(1, '请输入用户名')
    .max(128, '用户名不能超过 128 个字符'),
  // better-auth 对超过 128 的密码直接返回 400；在入口拦住并给出可读提示。
  password: z
    .string({ error: '请输入密码' })
    .min(1, '请输入密码')
    .max(128, '密码不能超过 128 个字符'),
});

type SessionUser = {
  id: string;
  name: string;
  username: string | null;
  businessId: string;
  disabled: boolean;
};

type SessionView = { user: SessionUser };

/**
 * better-auth 的 session 结果来自数据库；这里只做一次运行时形状检查。
 * 缺少 businessId 的旧行按未认证处理，不把技术 ID 当业务身份使用。
 */
function normalizeSession(value: unknown): SessionView | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as { user?: unknown; session?: unknown };
  if (raw.user === null || typeof raw.user !== 'object' || raw.session === undefined) return null;
  const user = raw.user as Record<string, unknown>;
  if (
    typeof user.id !== 'string' ||
    typeof user.name !== 'string' ||
    typeof user.businessId !== 'string'
  ) {
    return null;
  }
  return {
    user: {
      id: user.id,
      name: user.name,
      username: typeof user.username === 'string' ? user.username : null,
      businessId: user.businessId,
      disabled: user.disabled === true,
    },
  };
}

/** better-auth 一次可能下发多条 Set-Cookie；数组会被 Fastify 序列成多个同名头。 */
function forwardSetCookie(headers: Headers, reply: FastifyReply): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
}

function issuedCookie(headers: Headers): string {
  const issued = headers.get('set-cookie') ?? '';
  return issued
    .split(/,(?=\s*[\w-]+=)/)
    .map((part) => part.split(';')[0]?.trim())
    .filter((part) => part?.includes('='))
    .join('; ');
}

function clearAuthCookie(reply: FastifyReply, config: Config): void {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header('set-cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function revokeUserSessions(app: FastifyInstance, authUserId: string): Promise<void> {
  await app.db.delete(authSessions).where(eq(authSessions.userId, authUserId));
}

async function principalOf(app: FastifyInstance, user: SessionUser): Promise<Principal> {
  // 每次请求都从 DB 重读角色与 grants；权限变化立即生效。
  const { roles, grants } = await repo.access.getUserAccess(app.db, user.businessId);
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

async function sessionFromCookie(auth: Auth, cookie: string): Promise<SessionView | null> {
  if (cookie === '') return null;
  try {
    const response = await auth.api.getSession({
      headers: fromNodeHeaders({ cookie }),
      // 只读探测，不发刷新写：避免为探测多写一次会话。
      query: { disableRefresh: true },
    });
    return normalizeSession(response);
  } catch {
    return null;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const auth = createAuth(app.config, app.db);
  const origin = requireTrustedOrigin(app);

  // 播种依赖数据库；放到首次登录时做，数据库不可达时应用仍能启动并走统一的 500 路径。
  let bootstrapReady: Promise<void> | undefined;
  const ensureBootstrapReady = () => {
    bootstrapReady ??= ensureBootstrap(app.db, app.config).catch((error) => {
      bootstrapReady = undefined;
      throw error;
    });
    return bootstrapReady;
  };

  const readSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const { response, headers } = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    forwardSetCookie(headers, reply);
    return normalizeSession(response);
  };

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await readSession(request, reply);
    if (!session) throw new AppError('UNAUTHORIZED', 'not logged in');
    if (session.user.disabled) {
      await revokeUserSessions(app, session.user.id);
      throw new AppError('UNAUTHORIZED', 'account disabled');
    }
    request.principal = await principalOf(app, session.user);
  });

  typed(app).post(
    '/api/auth/login',
    {
      ...authRateLimit,
      config: { ...authRateLimit.config, access: { kind: 'public', reason: 'login' } },
      preHandler: [origin],
      schema: { body: loginBody },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      await ensureBootstrapReady();
      const signIn = () =>
        auth.api.signInUsername({
          body: { username, password },
          headers: fromNodeHeaders(request.headers),
          asResponse: true,
        });
      let result = await signIn();
      let session: SessionView | null = null;

      // better-auth 偶发在并发下返回 200，但会话行没写进库（cookie 随即失效）。
      // 用刚下发的 cookie 回读一次；读不到说明这次会话没落库，重试一次登录。
      if (result.ok) {
        session = await sessionFromCookie(auth, issuedCookie(result.headers));
        if (!session) {
          request.log.warn({ username }, 'login session missing after sign-in, retrying once');
          result = await signIn();
          if (result.ok) session = await sessionFromCookie(auth, issuedCookie(result.headers));
        }
      }

      if (!result.ok) {
        request.log.warn({ username }, 'login failed');
        // 失败登录不冒充已认证 actor，用户名只进摘要。
        await writeAudit(app.db, request.log, {
          actor: 'anonymous',
          action: 'auth.login.failed',
          input: { username },
          status: 'denied',
          requestId: request.id,
        });
        if (result.status >= 400 && result.status < 500) {
          return reject(reply, 'UNAUTHORIZED', 'invalid credentials');
        }
        throw new Error(`better-auth sign-in failed with status ${result.status}`);
      }

      if (!session) throw new Error('better-auth sign-in did not persist a session');
      if (session.user.disabled) {
        await revokeUserSessions(app, session.user.id);
        await writeAudit(app.db, request.log, {
          actor: 'anonymous',
          action: 'auth.login.failed',
          input: { username },
          status: 'denied',
          requestId: request.id,
        });
        return reject(reply, 'UNAUTHORIZED', 'account disabled');
      }

      forwardSetCookie(result.headers, reply);
      await writeAudit(app.db, request.log, {
        actor: session.user.businessId,
        action: 'auth.login.succeeded',
        status: 'ok',
        requestId: request.id,
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/logout',
    {
      config: { access: { kind: 'public', reason: 'logout' } },
      preHandler: [origin],
    },
    async (request, reply) => {
      const headers = fromNodeHeaders(request.headers);
      // 先读会话拿审计 actor；伪造/过期 cookie 也允许登出。
      const session = normalizeSession(await auth.api.getSession({ headers }));

      const result = await auth.api.signOut({ headers, asResponse: true });
      if (!result.ok) {
        throw new Error(`better-auth sign-out failed with status ${result.status}`);
      }
      // 库返回成功不代表会话已删；用原始 cookie 再查一次，避免「登出成功但旧 cookie 仍可用」。
      if (await auth.api.getSession({ headers })) {
        throw new Error('better-auth session revocation failed');
      }
      forwardSetCookie(result.headers, reply);

      await writeAudit(app.db, request.log, {
        actor: session?.user.businessId ?? 'anonymous',
        action: 'auth.logout',
        status: 'ok',
        requestId: request.id,
      });
      return { ok: true };
    },
  );

  app.get(
    '/api/auth/me',
    { config: { access: { kind: 'public', reason: 'auth status' } } },
    async (request, reply): Promise<AuthMe> => {
      const session = await readSession(request, reply);
      if (!session || session.user.disabled) return { authenticated: false };
      const principal = await principalOf(app, session.user);
      if (principal.kind !== 'user') return { authenticated: false };
      return {
        authenticated: true,
        user: {
          businessId: principal.businessId,
          username: principal.username,
          name: principal.name,
        },
        roles: principal.roles,
        grants: principal.grants,
      };
    },
  );

  typed(app).post(
    '/api/auth/change-password',
    {
      config: { access: { kind: 'authenticated' } },
      preHandler: [origin],
      schema: { body: changeOwnPasswordSchema },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal?.kind !== 'user') {
        return reject(reply, 'UNAUTHORIZED', 'not logged in');
      }
      try {
        await auth.api.changePassword({
          body: {
            currentPassword: request.body.currentPassword,
            newPassword: request.body.newPassword,
            revokeOtherSessions: false,
          },
          headers: fromNodeHeaders(request.headers),
        });
      } catch (error) {
        if (error instanceof APIError) {
          if (error.statusCode === 400) return reject(reply, 'UNAUTHORIZED', 'invalid credentials');
          if (error.statusCode === 401) return reject(reply, 'UNAUTHORIZED', 'not logged in');
        }
        throw error;
      }

      // 改密后所有旧 cookie 立即失效，包括当前请求使用的会话。
      await revokeUserSessions(app, principal.authUserId);
      clearAuthCookie(reply, app.config);
      await writeAudit(app.db, request.log, {
        actor: principal.businessId,
        action: 'auth.password.changed',
        status: 'ok',
        requestId: request.id,
      });
      return { ok: true };
    },
  );
}
