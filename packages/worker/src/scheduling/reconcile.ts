import { DbError } from '@agentport/core';
import { type createDb, schema } from '@agentport/db';
import { type AgentRunJob, EVAL_RUNS_QUEUE, errorText, RUNS_QUEUE } from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { Effect, Result, Schedule } from 'effect';
import type { Logger } from 'pino';
import { finalizeRun, type RunFinishedEvent } from '../runs/run-finish.js';
import { startIntervalTicker } from './interval-ticker.js';

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000;

export const LOST_RUN_ERROR = 'worker lost track of this run';

export const EVAL_LOST_ERROR = 'eval run lost';
const EVAL_STALE_MS = 60 * 60 * 1000;

const DB_RETRY = Schedule.min([Schedule.exponential('200 millis'), Schedule.recurs(3)]);

function withDb<A>(run: () => Promise<A>): Effect.Effect<A, DbError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new DbError(cause instanceof Error ? cause.message : String(cause), cause),
  }).pipe(Effect.retry(DB_RETRY));
}

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
    return probe.success === null || jobGone(probe.success);
  });
}

type EvalRef = { id: string };
const EVAL_REF = { id: schema.evalRuns.id };

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

interface ReconcileCleanupInput {
  runId: string;
  conversationId: string;
  sandboxId: string;
}

type ReconcileCleanup = (input: ReconcileCleanupInput) => Promise<void>;

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

    const [current] = yield* withDb(() =>
      db
        .select(RUNNING_REF)
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, candidate.id))
        .limit(1),
    );
    if (current === undefined || current.status !== 'running') return false;
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
          catch: (err) => new Error(errorText(err)),
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
        values: { error: LOST_RUN_ERROR, errorKind: 'infra' },
        audit: { action: 'agent.run.reconciled', status: 'error' },
      }),
    );
  });
}

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

export function startReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  agentTimeoutMs: number;
  redisUrl: string;
  cleanup: ReconcileCleanup;
}): () => Promise<void> {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection });
  queue.on('error', () => input.logger.warn('run queue connection failed'));
  const evalQueue = new Queue(EVAL_RUNS_QUEUE, { connection });
  evalQueue.on('error', () => input.logger.warn('eval queue connection failed'));
  const stopTicker = startIntervalTicker(
    () =>
      Promise.allSettled([
        reconcileOrphanedRuns(input.db, input.logger, input.agentTimeoutMs, queue, input.cleanup),
        reconcileOrphanedEvalRuns(input.db, input.logger, evalQueue),
      ]).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          input.logger.error('reconcile failed');
        }
      }),
    RECONCILE_EVERY_MS,
  );
  return async () => {
    await stopTicker();
    await Promise.all([queue.close(), evalQueue.close()]);
    await connection.quit();
  };
}
