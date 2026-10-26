import { repo, schema } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { knowledgeConnectors } from './connector-adapter.js';
import type { ImageQueryFn } from './image-processing.js';
import {
  describeKnowledgeError,
  isRetryableKnowledgeError,
  KnowledgeCancelled,
  type KnowledgeDeps,
  runKnowledgeJob,
} from './ingestion.js';
import { createParsingAdapter } from './parsing-adapter.js';
import { runWikiGenerate, type WikiQueryFn } from './wiki.js';

type KnowledgeJobRow = typeof schema.knowledgeJobs.$inferSelect;

const CANCEL_POLL_MS = 1_000;

/** 各任务类型的硬超时；超时按失败收尾，保留游标与旧版本。 */
export const KNOWLEDGE_TIMEOUT_MS: Record<KnowledgeJobRow['type'], number> = {
  ingest: 30 * 60_000,
  sync: 30 * 60_000,
  reindex: 2 * 60 * 60_000,
  wiki_generate: 15 * 60_000,
  cleanup: 30 * 60_000,
};

/** 分派所需依赖；队列与测试共用同一份判定。 */
export interface DispatchDeps extends KnowledgeDeps {
  knowledgeDir: string;
  wikiModel?: string | undefined;
  signal: AbortSignal;
  /** 测试替换 SDK；生产走官方 query。 */
  queryFn?: WikiQueryFn;
}

/**
 * 按任务类型分派：wiki_generate 走 SDK 生成器，其余走摄取链。
 * 两者都只负责执行与保存；终态统一由队列写入。
 */
export async function dispatchKnowledgeJob(
  job: KnowledgeJobRow,
  deps: DispatchDeps,
): Promise<void> {
  if (job.type === 'wiki_generate') {
    return runWikiGenerate(job, {
      db: deps.db,
      config: {
        KNOWLEDGE_DIR: deps.knowledgeDir,
        KNOWLEDGE_WIKI_MODEL: deps.wikiModel,
      },
      signal: deps.signal,
      ...(deps.queryFn === undefined ? {} : { queryFn: deps.queryFn }),
    });
  }
  return runKnowledgeJob(deps, job, deps.signal);
}

export interface KnowledgeWorkerConfig {
  db: KnowledgeDeps['db'];
  logger: Logger;
  redisUrl: string;
  knowledgeDir: string;
  decrypt: (payload: string) => Record<string, string>;
  /** Wiki 生成使用的模型；未配置时 wiki 任务会明确失败。 */
  wikiModel?: string | undefined;
  /** Docling 端点与密钥；不配置时二进制格式会明确失败而不是静默降级。 */
  parser?: { url?: string | undefined; key?: string | undefined } | undefined;
  /** KNOWLEDGE_PRIVATE_HOST_ALLOWLIST 解析后的可信私网主机。 */
  trustedHosts?: readonly string[] | undefined;
  /** 本地 fixture 仅用；production 仍拒绝 loopback。 */
  allowLoopback?: boolean | undefined;
  /** 测试替换 SDK query；不改变生产调用路径。 */
  queryFn?: WikiQueryFn | undefined;
  /** 图片 OCR/描述同样走官方 query；真实运行不传，默认使用 query。 */
  imageQueryFn?: ImageQueryFn | undefined;
  /** 测试用独立键前缀，避免消费同机真实知识队列。 */
  prefix?: string | undefined;
  /** 覆盖自动装配的解析/来源适配（既有测试仍用注入）。 */
  parse?: KnowledgeDeps['parse'] | undefined;
  chunkMarkdown?: KnowledgeDeps['chunkMarkdown'] | undefined;
  connectors?: KnowledgeDeps['connectors'] | undefined;
}

/**
 * 独立队列：与聊天 run 分开消费，知识任务不占 run 并发、不出现在运行历史。
 * 返回 close 供进程收尾；调度与对账分别由 scheduler.ts / reconcile.ts 启动。
 */
export async function startKnowledgeWorker(
  config: KnowledgeWorkerConfig,
): Promise<{ close: () => Promise<void> }> {
  const parsing = createParsingAdapter({
    parserUrl: config.parser?.url,
    parserKey: config.parser?.key,
  });
  const followups = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
    connection: { url: config.redisUrl },
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
  });
  followups.on('error', (err) => config.logger.warn({ err }, 'knowledge follow-up enqueue error'));
  const deps: KnowledgeDeps = {
    db: config.db,
    logger: config.logger,
    knowledgeDir: config.knowledgeDir,
    parse: config.parse ?? parsing.parse,
    chunkMarkdown: config.chunkMarkdown ?? parsing.chunkMarkdown,
    connectors: config.connectors ?? knowledgeConnectors,
    decrypt: config.decrypt,
    onWikiUpdate: async ({ jobIds }) => {
      for (const jobId of jobIds) {
        await followups.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      }
    },
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(config.imageQueryFn === undefined ? {} : { imageQueryFn: config.imageQueryFn }),
  };
  const scanner = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  scanner.on('error', (err) => config.logger.warn({ err }, 'knowledge cancel watch error'));

  const dispatch: DispatchDeps = {
    ...deps,
    knowledgeDir: config.knowledgeDir,
    wikiModel: config.wikiModel,
    signal: new AbortController().signal,
    ...(config.queryFn === undefined ? {} : { queryFn: config.queryFn }),
  };

  const worker = new Worker(
    KNOWLEDGE_JOBS_QUEUE,
    async (job: Job<{ jobId: string }>) => {
      const row = await repo.knowledge.claimJob(config.db, job.data.jobId);
      // 条件认领：重复投递、已取消或已完成时这里拿不到行，直接跳过。
      if (!row) return;

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, KNOWLEDGE_TIMEOUT_MS[row.type]);
      const cancelWatch = setInterval(() => {
        // 运行中取消走 Redis 键；任务已取消后 API 不再写 job 行。
        void scanner
          .get(knowledgeCancelKey(row.id))
          .then((value) => {
            if (value !== null) controller.abort();
          })
          .catch(() => undefined);
      }, CANCEL_POLL_MS);

      try {
        await dispatchKnowledgeJob(row, { ...dispatch, signal: controller.signal });
        await finish(config.db, row, { status: 'succeeded' });
      } catch (err) {
        if (controller.signal.aborted || err instanceof KnowledgeCancelled) {
          await finish(config.db, row, {
            status: timedOut ? 'failed' : 'cancelled',
            error: timedOut ? '任务超时' : 'cancelled',
          });
          return;
        }
        const error = describeKnowledgeError(err);
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (isRetryableKnowledgeError(err) && !lastAttempt) {
          // 回到 queued 才能被下一次投递重新条件认领；否则会卡在 running 被跳过。
          // 同步任务的 run 保持 running：重试仍会写同一个 syncRunId。
          await resetToQueued(config.db, row.id, error);
          throw err;
        }
        await finish(config.db, row, { status: 'failed', error });
      } finally {
        clearTimeout(timeout);
        clearInterval(cancelWatch);
        await scanner.del(knowledgeCancelKey(row.id)).catch(() => undefined);
      }
    },
    {
      connection: { url: config.redisUrl },
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      concurrency: 2,
    },
  );
  worker.on('failed', (job, err) => {
    config.logger.warn({ jobId: job?.id, err }, 'knowledge job failed');
  });

  return {
    close: async () => {
      await worker.close();
      await followups.close();
      scanner.disconnect();
    },
  };
}

async function resetToQueued(db: KnowledgeDeps['db'], jobId: string, error: string): Promise<void> {
  await db
    .update(schema.knowledgeJobs)
    .set({ status: 'queued', step: null, error })
    .where(and(eq(schema.knowledgeJobs.id, jobId), eq(schema.knowledgeJobs.status, 'running')));
}

/**
 * 队列是终态的唯一写入方。同步任务在摄取链路中途抛错（来源已删、范围为空等）时
 * sync run 仍停在 queued/running，这里一并收尾，避免前端一直显示进行中。
 */
async function finish(
  db: KnowledgeDeps['db'],
  job: KnowledgeJobRow,
  input: { status: 'succeeded' | 'failed' | 'cancelled'; error?: string },
): Promise<void> {
  const finished = await repo.knowledge.finishJob(db, job.id, input);
  if (!finished || job.type !== 'sync') return;
  const payload = knowledgeJobPayloadSchema.safeParse(job.payload);
  if (!payload.success || payload.data.type !== 'sync') return;
  // 摄取链路已正常收尾（成功/失败/取消）时 run 已是终态，这里不重复写。
  const [run] = await db
    .select({ status: schema.knowledgeSyncRuns.status })
    .from(schema.knowledgeSyncRuns)
    .where(eq(schema.knowledgeSyncRuns.id, payload.data.syncRunId))
    .limit(1);
  if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
  await repo.knowledge.finishSyncRun(db, payload.data.syncRunId, {
    status: input.status,
    error: input.error ?? null,
  });
  await repo.knowledge.updateSource(db, payload.data.sourceId, {
    lastSyncAt: new Date(),
    lastSyncStatus: input.status,
    lastError: input.error ?? null,
  });
}
