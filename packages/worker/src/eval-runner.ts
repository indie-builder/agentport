import { DbError, runProgram } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import { type AgentRunJob, judge, RUNS_QUEUE, runEnqueueOptions } from '@agentport/shared';
import { Queue, QueueEvents } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Result } from 'effect';
import type { Logger } from 'pino';

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

let runQueue: Queue<AgentRunJob> | undefined;
let runQueueEvents: QueueEvents | undefined;

function getRunQueue(redisUrl: string): Queue<AgentRunJob> {
  if (!runQueue) runQueue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: { url: redisUrl } });
  return runQueue;
}

function getRunQueueEvents(redisUrl: string): QueueEvents {
  if (!runQueueEvents) {
    runQueueEvents = new QueueEvents(RUNS_QUEUE, { connection: { url: redisUrl } });
    runQueueEvents.on('error', (error) => {
      process.stderr.write(`[eval-queue] redis error: ${error.message}\n`);
    });
  }
  return runQueueEvents;
}

export async function closeEvalRunQueue(): Promise<void> {
  await Promise.allSettled([runQueue?.close(), runQueueEvents?.close()]);
  runQueue = undefined;
  runQueueEvents = undefined;
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
    .map((message) => chatRepo.messageText(message.content) ?? '')
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
    const queueEvents = getRunQueueEvents(redisUrl);
    yield* Effect.tryPromise({
      try: () => queueEvents.waitUntilReady(),
      catch: (cause) => new Error(errorMessage(cause)),
    });
    const job = yield* Effect.tryPromise({
      try: () =>
        getRunQueue(redisUrl).add(
          'run',
          {
            runId: run.id,
            agentId: input.agentId,
            conversationId: conversation.id,
            prompt: input.prompt,
          },
          runEnqueueOptions(run.id),
        ),
      catch: (cause) => new Error(errorMessage(cause)),
    });

    const timeoutMs = Math.min(input.timeoutMs, 30 * 60_000);
    const deadline = Date.now() + timeoutMs;
    const completion = yield* Effect.result(
      Effect.tryPromise({
        try: () => job.waitUntilFinished(queueEvents, timeoutMs),
        catch: (cause) => new Error(errorMessage(cause)),
      }),
    );
    const current = yield* dbQuery(() => chatRepo.getRun(db, run.id));
    if (!current) return yield* Effect.fail(new Error('run disappeared'));
    if (['failed', 'cancelled', 'timeout'].includes(current.status)) {
      return yield* Effect.fail(
        new Error(`run ended with ${current.status}${current.error ? `: ${current.error}` : ''}`),
      );
    }
    if (Result.isFailure(completion)) {
      return yield* Effect.fail(
        Date.now() >= deadline ? new Error('run timed out') : completion.failure,
      );
    }
    if (current.status !== 'succeeded') {
      return yield* Effect.fail(new Error(`run ended with ${current.status}`));
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
    // BullMQ 重复投递时只让一个 worker 执行：认领失败说明别人已经在跑。
    const claimed = yield* dbQuery(() => evalRepo.claimEvalRun(db, evalRunId));
    if (!claimed) {
      logger.info({ evalRunId }, 'eval run already claimed, skipping duplicate delivery');
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
    if ((yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId)))?.status !== 'running') return;

    // 有快照就只跑快照：跑批期间改了用例也不能改变本次结果；[] 表示零条，不回读。
    const cases =
      evalRun.caseSnapshot ?? (yield* dbQuery(() => evalRepo.listCases(db, evalRun.agentId)));
    let passed = 0;
    let crashed: string | null = null;

    yield* Effect.forEach(
      cases,
      (testCase) =>
        Effect.gen(function* () {
          if ((yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId)))?.status !== 'running')
            return;
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
          if ((yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId)))?.status !== 'running')
            return;
          if (Result.isSuccess(result)) ok = result.success;
          else output = errorMessage(result.failure);
          if (ok) passed += 1;

          yield* Effect.gen(function* () {
            yield* dbQuery(() =>
              evalRepo.addResult(
                db,
                {
                  id: newId('evalResult'),
                  evalRunId,
                  caseId: testCase.id,
                  // 失败的 case 没有 run：外键要求 NULL 而不是空串。
                  runId: runId === '' ? null : runId,
                  passed: ok,
                  output,
                  // 用例行可能已被删除；报告要能独立于活表还原当时的问题与期望。
                  caseSnapshot: {
                    id: testCase.id,
                    name: testCase.name,
                    prompt: testCase.prompt,
                    expectation: testCase.expectation,
                  },
                },
                { recordProgress: true },
              ),
            );
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

    if ((yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId)))?.status !== 'running') return;
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
  await runProgram(program);
}
