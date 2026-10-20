import { Clock, ClockLive, DbError, runProgram } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import { judge } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Result } from 'effect';
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

function errorMessage(error: unknown): string {
  return error instanceof Error || error instanceof DbError ? error.message : String(error);
}

function dbQuery<A>(run: () => Promise<A>): Effect.Effect<A, DbError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DbError(errorMessage(cause), cause),
  });
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

/** 发起一次普通 agent run 并等到终态，返回最终 assistant 文本。 */
function runOneCase(
  db: Database,
  redisUrl: string,
  input: { agentId: string; prompt: string; timeoutMs: number; title: string },
) {
  return Effect.gen(function* () {
    const clock = yield* Clock;
    const conversation = yield* dbQuery(() =>
      chatRepo.createConversation(db, {
        id: newId('conversation'),
        agentId: input.agentId,
        title: input.title,
      }),
    );
    const run = yield* dbQuery(() =>
      chatRepo.createRun(db, {
        id: newId('run'),
        conversationId: conversation.id,
        agentId: input.agentId,
      }),
    );
    yield* dbQuery(() =>
      chatRepo.appendMessage(db, {
        id: newId('message'),
        conversationId: conversation.id,
        role: 'user',
        content: { type: 'text', text: input.prompt },
        runId: run.id,
      }),
    );
    yield* Effect.tryPromise({
      try: () =>
        getRunQueue(redisUrl).add(
          'run',
          {
            runId: run.id,
            agentId: input.agentId,
            conversationId: conversation.id,
            prompt: input.prompt,
          },
          { jobId: run.id, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
        ),
      catch: (cause) => new Error(errorMessage(cause)),
    });

    const deadline = (yield* clock.now()) + Math.min(input.timeoutMs, 30 * 60_000);
    for (;;) {
      yield* clock.sleep(POLL_MS);
      const current = yield* dbQuery(() => chatRepo.getRun(db, run.id));
      if (!current) return yield* Effect.fail(new Error('run disappeared'));
      if (TERMINAL.includes(current.status)) {
        if (current.status !== 'succeeded') {
          return yield* Effect.fail(
            new Error(
              `run ended with ${current.status}${current.error ? `: ${current.error}` : ''}`,
            ),
          );
        }
        break;
      }
      if ((yield* clock.now()) >= deadline) {
        return yield* Effect.fail(new Error('run timed out'));
      }
    }

    const messages = yield* dbQuery(() => chatRepo.listMessages(db, conversation.id));
    return { runId: run.id, output: assistantText(messages) };
  });
}

/** 串行跑批：单个 case 出错只记录该条失败，不中断后续 case。 */
export async function executeEvalRun(input: {
  db: Database;
  logger: Logger;
  redisUrl: string;
  evalRunId: string;
}): Promise<void> {
  const { db, logger, redisUrl, evalRunId } = input;
  const program = Effect.gen(function* () {
    const evalRun = yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId));
    // 已结束（被取消或被恢复逻辑收敛）的跑批不重跑。
    if (evalRun?.status !== 'running') {
      logger.info({ evalRunId }, 'eval run no longer running, skipping');
      return;
    }

    const [agent] = yield* dbQuery(async () =>
      db
        .select({ timeoutMs: schema.agents.timeoutMs })
        .from(schema.agents)
        .where(eq(schema.agents.id, evalRun.agentId))
        .limit(1),
    );
    if (!agent) return yield* Effect.fail(new Error(`agent ${evalRun.agentId} not found`));

    const cases = yield* dbQuery(() => evalRepo.listCases(db, evalRun.agentId));
    let passed = 0;
    let crashed: string | null = null;

    yield* Effect.forEach(
      cases,
      (testCase) =>
        Effect.gen(function* () {
          let output = '';
          let runId = '';
          let ok = false;
          // Effect v4 的 result 对应 v3 的 either，保留每条成功或失败。
          const result = yield* Effect.result(
            runOneCase(db, redisUrl, {
              agentId: evalRun.agentId,
              prompt: testCase.prompt,
              timeoutMs: agent.timeoutMs,
              title: `eval: ${testCase.name}`.slice(0, 80),
            }).pipe(
              Effect.flatMap((result) =>
                Effect.try({
                  try: () => {
                    runId = result.runId;
                    output = result.output;
                    return judge(output, testCase.expectation);
                  },
                  catch: (cause) => new Error(errorMessage(cause)),
                }),
              ),
            ),
          );
          if (Result.isSuccess(result)) ok = result.success;
          else output = errorMessage(result.failure);
          if (ok) passed += 1;

          yield* Effect.gen(function* () {
            yield* dbQuery(() =>
              evalRepo.addResult(db, {
                id: newId('evalResult'),
                evalRunId,
                caseId: testCase.id,
                runId,
                passed: ok,
                output,
              }),
            );
            yield* dbQuery(() => evalRepo.updateProgress(db, evalRunId, passed));
          }).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                logger.error({ err, evalRunId, caseId: testCase.id }, 'eval result write failed');
              }),
            ),
          );
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const err = Cause.squash(cause);
          crashed = errorMessage(err);
          logger.error({ err, evalRunId }, 'eval run crashed');
        }),
      ),
    );

    yield* dbQuery(() =>
      evalRepo.finishEvalRun(db, evalRunId, {
        status: crashed === null && passed === cases.length ? 'succeeded' : 'failed',
        passed,
        error: crashed,
      }),
    ).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          logger.error({ err, evalRunId }, 'eval run finalize failed');
        }),
      ),
    );
  });
  await runProgram(program.pipe(Effect.provide(ClockLive)));
}
