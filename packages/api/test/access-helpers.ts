import { randomBytes } from 'node:crypto';
import { createDb } from '@agentport/db';
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
import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Redis } from 'ioredis';
import { expect } from 'vitest';
import { type Config, loadConfig } from '../src/config.js';
import { registerAccountRoutes } from '../src/features/auth/accounts.js';
import { registerAuth } from '../src/features/auth/routes.js';
import { AUTH_COOKIE } from '../src/features/auth/types.js';
import { registerAccess } from '../src/plugins/access.js';
import { registerErrorHandler } from '../src/plugins/errors.js';

const SUFFIX = randomBytes(4).toString('hex');
let counter = 0;

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({ ...process.env, ...overrides });
}

export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${SUFFIX}-${counter.toString(36)}`;
}

async function probeInfra(config: Config): Promise<boolean> {
  const { pool } = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await pool.query('select 1');
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

export const infraReady: Promise<boolean> = probeInfra(testConfig());

/**
 * 只注册认证/授权/账户角色路由的最小 app：其他领域路由尚未声明 config.access 时，
 * 全量 app 会被 onRoute 校验拒绝，本单元用最小 app 独立验证。
 */
export async function startAccessApp(
  overrides: Partial<Record<string, string>> = {},
  extend?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const config = testConfig(overrides);
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { db, pool } = createDb(config.DATABASE_URL);
  app.decorate('db', db);
  app.decorate('pool', pool);
  app.decorate('config', config);
  app.addHook('onClose', async () => {
    await pool.end();
  });

  registerErrorHandler(app);
  registerAccess(app);
  await registerAuth(app);
  registerAccountRoutes(app);
  extend?.(app);
  await app.ready();
  return app;
}

export function inject(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

export function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((entry) => entry.name === AUTH_COOKIE);
  if (!cookie?.value) throw new Error(`no auth cookie in response: ${res.statusCode} ${res.body}`);
  return `${cookie.name}=${cookie.value}`;
}

export function login(
  app: FastifyInstance,
  username: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return inject(app, {
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { username, password },
  });
}

export async function adminCookie(app: FastifyInstance): Promise<string> {
  const config = testConfig();
  const res = await login(app, config.ADMIN_USER, config.ADMIN_PASSWORD);
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

export async function createAccount(
  app: FastifyInstance,
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
  res: LightMyRequestResponse;
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
  const res = await inject(app, {
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

export async function roleIdBySystemKey(
  app: FastifyInstance,
  cookie: string,
  systemKey: NonNullable<Role['systemKey']>,
): Promise<string> {
  const res = await inject(app, { method: 'GET', url: '/api/roles', headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  const matrix = res.json<{ roles: Role[] }>();
  const role = matrix.roles.find((entry) => entry.systemKey === systemKey);
  if (!role) throw new Error(`role ${systemKey} not found`);
  return role.id;
}

type Matrix = { revision: number; roles: Role[] };

/** 角色矩阵是全局 revision；并行测试按 409 重读后重试，不放松服务端原子性。 */
export async function mutateMatrix(
  app: FastifyInstance,
  cookie: string,
  transform: (current: Matrix) => {
    id?: string;
    name: string;
    grants: { permissionId: PermissionId; scope: AccessScope }[];
  }[],
): Promise<Matrix> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await inject(app, { method: 'GET', url: '/api/roles', headers: { cookie } });
    expect(current.statusCode, current.body).toBe(200);
    const matrix = current.json<Matrix>();
    const res = await inject(app, {
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
  app: FastifyInstance,
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

export function expectProblem(res: LightMyRequestResponse, code: ErrorCode): Problem {
  const body = problemSchema.parse(res.json());
  expect(res.statusCode).toBe(errorCode[code]);
  expect(body).toMatchObject({ code, status: res.statusCode });
  return body;
}
