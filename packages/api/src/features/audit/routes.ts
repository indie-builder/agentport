import { repo } from '@agentport/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typed } from '../../types.js';

const querySchema = z.object({
  action: z.string().trim().max(100).optional(),
  status: z.enum(['ok', 'error', 'denied']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.iso.datetime().optional(),
});

export function registerAuditRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get(
    '/api/audit',
    { ...auth, schema: { querystring: querySchema } },
    async (request) => {
      const { action, status, limit, before } = request.query;
      const rows = await repo.audit.listAudit(app.db, {
        ...(action ? { action } : {}),
        ...(status ? { status } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before: new Date(before) }),
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          actor: row.actor,
          action: row.action,
          target: row.target,
          status: row.status,
          durationMs: row.durationMs,
          requestId: row.requestId,
          inputDigest: row.inputDigest,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  );
}
