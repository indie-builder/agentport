import { newId, repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { getEvalQueue } from '../../queue/producer.js';

const limits = { off: process.env.RATE_LIMIT_DISABLED === '1' };

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

const createCaseSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(1).max(128),
  prompt: z.string().min(1).max(20_000),
  expectation: z.string().max(5_000).default(''),
});

const patchCaseSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  expectation: z.string().max(5_000).optional(),
});

function invalid(reply: FastifyReply, message: string) {
  return reply.status(400).send({ code: 'INVALID_INPUT', message });
}

export function registerEvalRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [app.requireAuth] };

  app.get<{ Querystring: { agentId?: string } }>('/api/eval/cases', auth, async (request) =>
    evalRepo.listCases(app.db, request.query.agentId),
  );

  app.post('/api/eval/cases', auth, async (request, reply) => {
    const parsed = createCaseSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    if (!(await chatRepo.agentExists(app.db, parsed.data.agentId))) {
      return reply.status(404).send({ code: 'AGENT_NOT_FOUND', message: 'agent not found' });
    }
    const row = await evalRepo.createCase(app.db, newId('evalCase'), parsed.data);
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: 'eval.case.created',
      target: row.id,
      input: { agentId: parsed.data.agentId, name: parsed.data.name },
      status: 'ok',
      requestId: request.id,
    });
    return reply.status(201).send(row);
  });

  app.patch<{ Params: { id: string } }>('/api/eval/cases/:id', auth, async (request, reply) => {
    const parsed = patchCaseSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    const row = await evalRepo.updateCase(app.db, request.params.id, parsed.data);
    if (!row) return reply.status(404).send({ code: 'NOT_FOUND', message: 'case not found' });
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: 'eval.case.updated',
      target: request.params.id,
      input: { fields: Object.keys(parsed.data) },
      status: 'ok',
      requestId: request.id,
    });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/api/eval/cases/:id', auth, async (request, reply) => {
    const deleted = await evalRepo.deleteCase(app.db, request.params.id);
    if (!deleted) return reply.status(404).send({ code: 'NOT_FOUND', message: 'case not found' });
    await writeAudit(app.db, request.log, {
      actor: 'admin',
      action: 'eval.case.deleted',
      target: request.params.id,
      status: 'ok',
      requestId: request.id,
    });
    return reply.status(204).send();
  });

  app.post(
    '/api/eval/runs',
    { ...auth, config: limits.off ? {} : { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({ agentId: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? 'invalid body');
      const { agentId } = parsed.data;

      const [agent] = await app.db
        .select({ id: schema.agents.id, timeoutMs: schema.agents.timeoutMs })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) {
        return reply.status(404).send({ code: 'AGENT_NOT_FOUND', message: 'agent not found' });
      }

      if (await evalRepo.hasRunningRun(app.db, agentId)) {
        return reply
          .status(409)
          .send({ code: 'EVAL_RUN_IN_PROGRESS', message: '该智能体已有正在运行的评估' });
      }

      const cases = await evalRepo.listCases(app.db, agentId);
      if (cases.length === 0) return invalid(reply, '该智能体还没有用例');

      const evalRun = await evalRepo.createEvalRun(app.db, {
        id: newId('evalRun'),
        agentId,
        total: cases.length,
      });

      // 执行搬到 worker：API 重启不再让跑批停在 running。
      await getEvalQueue().add('eval-run', { evalRunId: evalRun.id }, { jobId: evalRun.id });

      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.run.requested',
        target: evalRun.id,
        input: { agentId, total: cases.length },
        status: 'ok',
        requestId: request.id,
      });

      return reply.status(202).send({ evalRunId: evalRun.id });
    },
  );

  app.get<{ Querystring: { agentId?: string } }>('/api/eval/runs', auth, async (request) =>
    evalRepo.listRuns(app.db, request.query.agentId),
  );

  app.get<{ Params: { id: string } }>('/api/eval/runs/:id', auth, async (request, reply) => {
    const detail = await evalRepo.getRunDetail(app.db, request.params.id);
    if (!detail)
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'eval run not found' });
    return detail;
  });
}
