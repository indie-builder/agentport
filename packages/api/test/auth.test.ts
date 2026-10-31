import { authUsers, platformBootstrap } from '@agentport/db';
import { PERMISSIONS } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBootstrap } from '../src/features/auth/bootstrap.js';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import {
  adminCookie,
  cookieOf,
  createAccount,
  expectProblem,
  infraReady,
  inject,
  login,
  startAccessApp,
  testConfig,
} from './access-helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('auth', () => {
  const config = testConfig();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startAccessApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects protected routes without a cookie', async () => {
    const res = await inject(app, { method: 'GET', url: '/api/accounts' });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('rejects a wrong password', async () => {
    const res = await login(app, config.ADMIN_USER, 'definitely-not-the-password');
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === AUTH_COOKIE)).toBeUndefined();
  });

  it('rejects a wrong username', async () => {
    const res = await login(app, 'nobody', config.ADMIN_PASSWORD);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing or non-string field with the schema message', async () => {
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

  it('rejects an over-long username and password before better-auth', async () => {
    const username = await login(app, 'x'.repeat(129), config.ADMIN_PASSWORD);
    expect(expectProblem(username, 'INVALID_INPUT').path).toBe('/username');

    const password = await login(app, config.ADMIN_USER, 'x'.repeat(129));
    expect(expectProblem(password, 'INVALID_INPUT').path).toBe('/password');
  });

  it('rejects a cross-origin login without touching credentials', async () => {
    const res = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD, {
      origin: 'https://evil.example',
    });
    expect(expectProblem(res, 'FORBIDDEN')).toBeTruthy();
  });

  it('allows a login from a configured origin', async () => {
    const res = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD, {
      origin: 'http://localhost:5173',
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('logs in with the right credentials and sets an httpOnly cookie', async () => {
    const res = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const cookie = res.cookies.find((c) => c.name === AUTH_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    const authed = await inject(app, {
      method: 'GET',
      url: '/api/accounts',
      cookies: { [AUTH_COOKIE]: cookie?.value ?? '' },
    });
    expect(authed.statusCode, authed.body).toBe(200);
  });

  it('GET /api/auth/me returns the unified access payload', async () => {
    const anon = await inject(app, { method: 'GET', url: '/api/auth/me' });
    expect(anon.json()).toEqual({ authenticated: false });

    const cookie = await adminCookie(app);
    const me = await inject(app, { method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode, me.body).toBe(200);
    const body = me.json();
    expect(body).toMatchObject({
      authenticated: true,
      user: { businessId: 'bootstrap-admin', username: config.ADMIN_USER },
      roles: [{ systemKey: 'admin' }],
    });
    expect(body.grants).toHaveLength(PERMISSIONS.length);
    expect(body.grants.every((grant: { scope: string }) => grant.scope === 'platform')).toBe(true);
  });

  it('logout clears the cookie and revokes the session', async () => {
    const cookie = await adminCookie(app);
    const logout = await inject(app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(logout.cookies.find((c) => c.name === AUTH_COOKIE)?.value).toBe('');

    const after = await inject(app, { method: 'GET', url: '/api/accounts', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('refuses login for a disabled account and kills its old session', async () => {
    const admin = await adminCookie(app);
    const created = await createAccount(app, admin, { name: '停用账户' });
    expect(created.statusCode, created.body).toBe(201);

    const username = created.account.username;
    const signIn = await login(app, username, 'test-password-123');
    expect(signIn.statusCode, signIn.body).toBe(200);
    const cookie = cookieOf(signIn);

    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/accounts/${encodeURIComponent(created.account.businessId)}/status`,
      headers: { cookie: admin },
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    const oldCookie = await inject(app, {
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
    });
    expect(oldCookie.statusCode).toBe(401);

    const denied = await login(app, username, 'test-password-123');
    expect(denied.statusCode).toBe(401);
  });

  it('changes the own password, revoking every old session', async () => {
    const admin = await adminCookie(app);
    const created = await createAccount(app, admin, { name: '改密账户' });
    expect(created.statusCode, created.body).toBe(201);
    const account = JSON.parse(created.body) as { username: string; businessId: string };

    const signIn = await login(app, account.username, 'test-password-123');
    const cookie = cookieOf(signIn);

    const wrong = await inject(app, {
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'wrong-password', newPassword: '{{SECRET_qfao7tnn}}' },
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await inject(app, {
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'test-password-123', newPassword: '{{SECRET_qfao7tnn}}' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ ok: true });

    const oldSession = await inject(app, {
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
    });
    expect(oldSession.statusCode).toBe(401);

    expect((await login(app, account.username, 'test-password-123')).statusCode).toBe(401);
    expect((await login(app, account.username, '{{SECRET_qfao7tnn}}')).statusCode).toBe(200);
  });

  it('bootstrap is idempotent and never replays the environment password', async () => {
    await adminCookie(app);
    const before = await app.db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.businessId, 'bootstrap-admin'));
    expect(before).toHaveLength(1);

    const [credentialBefore] = (
      await app.pool.query<{ password: string }>(
        `select password from account where provider_id = 'credential'
         and user_id = (select id from "user" where business_id = 'bootstrap-admin')`,
      )
    ).rows;

    await ensureBootstrap(app.db, testConfig());
    await ensureBootstrap(app.db, testConfig());

    const [credentialAfter] = (
      await app.pool.query<{ password: string }>(
        `select password from account where provider_id = 'credential'
         and user_id = (select id from "user" where business_id = 'bootstrap-admin')`,
      )
    ).rows;
    expect(credentialAfter?.password).toBe(credentialBefore?.password);

    const markers = await app.db
      .select({ id: platformBootstrap.id })
      .from(platformBootstrap)
      .where(eq(platformBootstrap.id, 'initial'));
    expect(markers).toHaveLength(1);
    expect(
      (await login(app, testConfig().ADMIN_USER, testConfig().ADMIN_PASSWORD)).statusCode,
    ).toBe(200);
  });
});

describe.skipIf(!ready)('auth wildcard origins', () => {
  const config = testConfig();
  const origin = 'https://worktree-skills-toolbar-layout.agentport.localhost';
  let app: FastifyInstance;
  let strictApp: FastifyInstance;

  beforeAll(async () => {
    app = await startAccessApp({
      CORS_ORIGINS: 'http://localhost:5173,https://*.agentport.localhost',
    });
    strictApp = await startAccessApp({ CORS_ORIGINS: 'http://localhost:5173' });
  });

  afterAll(async () => {
    await app.close();
    await strictApp.close();
  });

  it('logs in and out from an arbitrary worktree subdomain', async () => {
    const signIn = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD, { origin });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const cookie = cookieOf(signIn);

    const logout = await inject(app, {
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin, cookie },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.cookies.find((c) => c.name === AUTH_COOKIE)?.value).toBe('');
  });

  it('rejects a subdomain login when the wildcard is not configured', async () => {
    const res = await login(strictApp, config.ADMIN_USER, config.ADMIN_PASSWORD, { origin });
    expect(expectProblem(res, 'FORBIDDEN')).toBeTruthy();
  });
});
