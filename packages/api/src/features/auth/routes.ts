import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import type { FastifyInstance } from 'fastify';
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS } from './types.js';

const SCRYPT_KEYLEN = 32;

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

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: app.config.NODE_ENV === 'production',
  } as const;

  app.decorate('requireAuth', async (request, reply) => {
    const token = request.cookies[AUTH_COOKIE];
    if (!token) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'not logged in' });
      return;
    }
    try {
      app.jwt.verify(token);
    } catch {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'invalid or expired token' });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as unknown;
    if (typeof body !== 'object' || body === null) {
      return reply.status(400).send({ code: 'INVALID_INPUT', message: 'body must be an object' });
    }
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply
        .status(400)
        .send({ code: 'INVALID_INPUT', message: 'username and password are required' });
    }

    const userOk = username === app.config.ADMIN_USER;
    // 用户名错也照样算一次 scrypt，避免响应时间泄露「用户名对不对」。
    const passOk = await passwordMatches(password, app.config.ADMIN_PASSWORD);
    if (!userOk || !passOk) {
      request.log.warn({ username }, 'login failed');
      return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'invalid credentials' });
    }

    const token = await reply.jwtSign({ username }, { expiresIn: AUTH_MAX_AGE_SECONDS });
    reply.setCookie(AUTH_COOKIE, token, { ...cookieOptions, maxAge: AUTH_MAX_AGE_SECONDS });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(AUTH_COOKIE, cookieOptions);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const token = request.cookies[AUTH_COOKIE];
    if (!token) return { authenticated: false };
    try {
      const payload = app.jwt.verify<{ username: string }>(token);
      return { authenticated: true, username: payload.username };
    } catch {
      return { authenticated: false };
    }
  });
}
