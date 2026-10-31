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
  unique,
} from './access-helpers.js';

const ready = await infraReady;

interface AccountBody {
  businessId: string;
  username: string;
  name: string;
  status: 'active' | 'disabled';
  roles: { systemKey: string | null }[];
}

describe.skipIf(!ready)('accounts', () => {
  let app: FastifyInstance;
  let admin: string;

  beforeAll(async () => {
    app = await startAccessApp();
    admin = await adminCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates accounts and lists active and disabled ones', async () => {
    const first = await createAccount(app, admin, { name: '甲' });
    const second = await createAccount(app, admin, { name: '乙' });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(first.account.roles).toEqual([
      { id: expect.any(String), name: '用户', systemKey: 'user' },
    ]);
    expect(JSON.stringify(first.body)).not.toMatch(/password|email|session/i);

    const listed = await inject(app, {
      method: 'GET',
      url: '/api/accounts?limit=100',
      headers: { cookie: admin },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const page = listed.json<{ items: AccountBody[]; total: number }>();
    expect(page.items.map((item) => item.businessId)).toEqual(
      expect.arrayContaining([first.account.businessId, second.account.businessId]),
    );

    await inject(app, {
      method: 'PATCH',
      url: `/api/accounts/${encodeURIComponent(second.account.businessId)}/status`,
      headers: { cookie: admin },
      payload: { status: 'disabled' },
    });
    const again = await inject(app, {
      method: 'GET',
      url: `/api/accounts?q=${encodeURIComponent(second.account.businessId)}`,
      headers: { cookie: admin },
    });
    const disabledPage = again.json<{ items: AccountBody[] }>();
    expect(
      disabledPage.items.find((item) => item.businessId === second.account.businessId),
    ).toMatchObject({ status: 'disabled' });
  });

  it('updates username/name but rejects immutable fields and invalid business IDs', async () => {
    const created = await createAccount(app, admin);
    const { businessId } = created.account;

    const updated = await inject(app, {
      method: 'PATCH',
      url: `/api/accounts/${encodeURIComponent(businessId)}`,
      headers: { cookie: admin },
      payload: { name: '新名字', username: unique('renamed') },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ businessId, name: '新名字' });

    for (const payload of [{}, { businessId: 'other' }, { name: 'x', password: '12345678' }]) {
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/accounts/${encodeURIComponent(businessId)}`,
        headers: { cookie: admin },
        payload,
      });
      expectProblem(res, 'INVALID_INPUT');
    }

    const spaced = await createAccount(app, admin, { businessId: 'bad id' });
    expectProblem(spaced.res, 'INVALID_INPUT');
  });

  it('rejects duplicate business IDs, duplicate usernames and unknown roles', async () => {
    const created = await createAccount(app, admin);
    const duplicate = await createAccount(app, admin, { businessId: created.account.businessId });
    expectProblem(duplicate.res, 'CONFLICT');

    const username = unique('shared');
    await createAccount(app, admin, { username });
    const sameName = await createAccount(app, admin, { username });
    expectProblem(sameName.res, 'CONFLICT');

    const badRole = await createAccount(app, admin, { roleIds: ['role_missing'] });
    expectProblem(badRole.res, 'INVALID_INPUT');
  });

  it('resets a password and revokes every old session', async () => {
    const created = await createAccount(app, admin);
    const signIn = await login(app, created.account.username, 'test-password-123');
    const cookie = cookieOf(signIn);

    const reset = await inject(app, {
      method: 'POST',
      url: `/api/accounts/${encodeURIComponent(created.account.businessId)}/password`,
      headers: { cookie: admin },
      payload: { password: '{{SECRET_qfao7tnn}}' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    const old = await inject(app, { method: 'GET', url: '/api/accounts', headers: { cookie } });
    expect(old.statusCode).toBe(401);
    expect((await login(app, created.account.username, 'test-password-123')).statusCode).toBe(401);
    expect((await login(app, created.account.username, '{{SECRET_qfao7tnn}}')).statusCode).toBe(
      200,
    );
  });

  it('deletes only credentials, keeps business links, and restores the same identity', async () => {
    const created = await createAccount(app, admin);
    const { businessId, username } = created.account;
    const signIn = await login(app, username, 'test-password-123');
    const cookie = cookieOf(signIn);

    await app.pool.query(
      'insert into user_preferences (business_id, content, revision) values ($1, $2, 0)',
      [businessId, 'keep me'],
    );

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/accounts/${encodeURIComponent(businessId)}`,
      headers: { cookie: admin },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ ok: true });

    const oldCookie = await inject(app, {
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
    });
    expect(oldCookie.statusCode).toBe(401);

    const authRows = await app.pool.query(
      `select
         (select count(*) from "user" where business_id = $1) as users,
         (select count(*) from session s join "user" u on u.id = s.user_id where u.business_id = $1) as sessions`,
      [businessId],
    );
    expect(Number(authRows.rows[0]?.users)).toBe(0);
    expect(Number(authRows.rows[0]?.sessions)).toBe(0);
    const prefs = await app.pool.query(
      'select content from user_preferences where business_id = $1',
      [businessId],
    );
    expect(prefs.rows[0]?.content).toBe('keep me');

    const withoutRestore = await createAccount(app, admin, { businessId, username: unique('new') });
    expectProblem(withoutRestore.res, 'CONFLICT');

    const restored = await createAccount(app, admin, {
      businessId,
      username: unique('restored'),
      restore: true,
    });
    expect(restored.statusCode, restored.body).toBe(201);
    expect(restored.account.roles).toEqual([
      { id: expect.any(String), name: '用户', systemKey: 'user' },
    ]);

    const oldAgain = await inject(app, {
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie },
    });
    expect(oldAgain.statusCode).toBe(401);
  });

  it('protects the last active administrator from disable and role removal', async () => {
    const disable = await inject(app, {
      method: 'PATCH',
      url: '/api/accounts/bootstrap-admin/status',
      headers: { cookie: admin },
      payload: { status: 'disabled' },
    });
    expectProblem(disable, 'CONFLICT');

    const roles = await inject(app, {
      method: 'GET',
      url: '/api/roles',
      headers: { cookie: admin },
    });
    const userRole = roles
      .json<{ roles: { id: string; systemKey: string | null }[] }>()
      .roles.find((role) => role.systemKey === 'user');
    const removeAdmin = await inject(app, {
      method: 'PUT',
      url: '/api/accounts/bootstrap-admin/roles',
      headers: { cookie: admin },
      payload: { roleIds: [userRole?.id] },
    });
    expectProblem(removeAdmin, 'CONFLICT');
  });

  it('assigns roles to offline identities with history only', async () => {
    const created = await createAccount(app, admin);
    await inject(app, {
      method: 'DELETE',
      url: `/api/accounts/${encodeURIComponent(created.account.businessId)}`,
      headers: { cookie: admin },
    });

    const roles = await inject(app, {
      method: 'GET',
      url: '/api/roles',
      headers: { cookie: admin },
    });
    const userRole = roles
      .json<{ roles: { id: string; systemKey: string | null }[] }>()
      .roles.find((role) => role.systemKey === 'user');

    const assigned = await inject(app, {
      method: 'PUT',
      url: `/api/accounts/${encodeURIComponent(created.account.businessId)}/roles`,
      headers: { cookie: admin },
      payload: { roleIds: [userRole?.id] },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    const missing = await inject(app, {
      method: 'PUT',
      url: `/api/accounts/${encodeURIComponent(unique('ghost'))}/roles`,
      headers: { cookie: admin },
      payload: { roleIds: [userRole?.id] },
    });
    expectProblem(missing, 'NOT_FOUND');
  });
});
