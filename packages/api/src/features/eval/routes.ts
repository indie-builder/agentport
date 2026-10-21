import { newId, repo, schema } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isPgCode, reject } from '../../plugins/errors.js';
import { evalRunRateLimit } from '../../plugins/security.js';
import { getEvalQueue } from '../../queue/producer.js';
import { typed } from '../../types.js';

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
  return reject(reply, 'INVALID_INPUT', message);
}

const idParams = z.object({ id: z.string().min(1) });
const listQuery = z.object({ agentId: z.string().min(1).optional() });

export function registerEvalRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.get('/api/eval/cases', { ...auth, schema: { querystring: listQuery } }, async (request) =>
    evalRepo.listCases(app.db, request.query.agentId),
  );

  app.post(
    '/api/eval/cases',
    { ...auth, schema: { body: createCaseSchema } },
    async (request, reply) => {
      const input = request.body;
      if (!(await chatRepo.agentExists(app.db, input.agentId))) {
        return reject(reply, 'AGENT_NOT_FOUND', 'agent not found');
      }
      const row = await evalRepo.createCase(app.db, newId('evalCase'), input);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.created',
        target: row.id,
        input: { agentId: input.agentId, name: input.name },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    '/api/eval/cases/:id',
    { ...auth, schema: { params: idParams, body: patchCaseSchema } },
    async (request, reply) => {
      const row = await evalRepo.updateCase(app.db, request.params.id, request.body);
      if (!row) return reject(reply, 'NOT_FOUND', 'case not found');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.updated',
        target: request.params.id,
        input: { fields: Object.keys(request.body) },
        status: 'ok',
        requestId: request.id,
      });
      return row;
    },
  );

  app.delete(
    '/api/eval/cases/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const deleted = await evalRepo.deleteCase(app.db, request.params.id);
      if (!deleted) return reject(reply, 'NOT_FOUND', 'case not found');
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'eval.case.deleted',
        target: request.params.id,
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/eval/runs',
    {
      ...auth,
      ...evalRunRateLimit,
      schema: { body: z.object({ agentId: z.string().min(1) }) },
    },
    async (request, reply) => {
      const { agentId } = request.body;

      const [agent] = await app.db
        .select({ id: schema.agents.id, timeoutMs: schema.agents.timeoutMs })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .limit(1);
      if (!agent) {
        return reject(reply, 'AGENT_NOT_FOUND', 'agent not found');
      }

      const cases = await evalRepo.listCases(app.db, agentId);
      if (cases.length === 0) return invalid(reply, '该智能体还没有用例');

      let evalRun: typeof schema.evalRuns.$inferSelect | undefined;
      try {
        evalRun = await app.db.transaction(async (tx) => {
          // 同一 agent 的提交跨 API 进程串行；Redis 入队不持有数据库锁。
          await tx
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(eq(schema.agents.id, agentId))
            .for('update');
          const [running] = await tx
            .select({ id: schema.evalRuns.id })
            .from(schema.evalRuns)
            .where(and(eq(schema.evalRuns.agentId, agentId), eq(schema.evalRuns.status, 'running')))
            .limit(1);
          if (running) return undefined;
          const [created] = await tx
            .insert(schema.evalRuns)
            .values({ id: newId('evalRun'), agentId, total: cases.length })
            .returning();
          return created;
        });
      } catch (err) {
        if (!isPgCode(err, '23505')) throw err;
      }
      if (!evalRun) {
        return reject(reply, 'EVAL_RUN_IN_PROGRESS', '该智能体已有正在运行的评估');
      }

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

  app.get('/api/eval/runs', { ...auth, schema: { querystring: listQuery } }, async (request) =>
    evalRepo.listRuns(app.db, request.query.agentId),
  );

  app.get(
    '/api/eval/runs/:id',
    { ...auth, schema: { params: idParams } },
    async (request, reply) => {
      const detail = await evalRepo.getRunDetail(app.db, request.params.id);
      if (!detail) return reject(reply, 'NOT_FOUND', 'eval run not found');
      return detail;
    },
  );
}
