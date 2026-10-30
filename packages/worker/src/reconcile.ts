import { DbError } from '@agentport/core';
import { type createDb, schema } from '@agentport/db';
import { type AgentRunJob, EVAL_RUNS_QUEUE, RUNS_QUEUE } from '@agentport/shared';
import { Queue } from 'bullmq';
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { Effect, Result, Schedule } from 'effect';
import type { Logger } from 'pino';
import { finalizeRun, type RunFinishedEvent } from './run-finish.js';

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;

export const LOST_RUN_ERROR = 'worker lost track of this run';

export const EVAL_LOST_ERROR = 'eval run lost';
const EVAL_STALE_MS = 60 * 60 * 1000;

/** 收敛是幂等的 UPDATE；瞬时数据库故障重试三次比等下一轮五分钟划算。 */
const DB_RETRY = Schedule.min([Schedule.exponential('200 millis'), Schedule.recurs(3)]);

function withDb<A>(run: () => Promise<A>): Effect.Effect<A, DbError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DbError(cause instanceof Error ? cause.message : String(cause), cause),
  }).pipe(Effect.retry(DB_RETRY));
}

/**
 * 探测在 Redis 上可能很慢；抽出来才能让调用方以并发 4 逐个排队。
 * 返回 true 表示 job 已消失或已到终态，调用方再做条件更新。
 * Redis 报错里可能带连接串：只允许调用方记固定文案和 id，候选留给下一轮。
 */
function probeJobGone(
  queue: Pick<Queue, 'getJob'>,
  id: string,
  onError: Effect.Effect<void>,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const probe = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          const job = await queue.getJob(id);
          return job ? await job.getState() : null;
        },
        catch: () => new Error('queue probe failed'),
      }).pipe(Effect.timeout(20_000)),
    );
    if (Result.isFailure(probe)) {
      yield* onError;
      return false;
    }
    // null 表示 job 已消失；其余状态交给 jobGone 判断。
    return probe.success === null || jobGone(probe.success);
  });
}

type EvalRef = { id: string };
const EVAL_REF = { id: schema.evalRuns.id };

/** 评估候选：条件更新保证探测期间被取消或完成的跑批不被覆盖。 */
function reconcileQueuedEval(
  db: Db,
  logger: Logger,
  candidate: EvalRef,
  cutoff: Date,
  queue: Pick<Queue, 'getJob'>,
): Effect.Effect<EvalRef[], DbError> {
  return Effect.gen(function* () {
    const gone = yield* probeJobGone(
      queue,
      candidate.id,
      Effect.sync(() => {
        logger.warn(
          { evalRunId: candidate.id },
          'eval queue probe failed, keeping running eval run',
        );
      }),
    );
    if (!gone) return [];
    return yield* withDb(() =>
      db
        .update(schema.evalRuns)
        .set({ status: 'failed', error: EVAL_LOST_ERROR, finishedAt: new Date() })
        .where(
          and(
            eq(schema.evalRuns.id, candidate.id),
            eq(schema.evalRuns.status, 'running'),
            lt(schema.evalRuns.createdAt, cutoff),
          ),
        )
        .returning(EVAL_REF),
    );
  });
}

/**
 * 评估跑批的 job 也可能在 API/worker 重启后丢失：
 * 对停在 running 且超过 1 小时的跑批逐个问队列，job 消失或已到终态才收敛为 failed。
 */
export async function reconcileOrphanedEvalRuns(
  db: Db,
  logger: Logger,
  queue: Pick<Queue, 'getJob'>,
): Promise<number> {
  const cutoff = new Date(Date.now() - EVAL_STALE_MS);
  const candidates = await Effect.runPromise(
    withDb(() =>
      db
        .select(EVAL_REF)
        .from(schema.evalRuns)
        .where(and(eq(schema.evalRuns.status, 'running'), lt(schema.evalRuns.createdAt, cutoff))),
    ),
  );
  const failed = await Effect.runPromise(
    Effect.forEach(
      candidates,
      (candidate) => reconcileQueuedEval(db, logger, candidate, cutoff, queue),
      { concurrency: 4 },
    ),
  );
  const count = failed.flat().length;
  if (count > 0) logger.warn({ count }, 'reconciled orphaned running eval runs');
  return count;
}

const LOST_RUN_EVENT: RunFinishedEvent = {
  type: 'run_finished',
  status: 'failed',
  error: LOST_RUN_ERROR,
};

/**
 * 队列里仍有工作（waiting/delayed/active/prioritized/waiting-children）就保留；
 * job 消失或已到终态才算孤儿。未列出的状态保守保留。
 */
function jobGone(state: string): boolean {
  switch (state) {
    case 'completed':
    case 'failed':
    case 'unknown':
      return true;
    default:
      return false;
  }
}

type Db = ReturnType<typeof createDb>['db'];
type RunRef = { id: string; conversationId: string };
const RUN_REF = { id: schema.agentRuns.id, conversationId: schema.agentRuns.conversationId };

export interface ReconcileCleanupInput {
  runId: string;
  conversationId: string;
  sandboxId: string;
}

/** 必传：有 sandboxId 时必须真正等到销毁结果，缺省不能被当成清理成功。 */
export type ReconcileCleanup = (input: ReconcileCleanupInput) => Promise<void>;

type RunningCandidate = RunRef & {
  status: (typeof schema.agentRuns.$inferSelect)['status'];
  sandboxId: string | null;
  pendingFinish: RunFinishedEvent | null;
};
const RUNNING_REF = {
  id: schema.agentRuns.id,
  conversationId: schema.agentRuns.conversationId,
  status: schema.agentRuns.status,
  sandboxId: schema.agentRuns.sandboxId,
  pendingFinish: schema.agentRuns.pendingFinish,
};

/**
 * running 候选有两类：已暂存终态（每轮都看，不等 timeout），
 * 或超过该 agent 自己 timeout + 宽限的普通运行。两者都还要过队列探测。
 */
function runningCandidates(db: Db): Promise<RunningCandidate[]> {
  return db
    .select(RUNNING_REF)
    .from(schema.agentRuns)
    .innerJoin(schema.agents, eq(schema.agentRuns.agentId, schema.agents.id))
    .where(
      and(
        eq(schema.agentRuns.status, 'running'),
        or(
          isNotNull(schema.agentRuns.pendingFinish),
          lt(
            schema.agentRuns.startedAt,
            sql`now() - (${schema.agents.timeoutMs} + ${GRACE_MS}) * interval '1 millisecond'`,
          ),
        ),
      ),
    );
}

/**
 * running 的终态只在自己确认 job 已结束、容器已销毁后写入：
 * - 有 pendingFinish：接管原事件，CAS 胜者发布并审计；
 * - 无 pendingFinish：真孤儿按 LOST_RUN_ERROR 收尾。
 * 清理失败或 job 仍在就保持 running，业务占用不释放。
 */
function reconcileRunning(
  db: Db,
  logger: Logger,
  candidate: RunningCandidate,
  queue: Pick<Queue, 'getJob'>,
  cleanup: ReconcileCleanup,
): Effect.Effect<boolean, DbError> {
  return Effect.gen(function* () {
    const gone = yield* probeJobGone(
      queue,
      candidate.id,
      Effect.sync(() => {
        logger.warn({ runId: candidate.id }, 'run queue probe failed, keeping running run');
      }),
    );
    if (!gone) return false;

    // 探测期间候选可能已完成、被重试或换了容器：按主键重读当前行再决定。
    // 旧快照直接清理会误杀已完成 run A 之后复用同一容器的 run B。
    const [current] = yield* withDb(() =>
      db
        .select(RUNNING_REF)
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, candidate.id))
        .limit(1),
    );
    if (current === undefined || current.status !== 'running') return false;
    // sandboxId 或 pendingFinish 的有无变了说明快照已过期，留到下一轮重新取快照。
    if (
      current.sandboxId !== candidate.sandboxId ||
      (current.pendingFinish === null) !== (candidate.pendingFinish === null)
    ) {
      return false;
    }

    if (current.sandboxId !== null) {
      const sandboxId = current.sandboxId;
      const cleaned = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            cleanup({ runId: current.id, conversationId: current.conversationId, sandboxId }),
          catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
        }),
      );
      if (Result.isFailure(cleaned)) {
        logger.warn(
          { runId: current.id, sandboxId, error: cleaned.failure.message },
          'run sandbox cleanup failed, keeping running run',
        );
        return false;
      }
    }

    const event = current.pendingFinish ?? LOST_RUN_EVENT;
    return yield* Effect.promise(() =>
      finalizeRun({
        db,
        logger,
        runId: current.id,
        event,
        pending: current.pendingFinish === null ? 'absent' : 'required',
        ...(current.pendingFinish === null
          ? { values: { error: LOST_RUN_ERROR, errorKind: null } }
          : {}),
        audit: {
          action: 'agent.run.reconciled',
          status: event.status === 'succeeded' ? 'ok' : 'error',
        },
      }),
    );
  });
}

/** 排队孤儿：job 消失/终态才 failed；探测期间被认领的由条件更新保住。 */
function reconcileQueued(
  db: Db,
  logger: Logger,
  candidate: RunRef,
  cutoff: Date,
  queue: Pick<Queue, 'getJob'>,
): Effect.Effect<boolean, DbError> {
  return Effect.gen(function* () {
    const gone = yield* probeJobGone(
      queue,
      candidate.id,
      Effect.sync(() => {
        // Redis 报错里可能带连接串；只记固定文案和 runId，候选留给下一轮。
        logger.warn({ runId: candidate.id }, 'run queue probe failed, keeping queued run');
      }),
    );
    if (!gone) return false;
    return yield* Effect.promise(() =>
      finalizeRun({
        db,
        logger,
        runId: candidate.id,
        event: LOST_RUN_EVENT,
        fromStatus: 'queued',
        queuedBefore: cutoff,
        values: { error: LOST_RUN_ERROR, errorKind: null },
        audit: { action: 'agent.run.reconciled', status: 'error' },
      }),
    );
  });
}

/**
 * worker 崩溃/重启后，DB 里会残留 running 或 queued 的 run。
 * queued 超过全局上限后问队列；running 只在超过该 agent 自己的 timeout + 宽限、
 * 或已有 pendingFinish 时成为候选，并且必须先探测到 job 已结束才可能收敛。
 * 有 sandboxId 时必须等 cleanup 成功；失败或 job 未结束都保持 running，下一轮再试。
 */
export async function reconcileOrphanedRuns(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  agentTimeoutMs: number,
  queue: Pick<Queue, 'getJob'>,
  cleanup: ReconcileCleanup,
): Promise<number> {
  const cutoff = new Date(Date.now() - agentTimeoutMs - GRACE_MS);
  const staleQueued = and(
    eq(schema.agentRuns.status, 'queued'),
    lt(schema.agentRuns.createdAt, cutoff),
  );

  const [running, queued] = await Effect.runPromise(
    Effect.all(
      [
        withDb(() => runningCandidates(db)),
        withDb(() => db.select(RUN_REF).from(schema.agentRuns).where(staleQueued)),
      ],
      { concurrency: 2 },
    ),
  );

  const [reconciledRunning, reconciledQueued] = await Effect.runPromise(
    Effect.all(
      [
        Effect.forEach(
          running,
          (candidate) => reconcileRunning(db, logger, candidate, queue, cleanup),
          {
            concurrency: 4,
          },
        ),
        Effect.forEach(
          queued,
          (candidate) => reconcileQueued(db, logger, candidate, cutoff, queue),
          { concurrency: 4 },
        ),
      ],
      { concurrency: 2 },
    ),
  );

  const count = reconciledRunning.filter(Boolean).length + reconciledQueued.filter(Boolean).length;
  if (count > 0) logger.warn({ count }, 'reconciled orphaned runs');
  return count;
}

/**
 * 启动时先跑一次，之后每 5 分钟一次；用 setInterval 而非 BullMQ，少一个队列和 worker。
 * 返回的 stop 会等在跑的 tick 结束再关队列：否则关闭进程时可能和正在写的事件撞车。
 */
export function startReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  agentTimeoutMs: number;
  redisUrl: string;
  cleanup: ReconcileCleanup;
}): () => Promise<void> {
  const queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: { url: input.redisUrl } });
  queue.on('error', () => input.logger.warn('run queue connection failed'));
  const evalQueue = new Queue(EVAL_RUNS_QUEUE, { connection: { url: input.redisUrl } });
  evalQueue.on('error', () => input.logger.warn('eval queue connection failed'));
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (busy) return;
    busy = true;
    inFlight = Promise.allSettled([
      reconcileOrphanedRuns(input.db, input.logger, input.agentTimeoutMs, queue, input.cleanup),
      reconcileOrphanedEvalRuns(input.db, input.logger, evalQueue),
    ])
      .then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          input.logger.error('reconcile failed');
        }
      })
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_EVERY_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
    await Promise.all([queue.close(), evalQueue.close()]);
  };
}
