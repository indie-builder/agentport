import { newId, repo, schema } from '@agentport/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { getQueue } from '../../queue/producer.js';

const limits = { off: process.env.RATE_LIMIT_DISABLED === '1' };

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

const POLL_MS = 500;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timeout'];

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

/** 最小判定：expectation 非空则大小写不敏感包含；为空则只要求有文本。 */
export function judge(output: string, expectation: string): boolean {
  if (expectation.trim().length === 0) return output.trim().length > 0;
  return output.toLowerCase().includes(expectation.trim().toLowerCase());
}

function assistantText(messages: Awaited<ReturnType<typeof chatRepo.listMessages>>): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => {
      const content = message.content;
      if (typeof content === 'object' && content !== null && 'text' in content) {
        return typeof content.text === 'string' ? content.text : '';
      }
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** 发起一次普通 agent run 并等到终态，返回最终 assistant 文本；失败抛错。 */
async function runOneCase(
  app: FastifyInstance,
  input: { agentId: string; prompt: string; timeoutMs: number; title: string },
): Promise<{ runId: string; output: string }> {
  const conversation = await chatRepo.createConversation(app.db, {
    id: newId('conversation'),
    agentId: input.agentId,
    title: input.title,
  });
  const run = await chatRepo.createRun(app.db, {
    id: newId('run'),
    conversationId: conversation.id,
    agentId: input.agentId,
  });
  await chatRepo.appendMessage(app.db, {
    id: newId('message'),
    conversationId: conversation.id,
    role: 'user',
    content: { type: 'text', text: input.prompt },
    runId: run.id,
  });
  await getQueue().add(
    'run',
    {
      runId: run.id,
      agentId: input.agentId,
      conversationId: conversation.id,
      prompt: input.prompt,
    },
    { jobId: run.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
  );

  const deadline = Date.now() + Math.min(input.timeoutMs, 30 * 60_000);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const current = await chatRepo.getRun(app.db, run.id);
    if (!current) throw new Error('run disappeared');
    if (TERMINAL.includes(current.status)) {
      if (current.status !== 'succeeded') {
        throw new Error(
          `run ended with ${current.status}${current.error ? `: ${current.error}` : ''}`,
        );
      }
      break;
    }
    if (Date.now() >= deadline) throw new Error('run timed out');
  }

  const messages = await chatRepo.listMessages(app.db, conversation.id);
  return { runId: run.id, output: assistantText(messages) };
}

/** 后台串行跑批：单个 case 出错只记录该条失败，不中断后续 case。 */
async function executeEvalRun(
  app: FastifyInstance,
  input: {
    evalRunId: string;
    agentId: string;
    timeoutMs: number;
    cases: Awaited<ReturnType<typeof evalRepo.listCases>>;
  },
): Promise<void> {
  let passed = 0;
  let crashed: string | null = null;

  try {
    for (const testCase of input.cases) {
      let output = '';
      let runId = '';
      let ok = false;
      try {
        const result = await runOneCase(app, {
          agentId: input.agentId,
          prompt: testCase.prompt,
          timeoutMs: input.timeoutMs,
          title: `eval: ${testCase.name}`.slice(0, 80),
        });
        runId = result.runId;
        output = result.output;
        ok = judge(output, testCase.expectation);
      } catch (err) {
        output = err instanceof Error ? err.message : String(err);
      }
      if (ok) passed += 1;
      try {
        await evalRepo.addResult(app.db, {
          id: newId('evalResult'),
          evalRunId: input.evalRunId,
          caseId: testCase.id,
          runId,
          passed: ok,
          output,
        });
      } catch (err) {
        app.log.error(
          { err, evalRunId: input.evalRunId, caseId: testCase.id },
          'eval result write failed',
        );
      }
    }
  } catch (err) {
    crashed = err instanceof Error ? err.message : String(err);
    app.log.error({ err, evalRunId: input.evalRunId }, 'eval run crashed');
  }

  try {
    await evalRepo.finishEvalRun(app.db, input.evalRunId, {
      status: crashed === null && passed === input.cases.length ? 'succeeded' : 'failed',
      passed,
    });
  } catch (err) {
    app.log.error({ err, evalRunId: input.evalRunId }, 'eval run finalize failed');
  }
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

      // 不 await：请求立即返回 202，跑批在进程内串行继续。
      void executeEvalRun(app, {
        evalRunId: evalRun.id,
        agentId,
        timeoutMs: agent.timeoutMs,
        cases,
      });

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
