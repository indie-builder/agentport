import { sql } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { collectMetrics } from '../plugins/metrics.js';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ status: 'ok' }));

  // 本机运维读取，无鉴权；单项依赖失败时该字段返回 null。
  app.get('/health/metrics', async () => collectMetrics(app));

  app.get('/health/ready', async (_request, reply) => {
    const checks = { db: 'ok' as 'ok' | 'error', redis: 'ok' as 'ok' | 'error' };
    try {
      await app.db.execute(sql`select 1`);
    } catch (err) {
      app.log.error({ err }, 'readiness: db check failed');
      checks.db = 'error';
    }
    try {
      const redis = new (await import('ioredis')).Redis(app.config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      await redis.connect();
      await redis.ping();
      await redis.quit();
    } catch (err) {
      app.log.error({ err }, 'readiness: redis check failed');
      checks.redis = 'error';
    }
    const ok = checks.db === 'ok' && checks.redis === 'ok';
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', ...checks });
  });
}
