import { repo, schema } from '@agentport/db';
import {
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { DelayedError, type Job, Queue, Worker } from 'bullmq';
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
  type SyncRunResult,
} from './ingestion.js';
import { createParsingAdapter } from './parsing-adapter.js';
import { runWikiGenerate, type WikiQueryFn } from './wiki.js';

type KnowledgeJobRow = typeof schema.knowledgeJobs.$inferSelect;

const CANCEL_POLL_MS = 1_000;
/**
 * 认领后崩溃的 worker 会把行留在 running，BullMQ 随后重投同一个 job。
 * 对账每 5 分钟扫描、宽限 5 分钟；1 分钟后重看一次即可接上退回的 queued。
 */
const REDELIVERY_DELAY_MS = 60_000;

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
 * 两者都只负责执行并返回 sync 结果；终态统一由 DB 仓库的 finishJob 原子提交。
 */
export async function dispatchKnowledgeJob(
  job: KnowledgeJobRow,
  deps: DispatchDeps,
): Promise<SyncRunResult | void> {
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
  // 关闭时 abort 活跃任务；否则 worker.close() 会等满任务超时（最长 2h）。
  const activeJobs = new Set<AbortController>();
  let closing = false;

  const dispatch: DispatchDeps = {
    ...deps,
    knowledgeDir: config.knowledgeDir,
    wikiModel: config.wikiModel,
    signal: new AbortController().signal,
    ...(config.queryFn === undefined ? {} : { queryFn: config.queryFn }),
  };

  const worker = new Worker(
    KNOWLEDGE_JOBS_QUEUE,
    async (job: Job<{ jobId: string }>, token?: string) => {
      const row = await repo.knowledge.claimJob(config.db, job.data.jobId);
      // 条件认领：重复投递、已取消或已完成时这里拿不到行。
      if (!row) {
        // 行仍是 running：崩溃 worker 已认领过，BullMQ 把同一个 job 重投了。
        // 直接返回会把它记 completed，任务再也不会执行；官方延后交还执行权，
        // 由 reconcile 把超期 running 退回 queued 后再认领（DelayedError 不消耗失败次数）。
        const existing = await repo.knowledge.getJob(config.db, job.data.jobId);
        if (existing?.status === 'running') {
          await job.moveToDelayed(Date.now() + REDELIVERY_DELAY_MS, token);
          throw new DelayedError();
        }
        return;
      }

      const controller = new AbortController();
      activeJobs.add(controller);
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
        // close 可能发生在认领期间：已经拿到的任务不再执行。
        if (closing) throw new KnowledgeCancelled();
        const result = await dispatchKnowledgeJob(row, { ...dispatch, signal: controller.signal });
        await finish(config.db, row, {
          status: 'succeeded',
          ...(result === undefined ? {} : { result }),
        });
      } catch (err) {
        if (closing) {
          // SIGTERM 中断不是用户取消，也不能算成功：退回 queued 并让 BullMQ 重试。
          await resetToQueued(config.db, row.id, 'worker shutting down');
          throw err;
        }
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
        activeJobs.delete(controller);
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
      // 先停止领取并 abort 活跃任务，再把关闭收尾；否则会等满任务硬超时才释放进程。
      closing = true;
      for (const controller of activeJobs) controller.abort();
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
 * 所有业务终态都经过 DB 仓库的 finishJob：job CAS、sync run、source 摘要与游标
 * 由同一事务提交；这里不再分别写 job/run/source。
 */
async function finish(
  db: KnowledgeDeps['db'],
  job: KnowledgeJobRow,
  input: { status: 'succeeded' | 'failed' | 'cancelled'; error?: string; result?: SyncRunResult },
): Promise<void> {
  await repo.knowledge.finishJob(db, job.id, input);
}
