import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { getKnowledgeQueue, getQueue } from '../queue/producer.js';

interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface HealthMetrics {
  process: { uptimeSeconds: number; memoryRssBytes: number; nodeVersion: string };
  queue: QueueCounts | null;
  /** 知识任务与聊天 run 分开消费，单独暴露五态。 */
  knowledgeQueue: QueueCounts | null;
  db: { total: number; idle: number; waiting: number };
  redis: { pingMs: number } | null;
}

const SLOW_REQUEST_MS = 2_000;
// BullMQ 的 Redis 客户端会无限重连，必须给指标探测加超时，否则端点会一直挂着。
const CHECK_TIMEOUT_MS = 1_500;
const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

let redis: Redis | undefined;

function metricsRedis(app: FastifyInstance): Redis {
  if (!redis) {
    redis = new Redis(app.config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    redis.on('error', (err: Error) => app.log.warn({ err }, 'metrics: redis error'));
  }
  return redis;
}

async function attempt<T>(
  app: FastifyInstance,
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref();
    });
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    app.log.warn({ err }, `metrics: ${name} unavailable`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerMetrics(app: FastifyInstance): void {
  // 关掉 Fastify 内置请求日志（原始 URL 基数高），统一在这里按路由模板记录。
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    const route = request.routeOptions.url || 'unmatched';
    const responseTime = Math.round(reply.elapsedTime);
    // SSE 的响应耗时等于整段运行时长，对它打慢请求没有意义。
    const streaming = String(reply.getHeader('content-type') ?? '').includes('text/event-stream');
    if (!streaming && responseTime > SLOW_REQUEST_MS) {
      request.log.warn({ route, statusCode: reply.statusCode, responseTime }, 'slow request');
      return;
    }
    request.log.info({ route, statusCode: reply.statusCode, responseTime }, 'request completed');
  });

  app.addHook('onClose', async () => {
    redis?.disconnect();
    redis = undefined;
  });
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

/** 每项独立降级：外部依赖不可用时返回 null，调用方仍拿到 200。 */
export async function collectMetrics(app: FastifyInstance): Promise<HealthMetrics> {
  const queue = await attempt(app, 'queue', () => jobCounts(getQueue()));

  const knowledgeQueue = await attempt(app, 'knowledge queue', () =>
    jobCounts(getKnowledgeQueue()),
  );

  const redisPing = await attempt(app, 'redis', async () => {
    const started = performance.now();
    await metricsRedis(app).ping();
    return { pingMs: Math.round(performance.now() - started) };
  });

  return {
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssBytes: process.memoryUsage().rss,
      nodeVersion: process.version,
    },
    queue,
    knowledgeQueue,
    db: {
      total: app.pool.totalCount,
      idle: app.pool.idleCount,
      waiting: app.pool.waitingCount,
    },
    redis: redisPing,
  };
}

/** 共享 Redis 客户端的 ping；health/ready 与 metrics 共用，避免每请求建连。 */
export async function pingRedis(app: FastifyInstance): Promise<number> {
  const client = metricsRedis(app);
  if (client.status === 'wait') await client.connect();
  const started = Date.now();
  await client.ping();
  return Date.now() - started;
}
