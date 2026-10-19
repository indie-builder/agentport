import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@agentport/db';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { AUTH_COOKIE } from '../src/features/auth/types.js';

// 每个测试文件独立后缀：并行执行时名称不会互相冲突，也不需要全局清理。
const SUFFIX = randomBytes(4).toString('hex');
let counter = 0;

/**
 * RATE_LIMIT_DISABLED=1 实际不生效（security.ts 检查的是 process.env，但同样从 env 读），
 * 而登录路由自带 10 次/分钟限额、计数落在共享 Redis 里。这里固定一个本文件专用的
 * 回环地址，让 @fastify/rate-limit 按 IP 分桶，跨文件互不干扰。
 * shortcut: 仅适用于本机注入测试，CI 并发跑同文件时仍需注意次数，超过 10 次登录会 429。
 */
const HOST_OCTET = 10 + (Number.parseInt(SUFFIX.slice(0, 2), 16) % 40);
export const INJECT_IP = `127.0.0.${HOST_OCTET}`;

/** 登录请求统一带 remoteAddress，否则所有文件共用 127.0.0.1 的额度。 */
export function inject(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ remoteAddress: INJECT_IP, ...opts });
}

/** 合法 slug/name：小写字母、数字、- 和 _。 */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${SUFFIX}-${counter.toString(36)}`;
}

/** 工作区写到系统临时目录，避免污染仓库 data/。 */
process.env.WORKSPACES_DIR = join(tmpdir(), 'agentport-test-workspaces');

export function testConfig(): Config {
  return loadConfig(process.env);
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
  try {
    await redis.connect();
    const clients = await redis.client('LIST');
    // BullMQ worker 会以阻塞连接消费队列；存在阻塞客户端即视为有消费者。
    // BullMQ 6 用 BZPOPMIN 拉取延迟任务，不再用 BRPOP。
    return !/cmd=(blpop|brpop|bzpopmin)/i.test(clients);
  } catch {
    return true;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export const infraReady: Promise<boolean> = probeInfra(testConfig());

export const queueIdle: Promise<boolean> = probeQueueIdle(testConfig().REDIS_URL);

export async function startApp(): Promise<FastifyInstance> {
  const app = await buildApp(testConfig());
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

/** 只删本次测试创建的目标；级联会带走 tools / agent_servers / conversations。 */
export async function cleanup(
  app: FastifyInstance,
  targets: { serverNames?: string[]; agentSlugs?: string[]; runIds?: string[] },
): Promise<void> {
  const { serverNames = [], agentSlugs = [], runIds = [] } = targets;
  if (runIds.length > 0) {
    await app.pool.query('delete from agent_runs where id = any($1::text[])', [runIds]);
  }
  if (agentSlugs.length > 0) {
    await app.pool.query('delete from agents where slug = any($1::text[])', [agentSlugs]);
  }
  if (serverNames.length > 0) {
    await app.pool.query('delete from servers where name = any($1::text[])', [serverNames]);
  }
  const ids = [...serverNames, ...agentSlugs, ...runIds];
  if (ids.length > 0) {
    await app.pool.query('delete from audit_log where target = any($1::text[])', [ids]);
  }
}
