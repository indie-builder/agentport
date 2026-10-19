import { repo } from '@agentport/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

const querySchema = z.object({
  action: z.string().trim().max(100).optional(),
  status: z.enum(['ok', 'error', 'denied']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.iso.datetime().optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

export function registerAuditRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get('/api/audit', auth, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid query');
    const { action, status, limit, before } = parsed.data;
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
  });
}
