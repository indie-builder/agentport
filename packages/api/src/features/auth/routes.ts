import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getTrustedOrigins, isTrustedOrigin } from '../../config.js';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { authRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import { createAuth, ensureAdmin } from './better-auth.js';

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

/** better-auth 一次可能下发多条 Set-Cookie；数组会被 Fastify 序列成多个同名头。 */
function forwardSetCookie(headers: Headers, reply: FastifyReply): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const auth = createAuth(app.config, app.db);
  const trustedOrigins = getTrustedOrigins(app.config);

  /**
   * 写入口的 CSRF 防线：内部 auth.api 不经过 better-auth 的 origin check。
   * 同源请求由 Host 自动放行；带 Origin 的跨站/子域请求必须在 allowlist 内。
   */
  const originAllowed = (request: FastifyRequest): boolean => {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (origin === `${request.protocol}://${request.headers.host}`) return true;
    return isTrustedOrigin(origin, trustedOrigins);
  };

  // 播种依赖数据库；放到首次登录时做，数据库不可达时应用仍能启动并走统一的 500 路径。
  let adminReady: Promise<void> | undefined;
  const ensureAdminReady = () => {
    adminReady ??= ensureAdmin(app.db, app.config).catch((error) => {
      adminReady = undefined;
      throw error;
    });
    return adminReady;
  };

  const currentSession = (request: FastifyRequest) =>
    auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const { response, headers } = await currentSession(request);
    forwardSetCookie(headers, reply);
    if (!response || response.user.username !== app.config.ADMIN_USER) {
      reject(reply, 'UNAUTHORIZED', 'not logged in');
    }
  });

  typed(app).post(
    '/api/auth/login',
    { ...authRateLimit, schema: { body: loginBody } },
    async (request, reply) => {
      if (!originAllowed(request)) {
        return reject(reply, 'FORBIDDEN', 'origin not allowed');
      }
      const { username, password } = request.body;
      await ensureAdminReady();
      const result = await auth.api.signInUsername({
        body: { username, password },
        headers: fromNodeHeaders(request.headers),
        asResponse: true,
      });

      if (!result.ok) {
        request.log.warn({ username }, 'login failed');
        // 安全审计：失败也要落库，actor 用提交的用户名。
        await writeAudit(app.db, request.log, {
          actor: username,
          action: 'auth.login.failed',
          status: 'denied',
          requestId: request.id,
        });
        if (result.status >= 400 && result.status < 500) {
          return reject(reply, 'UNAUTHORIZED', 'invalid credentials');
        }
        throw new Error(`better-auth sign-in failed with status ${result.status}`);
      }

      forwardSetCookie(result.headers, reply);
      await writeAudit(app.db, request.log, {
        actor: username,
        action: 'auth.login.succeeded',
        status: 'ok',
        requestId: request.id,
      });
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    if (!originAllowed(request)) {
      return reject(reply, 'FORBIDDEN', 'origin not allowed');
    }
    const headers = fromNodeHeaders(request.headers);
    // 先读会话拿审计 actor；退化到 anonymous 与旧行为一致（伪造/过期 cookie 也允许登出）。
    const session = await auth.api.getSession({ headers });
    const username = session?.user.username ?? 'anonymous';

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
      actor: username,
      action: 'auth.logout',
      status: 'ok',
      requestId: request.id,
    });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const { response, headers } = await currentSession(request);
    forwardSetCookie(headers, reply);
    if (!response || response.user.username !== app.config.ADMIN_USER) {
      return { authenticated: false };
    }
    return { authenticated: true, username: response.user.username };
  });
}
