import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb } from '@agentport/db';
import {
  type ErrorCode,
  errorCode,
  type Problem,
  problemSchema,
  RUNS_QUEUE,
  runEventsConnectionName,
  type Server,
} from '@agentport/shared';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { AUTH_COOKIE } from '../src/features/auth/types.js';

// 每个测试文件独立后缀：并行执行时名称不会互相冲突，也不需要全局清理。
const SUFFIX = randomBytes(4).toString('hex');
let counter = 0;

export function inject(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

/** ZIP 导出/导入是二进制接口：直接发字节并声明 application/zip。 */
export function injectZip(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  cookie: string,
  payload?: Buffer,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: payload === undefined ? { cookie } : { cookie, 'content-type': 'application/zip' },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** 合法 slug/name：小写字母、数字、- 和 _。 */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${SUFFIX}-${counter.toString(36)}`;
}

/** 工作区写到系统临时目录，避免污染仓库 data/。 */
process.env.WORKSPACES_DIR = join(tmpdir(), 'agentport-test-workspaces');

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({ ...process.env, ...overrides });
}

/** Postgres 与 Redis 都可用才跑集成测试；否则整个 describe 跳过。 */
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

/**
 * 队列里有活跃消费者会让集成测试的 run 被真实 worker 跑掉，导致状态断言失败。
 * 这里检测 agent-runs 是否有 active/waiting 的 worker，有则提示。
 */
async function probeQueueIdle(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // CLIENT LIST 是实例级的，不受库号隔离；只看本测试库里 agent-runs 的连接：
  // 开发库上常驻的 worker 会让整组用例误判，同轮其他测试起的 worker 也不该算进来。
  const db = new URL(redisUrl).pathname.replace('/', '') || '0';
  // BullMQ 用 CLIENT SETNAME 标记归属：`bull:<base64(队列名)>`，具名 worker 追加 `:w:`。
  const ownedBy = `name=bull:${Buffer.from(RUNS_QUEUE).toString('base64')}`;
  try {
    await redis.connect();
    const clients = await redis.client('LIST');
    // BullMQ worker 会以阻塞连接消费队列；存在阻塞客户端即视为有消费者。
    // BullMQ 6 用 BZPOPMIN 拉取延迟任务，不再用 BRPOP。
    return !clients
      .split('\n')
      .filter((line) => line.includes(` db=${db} `) && line.includes(ownedBy))
      .some((line) => /cmd=(blpop|brpop|bzpopmin)/i.test(line));
  } catch {
    return true;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export const infraReady: Promise<boolean> = probeInfra(testConfig());

export const queueIdle: Promise<boolean> = probeQueueIdle(testConfig().REDIS_URL);

export async function startApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides));
  // 让 cookie/jwt 等插件在第一个 inject 前完成 boot。
  await app.ready();
  return app;
}

export async function loginCookie(app: FastifyInstance): Promise<string> {
  const config = testConfig();
  const res = await inject(app, {
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: config.ADMIN_USER, password: config.ADMIN_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === AUTH_COOKIE);
  if (!cookie) throw new Error('login did not set the auth cookie');
  return `${cookie.name}=${cookie.value}`;
}

interface CreateAgentOptions {
  slug?: string;
  serverIds?: string[];
  skillIds?: string[];
  subAgentIds?: string[];
  /** 把 slug 记进调用方的清理数组。 */
  track?: string[];
  /** 预期状态码，默认 201；用于重复 slug 之类的拒绝路径。 */
  expectStatus?: number;
}

export async function createAgent(
  app: FastifyInstance,
  cookie: string,
  options: CreateAgentOptions = {},
): Promise<LightMyRequestResponse> {
  const slug = options.slug ?? unique('agent');
  options.track?.push(slug);
  const res = await inject(app, {
    method: 'POST',
    url: '/api/agents',
    headers: { cookie },
    payload: {
      slug,
      name: `Agent ${slug}`,
      systemPrompt: 'You are helpful.',
      ...(options.serverIds === undefined ? {} : { serverIds: options.serverIds }),
      ...(options.skillIds === undefined ? {} : { skillIds: options.skillIds }),
      ...(options.subAgentIds === undefined ? {} : { subAgentIds: options.subAgentIds }),
    },
  });
  expect(res.statusCode, res.body).toBe(options.expectStatus ?? 201);
  return res;
}

/** 只有 generated server 需要工厂：测试里它是最常见的类型。 */
export async function createServer(
  app: FastifyInstance,
  cookie: string,
  options: { name?: string; baseUrl?: string; track?: string[] } = {},
): Promise<Server> {
  const name = options.name ?? unique('server');
  options.track?.push(name);
  const res = await inject(app, {
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name,
      kind: 'generated',
      baseUrl: options.baseUrl ?? 'https://jsonplaceholder.typicode.com',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Server>();
}

/**
 * 直接落一条 run（含所属会话），跳过 /api/chat：用于验证从 run 出发的读路径。
 * mcpTokenHash 同时写入有效期，供 per-run token 的用例使用。
 */
export async function seedRun(
  app: FastifyInstance,
  agentId: string,
  options: { runId?: string; conversationId?: string; mcpTokenHash?: string } = {},
): Promise<{ runId: string; conversationId: string }> {
  const runId = options.runId ?? unique('seed-run');
  const conversationId = options.conversationId ?? unique('seed-conv');
  await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
    conversationId,
    agentId,
  ]);
  await app.pool.query(
    'insert into agent_runs (id, conversation_id, agent_id, status, mcp_token_hash, mcp_token_expires_at) values ($1, $2, $3, $4, $5, $6)',
    [
      runId,
      conversationId,
      agentId,
      'running',
      options.mcpTokenHash ?? null,
      options.mcpTokenHash === undefined ? null : new Date(Date.now() + 5 * 60_000),
    ],
  );
  return { runId, conversationId };
}

/** 断言响应体是完整 Problem，且 code 与 HTTP 状态一致。 */
export function expectProblem(res: LightMyRequestResponse, code: ErrorCode): Problem {
  const body = problemSchema.parse(res.json());
  expect(res.statusCode).toBe(errorCode[code]);
  expect(body).toMatchObject({ code, status: res.statusCode });
  return body;
}

/** 轮询到条件成立；SSE 订阅/退订是异步的，不能立即断言。 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return false;
}

/** 用独立连接数某个 run 的阻塞事件跟随者；连接名由 producer 设置。 */
export async function eventFollowerCount(redis: Redis, runId: string): Promise<number> {
  const name = `name=${runEventsConnectionName(runId)}`;
  const list = await redis.client('LIST');
  return list.split('\n').filter((line) => line.includes(`${name} `) || line.endsWith(name)).length;
}

/** 只删本次测试创建的目标；级联会带走 tools / agent_servers / conversations。 */
export async function cleanup(
  app: FastifyInstance,
  targets: {
    serverNames?: string[];
    agentSlugs?: string[];
    skillSlugs?: string[];
    runIds?: string[];
  },
): Promise<void> {
  const { serverNames = [], agentSlugs = [], skillSlugs = [], runIds = [] } = targets;
  if (runIds.length > 0) {
    await app.pool.query('delete from agent_runs where id = any($1::text[])', [runIds]);
  }
  if (agentSlugs.length > 0) {
    await app.pool.query('delete from agents where slug = any($1::text[])', [agentSlugs]);
  }
  if (skillSlugs.length > 0) {
    await app.pool.query('delete from skills where slug = any($1::text[])', [skillSlugs]);
  }
  if (serverNames.length > 0) {
    await app.pool.query('delete from servers where name = any($1::text[])', [serverNames]);
  }
  const ids = [...serverNames, ...agentSlugs, ...skillSlugs, ...runIds];
  if (ids.length > 0) {
    await app.pool.query('delete from audit_log where target = any($1::text[])', [ids]);
  }
}
