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

/**
 * 发起一次普通 agent run 并等到终态，返回最终 assistant 文本。
 * run 一旦创建就写入 context：失败路径也要留下可追踪的 runId。
 */
function runOneCase(
  db: Database,
  redisUrl: string,
  input: { agentId: string; prompt: string; timeoutMs: number; title: string },
  context: { runId: string | null },
) {
  return Effect.gen(function* () {
    const agentVersion = yield* dbQuery(() =>
      repo.agentVersions.latestAgentVersion(db, input.agentId),
    );
    // 评估用例与聊天共用准入：同一事务取绑定锁、锁「发起专家 + enabled 子级」的记忆。
    const admitted = yield* dbQuery(() =>
      chatRepo.admitChatRun(db, {
        agentId: input.agentId,
        message: input.prompt,
        title: input.title,
        ...(agentVersion === null ? {} : { agentVersion }),
      }),
    );
    const run = admitted.run;
    context.runId = run.id;
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
            conversationId: admitted.conversationId,
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

    const messages = yield* dbQuery(() => chatRepo.listMessages(db, admitted.conversationId));
    return { output: assistantText(messages) };
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
          let ok = false;
          const runContext: { runId: string | null } = { runId: null };
          // Effect v4 的 result 对应 v3 的 either，保留每条成功或失败。
          const result = yield* Effect.result(
            runOneCase(
              db,
              redisUrl,
              {
                agentId: evalRun.agentId,
                prompt: testCase.prompt,
                timeoutMs: agent.timeoutMs,
                title: `eval: ${testCase.name}`.slice(0, 80),
              },
              runContext,
            ).pipe(
              Effect.flatMap((result) =>
                Effect.try({
                  try: () => {
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

          yield* dbQuery(() =>
            evalRepo.addResult(
              db,
              {
                id: newId('evalResult'),
                evalRunId,
                caseId: testCase.id,
                runId: runContext.runId,
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
          // 只有真正落库成功才计 passed；写失败交给外层 crashed 收尾，避免假成功。
          if (ok) passed += 1;
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
