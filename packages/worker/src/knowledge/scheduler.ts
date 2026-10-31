import { type createDb, repo, schema } from '@agentport/db';
import { KNOWLEDGE_JOBS_QUEUE, knowledgeEnqueueOptions } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
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
  if (source?.status !== 'active' || source.syncCron === null || source.syncCron === '') {
    return 'skipped';
  }

  const created = await repo.knowledge.createSyncJob(input.db, source.id);
  if (created.status === 'not_found' || created.status === 'not_active') return 'skipped';
  if (created.status === 'in_progress') return 'duplicate';

  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await input.queue.add(
        'knowledge',
        { jobId: created.job.id },
        knowledgeEnqueueOptions(created.job.id),
      );
      input.logger.info({ sourceId: source.id, jobId: created.job.id }, 'knowledge sync fired');
      return 'fired';
    } catch (err) {
      input.logger.warn({ err, sourceId: source.id, attempt }, 'knowledge sync enqueue failed');
    }
  }

  // 入队最终失败：只有仍为 queued 的 CAS 赢家能收口 job/run/source；已认领不覆盖。
  await repo.knowledge.finishJob(input.db, created.job.id, {
    fromStatus: 'queued',
    status: 'failed',
    error: '定时同步入队失败',
  });
  return 'failed';
}

/** 对账所需的队列子集；测试可注入故障而不关停共用 Redis。 */
export interface KnowledgeSchedulerQueue {
  getJobSchedulers(): Promise<Array<{ key: string; pattern?: string | null }>>;
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: 'UTC' },
    template: {
      name: string;
      data: { sourceId: string };
      opts: {
        attempts: number;
        backoff: { type: 'exponential'; delay: number };
        removeOnComplete: number;
        removeOnFail: number;
      };
    },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<unknown>;
}

/**
 * DB 是调度权威：只对 active 且 cron 非空的来源保留 scheduler。
 * 每个来源的移除/更新独立隔离；坏 cron 或 Redis 单项失败不阻断其他来源与回收。
 */
export async function syncKnowledgeSchedulers(input: {
  db: Db;
  logger: Logger;
  queue: KnowledgeSchedulerQueue;
}): Promise<void> {
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
    (await input.queue.getJobSchedulers())
      .filter((entry) => entry.key.startsWith(SCHEDULER_ID_PREFIX))
      .map((entry) => [entry.key, entry.pattern ?? null]),
  );
  for (const [id, cron] of desired) {
    if (existing.get(id) === cron) continue;
    const sourceId = id.slice(SCHEDULER_ID_PREFIX.length);
    let stage = 'remove';
    try {
      // 先移除旧 pattern，避免 DB 改成坏值后旧 cron 继续触发。
      if (existing.has(id)) await input.queue.removeJobScheduler(id);
      stage = 'upsert';
      const entry = await input.queue.upsertJobScheduler(
        id,
        { pattern: cron, tz: 'UTC' },
        {
          name: 'knowledge-sync',
          data: { sourceId },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        },
      );
      if (entry === undefined || entry === null)
        throw new Error('scheduler upsert returned no entry');
    } catch (err) {
      input.logger.warn(
        { err, sourceId, stage, pattern: cron },
        'knowledge scheduler update failed',
      );
    }
  }
  for (const id of existing.keys()) {
    if (desired.has(id)) continue;
    try {
      await input.queue.removeJobScheduler(id);
    } catch (err) {
      input.logger.warn({ err, schedulerId: id }, 'knowledge scheduler removal failed');
    }
  }
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
    await syncKnowledgeSchedulers({
      db: input.db,
      logger: input.logger,
      queue: queue as unknown as KnowledgeSchedulerQueue,
    });
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
