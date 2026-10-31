import type {
  AgentRunJob,
  ChatEvent,
  EvalRunJob,
  RuntimeEnvironmentBuildJob,
} from '@agentport/shared';
import {
  chatEventSchema,
  EVAL_RUNS_QUEUE,
  KNOWLEDGE_CANCEL_PAYLOAD,
  KNOWLEDGE_JOBS_QUEUE,
  knowledgeCancelKey,
  RUN_CANCEL_PAYLOAD,
  RUNS_QUEUE,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  runCancelKey,
  runEventsConnectionName,
  runStreamKey,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * 事件通道用 Redis Stream 而不是 pub/sub：
 * pub/sub 在订阅建立前发出的事件会永久丢失（客户端从 POST 到建连之间常见）。
 * Stream 允许从 0 回放；每次发布刷新 TTL，超过 1 小时没有任何新事件时整条流过期。
 */
const STREAM_TTL_SECONDS = 3600;

/**
 * 每次 XRANGE/XREAD 的条数上限。首次回放从流头逐页读完，COUNT 2 只限制单页驻留，
 * 不限制整条流；单条事件本身可能超过 8MiB（run_finished 的 canonical），
 * 所以这里不给整轮回放设累计字节或内存上界。
 */
const READ_PAGE_SIZE = 2;

type StreamEntry = [string, string[]];

function payloadOf(fields: string[]): string | undefined {
  const index = fields.indexOf('payload');
  return index >= 0 ? fields[index + 1] : undefined;
}

function logRedisError(err: Error): void {
  process.stderr.write(`[queue] redis error: ${err.message}\n`);
}

let queue: Queue<AgentRunJob> | undefined;
let evalQueue: Queue<EvalRunJob> | undefined;
let knowledgeQueue: Queue<{ jobId: string }> | undefined;
let runtimeEnvironmentBuildQueue: Queue<RuntimeEnvironmentBuildJob> | undefined;
let client: Redis | undefined;

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: { url: REDIS_URL } });
    queue.on('error', logRedisError);
  }
  return queue;
}

export function getEvalQueue(): Queue<EvalRunJob> {
  if (!evalQueue) {
    evalQueue = new Queue<EvalRunJob>(EVAL_RUNS_QUEUE, { connection: { url: REDIS_URL } });
    evalQueue.on('error', logRedisError);
  }
  return evalQueue;
}

/** 知识任务独立队列：与聊天 run 分开消费，不占 run 并发、不进运行历史。 */
export function getKnowledgeQueue(): Queue<{ jobId: string }> {
  if (!knowledgeQueue) {
    knowledgeQueue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: { url: REDIS_URL },
    });
    knowledgeQueue.on('error', logRedisError);
  }
  return knowledgeQueue;
}

/** 构建任务独立队列：与聊天 run 分开消费，不占运行并发；jobId = versionId。 */
export function getRuntimeEnvironmentBuildQueue(): Queue<RuntimeEnvironmentBuildJob> {
  if (!runtimeEnvironmentBuildQueue) {
    runtimeEnvironmentBuildQueue = new Queue<RuntimeEnvironmentBuildJob>(
      RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
      { connection: { url: REDIS_URL } },
    );
    runtimeEnvironmentBuildQueue.on('error', logRedisError);
  }
  return runtimeEnvironmentBuildQueue;
}

function getClient(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    client.on('error', logRedisError);
  }
  return client;
}

/** 运行中的知识任务：worker 每秒轮询该键，非空即 abort；键由 worker 收尾时删除。 */
export async function publishKnowledgeCancel(jobId: string): Promise<void> {
  await getClient().set(
    knowledgeCancelKey(jobId),
    KNOWLEDGE_CANCEL_PAYLOAD,
    'EX',
    STREAM_TTL_SECONDS,
  );
}

function parseEvent(payload: string): ChatEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = chatEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * pipeline.exec() 不会因单条命令失败而 reject，只逐命令返回 [error, result]；
 * 这里必须检查每一条，否则写入失败会被当成成功。
 */
function throwOnCommandError(results: [Error | null, unknown][] | null): void {
  for (const [err] of results ?? []) {
    if (err) throw err;
  }
}

export async function publishRun(runId: string, event: ChatEvent): Promise<void> {
  const redis = getClient();
  const key = runStreamKey(runId);
  // 事件流不会被读取者删除（可回放），单独给 TTL 兜底；两条命令合成一次往返。
  throwOnCommandError(
    await redis
      .pipeline()
      .xadd(key, '*', 'payload', JSON.stringify(event))
      .expire(key, STREAM_TTL_SECONDS)
      .exec(),
  );
}

/**
 * running 运行的取消信号：只发通知，终态由 worker 停止容器、写完消息与产出后落库。
 * 键本身也是信号（worker 订阅后先查一次），`publish` 负责唤醒已订阅的 worker；
 * NX 让重复点击只写一条审计。
 */
export async function requestRunCancel(runId: string): Promise<boolean> {
  const redis = getClient();
  const key = runCancelKey(runId);
  const replies = await redis
    .pipeline()
    .set(key, RUN_CANCEL_PAYLOAD, 'EX', STREAM_TTL_SECONDS, 'NX')
    .publish(key, RUN_CANCEL_PAYLOAD)
    .exec();
  throwOnCommandError(replies);
  // SET NX 已有键时返回 null：这次没有真正发出新信号。
  const setResult = replies?.[0]?.[1];
  return setResult !== null && setResult !== undefined;
}

/** 挂起的工具调用据此在 worker 收尾前就停止等待。 */
export async function isRunCancelRequested(runId: string): Promise<boolean> {
  return (await getClient().exists(runCancelKey(runId))) === 1;
}

export interface RunSubscription {
  /** 从第一条事件开始回放，并在有新事件时继续推送。 */
  close: () => void;
}

/** 每个订阅独占连接；close() 时断开，避免一条连接的退出影响其他观众。 */
const subscriptions = new Map<Redis, () => void>();

/**
 * 从流头回放并持续跟进：首次回放从 0-0 正序逐页读完（COUNT 2 限制单页驻留），
 * 随后用阻塞 XREAD 从最后一条真实 ID 继续：不用消费组（多观众各自回放），
 * 也不用 `$`（会跳过阻塞前到达的事件）。
 * 回放完成后 subscribeRun 才 resolve，调用方在拿到订阅后补发终态不会截断回放。
 * 回调可以返回 Promise：写端背压时循环会停下等待，而不是在内存里堆事件。
 * 客户端断开时只需 close()（或 abort signal），不删除流（其他客户端还能回放）。
 */
export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  if (signal?.aborted) return { close: () => undefined };
  const key = runStreamKey(runId);
  let closed = false;
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    connectionName: runEventsConnectionName(runId),
  });
  redis.on('error', (err) => {
    // 主动断开会打断在途的 XREAD，连接关闭后的 EPIPE 属于预期。
    if (!closed) logRedisError(err);
  });
  let lastId = '0-0';

  const release = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    subscriptions.delete(redis);
    // QUIT 会排在阻塞中的 XREAD 后面等它返回，所以关闭必须直接断开连接。
    redis.disconnect();
  };
  const onAbort = (): void => release();
  signal?.addEventListener('abort', onAbort, { once: true });
  subscriptions.set(redis, () => {
    // Shutdown must not wait for a stalled viewer to drain.
    void Promise.resolve(cb({ type: 'error', message: 'Server shutting down' })).catch(
      (err: unknown) => {
        logRedisError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    release();
  });

  try {
    let cursor = '0-0';
    for (;;) {
      if (closed) break;
      const page = (await getClient().xrange(
        key,
        cursor,
        '+',
        'COUNT',
        READ_PAGE_SIZE,
      )) as StreamEntry[];
      for (const [id, fields] of page) {
        if (closed) break;
        lastId = id;
        const event = parseEvent(payloadOf(fields) ?? '');
        if (event) await cb(event);
      }
      if (closed || page.length < READ_PAGE_SIZE) break;
      const newest = page.at(-1)?.[0];
      if (newest === undefined) break;
      cursor = `(${newest}`;
    }
  } catch (err) {
    release();
    throw err;
  }

  if (closed) return { close: release };

  // 回放完成后调用方不再等这个函数；跟读阶段的错误只能记录并释放，不能抛出。
  // 终端错误（握手/鉴权失败等）向观众发一条 error，让 SSE 正常收尾而不是静默卡住；
  // 闪断由 ioredis 自动重连并从 lastId 续读，不会进这里。
  void (async () => {
    try {
      while (!closed) {
        const reply = (await redis.xread(
          'COUNT',
          READ_PAGE_SIZE,
          'BLOCK',
          0,
          'STREAMS',
          key,
          lastId,
        )) as Array<[string, StreamEntry[]]> | null;
        for (const [, batch] of reply ?? []) {
          for (const [id, fields] of batch) {
            if (closed) return;
            lastId = id;
            const event = parseEvent(payloadOf(fields) ?? '');
            if (event) await cb(event);
          }
        }
      }
    } catch (err) {
      // close() 主动断开连接会让在途的 XREAD 失败，属于预期。
      if (!closed) {
        logRedisError(err instanceof Error ? err : new Error(String(err)));
        try {
          await cb({ type: 'error', message: '事件流中断，请刷新页面或重试' });
        } catch {
          // 观众写入失败时仍要释放连接。
        }
        release();
      }
    }
  })();

  return { close: release };
}

export async function closeProducer(): Promise<void> {
  const closing = [queue, evalQueue, knowledgeQueue, runtimeEnvironmentBuildQueue, client] as const;
  queue = undefined;
  evalQueue = undefined;
  knowledgeQueue = undefined;
  runtimeEnvironmentBuildQueue = undefined;
  client = undefined;
  await Promise.allSettled([
    closing[0]?.close(),
    closing[1]?.close(),
    closing[2]?.close(),
    closing[3]?.close(),
    closing[4]?.quit(),
    ...[...subscriptions.values()].map((close) => close()),
  ]);
  subscriptions.clear();
}
