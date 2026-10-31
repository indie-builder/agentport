import { ACCESS_SCOPES, PERMISSIONS, type Role } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCookie,
  createRole,
  expectProblem,
  grants,
  infraReady,
  inject,
  mutateMatrix,
  startAccessApp,
  unique,
} from './access-helpers.js';

const ready = await infraReady;

interface Matrix {
  revision: number;
  roles: Role[];
}

describe.skipIf(!ready)('roles', () => {
  let app: FastifyInstance;
  let admin: string;

  beforeAll(async () => {
    app = await startAccessApp();
    admin = await adminCookie(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const getMatrix = async (): Promise<Matrix> => {
    const res = await inject(app, { method: 'GET', url: '/api/roles', headers: { cookie: admin } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Matrix>();
  };

  /** 构造必然失效的 revision；并行写也不会命中。 */
  const putRaw = (expectedRevision: number, roles: unknown[]) =>
    inject(app, {
      method: 'PUT',
      url: '/api/roles',
      headers: { cookie: admin },
      payload: { expectedRevision, roles },
    });

  /** 遇到并行 revision 变化时重读重试，仍断言目标校验错误。 */
  const expectInvalid = async (
    build: (matrix: Matrix) => unknown[],
    code: 'INVALID_INPUT' | 'CONFLICT',
  ) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matrix = await getMatrix();
      const res = await putRaw(matrix.revision, build(matrix));
      if (res.statusCode === 409 && code === 'INVALID_INPUT') continue;
      expectProblem(res, code);
      return;
    }
    throw new Error('could not observe the expected rejected write');
  };

  it('exposes the four system roles and the shared permission catalog', async () => {
    const matrix = await getMatrix();
    expect(matrix.revision).toBeGreaterThanOrEqual(0);
    // 并行套件可能留下自定义角色；这里只认系统角色集合。
    expect(
      matrix.roles
        .map((role) => role.systemKey)
        .filter((systemKey) => systemKey !== null)
        .sort(),
    ).toEqual(['admin', 'maintainer', 'owner', 'user']);
    const adminRole = matrix.roles.find((role) => role.systemKey === 'admin');
    expect(adminRole?.grants).toHaveLength(PERMISSIONS.length);
    expect(adminRole?.grants.every((grant) => grant.scope === 'platform')).toBe(true);

    const res = await inject(app, {
      method: 'GET',
      url: '/api/permissions',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    const catalog = res.json<{
      permissions: { id: string }[];
      scopes: { id: string; label: string }[];
    }>();
    expect(catalog.permissions.map((permission) => permission.id)).toEqual(
      PERMISSIONS.map((permission) => permission.id),
    );
    expect(catalog.scopes).toEqual(ACCESS_SCOPES);
  });

  it('rejects a stale revision without partial writes', async () => {
    const before = await getMatrix();
    const name = unique('stale');
    const res = await putRaw(before.revision + 1000, [
      ...before.roles.map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
      { name, grants: [] },
    ]);
    expectProblem(res, 'CONFLICT');
    const after = await getMatrix();
    expect(after.roles.some((role) => role.name === name)).toBe(false);
  });

  it('rejects unknown permissions, scopes, duplicates and missing read dependencies', async () => {
    await expectInvalid(
      (matrix) => [
        ...matrix.roles,
        {
          name: unique('bad-permission'),
          grants: [{ permissionId: 'servers.explode', scope: 'platform' }],
        },
      ],
      'INVALID_INPUT',
    );

    await expectInvalid(
      (matrix) => [
        ...matrix.roles,
        {
          name: unique('bad-scope'),
          grants: [{ permissionId: 'servers.read', scope: 'own_data' }],
        },
      ],
      'INVALID_INPUT',
    );

    await expectInvalid(
      (matrix) => [
        ...matrix.roles,
        {
          name: unique('duplicate'),
          grants: [
            { permissionId: 'agents.read', scope: 'authorized_agents' },
            { permissionId: 'agents.read', scope: 'authorized_agents' },
          ],
        },
      ],
      'INVALID_INPUT',
    );

    await expectInvalid(
      (matrix) => [
        ...matrix.roles,
        {
          name: unique('missing-read'),
          grants: [{ permissionId: 'agents.config.update', scope: 'maintained_agents' }],
        },
      ],
      'INVALID_INPUT',
    );

    await expectInvalid(
      (matrix) => [
        ...matrix.roles,
        { name: unique('dup-name'), grants: [] },
        { name: matrix.roles[0]?.name ?? '用户', grants: [] },
      ],
      'INVALID_INPUT',
    );
  });

  it('creates, updates, and deletes custom roles atomically', async () => {
    const name = unique('custom');
    const sorted = (entries: { permissionId: string; scope: string }[]) =>
      [...entries].sort((a, b) =>
        `${a.permissionId}:${a.scope}`.localeCompare(`${b.permissionId}:${b.scope}`),
      );
    const created = await createRole(app, admin, name, grants(['overview.read', 'own_data']));
    expect(created.systemKey).toBeNull();
    expect(sorted(created.grants)).toEqual(sorted(grants(['overview.read', 'own_data'])));

    const updated = await mutateMatrix(app, admin, (matrix) =>
      matrix.roles.map((role) =>
        role.id === created.id
          ? {
              id: role.id,
              name: role.name,
              grants: grants(['overview.read', 'own_data'], ['agents.read', 'authorized_agents']),
            }
          : { id: role.id, name: role.name, grants: role.grants },
      ),
    );
    expect(sorted(updated.roles.find((role) => role.id === created.id)?.grants ?? [])).toEqual(
      sorted(grants(['overview.read', 'own_data'], ['agents.read', 'authorized_agents'])),
    );

    const removed = await mutateMatrix(app, admin, (matrix) =>
      matrix.roles
        .filter((role) => role.id !== created.id)
        .map((role) => ({ id: role.id, name: role.name, grants: role.grants })),
    );
    expect(removed.roles.some((role) => role.id === created.id)).toBe(false);
  });

  it('never accepts tampered grants for the system admin role', async () => {
    const updated = await mutateMatrix(app, admin, (matrix) =>
      matrix.roles.map((role) =>
        role.systemKey === 'admin'
          ? { id: role.id, name: '平台管理员', grants: [] }
          : { id: role.id, name: role.name, grants: role.grants },
      ),
    );
    const adminRole = updated.roles.find((role) => role.systemKey === 'admin');
    expect(adminRole?.grants).toHaveLength(PERMISSIONS.length);
  });
});
