import { type createDb, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { Queue } from 'bullmq';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { KNOWLEDGE_TIMEOUT_MS } from './queue.js';

const RECONCILE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/**
 * 刚认领的 running 行先放过一轮：探测与认领并发时状态仍有瞬时窗口。
 * queued 不加宽限：DB 有行而队列没有 job 本身就是确定的丢失，补投按 jobId 去重也无副作用。
 */
const RUNNING_GRACE_MS = 5 * 60_000;

export const KNOWLEDGE_LOST_ERROR = 'knowledge worker lost track of this job';

/** 队列里仍有工作（waiting/delayed/active/prioritized）就保留；job 消失或已终态才算丢失。 */
const ACTIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

export interface KnowledgeQueueLike {
  getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined>;
  /** 同 jobId 已存在 failed/completed 时 add 会被去重，必须先移除旧条目。 */
  remove: (id: string) => Promise<unknown>;
  add: (
    name: 'knowledge',
    data: { jobId: string },
    opts: ReturnType<typeof knowledgeEnqueueOptions>,
  ) => Promise<unknown>;
}

async function queueState(queue: KnowledgeQueueLike, id: string): Promise<string | null> {
  const job = await queue.getJob(id);
  return job ? job.getState() : null;
}

/**
 * 崩溃恢复：DB 的 running/queued 与 Redis 实际状态对账。
 *
 * - running + active：保留（长任务不能被误杀）。
 * - running + waiting/delayed：worker 在认领后崩溃，BullMQ 已把 job 放回重试；
 *   把行退回 queued，重试才有机会重新认领（认领只接受 queued）。
 * - running + 消失/终态，或超过 2 倍超时：置 failed。
 * - queued + 队列中不存在：重新入队，避免 Redis 丢数据后永远排队。
 */
export async function reconcileKnowledgeJobs(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  queue: KnowledgeQueueLike,
  now: number = Date.now(),
): Promise<{ failed: number; requeued: number }> {
  const rows = await db
    .select()
    .from(schema.knowledgeJobs)
    .where(inArray(schema.knowledgeJobs.status, ['queued', 'running']));

  let failed = 0;
  let requeued = 0;
  for (const row of rows) {
    if (
      row.status === 'running' &&
      now - (row.startedAt ?? row.createdAt).getTime() < RUNNING_GRACE_MS
    ) {
      continue;
    }
    const state = await queueState(queue, row.id).catch(() => undefined);
    if (state === undefined) continue; // Redis 不可用：本轮不动任何行，留给下一轮。

    if (row.status === 'running') {
      const timedOut =
        row.startedAt !== null &&
        now - row.startedAt.getTime() > 2 * KNOWLEDGE_TIMEOUT_MS[row.type];
      if (!timedOut && state !== null && ACTIVE_STATES.has(state)) {
        if (state === 'active') continue;
        // waiting/delayed：重试中的 job 需要行回到 queued 才能被认领。
        const requeuedRow = await db
          .update(schema.knowledgeJobs)
          .set({ status: 'queued', startedAt: null, step: null })
          .where(
            and(eq(schema.knowledgeJobs.id, row.id), eq(schema.knowledgeJobs.status, 'running')),
          )
          .returning({ id: schema.knowledgeJobs.id });
        if (requeuedRow.length > 0) requeued += 1;
        continue;
      }
      const error = timedOut ? '任务超时' : KNOWLEDGE_LOST_ERROR;
      try {
        const finished = await repo.knowledge.finishJob(db, row.id, {
          fromStatus: 'running',
          status: 'failed',
          error,
        });
        if (finished) {
          failed += 1;
          logger.warn({ jobId: row.id, error }, 'knowledge job reconciled as failed');
        }
      } catch (err) {
        // 关联行缺失/错配时事务整体回滚；保留 running 交下一轮或人工处理。
        logger.warn({ err, jobId: row.id }, 'knowledge job reconcile finish failed');
      }
      continue;
    }

    // queued：job 仍在队列里就不动；Redis 丢数据才会得到 null/终态。
    if (state !== null && ACTIVE_STATES.has(state)) continue;
    try {
      // 旧的 failed/completed 条目会按 jobId 去重，导致 add 变成空操作。
      if (state !== null) await queue.remove(row.id).catch(() => undefined);
      await queue.add('knowledge', { jobId: row.id }, knowledgeEnqueueOptions(row.id));
      requeued += 1;
      logger.warn({ jobId: row.id }, 'knowledge queued job re-enqueued');
    } catch (err) {
      logger.warn({ err, jobId: row.id }, 'knowledge job re-enqueue failed');
    }
  }

  return { failed, requeued };
}

/**
 * 每天一条全局 cleanup：blob 回收按引用判断，不属于某个库。
 * 同一天已有记录、或上一次 cleanup 还没跑完（queued/running），都不再新建；
 * 入队失败只留 queued 行，交给下一轮 reconcile 按 jobId 补投。
 * shortcut: 多 worker 并发时可能各建一条，部署是单 worker，扩容时改为部分唯一索引。
 */
export async function ensureDailyCleanup(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  queue: KnowledgeQueueLike,
  now: number = Date.now(),
): Promise<void> {
  const dayStart = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  const [existing] = await db
    .select({ id: schema.knowledgeJobs.id })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.type, 'cleanup'),
        isNull(schema.knowledgeJobs.baseId),
        or(
          gte(schema.knowledgeJobs.createdAt, dayStart),
          inArray(schema.knowledgeJobs.status, ['queued', 'running']),
        ),
      ),
    )
    .limit(1);
  if (existing) return;

  const job = await repo.knowledge.createJob(db, {
    type: 'cleanup',
    baseId: null,
    documentId: null,
    sourceId: null,
    payload: { type: 'cleanup' },
  });
  try {
    await queue.add('knowledge', { jobId: job.id }, knowledgeEnqueueOptions(job.id));
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'knowledge cleanup enqueue failed');
  }
}

/**
 * 启动先跑一次，之后每 5 分钟一次；用 setInterval 而非 BullMQ，少一个队列。
 * 返回的 stop 等本轮结束再关队列，避免关闭时和正在写的操作撞车。
 */
export function startKnowledgeReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  redisUrl: string;
  prefix?: string;
}): () => Promise<void> {
  const queue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
    connection: { url: input.redisUrl, maxRetriesPerRequest: null },
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  });
  queue.on('error', () => input.logger.warn('knowledge queue connection failed'));

  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (busy) return;
    busy = true;
    inFlight = reconcileKnowledgeJobs(input.db, input.logger, queue)
      .then(() => ensureDailyCleanup(input.db, input.logger, queue))
      .then(() => undefined)
      .catch((err: unknown) => {
        input.logger.error({ err }, 'knowledge reconcile failed');
      })
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await inFlight;
    await queue.close();
  };
}
