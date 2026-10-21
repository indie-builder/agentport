import { sql } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { collectMetrics } from '../plugins/metrics.js';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ status: 'ok' }));

  // 运维指标需登录；单项依赖失败时该字段返回 null。
  app.get('/health/metrics', { preHandler: [app.requireAuth] }, async () => collectMetrics(app));

  app.get('/health/ready', async (_request, reply) => {
    const checks = { db: 'ok' as 'ok' | 'error', redis: 'ok' as 'ok' | 'error' };
    try {
      await app.db.execute(sql`select 1`);
    } catch (err) {
      app.log.error({ err }, 'readiness: db check failed');
      checks.db = 'error';
    }
    try {
      // 复用 metrics 的共享客户端：每个请求新建连接会造成连接风暴。
      const { pingRedis } = await import('../plugins/metrics.js');
      await pingRedis(app);
    } catch (err) {
      app.log.error({ err }, 'readiness: redis check failed');
      checks.redis = 'error';
    }
    const ok = checks.db === 'ok' && checks.redis === 'ok';
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', ...checks });
  });
}
