import { DbError, runProgram } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import { type AgentRunJob, judge, RUNS_QUEUE, runEnqueueOptions } from '@agentport/shared';
import { Queue, QueueEvents, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Cause, Effect, Result } from 'effect';
import type { Logger } from 'pino';
import { loadUserAgentAccess } from './run-access.js';

const evalRepo = repo.evalRepo;
const chatRepo = repo.chat;

/** 已认领的批次被重投说明上次执行被中断；不续跑，交由 processor 收口为 failed。 */
const EVAL_INTERRUPTED_ERROR = 'eval run execution was interrupted; start a new evaluation';

/** DB/infra 原文含 SQL 与参数；对外只落固定、可操作的说明。 */
export const EVAL_FAILURE_PUBLIC_MESSAGE =
  'eval run failed due to a database or infrastructure error; start a new evaluation';

/** 只保留最小的领域中断消息（UnrecoverableError）；其余错误不把原文写进 DB。 */
export function publicEvalFailureMessage(error: unknown): string {
  return error instanceof UnrecoverableError ? error.message : EVAL_FAILURE_PUBLIC_MESSAGE;
}

function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 日志诊断：只给错误类型与 PG code，不序列化 message/cause（可能含 SQL 参数）。 */
export function evalFailureDiagnostics(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  const errorName =
    error instanceof Error ? error.name : error instanceof DbError ? 'DbError' : typeof error;
  const errorCode = errorCodeOf(error);
  return errorCode === undefined ? { errorName } : { errorName, errorCode };
}

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
  input: {
    agentId: string;
    businessId: string;
    prompt: string;
    timeoutMs: number;
    title: string;
  },
  context: { runId: string | null },
) {
  return Effect.gen(function* () {
    const agentVersion = yield* dbQuery(() =>
      repo.agentVersions.latestAgentVersion(db, input.agentId),
    );
    // 评估用例与聊天共用准入：同一事务取绑定锁、锁「发起专家 + enabled 子级」的记忆。
    // 执行主体显式取 evalRuns.createdBy，不接受 job/client 用户字段。
    const admitted = yield* dbQuery(() =>
      chatRepo.admitChatRun(db, {
        agentId: input.agentId,
        message: input.prompt,
        title: input.title,
        // 用例运行在 DB 标记为 event：worker 排队复核据此从 evalRuns 重查 eval.execute。
        trigger: 'event',
        subject: { kind: 'user', businessId: input.businessId },
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
    // BullMQ 重复投递时只让一个 worker 执行：认领失败说明该批次已经启动过。
    const claimed = yield* dbQuery(() => evalRepo.claimEvalRun(db, evalRunId));
    if (!claimed) {
      const current = yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId));
      if (current?.status === 'running' && current.claimedAt !== null) {
        // 已认领的重投不续跑、不重跑 case：明确失败，保留已落库结果与 passed。
        return yield* Effect.fail(new UnrecoverableError(EVAL_INTERRUPTED_ERROR));
      }
      logger.info({ evalRunId }, 'eval run no longer running, skipping duplicate delivery');
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

    // 执行主体是 evalRuns.createdBy：每次开跑前用 DB 实时账户与授权重查，不降级。
    const { denial, grants } = yield* dbQuery(() =>
      loadUserAgentAccess(db, {
        businessId: evalRun.createdBy,
        agentId: evalRun.agentId,
        permissions: ['agents.use', 'eval.execute'],
      }),
    );
    if (denial !== null) {
      yield* dbQuery(() =>
        evalRepo.finishEvalRun(db, evalRunId, {
          status: 'failed',
          passed: 0,
          error: denial.message,
        }),
      );
      yield* dbQuery(() =>
        repo.audit.writeAudit(db, logger, {
          actor: 'worker',
          action: 'eval.denied',
          target: evalRunId,
          status: 'denied',
          input: { reason: denial.reason, businessId: evalRun.createdBy },
        }),
      );
      return;
    }
    // 用例读取仍受当前用户自己的 eval.read 范围约束，不把执行身份当全平台。
    const accessFilter = {
      businessId: evalRun.createdBy,
      scopes: [
        ...new Set(
          grants.filter((grant) => grant.permissionId === 'eval.read').map((grant) => grant.scope),
        ),
      ],
    };

    // 有快照就只跑快照：跑批期间改了用例也不能改变本次结果；[] 表示零条，不回读。
    const cases =
      evalRun.caseSnapshot ??
      (yield* dbQuery(() => evalRepo.listCases(db, accessFilter, evalRun.agentId)));
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
                businessId: evalRun.createdBy,
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
          // DB 原文含 SQL 与参数，不能作为模型输出公开；其他用例/领域失败仍保留可读原文。
          else
            output =
              result.failure instanceof DbError
                ? publicEvalFailureMessage(result.failure)
                : errorMessage(result.failure);

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
          crashed = publicEvalFailureMessage(err);
          logger.error({ evalRunId, ...evalFailureDiagnostics(err) }, 'eval run crashed');
        }),
      ),
    );

    if ((yield* dbQuery(() => evalRepo.getEvalRun(db, evalRunId)))?.status !== 'running') return;
    // 最终持久化失败必须传播给 processor 收口，不能只记日志后当作成功返回。
    yield* dbQuery(() =>
      evalRepo.finishEvalRun(db, evalRunId, {
        status: crashed === null && passed === cases.length ? 'succeeded' : 'failed',
        passed,
        error: crashed,
      }),
    );
  });
  await runProgram(program);
}
