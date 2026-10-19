import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import { infraReady, inject, startApp, testConfig } from './helpers.js';

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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
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
});
