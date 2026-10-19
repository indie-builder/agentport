import { sql } from '@agentport/db';
import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'degraded', db: 'error' });
    }
  });
}
