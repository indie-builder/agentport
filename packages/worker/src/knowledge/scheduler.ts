import { type createDb, newId, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

/**
 * 轻触发队列：scheduler 的每次触发只带 sourceId，到点后由本模块创建
 * knowledge_sync_runs + knowledge_jobs 再投递到知识队列。
 * 不能直接在知识队列上重复使用同一个 DB job id：BullMQ 会把后续触发当成重复 job 丢掉。
 */
const KNOWLEDGE_SYNC_TRIGGERS_QUEUE = 'knowledge-sync-triggers';
const SCHEDULER_ID_PREFIX = 'knowledge-sync:';
const RECONCILE_MS = 5 * 60_000;
const ENQUEUE_ATTEMPTS = 3;

type Db = ReturnType<typeof createDb>['db'];

export interface KnowledgeJobsQueueLike {
  add: (
    name: 'knowledge',
    data: { jobId: string },
    opts: ReturnType<typeof knowledgeEnqueueOptions>,
  ) => Promise<unknown>;
}

export type KnowledgeSyncTriggerOutcome = 'fired' | 'skipped' | 'duplicate' | 'failed';

function schedulerId(sourceId: string): string {
  return `${SCHEDULER_ID_PREFIX}${sourceId}`;
}

/**
 * 一次定时触发：先重读库（陈旧触发不能复活已暂停/删除的来源），
 * 再用事务内 advisory lock 保证同一来源不会同时存在两个 queued/running 同步任务。
 */
export async function processKnowledgeSyncTrigger(
  input: { db: Db; logger: Logger; queue: KnowledgeJobsQueueLike },
  data: unknown,
): Promise<KnowledgeSyncTriggerOutcome> {
  const sourceId =
    data && typeof data === 'object' && 'sourceId' in data
      ? (data as { sourceId: unknown }).sourceId
      : null;
  if (typeof sourceId !== 'string' || sourceId === '') {
    input.logger.warn({ data }, 'skip knowledge sync trigger: invalid payload');
    return 'skipped';
  }

  const source = await repo.knowledge.getSource(input.db, sourceId);
  if (source?.status !== 'active' || source.syncCron === null) {
    return 'skipped';
  }

  const created = await input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${source.id}))`);
    const [active] = await tx
      .select({ id: schema.knowledgeJobs.id })
      .from(schema.knowledgeJobs)
      .where(
        and(
          eq(schema.knowledgeJobs.sourceId, source.id),
          inArray(schema.knowledgeJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    if (active) return null;

    const syncRunId = newId('knowledgeSyncRun');
    const jobId = newId('knowledgeJob');
    await tx.insert(schema.knowledgeSyncRuns).values({
      id: syncRunId,
      sourceId: source.id,
      status: 'queued',
      cursorBefore: source.cursor,
    });
    await tx.insert(schema.knowledgeJobs).values({
      id: jobId,
      type: 'sync',
      baseId: source.baseId,
      documentId: null,
      sourceId: source.id,
      status: 'queued',
      payload: { type: 'sync', sourceId: source.id, syncRunId },
    });
    return { jobId, syncRunId };
  });
  if (!created) return 'duplicate';

  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await input.queue.add(
        'knowledge',
        { jobId: created.jobId },
        knowledgeEnqueueOptions(created.jobId),
      );
      input.logger.info({ sourceId: source.id, jobId: created.jobId }, 'knowledge sync fired');
      return 'fired';
    } catch (err) {
      input.logger.warn({ err, sourceId: source.id, attempt }, 'knowledge sync enqueue failed');
    }
  }

  // 入队最终失败：只把仍 queued 的行收为 failed，sync run 同步收尾。
  await input.db
    .update(schema.knowledgeJobs)
    .set({ status: 'failed', error: '定时同步入队失败', endedAt: new Date() })
    .where(
      and(eq(schema.knowledgeJobs.id, created.jobId), eq(schema.knowledgeJobs.status, 'queued')),
    );
  await repo.knowledge.finishSyncRun(input.db, created.syncRunId, {
    status: 'failed',
    error: '定时同步入队失败',
  });
  return 'failed';
}

export interface KnowledgeScheduler {
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 定时同步的权威来源是 knowledge_sources.sync_cron：启动同步一次，之后每 5 分钟对账。
 * 只有 active 且 cron 非空的来源进入 Redis；暂停、cron 置空或删除都会移除旧 scheduler。
 */
export function startKnowledgeScheduler(input: {
  db: Db;
  logger: Logger;
  redisUrl: string;
  /** 测试用独立键前缀，避免对账删到同机真实 scheduler。 */
  prefix?: string;
}): KnowledgeScheduler {
  const connection = { url: input.redisUrl, maxRetriesPerRequest: null };
  const options = {
    connection,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  };
  const queue = new Queue<{ sourceId: string }>(KNOWLEDGE_SYNC_TRIGGERS_QUEUE, options);
  const jobsQueue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, options);
  const worker = new Worker<{ sourceId: string }>(
    KNOWLEDGE_SYNC_TRIGGERS_QUEUE,
    (job) =>
      processKnowledgeSyncTrigger(
        { db: input.db, logger: input.logger, queue: jobsQueue },
        job.data,
      ),
    { ...options, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    input.logger.error({ jobId: job?.id, err }, 'knowledge sync trigger failed');
  });
  queue.on('error', (err) => input.logger.error({ err }, 'knowledge sync queue error'));

  async function sync(): Promise<void> {
    const rows = await input.db
      .select({
        id: schema.knowledgeSources.id,
        cron: schema.knowledgeSources.syncCron,
        status: schema.knowledgeSources.status,
      })
      .from(schema.knowledgeSources);
    const desired = new Map(
      rows
        .filter((row) => row.status === 'active' && row.cron !== null && row.cron !== '')
        .map((row) => [schedulerId(row.id), row.cron as string]),
    );
    const existing = new Map(
      (await queue.getJobSchedulers())
        .filter((entry) => entry.key.startsWith(SCHEDULER_ID_PREFIX))
        .map((entry) => [entry.key, entry.pattern]),
    );
    for (const [id, cron] of desired) {
      if (existing.get(id) === cron) continue;
      await queue.upsertJobScheduler(
        id,
        { pattern: cron, tz: 'UTC' },
        {
          name: 'knowledge-sync',
          data: { sourceId: id.slice(SCHEDULER_ID_PREFIX.length) },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );
    }
    for (const id of existing.keys()) {
      if (!desired.has(id)) await queue.removeJobScheduler(id);
    }
  }

  const timer = setInterval(() => {
    void sync().catch((err: unknown) =>
      input.logger.error({ err }, 'knowledge scheduler sync failed'),
    );
  }, RECONCILE_MS);
  timer.unref();

  return {
    sync,
    close: async () => {
      clearInterval(timer);
      await worker.close();
      await jobsQueue.close();
      await queue.close();
    },
  };
}
