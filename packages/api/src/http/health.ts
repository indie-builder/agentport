import { sql } from '@agentport/db';
import { RedisClient, version } from 'bun';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import { getKnowledgeQueue, getQueue } from '../queue/producer.js';
import { type AppContext, type HttpEnv, requestContext } from './context.js';
import { access } from './middleware.js';

interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface HealthMetrics {
  process: { uptimeSeconds: number; memoryRssBytes: number; bunVersion: string };
  queue: QueueCounts | null;
  knowledgeQueue: QueueCounts | null;
  db: { connected: boolean; pingMs: number | null; maxConnections: number | null };
  redis: { pingMs: number } | null;
}

const CHECK_TIMEOUT_MS = 1_500;
const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

const activeRedis = new Set<RedisClient>();

async function attempt<T>(log: Logger, name: string, fn: () => Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref();
    });
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    log.warn({ err }, `metrics: ${name} unavailable`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function jobCounts(queue: {
  getJobCounts: (...states: typeof JOB_STATES) => Promise<Record<string, number>>;
}): Promise<QueueCounts> {
  const counts = await queue.getJobCounts(...JOB_STATES);
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  };
}

export async function collectMetrics(deps: AppContext): Promise<HealthMetrics> {
  const [queue, knowledgeQueue, redisPing, dbPing] = await Promise.all([
    attempt(deps.log, 'queue', () => jobCounts(getQueue())),
    attempt(deps.log, 'knowledge queue', () => jobCounts(getKnowledgeQueue())),
    attempt(deps.log, 'redis', async () => ({ pingMs: await pingRedis(deps) })),
    attempt(deps.log, 'postgres', async () => {
      const started = performance.now();
      await deps.client`select 1`;
      return Math.round(performance.now() - started);
    }),
  ]);

  return {
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssBytes: process.memoryUsage().rss,
      bunVersion: version,
    },
    queue,
    knowledgeQueue,
    db: {
      connected: dbPing !== null,
      pingMs: dbPing,
      maxConnections: deps.client.options.max ?? null,
    },
    redis: redisPing,
  };
}

export async function pingRedis(deps: AppContext): Promise<number> {
  const client = new RedisClient(deps.config.REDIS_URL, { connectionTimeout: CHECK_TIMEOUT_MS });
  activeRedis.add(client);
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timeout')), CHECK_TIMEOUT_MS).unref();
      }),
    ]);
    return Date.now() - started;
  } finally {
    clearTimeout(timer);
    activeRedis.delete(client);
    client.close();
  }
}

export function closeHealth(): void {
  for (const client of activeRedis) client.close();
  activeRedis.clear();
}

export function registerHealthHttp(app: Hono<HttpEnv>, _deps: AppContext): void {
  app.get(
    '/health/metrics',
    access({ kind: 'permission', permissionId: 'operations.read' }),
    async (c) => {
      const context = requestContext(c);
      return c.json(await collectMetrics(context));
    },
  );

  app.get('/health/live', access({ kind: 'public', reason: 'liveness probe' }), (c) =>
    c.json({ status: 'ok' }),
  );

  app.get('/health/ready', access({ kind: 'public', reason: 'readiness probe' }), async (c) => {
    const context = requestContext(c);
    const checks = { db: 'ok' as 'ok' | 'error', redis: 'ok' as 'ok' | 'error' };
    try {
      await context.db.execute(sql`select 1`);
    } catch (err) {
      context.log.error({ err }, 'readiness: db check failed');
      checks.db = 'error';
    }
    try {
      await pingRedis(context);
    } catch (err) {
      context.log.error({ err }, 'readiness: redis check failed');
      checks.redis = 'error';
    }
    const ok = checks.db === 'ok' && checks.redis === 'ok';
    return c.json({ status: ok ? 'ok' : 'degraded', ...checks }, ok ? 200 : 503);
  });
}
