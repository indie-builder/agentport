import { type createDb, repo, schema } from '@agentport/db';
import {
  isActiveJobState,
  KNOWLEDGE_JOB_TIMEOUT_MS,
  KNOWLEDGE_JOBS_QUEUE,
  type KnowledgeJobQueuePayload,
  knowledgeEnqueueOptions,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { queueState } from '../runs/queue-state.js';
import { startIntervalTicker } from '../scheduling/interval-ticker.js';

const RECONCILE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RUNNING_GRACE_MS = 5 * 60_000;

export const KNOWLEDGE_LOST_ERROR = 'knowledge worker lost track of this job';

export interface KnowledgeQueueLike {
  getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined>;
  /** 同 jobId 已存在 failed/completed 时 add 会被去重，必须先移除旧条目。 */
  remove: (id: string) => Promise<unknown>;
  add: (
    name: 'knowledge',
    data: KnowledgeJobQueuePayload,
    opts: ReturnType<typeof knowledgeEnqueueOptions>,
  ) => Promise<unknown>;
}

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
    if (state === undefined) continue;

    if (row.status === 'running') {
      const timedOut =
        row.startedAt !== null &&
        now - row.startedAt.getTime() > 2 * KNOWLEDGE_JOB_TIMEOUT_MS[row.type];
      if (!timedOut && state !== null && isActiveJobState(state)) {
        if (state === 'active') continue;
        if (await repo.knowledge.requeueKnowledgeJob(db, row.id)) requeued += 1;
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
          if (row.type === 'summary' && row.documentId !== null) {
            const payload = knowledgeJobPayloadSchema.safeParse(row.payload);
            await repo.knowledge
              .failDocumentSummary(
                db,
                row.documentId,
                error,
                payload.success && payload.data.type === 'summary'
                  ? payload.data.versionId
                  : undefined,
              )
              .catch((err: unknown) => {
                logger.warn(
                  { err, documentId: row.documentId },
                  'knowledge document summary settle failed',
                );
              });
          }
          if (row.documentId !== null) {
            await repo.knowledge
              .settleProcessingDocument(db, row.documentId)
              .catch((err: unknown) => {
                logger.warn(
                  { err, documentId: row.documentId },
                  'knowledge document settle failed',
                );
              });
          }
          logger.warn({ jobId: row.id, error }, 'knowledge job reconciled as failed');
        }
      } catch (err) {
        logger.warn({ err, jobId: row.id }, 'knowledge job reconcile finish failed');
      }
      continue;
    }

    if (state !== null && isActiveJobState(state)) continue;
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

export async function startKnowledgeReconciler(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  redisUrl: string;
  prefix?: string;
}): Promise<() => Promise<void>> {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const queue = new Queue<KnowledgeJobQueuePayload>(KNOWLEDGE_JOBS_QUEUE, {
    connection,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  });
  queue.on('error', () => input.logger.warn('knowledge queue connection failed'));
  await queue.waitUntilReady();

  const stopTicker = startIntervalTicker(
    () =>
      reconcileKnowledgeJobs(input.db, input.logger, queue)
        .then(() => ensureDailyCleanup(input.db, input.logger, queue))
        .then(() => undefined)
        .catch((err: unknown) => {
          input.logger.error({ err }, 'knowledge reconcile failed');
        }),
    RECONCILE_MS,
  );

  return async () => {
    await stopTicker();
    await queue.close();
    await connection.quit();
  };
}
