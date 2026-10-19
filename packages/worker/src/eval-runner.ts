import { type Database, newId, repo, schema } from '@agentport/db';
import { judge } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

const POLL_MS = 500;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timeout'];

let runQueue: Queue | undefined;

function getRunQueue(redisUrl: string): Queue {
  if (!runQueue) runQueue = new Queue('agent-runs', { connection: { url: redisUrl } });
  return runQueue;
}

export async function closeEvalRunQueue(): Promise<void> {
  await runQueue?.close();
  runQueue = undefined;
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
  db: Database,
  redisUrl: string,
  input: { agentId: string; prompt: string; timeoutMs: number; title: string },
): Promise<{ runId: string; output: string }> {
  const conversation = await chatRepo.createConversation(db, {
    id: newId('conversation'),
    agentId: input.agentId,
    title: input.title,
  });
  const run = await chatRepo.createRun(db, {
    id: newId('run'),
    conversationId: conversation.id,
    agentId: input.agentId,
  });
  await chatRepo.appendMessage(db, {
    id: newId('message'),
    conversationId: conversation.id,
    role: 'user',
    content: { type: 'text', text: input.prompt },
    runId: run.id,
  });
  await getRunQueue(redisUrl).add(
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
    const current = await chatRepo.getRun(db, run.id);
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

  const messages = await chatRepo.listMessages(db, conversation.id);
  return { runId: run.id, output: assistantText(messages) };
}

/** 串行跑批：单个 case 出错只记录该条失败，不中断后续 case。 */
export async function executeEvalRun(input: {
  db: Database;
  logger: Logger;
  redisUrl: string;
  evalRunId: string;
}): Promise<void> {
  const { db, logger, redisUrl, evalRunId } = input;
  const evalRun = await evalRepo.getEvalRun(db, evalRunId);
  // 已结束（被取消或被恢复逻辑收敛）的跑批不重跑。
  if (evalRun?.status !== 'running') {
    logger.info({ evalRunId }, 'eval run no longer running, skipping');
    return;
  }

  const [agent] = await db
    .select({ timeoutMs: schema.agents.timeoutMs })
    .from(schema.agents)
    .where(eq(schema.agents.id, evalRun.agentId))
    .limit(1);
  if (!agent) throw new Error(`agent ${evalRun.agentId} not found`);

  const cases = await evalRepo.listCases(db, evalRun.agentId);
  let passed = 0;
  let crashed: string | null = null;

  try {
    for (const testCase of cases) {
      let output = '';
      let runId = '';
      let ok = false;
      try {
        const result = await runOneCase(db, redisUrl, {
          agentId: evalRun.agentId,
          prompt: testCase.prompt,
          timeoutMs: agent.timeoutMs,
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
        await evalRepo.addResult(db, {
          id: newId('evalResult'),
          evalRunId,
          caseId: testCase.id,
          runId,
          passed: ok,
          output,
        });
        await evalRepo.updateProgress(db, evalRunId, passed);
      } catch (err) {
        logger.error({ err, evalRunId, caseId: testCase.id }, 'eval result write failed');
      }
    }
  } catch (err) {
    crashed = err instanceof Error ? err.message : String(err);
    logger.error({ err, evalRunId }, 'eval run crashed');
  }

  try {
    await evalRepo.finishEvalRun(db, evalRunId, {
      status: crashed === null && passed === cases.length ? 'succeeded' : 'failed',
      passed,
      error: crashed,
    });
  } catch (err) {
    logger.error({ err, evalRunId }, 'eval run finalize failed');
  }
}
