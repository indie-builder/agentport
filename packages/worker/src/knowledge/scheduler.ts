import { type createDb, repo, schema } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  KNOWLEDGE_SYNC_TRIGGERS_QUEUE,
  type KnowledgeJobQueuePayload,
  type KnowledgeSyncTriggerPayload,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { createBunRedisClient, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import { startIntervalTicker } from '../scheduling/interval-ticker.js';

const SCHEDULER_ID_PREFIX = 'knowledge-sync:';
const RECONCILE_MS = 5 * 60_000;
const ENQUEUE_ATTEMPTS = 3;

type Db = ReturnType<typeof createDb>['db'];

export interface KnowledgeJobsQueueLike {
  add: (
    name: 'knowledge',
    data: KnowledgeJobQueuePayload,
    opts: ReturnType<typeof knowledgeEnqueueOptions>,
  ) => Promise<unknown>;
}

type KnowledgeSyncTriggerOutcome = 'fired' | 'skipped' | 'duplicate' | 'failed';

function schedulerId(sourceId: string): string {
  return `${SCHEDULER_ID_PREFIX}${sourceId}`;
}

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

  await repo.knowledge.finishJob(input.db, created.job.id, {
    fromStatus: 'queued',
    status: 'failed',
    error: '定时同步入队失败',
  });
  return 'failed';
}

export interface KnowledgeSchedulerQueue {
  getJobSchedulers(): Promise<Array<{ key: string; pattern?: string | null }>>;
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: 'UTC' },
    template: {
      name: string;
      data: KnowledgeSyncTriggerPayload;
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

interface KnowledgeScheduler {
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

export function startKnowledgeScheduler(input: {
  db: Db;
  logger: Logger;
  redisUrl: string;
  /** 测试用独立键前缀，避免对账删到同机真实 scheduler。 */
  prefix?: string;
}): KnowledgeScheduler {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const options = {
    connection,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
  };
  const queue = new Queue<KnowledgeSyncTriggerPayload>(KNOWLEDGE_SYNC_TRIGGERS_QUEUE, options);
  const jobsQueue = new Queue<KnowledgeJobQueuePayload>(KNOWLEDGE_JOBS_QUEUE, options);
  const worker = new Worker<KnowledgeSyncTriggerPayload>(
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

  async function syncOnce(): Promise<void> {
    await syncKnowledgeSchedulers({
      db: input.db,
      logger: input.logger,
      queue: queue as unknown as KnowledgeSchedulerQueue,
    });
  }

  let inFlight: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = syncOnce()
      .catch((err: unknown) => {
        input.logger.error({ err }, 'knowledge scheduler sync failed');
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const stopTicker = startIntervalTicker(() => sync(), RECONCILE_MS);

  return {
    sync,
    close: async () => {
      await stopTicker();
      await worker.close();
      await jobsQueue.close();
      await queue.close();
      await connection.quit();
    },
  };
}
