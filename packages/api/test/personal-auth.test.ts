import { auditLog, authSessions, authUsers } from '@agentport/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCookie,
  cookieOf,
  createAccount,
  expectProblem,
  infraReady,
  inject,
  login,
  startAccessApp,
} from './access-helpers.js';

const ready = await infraReady;
const TEST_PASSWORD = 'test-password-123';
const PREVIEW_ORIGIN = 'https://personal-module.agentport.localhost';

type PersonalSessionBody = {
  items: {
    id: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    current: boolean;
  }[];
};

async function accountAndCookie(app: FastifyInstance, admin: string, name: string) {
  const created = await createAccount(app, admin, { name, roleIds: [] });
  expect(created.statusCode, created.body).toBe(201);
  const signIn = await login(app, created.account.username, TEST_PASSWORD);
  expect(signIn.statusCode, signIn.body).toBe(200);
  return { account: created.account, cookie: cookieOf(signIn) };
}

async function authUserId(app: FastifyInstance, businessId: string): Promise<string> {
  const [row] = await app.db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.businessId, businessId));
  if (!row) throw new Error(`auth user not found for ${businessId}`);
  return row.id;
}

async function listSessions(app: FastifyInstance, cookie: string) {
  return inject(app, { method: 'GET', url: '/api/me/sessions', headers: { cookie } });
}

describe.skipIf(!ready)('personal profile and session routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await startAccessApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('updates the own display name without any permission leaf', async () => {
    const admin = await adminCookie(app);
    const { account, cookie } = await accountAndCookie(app, admin, '初始姓名');

    const res = await inject(app, {
      method: 'PATCH',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { name: '新姓名' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      businessId: account.businessId,
      username: account.username,
      name: '新姓名',
    });
    expect(res.body).not.toMatch(/"token"|"userId"|"cookie"/i);

    const me = await inject(app, { method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({
      authenticated: true,
      user: { businessId: account.businessId, username: account.username, name: '新姓名' },
    });

    const audit = await app.db
      .select({ actor: auditLog.actor, target: auditLog.target, status: auditLog.status })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'auth.profile.updated'),
          eq(auditLog.actor, account.businessId),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit).toEqual([{ actor: account.businessId, target: account.businessId, status: 'ok' }]);
  });

  it('rejects identity fields, blank names, anonymous callers and untrusted origins', async () => {
    const admin = await adminCookie(app);
    const { account, cookie } = await accountAndCookie(app, admin, '只读身份');

    for (const payload of [
      { name: '合法', username: 'hijack' },
      { name: '合法', businessId: 'other' },
      { name: '合法', roles: ['admin'] },
      { name: '合法', image: 'https://example.com/a.png' },
      { name: '' },
      { name: '   ' },
    ]) {
      const res = await inject(app, {
        method: 'PATCH',
        url: '/api/me/profile',
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, res.body).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }

    const unchanged = await inject(app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(unchanged.json()).toMatchObject({ user: { name: '只读身份' } });

    const anonymous = await inject(app, {
      method: 'PATCH',
      url: '/api/me/profile',
      payload: { name: '匿名' },
    });
    expectProblem(anonymous, 'UNAUTHORIZED');

    const evil = await inject(app, {
      method: 'PATCH',
      url: '/api/me/profile',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { name: '跨站' },
    });
    expectProblem(evil, 'FORBIDDEN');

    expect(account.businessId).toBeTruthy();
  });

  it('rejects a disabled account and its old session', async () => {
    const admin = await adminCookie(app);
    const { account, cookie } = await accountAndCookie(app, admin, '停用个人');

    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/accounts/${encodeURIComponent(account.businessId)}/status`,
      headers: { cookie: admin },
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);

    const res = await inject(app, {
      method: 'PATCH',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { name: '不该成功' },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('allows a trusted preview origin for profile writes', async () => {
    const wildcard = await startAccessApp({
      CORS_ORIGINS: `http://localhost:5173,https://*.agentport.localhost`,
    });
    try {
      const admin = await adminCookie(wildcard);
      const created = await createAccount(wildcard, admin, { name: '预览账户', roleIds: [] });
      expect(created.statusCode, created.body).toBe(201);
      const signIn = await login(wildcard, created.account.username, TEST_PASSWORD, {
        origin: PREVIEW_ORIGIN,
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const cookie = cookieOf(signIn);

      const res = await inject(wildcard, {
        method: 'PATCH',
        url: '/api/me/profile',
        headers: { cookie, origin: PREVIEW_ORIGIN },
        payload: { name: '预览改名' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ name: '预览改名' });
    } finally {
      await wildcard.close();
    }
  });

  it('lists only the caller sessions with an accurate current marker and no credentials', async () => {
    const admin = await adminCookie(app);
    const a = await accountAndCookie(app, admin, '会话甲');
    const b = await accountAndCookie(app, admin, '会话乙');
    const aSecond = await login(app, a.account.username, TEST_PASSWORD);
    expect(aSecond.statusCode, aSecond.body).toBe(200);
    const aSecondCookie = cookieOf(aSecond);
    const bSecond = await login(app, b.account.username, TEST_PASSWORD);
    expect(bSecond.statusCode, bSecond.body).toBe(200);
    const bSecondCookie = cookieOf(bSecond);

    const first = await listSessions(app, a.cookie);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).not.toMatch(/"token"|"userId"|"cookie"/i);
    const firstBody = first.json<PersonalSessionBody>();
    expect(firstBody.items).toHaveLength(2);
    for (const item of firstBody.items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'current',
        'expiresAt',
        'id',
        'ipAddress',
        'updatedAt',
        'userAgent',
      ]);
    }
    const firstCurrent = firstBody.items.filter((item) => item.current);
    expect(firstCurrent).toHaveLength(1);

    const second = await listSessions(app, aSecondCookie);
    const secondBody = second.json<PersonalSessionBody>();
    expect(secondBody.items.filter((item) => item.current)).toHaveLength(1);
    const secondCurrentId = secondBody.items.find((item) => item.current)?.id;
    expect(secondCurrentId).not.toBe(firstCurrent[0]?.id);

    const bSessions = await listSessions(app, b.cookie);
    const bBody = bSessions.json<PersonalSessionBody>();
    expect(bBody.items).toHaveLength(2);
    const bIds = new Set(bBody.items.map((item) => item.id));
    expect(bBody.items.filter((item) => item.current)).toHaveLength(1);
    expect(firstBody.items.some((item) => bIds.has(item.id))).toBe(false);

    const bSecondBody = (await listSessions(app, bSecondCookie)).json<PersonalSessionBody>();
    expect(bSecondBody.items.find((item) => item.current)?.id).not.toBe(
      bBody.items.find((item) => item.current)?.id,
    );

    const anonymous = await inject(app, { method: 'GET', url: '/api/me/sessions' });
    expectProblem(anonymous, 'UNAUTHORIZED');
  });

  it('rejects the current session, other users and unknown ids, then revokes own other sessions', async () => {
    const admin = await adminCookie(app);
    const a = await accountAndCookie(app, admin, '撤销甲');
    const b = await accountAndCookie(app, admin, '撤销乙');
    const aSecond = await login(app, a.account.username, TEST_PASSWORD);
    const aSecondCookie = cookieOf(aSecond);

    const mine = (await listSessions(app, a.cookie)).json<PersonalSessionBody>();
    const currentId = mine.items.find((item) => item.current)?.id;
    const otherId = mine.items.find((item) => !item.current)?.id;
    expect(currentId).toBeTruthy();
    expect(otherId).toBeTruthy();

    const bSessions = (await listSessions(app, b.cookie)).json<PersonalSessionBody>();
    const otherUserSessionId = bSessions.items[0]?.id;

    const current = await inject(app, {
      method: 'DELETE',
      url: `/api/me/sessions/${encodeURIComponent(currentId ?? '')}`,
      headers: { cookie: a.cookie },
    });
    expectProblem(current, 'CONFLICT');

    const foreign = await inject(app, {
      method: 'DELETE',
      url: `/api/me/sessions/${encodeURIComponent(otherUserSessionId ?? '')}`,
      headers: { cookie: a.cookie },
    });
    expectProblem(foreign, 'NOT_FOUND');

    const missing = await inject(app, {
      method: 'DELETE',
      url: '/api/me/sessions/does-not-exist',
      headers: { cookie: a.cookie },
    });
    expectProblem(missing, 'NOT_FOUND');

    const evil = await inject(app, {
      method: 'DELETE',
      url: `/api/me/sessions/${encodeURIComponent(otherId ?? '')}`,
      headers: { cookie: a.cookie, origin: 'https://evil.example' },
    });
    expectProblem(evil, 'FORBIDDEN');

    const revoked = await inject(app, {
      method: 'DELETE',
      url: `/api/me/sessions/${encodeURIComponent(otherId ?? '')}`,
      headers: { cookie: a.cookie },
    });
    expect(revoked.statusCode, revoked.body).toBe(204);

    const dead = await listSessions(app, aSecondCookie);
    expectProblem(dead, 'UNAUTHORIZED');
    const alive = await listSessions(app, a.cookie);
    expect(alive.statusCode, alive.body).toBe(200);

    const audit = await app.db
      .select({ actor: auditLog.actor, target: auditLog.target, status: auditLog.status })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'auth.session.revoked'), eq(auditLog.target, otherId ?? '')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit).toEqual([{ actor: a.account.businessId, target: otherId, status: 'ok' }]);
  });

  it('maps a stale but unexpired session to FORBIDDEN without logging the user out', async () => {
    const admin = await adminCookie(app);
    const stale = await accountAndCookie(app, admin, '过期鲜度');
    const userId = await authUserId(app, stale.account.businessId);
    await app.db
      .update(authSessions)
      .set({
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .where(eq(authSessions.userId, userId));

    const listed = await listSessions(app, stale.cookie);
    const body = expectProblem(listed, 'FORBIDDEN');
    expect(body.message).toBe('请重新登录后管理登录会话');

    const removed = await inject(app, {
      method: 'DELETE',
      url: '/api/me/sessions/anything',
      headers: { cookie: stale.cookie },
    });
    expect(expectProblem(removed, 'FORBIDDEN').message).toBe('请重新登录后管理登录会话');

    const me = await inject(app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: stale.cookie },
    });
    expect(me.json()).toMatchObject({ authenticated: true });
  });
});
