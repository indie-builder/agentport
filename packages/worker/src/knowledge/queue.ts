import { repo, schema } from '@agentport/db';
import {
  KNOWLEDGE_JOB_TIMEOUT_MS,
  KNOWLEDGE_JOBS_QUEUE,
  type KnowledgeJobQueuePayload,
  knowledgeCancelKey,
  knowledgeEnqueueOptions,
} from '@agentport/shared';
import { createBunRedisClient, DelayedError, type Job, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { knowledgeConnectors } from './connector-adapter.js';
import type { ImageQueryFn } from './image-processing.js';
import {
  describeKnowledgeError,
  isRetryableKnowledgeError,
  KnowledgeCancelled,
  type KnowledgeDeps,
  type KnowledgeJobResult,
  runKnowledgeJob,
} from './ingestion.js';
import { createParsingAdapter } from './parsing-adapter.js';
import { runKnowledgeSummary } from './summary.js';
import { runKnowledgeTagging } from './tagging.js';
import { runWikiGenerate, type WikiQueryFn } from './wiki.js';

type KnowledgeJobRow = typeof schema.knowledgeJobs.$inferSelect;

const CANCEL_POLL_MS = 1_000;
const REDELIVERY_DELAY_MS = 60_000;

interface DispatchDeps extends KnowledgeDeps {
  knowledgeDir: string;
  wikiModel?: string | undefined;
  signal: AbortSignal;
  /** 测试替换 SDK；生产走官方 query。 */
  queryFn?: WikiQueryFn;
}

export async function dispatchKnowledgeJob(
  job: KnowledgeJobRow,
  deps: DispatchDeps,
): Promise<KnowledgeJobResult | undefined> {
  if (job.type === 'wiki_generate') {
    await runWikiGenerate(job, {
      db: deps.db,
      config: {
        KNOWLEDGE_DIR: deps.knowledgeDir,
        KNOWLEDGE_WIKI_MODEL: deps.wikiModel,
        ANTHROPIC_BASE_URL: deps.anthropicBaseUrl,
      },
      signal: deps.signal,
      ...(deps.queryFn === undefined ? {} : { queryFn: deps.queryFn }),
    });
    return;
  }
  if (job.type === 'summary') {
    await runKnowledgeSummary(job, {
      db: deps.db,
      config: {
        KNOWLEDGE_DIR: deps.knowledgeDir,
        KNOWLEDGE_SUMMARY_MODEL: deps.summaryModel,
        ANTHROPIC_BASE_URL: deps.anthropicBaseUrl,
      },
      signal: deps.signal,
      ...(deps.queryFn === undefined ? {} : { queryFn: deps.queryFn }),
    });
    return;
  }
  if (job.type === 'tag_generate') {
    await runKnowledgeTagging(job, {
      db: deps.db,
      config: {
        KNOWLEDGE_DIR: deps.knowledgeDir,
        KNOWLEDGE_SUMMARY_MODEL: deps.summaryModel,
      },
      signal: deps.signal,
      ...(deps.queryFn === undefined ? {} : { queryFn: deps.queryFn }),
    });
    return;
  }
  return runKnowledgeJob(deps, job, deps.signal);
}

interface KnowledgeWorkerConfig {
  db: KnowledgeDeps['db'];
  logger: Logger;
  redisUrl: string;
  knowledgeDir: string;
  decrypt: (payload: string) => Record<string, string>;
  /** Wiki 生成使用的模型；未配置时 wiki 任务会明确失败。 */
  wikiModel?: string | undefined;
  /** 文档摘要使用的模型；未配置时摘要任务会明确失败。 */
  summaryModel?: string | undefined;
  anthropicBaseUrl: string | undefined;
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

export async function startKnowledgeWorker(
  config: KnowledgeWorkerConfig,
): Promise<{ close: () => Promise<void> }> {
  const parsing = createParsingAdapter({
    parserUrl: config.parser?.url,
    parserKey: config.parser?.key,
  });
  const connection = createBunRedisClient(new RedisClient(config.redisUrl));
  const followups = new Queue<KnowledgeJobQueuePayload>(KNOWLEDGE_JOBS_QUEUE, {
    connection,
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
    summaryModel: config.summaryModel,
    onSummaryJobs: async ({ jobIds }) => {
      for (const jobId of jobIds) {
        await followups.add('knowledge', { jobId }, knowledgeEnqueueOptions(jobId));
      }
    },
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(config.imageQueryFn === undefined ? {} : { imageQueryFn: config.imageQueryFn }),
    anthropicBaseUrl: config.anthropicBaseUrl,
  };
  const scanner = new RedisClient(config.redisUrl);
  scanner.onclose = (err) => config.logger.warn({ err }, 'knowledge cancel watch error');
  const activeJobs = new Set<AbortController>();
  let closing = false;

  const dispatch: Omit<DispatchDeps, 'signal'> = {
    ...deps,
    knowledgeDir: config.knowledgeDir,
    wikiModel: config.wikiModel,
    ...(config.queryFn === undefined ? {} : { queryFn: config.queryFn }),
  };

  const worker = new Worker(
    KNOWLEDGE_JOBS_QUEUE,
    async (job: Job<KnowledgeJobQueuePayload>, token?: string) => {
      const row = await repo.knowledge.claimJob(config.db, job.data.jobId);
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
      }, KNOWLEDGE_JOB_TIMEOUT_MS[row.type]);
      const cancelWatch = setInterval(() => {
        void scanner
          .get(knowledgeCancelKey(row.id))
          .then((value) => {
            if (value !== null) controller.abort();
          })
          .catch(() => undefined);
      }, CANCEL_POLL_MS);

      let terminal = false;
      try {
        const pendingCancel = (await scanner.get(knowledgeCancelKey(row.id))) !== null;
        if (closing || pendingCancel || controller.signal.aborted) throw new KnowledgeCancelled();
        const result = await dispatchKnowledgeJob(row, { ...dispatch, signal: controller.signal });
        const cancelRequested = (await scanner.get(knowledgeCancelKey(row.id))) !== null;
        if (cancelRequested || controller.signal.aborted) {
          throw new KnowledgeCancelled();
        }
        terminal = await finish(config.db, row, {
          status: 'succeeded',
          ...result,
        });
      } catch (err) {
        if (closing) {
          await resetToQueued(config.db, row.id, 'worker shutting down');
          throw err;
        }
        if (controller.signal.aborted || err instanceof KnowledgeCancelled) {
          terminal = await finish(config.db, row, {
            status: timedOut ? 'failed' : 'cancelled',
            error: timedOut ? '任务超时' : 'cancelled',
          });
          return;
        }
        const error = describeKnowledgeError(err);
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (isRetryableKnowledgeError(err) && !lastAttempt) {
          await resetToQueued(config.db, row.id, error);
          throw err;
        }
        terminal = await finish(config.db, row, { status: 'failed', error });
      } finally {
        activeJobs.delete(controller);
        clearTimeout(timeout);
        clearInterval(cancelWatch);
        if (terminal) await scanner.del(knowledgeCancelKey(row.id)).catch(() => undefined);
      }
    },
    {
      connection,
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      concurrency: 2,
    },
  );
  worker.on('failed', (job, err) => {
    config.logger.warn({ jobId: job?.id, err }, 'knowledge job failed');
  });

  return {
    close: async () => {
      closing = true;
      for (const controller of activeJobs) controller.abort();
      await worker.close();
      await followups.close();
      await connection.quit();
      scanner.onclose = () => undefined;
      scanner.close();
    },
  };
}

async function resetToQueued(db: KnowledgeDeps['db'], jobId: string, error: string): Promise<void> {
  await db
    .update(schema.knowledgeJobs)
    .set({ status: 'queued', step: null, error })
    .where(and(eq(schema.knowledgeJobs.id, jobId), eq(schema.knowledgeJobs.status, 'running')));
}

async function finish(
  db: KnowledgeDeps['db'],
  job: KnowledgeJobRow,
  input: repo.knowledge.FinishJobInput,
): Promise<boolean> {
  return (await repo.knowledge.finishJob(db, job.id, input)) !== null;
}
