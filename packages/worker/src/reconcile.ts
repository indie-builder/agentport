import { DbError } from '@agentport/core';
import { type createDb, repo, schema } from '@agentport/db';
import { type AgentRunJob, EVAL_RUNS_QUEUE, RUNS_QUEUE } from '@agentport/shared';
import { Queue } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import { Effect, Result, Schedule } from 'effect';
import type { Logger } from 'pino';
import { publishRun } from './runner-client.js';

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

const FINISHED_EVENT = {
  type: 'run_finished',
  status: 'failed',
  error: LOST_RUN_ERROR,
} as const;

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

/** 探测在 Redis 上可能很慢；抽出来才能让调用方以并发 4 逐个排队。 */
function reconcileQueued(
  db: Db,
  logger: Logger,
  candidate: RunRef,
  cutoff: Date,
  queue: Pick<Queue, 'getJob'>,
): Effect.Effect<RunRef[], DbError> {
  return Effect.gen(function* () {
    const gone = yield* probeJobGone(
      queue,
      candidate.id,
      Effect.sync(() => {
        // Redis 报错里可能带连接串；只记固定文案和 runId，候选留给下一轮。
        logger.warn({ runId: candidate.id }, 'run queue probe failed, keeping queued run');
      }),
    );
    if (!gone) return [];
    // 条件更新：探测期间被认领或取消的 run 不能被覆盖。
    return yield* withDb(() =>
      db
        .update(schema.agentRuns)
        .set({ status: 'failed', error: LOST_RUN_ERROR, endedAt: new Date() })
        .where(
          and(
            eq(schema.agentRuns.id, candidate.id),
            eq(schema.agentRuns.status, 'queued'),
            lt(schema.agentRuns.createdAt, cutoff),
          ),
        )
        .returning(RUN_REF),
    );
  });
}

/**
 * worker 崩溃/重启后，DB 里会残留 running 或 queued 的 run：把已超过超时上限的收敛成 failed，
 * 并补发 run_finished，否则前端会一直转圈。
 * queued 还要问队列：积压或整体重启后 job 可能仍在 waiting，不能按时间一刀切。
 * running 用该 agent 自己的 timeout_ms 判定：当前配置即本次运行上限，不取运行时快照。
 */
export async function reconcileOrphanedRuns(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  agentTimeoutMs: number,
  queue: Pick<Queue, 'getJob'>,
): Promise<number> {
  const cutoff = new Date(Date.now() - agentTimeoutMs - GRACE_MS);
  const staleRunning = and(
    eq(schema.agentRuns.agentId, schema.agents.id),
    eq(schema.agentRuns.status, 'running'),
    lt(
      schema.agentRuns.startedAt,
      sql`now() - (${schema.agents.timeoutMs} + ${GRACE_MS}) * interval '1 millisecond'`,
    ),
  );
  // queued 从未启动：startedAt 为 NULL，用入队时间判断陈旧。
  const staleQueued = and(
    eq(schema.agentRuns.status, 'queued'),
    lt(schema.agentRuns.createdAt, cutoff),
  );

  const failed = await Effect.runPromise(
    withDb(() =>
      db
        .update(schema.agentRuns)
        .set({ status: 'failed', error: LOST_RUN_ERROR, endedAt: new Date() })
        .from(schema.agents)
        .where(staleRunning)
        .returning(RUN_REF),
    ),
  );

  const candidates = await Effect.runPromise(
    withDb(() => db.select(RUN_REF).from(schema.agentRuns).where(staleQueued)),
  );
  // 探测慢不能拖住整轮：每个候选独立排队，最多 4 个并发。
  const reconciledQueued = await Effect.runPromise(
    Effect.forEach(
      candidates,
      (candidate) => reconcileQueued(db, logger, candidate, cutoff, queue),
      { concurrency: 4 },
    ),
  );

  const rows = [...failed, ...reconciledQueued.flat()];

  // 先落库再补发事件：前端漏掉事件也能从 DB 看到终态。
  await Effect.runPromise(
    Effect.forEach(
      rows,
      (row) => Effect.promise(() => publishRun(row.id, FINISHED_EVENT, logger)),
      { concurrency: 4, discard: true },
    ),
  );
  if (rows.length > 0) {
    for (const row of rows) {
      await repo.audit.writeAudit(db, logger, {
        actor: 'worker',
        action: 'agent.run.reconciled',
        target: row.id,
        status: 'error',
      });
    }
    logger.warn({ runs: rows.map((row) => row.id) }, 'reconciled orphaned runs');
  }
  return rows.length;
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
    inFlight = Promise.all([
      reconcileOrphanedRuns(input.db, input.logger, input.agentTimeoutMs, queue),
      reconcileOrphanedEvalRuns(input.db, input.logger, evalQueue),
    ])
      .then(() => undefined)
      .catch(() => {
        input.logger.error('reconcile failed');
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
