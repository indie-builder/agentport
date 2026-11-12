import type {
  AgentRunJob,
  ChannelEvent,
  ChannelMessage,
  ChatEvent,
  EvalRunJob,
  RuntimeEnvironmentBuildJob,
} from '@agentport/shared';
import {
  channelEventSchema,
  channelEventsConnectionName,
  channelStreamKey,
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
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import type { ZodType } from 'zod';

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
let client: RedisClient | undefined;
let channelClient: RedisClient | undefined;
let queueConnection: ReturnType<typeof createBunRedisClient> | undefined;

function getQueueConnection() {
  queueConnection ??= createBunRedisClient(new RedisClient(REDIS_URL));
  return queueConnection;
}

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(RUNS_QUEUE, { connection: getQueueConnection() });
    queue.on('error', logRedisError);
  }
  return queue;
}

export function getEvalQueue(): Queue<EvalRunJob> {
  if (!evalQueue) {
    evalQueue = new Queue<EvalRunJob>(EVAL_RUNS_QUEUE, { connection: getQueueConnection() });
    evalQueue.on('error', logRedisError);
  }
  return evalQueue;
}

/** 知识任务独立队列：与聊天 run 分开消费，不占 run 并发、不进运行历史。 */
export function getKnowledgeQueue(): Queue<{ jobId: string }> {
  if (!knowledgeQueue) {
    knowledgeQueue = new Queue<{ jobId: string }>(KNOWLEDGE_JOBS_QUEUE, {
      connection: getQueueConnection(),
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
      { connection: getQueueConnection() },
    );
    runtimeEnvironmentBuildQueue.on('error', logRedisError);
  }
  return runtimeEnvironmentBuildQueue;
}

function getClient(): RedisClient {
  if (!client) {
    client = new RedisClient(REDIS_URL);
    client.onclose = logRedisError;
  }
  return client;
}

function getChannelClient(): RedisClient {
  if (!channelClient) {
    channelClient = new RedisClient(REDIS_URL, {
      connectionTimeout: 1_000,
      idleTimeout: 1_000,
      autoReconnect: false,
    });
    channelClient.onclose = () => undefined;
  }
  return channelClient;
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

function parseEvent<T>(payload: string, schema: ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const parseChatEvent = (payload: string): ChatEvent | null => parseEvent(payload, chatEventSchema);
const parseChannelEvent = (payload: string): ChannelEvent | null =>
  parseEvent(payload, channelEventSchema);

export async function publishRun(runId: string, event: ChatEvent): Promise<void> {
  const redis = getClient();
  const key = runStreamKey(runId);
  await Promise.all([
    redis.send('XADD', [key, '*', 'payload', JSON.stringify(event)]),
    redis.expire(key, STREAM_TTL_SECONDS),
  ]);
}

/** 频道事件只做唤醒；订阅端按 DB 的 seq 补拉，不信任这里的正文。 */
export async function publishChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
  const redis = getChannelClient();
  if (!redis.connected) await redis.connect();
  const key = channelStreamKey(channelId);
  await Promise.all([
    redis.send('XADD', [key, '*', 'payload', JSON.stringify(event)]),
    redis.expire(key, STREAM_TTL_SECONDS),
  ]);
}

export async function publishChannelMessage(
  channelId: string,
  message: ChannelMessage,
): Promise<void> {
  return publishChannelEvent(channelId, {
    type: 'message.created',
    channelId,
    seq: message.seq,
    message,
  });
}

/**
 * running 运行的取消信号：只发通知，终态由 worker 停止容器、写完消息与产出后落库。
 * 键本身也是信号（worker 订阅后先查一次），`publish` 负责唤醒已订阅的 worker；
 * NX 让重复点击只写一条审计。
 */
export async function requestRunCancel(runId: string): Promise<boolean> {
  const redis = getClient();
  const key = runCancelKey(runId);
  const [setResult] = await Promise.all([
    redis.send('SET', [key, RUN_CANCEL_PAYLOAD, 'EX', String(STREAM_TTL_SECONDS), 'NX']),
    redis.publish(key, RUN_CANCEL_PAYLOAD),
  ]);
  return setResult !== null;
}

/** 挂起的工具调用据此在 worker 收尾前就停止等待。 */
export async function isRunCancelRequested(runId: string): Promise<boolean> {
  return await getClient().exists(runCancelKey(runId));
}

export interface RunSubscription {
  /** 从第一条事件开始回放，并在有新事件时继续推送。 */
  close: () => void;
}

/** 每个订阅独占连接；close() 时断开，避免一条连接的退出影响其他观众。 */
const subscriptions = new Map<RedisClient, () => void>();

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
  return subscribeStream(
    runStreamKey(runId),
    runEventsConnectionName(runId),
    parseChatEvent,
    { type: 'error', message: 'Server shutting down' },
    { type: 'error', message: '事件流中断，请刷新页面或重试' },
    cb,
    signal,
  );
}

export async function subscribeChannel(
  channelId: string,
  cb: (event: ChannelEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  return subscribeStream(
    channelStreamKey(channelId),
    channelEventsConnectionName(channelId),
    parseChannelEvent,
    { type: 'error', message: 'Server shutting down' },
    { type: 'error', message: '事件流中断，请刷新页面或重试' },
    cb,
    signal,
    getChannelClient(),
  );
}

async function subscribeStream<T>(
  key: string,
  connectionName: string,
  parse: (payload: string) => T | null,
  shutdownEvent: T,
  errorEvent: T,
  cb: (event: T) => void | Promise<void>,
  signal?: AbortSignal,
  replayClient?: RedisClient,
): Promise<RunSubscription> {
  if (signal?.aborted) return { close: () => undefined };
  let closed = false;
  let redis = new RedisClient(REDIS_URL);
  redis.onclose = (err) => {
    if (!closed) logRedisError(err);
  };
  let lastId = '0-0';

  const release = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    subscriptions.delete(redis);
    // QUIT 会排在阻塞中的 XREAD 后面等它返回，所以关闭必须直接断开连接。
    redis.onclose = () => undefined;
    redis.close();
  };
  const onAbort = (): void => release();
  signal?.addEventListener('abort', onAbort, { once: true });
  const shutdown = () => {
    // Shutdown must not wait for a stalled viewer to drain.
    void Promise.resolve(cb(shutdownEvent)).catch((err: unknown) => {
      logRedisError(err instanceof Error ? err : new Error(String(err)));
    });
    release();
  };
  subscriptions.set(redis, shutdown);

  try {
    await redis.send('CLIENT', ['SETNAME', connectionName]);
    let cursor = '0-0';
    for (;;) {
      if (closed) break;
      if (replayClient && !replayClient.connected) await replayClient.connect();
      const page: StreamEntry[] = await (replayClient ?? getClient()).send('XRANGE', [
        key,
        cursor,
        '+',
        'COUNT',
        String(READ_PAGE_SIZE),
      ]);
      for (const [id, fields] of page) {
        if (closed) break;
        lastId = id;
        const event = parse(payloadOf(fields) ?? '');
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

  void (async () => {
    try {
      while (!closed) {
        let reply: Record<string, StreamEntry[]> | null;
        try {
          if (!redis.connected) {
            await redis.connect();
            await redis.send('CLIENT', ['SETNAME', connectionName]);
          }
          reply = await redis.send('XREAD', [
            'COUNT',
            String(READ_PAGE_SIZE),
            'BLOCK',
            '0',
            'STREAMS',
            key,
            lastId,
          ]);
        } catch (err) {
          if (closed) return;
          if (err instanceof Error && 'code' in err && err.code === 'ERR_REDIS_SERVER_ERROR')
            throw err;
          logRedisError(err instanceof Error ? err : new Error(String(err)));
          subscriptions.delete(redis);
          redis.onclose = () => undefined;
          redis.close();
          redis = new RedisClient(REDIS_URL);
          redis.onclose = logRedisError;
          subscriptions.set(redis, shutdown);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        for (const batch of Object.values(reply ?? {})) {
          for (const [id, fields] of batch) {
            if (closed) return;
            lastId = id;
            const event = parse(payloadOf(fields) ?? '');
            if (event) await cb(event);
          }
        }
      }
    } catch (err) {
      if (!closed) {
        logRedisError(err instanceof Error ? err : new Error(String(err)));
        try {
          await cb(errorEvent);
        } finally {
          release();
        }
      }
    }
  })().catch(logRedisError);

  return { close: release };
}

export async function closeProducer(): Promise<void> {
  if (channelClient) channelClient.onclose = () => undefined;
  channelClient?.close();
  channelClient = undefined;
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
    ...[...subscriptions.values()].map((close) => close()),
  ]);
  if (closing[4]) closing[4].onclose = () => undefined;
  closing[4]?.close();
  await queueConnection?.quit();
  queueConnection = undefined;
  subscriptions.clear();
}
