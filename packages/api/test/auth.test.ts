import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import { expectProblem, infraReady, inject, startApp, testConfig } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('auth', () => {
  const config = testConfig();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (username: string, password: string) =>
    inject(app, { method: 'POST', url: '/api/auth/login', payload: { username, password } });

  it('rejects protected routes without a cookie', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/servers' });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('rejects a wrong password', async () => {
    const res = await login(config.ADMIN_USER, 'definitely-not-the-password');
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === AUTH_COOKIE)).toBeUndefined();
  });

  it('rejects a wrong username', async () => {
    const res = await login('nobody', config.ADMIN_PASSWORD);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing or non-string field with the schema message', async () => {
    // schema 在进入 handler 前就拒绝（也不会白算一次 scrypt），文案保持人类可读。
    for (const payload of [
      {},
      { username: config.ADMIN_USER },
      { username: null, password: 'x' },
    ]) {
      const res = await inject(app, { method: 'POST', url: '/api/auth/login', payload });
      const body = expectProblem(res, 'INVALID_INPUT');
      expect(body.path).toMatch(/^\/(username|password)$/);
      expect(body.message).toMatch(/用户名|密码/);
    }
  });

  it('rejects an over-long username instead of truncating it', async () => {
    const res = await login('x'.repeat(129), config.ADMIN_PASSWORD);
    expect(expectProblem(res, 'INVALID_INPUT').path).toBe('/username');
  });

  it('logs in with the right credentials and sets an httpOnly cookie', async () => {
    const res = await login(config.ADMIN_USER, config.ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const cookie = res.cookies.find((c) => c.name === AUTH_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    const authed = await inject(app, {
      method: 'GET',
      url: '/api/servers',
      cookies: { [AUTH_COOKIE]: cookie?.value ?? '' },
    });
    expect(authed.statusCode).toBe(200);
  });

  it('GET /api/auth/me reflects login state', async () => {
    const anon = await inject(app, { method: 'GET', url: '/api/auth/me' });
    expect(anon.json()).toEqual({ authenticated: false });

    const res = await login(config.ADMIN_USER, config.ADMIN_PASSWORD);
    const token = res.cookies.find((c) => c.name === AUTH_COOKIE)?.value ?? '';
    const me = await inject(app, {
      method: 'GET',
      url: '/api/auth/me',
      cookies: { [AUTH_COOKIE]: token },
    });
    expect(me.json()).toEqual({ authenticated: true, username: config.ADMIN_USER });
  });

  it('logout clears the session cookie', async () => {
    const res = await inject(app, { method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cookie = res.cookies.find((c) => c.name === AUTH_COOKIE);
    expect(cookie?.value).toBe('');
  });

  it('revokes the token on logout: the old cookie stops working', async () => {
    // 登录限流按 IP 分桶，本文件其它用例也用 inject；这里用独立 IP 避免互相消耗额度。
    const ip = '127.0.0.200';
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip,
      payload: { username: config.ADMIN_USER, password: config.ADMIN_PASSWORD },
    });
    const token = loginRes.cookies.find((c) => c.name === AUTH_COOKIE)?.value ?? '';

    const before = await app.inject({
      method: 'GET',
      url: '/api/servers',
      remoteAddress: ip,
      cookies: { [AUTH_COOKIE]: token },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      remoteAddress: ip,
      cookies: { [AUTH_COOKIE]: token },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/servers',
      remoteAddress: ip,
      cookies: { [AUTH_COOKIE]: token },
    });
    expect(after.statusCode).toBe(401);
  });
});
