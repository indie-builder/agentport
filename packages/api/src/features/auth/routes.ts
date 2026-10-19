import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { writeAudit } from '../../plugins/audit.js';
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS } from './types.js';

const limits = { off: process.env.RATE_LIMIT_DISABLED === '1' };

const SCRYPT_KEYLEN = 32;

function sessionKey(sid: string): string {
  return `session:${sid}`;
}

/**
 * 登录时在 Redis 写 sid，logout 删除；JWT 本身不能撤销，靠这个键让 token 立即失效。
 * Redis 不可用时拒绝请求，而不是当成「没有会话」放行或拦截所有请求。
 */
/**
 * 短期本地缓存：每个请求都打一次 Redis 会把吞吐压在约 1.6k rps。
 * 缓存 5 秒，撤销的生效延迟有界；logout 会主动清掉本进程的缓存。
 */
const SESSION_TTL_MS = 5_000;
const sessionCache = new Map<string, { alive: boolean; expiresAt: number }>();

function forgetSession(sid: string): void {
  sessionCache.delete(sid);
}

async function sessionAlive(redis: Redis, sid: unknown): Promise<boolean> {
  if (typeof sid !== 'string' || sid.length === 0) return false;
  const now = Date.now();
  const cached = sessionCache.get(sid);
  if (cached && cached.expiresAt > now) return cached.alive;
  try {
    const alive = (await redis.exists(sessionKey(sid))) === 1;
    // 只缓存在量有界，避免被随机 sid 撑爆。
    if (sessionCache.size > 1000) sessionCache.clear();
    sessionCache.set(sid, { alive, expiresAt: now + SESSION_TTL_MS });
    return alive;
  } catch {
    return false;
  }
}

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 每次随机 salt 派生后做常量时间比较；两边等长，timingSafeEqual 不会因长度提前返回。 */
async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const salt = randomBytes(16).toString('hex');
  const [a, b] = await Promise.all([scryptAsync(input, salt), scryptAsync(expected, salt)]);
  return timingSafeEqual(a, b);
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  // 不能 await：root 上 await register 会立刻 boot，后续 feature 的 register 就再也挂不上去。
  // 插件与 route 都在 listen 前完成 boot，装饰器在请求期才被读取，所以这里只登记不等待。
  void app.register(cookie);
  void app.register(jwt, { secret: app.config.JWT_SECRET });

  const redis = new Redis(app.config.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on('error', (err: Error) => app.log.warn({ err }, 'auth session redis error'));
  app.addHook('onClose', async () => {
    await redis.quit();
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: app.config.NODE_ENV === 'production',
  } as const;

  const unauthorized = (reply: FastifyReply, message: string): void => {
    reply.status(401).send({ code: 'UNAUTHORIZED', message });
  };

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[AUTH_COOKIE];
    if (!token) {
      unauthorized(reply, 'not logged in');
      return;
    }
    let payload: { sid?: unknown };
    try {
      payload = app.jwt.verify<{ sid?: unknown }>(token);
    } catch {
      unauthorized(reply, 'invalid or expired token');
      return;
    }
    if (!(await sessionAlive(redis, payload.sid))) {
      unauthorized(reply, 'session expired or revoked');
    }
  });

  app.post(
    '/api/auth/login',
    { config: limits.off ? {} : { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as unknown;
      if (typeof body !== 'object' || body === null) {
        return reply.status(400).send({ code: 'INVALID_INPUT', message: 'body must be an object' });
      }
      const raw = body as Record<string, unknown>;
      if (typeof raw.username !== 'string' || typeof raw.password !== 'string') {
        return reply
          .status(400)
          .send({ code: 'INVALID_INPUT', message: 'username and password are required' });
      }
      // 未认证端点：超长用户名会被永久写入审计表，截断后再使用。
      const username = raw.username.slice(0, 128);
      const password = raw.password;

      const userOk = username === app.config.ADMIN_USER;
      // 用户名错也照样算一次 scrypt，避免响应时间泄露「用户名对不对」。
      const passOk = await passwordMatches(password, app.config.ADMIN_PASSWORD);
      if (!userOk || !passOk) {
        request.log.warn({ username }, 'login failed');
        // 安全审计：失败也要落库，actor 用提交的用户名。
        await writeAudit(app.db, request.log, {
          actor: username,
          action: 'auth.login.failed',
          status: 'denied',
          requestId: request.id,
        });
        return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'invalid credentials' });
      }

      await writeAudit(app.db, request.log, {
        actor: username,
        action: 'auth.login.succeeded',
        status: 'ok',
        requestId: request.id,
      });
      const sid = randomBytes(16).toString('base64url');
      const token = await reply.jwtSign({ username, sid }, { expiresIn: AUTH_MAX_AGE_SECONDS });
      await redis.set(sessionKey(sid), username, 'EX', AUTH_MAX_AGE_SECONDS);
      reply.setCookie(AUTH_COOKIE, token, { ...cookieOptions, maxAge: AUTH_MAX_AGE_SECONDS });
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[AUTH_COOKIE];
    let username = 'anonymous';
    if (token) {
      try {
        const payload = app.jwt.verify<{ username: string; sid?: unknown }>(token);
        username = payload.username;
        // 伪造/过期 token 里可能没有 sid；有才删，删除本身幂等。
        if (typeof payload.sid === 'string') {
          await redis.del(sessionKey(payload.sid));
          forgetSession(payload.sid);
        }
      } catch {
        // 过期或伪造的 token 也允许登出，审计里记为 anonymous。
      }
    }
    await writeAudit(app.db, request.log, {
      actor: username,
      action: 'auth.logout',
      status: 'ok',
      requestId: request.id,
    });
    reply.clearCookie(AUTH_COOKIE, cookieOptions);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const token = request.cookies[AUTH_COOKIE];
    if (!token) return { authenticated: false };
    try {
      const payload = app.jwt.verify<{ username: string; sid?: unknown }>(token);
      if (!(await sessionAlive(redis, payload.sid))) return { authenticated: false };
      return { authenticated: true, username: payload.username };
    } catch {
      return { authenticated: false };
    }
  });
}
