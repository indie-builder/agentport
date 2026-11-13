import { RedisClient, version } from 'bun';
import { sql } from 'drizzle-orm';
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
  oldestWaitingMs: number | null;
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

let redisClient: RedisClient | null = null;

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
  getWaiting: (start: number, end: number) => Promise<{ timestamp: number }[]>;
}): Promise<QueueCounts> {
  const [counts, waiting] = await Promise.all([
    queue.getJobCounts(...JOB_STATES),
    queue.getWaiting(0, 0).catch(() => []),
  ]);
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    oldestWaitingMs: waiting[0] === undefined ? null : Date.now() - waiting[0].timestamp,
  };
}

async function collectMetrics(deps: AppContext): Promise<HealthMetrics> {
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

function getRedisClient(url: string): RedisClient {
  redisClient ??= new RedisClient(url, { connectionTimeout: CHECK_TIMEOUT_MS });
  return redisClient;
}

async function pingRedis(deps: AppContext): Promise<number> {
  const client = getRedisClient(deps.config.REDIS_URL);
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
  } catch (err) {
    if (redisClient === client) {
      client.close();
      redisClient = null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function closeHealth(): void {
  redisClient?.close();
  redisClient = null;
}

export function registerHealthHttp(app: Hono<HttpEnv>): void {
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
