import {
  type AccessScope,
  type ErrorCode,
  errorCode,
  type PermissionGrant,
  type PermissionId,
  type Problem,
  problemSchema,
  type Role,
} from '@agentport/shared';
import { expect } from 'bun:test';
import { AUTH_COOKIE } from '../src/modules/auth/types.js';
import {
  infraReady,
  request,
  startApp,
  type TestApp,
  type TestResponse,
  testConfig,
  unique,
} from './helpers.js';

export type { TestApp, TestResponse };
export { infraReady, request, testConfig, unique };

/**
 * 认证/授权测试只需要完整 app：新架构下访问控制由 contract meta 与 http/access 统一执行，
 * 不再需要另拼一个最小 Fastify 实例。
 */
export async function startAccessApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<TestApp> {
  return startApp(overrides);
}

export function cookieOf(res: TestResponse): string {
  const cookie = res.cookies.find((entry) => entry.name === AUTH_COOKIE);
  if (!cookie?.value) throw new Error(`no auth cookie in response: ${res.statusCode} ${res.body}`);
  return `${cookie.name}=${cookie.value}`;
}

export function login(
  app: TestApp,
  username: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return request(app, {
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { username, password },
  });
}

export async function adminCookie(app: TestApp): Promise<string> {
  const config = testConfig();
  const res = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD);
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

export async function createAccount(
  app: TestApp,
  cookie: string,
  input: {
    businessId?: string;
    username?: string;
    name?: string;
    password?: string;
    roleIds?: string[];
    restore?: boolean;
  } = {},
): Promise<{
  res: TestResponse;
  statusCode: number;
  body: string;
  account: {
    businessId: string;
    username: string;
    name: string;
    status: string;
    roles: { id: string; name: string; systemKey: string | null }[];
  };
}> {
  const res = await request(app, {
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie },
    payload: {
      businessId: input.businessId ?? unique('biz'),
      username: input.username ?? unique('user'),
      name: input.name ?? '测试账户',
      password: input.password ?? 'test-password-123',
      restore: input.restore ?? false,
      ...(input.roleIds === undefined ? {} : { roleIds: input.roleIds }),
    },
  });
  return { res, statusCode: res.statusCode, body: res.body, account: res.json() };
}

type Matrix = { revision: number; roles: Role[] };

/** 角色矩阵是全局 revision；并行测试按 409 重读后重试，不放松服务端原子性。 */
export async function mutateMatrix(
  app: TestApp,
  cookie: string,
  transform: (current: Matrix) => {
    id?: string;
    name: string;
    grants: { permissionId: PermissionId; scope: AccessScope }[];
  }[],
): Promise<Matrix> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await request(app, {
      method: 'GET',
      url: '/api/roles',
      headers: { cookie },
    });
    expect(current.statusCode, current.body).toBe(200);
    const matrix = current.json<Matrix>();
    const res = await request(app, {
      method: 'PUT',
      url: '/api/roles',
      headers: { cookie },
      payload: {
        expectedRevision: matrix.revision,
        roles: transform(matrix),
      },
    });
    if (res.statusCode === 409) continue;
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Matrix>();
  }
  throw new Error('role matrix stayed stale after retries');
}

export async function createRole(
  app: TestApp,
  cookie: string,
  name: string,
  grants: { permissionId: PermissionId; scope: AccessScope }[],
): Promise<Role> {
  const updated = await mutateMatrix(app, cookie, (matrix) => [
    ...matrix.roles.map((role) => ({
      id: role.id,
      name: role.name,
      grants: role.grants,
    })),
    { name, grants },
  ]);
  const role = updated.roles.find((entry) => entry.name === name);
  if (!role) throw new Error(`role ${name} not created`);
  return role;
}

export function grants(...values: [PermissionId, AccessScope][]): PermissionGrant[] {
  return values.map(([permissionId, scope]) => ({ permissionId, scope }));
}

export function expectProblem(res: TestResponse, code: ErrorCode): Problem {
  const body = problemSchema.parse(res.json());
  expect(res.statusCode).toBe(errorCode[code]);
  expect(body).toMatchObject({ code, status: res.statusCode });
  return body;
}
