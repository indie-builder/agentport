import type { AgentRunJob, ChatEvent, EvalRunJob } from '@agentport/shared';
import {
  chatEventSchema,
  EVAL_RUNS_QUEUE,
  RUN_CANCEL_PAYLOAD,
  RUN_STREAM_MAXLEN,
  RUNS_QUEUE,
  runCancelKey,
  runChannel,
  runStreamKey,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export { RUNS_QUEUE as QUEUE_NAME } from '@agentport/shared';

/** worker 用 ChatEvent 回传，API 用 cancel 通知 worker 终止。 */
export type RunSignal = ChatEvent | { type: 'cancel' };

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * 事件通道用 Redis Stream 而不是 pub/sub：
 * pub/sub 在订阅建立前发出的事件会永久丢失（客户端从 POST 到建连之间常见）。
 * Stream 允许从 0 回放，且由 TTL 清理，不需要额外维护。
 */
const STREAM_TTL_SECONDS = 3600;

/** 首次回放只补发最近的 8MiB，晚加入的观众不会把整条流拉进内存。 */
const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** 每次 XRANGE/XREVRANGE 的条数上限：事件再大，单次读取也是有界的。 */
const READ_PAGE_SIZE = 1;

type StreamEntry = [string, string[]];

function payloadOf(fields: string[]): string | undefined {
  const index = fields.indexOf('payload');
  return index >= 0 ? fields[index + 1] : undefined;
}

/**
 * 从最新一条往前分页读，直到 8MiB 或流头；返回按时间正序的事件。
 * 触发上限时 truncated 为真，由调用方补一条截断标记。
 */
async function readLatest(
  redis: Redis,
  key: string,
): Promise<{ entries: StreamEntry[]; newestId: string | undefined; truncated: boolean }> {
  const newestFirst: StreamEntry[] = [];
  let newestId: string | undefined;
  let cursor = '+';
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const page = (await redis.xrevrange(
      key,
      cursor,
      '-',
      'COUNT',
      READ_PAGE_SIZE,
    )) as StreamEntry[];
    newestId ??= page[0]?.[0];
    for (const entry of page) {
      bytes += Buffer.byteLength(payloadOf(entry[1]) ?? '');
      if (bytes > REPLAY_MAX_BYTES) {
        truncated = true;
        break;
      }
      newestFirst.push(entry);
    }
    if (truncated || page.length < READ_PAGE_SIZE) break;
    const oldest = page.at(-1)?.[0];
    if (oldest === undefined) break;
    cursor = `(${oldest}`;
  }
  return { entries: newestFirst.reverse(), newestId, truncated };
}

function logRedisError(err: Error): void {
  process.stderr.write(`[queue] redis error: ${err.message}\n`);
}

let queue: Queue<AgentRunJob> | undefined;
let evalQueue: Queue<EvalRunJob> | undefined;
let client: Redis | undefined;
let subscriber: Redis | undefined;

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

function getClient(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    client.on('error', logRedisError);
  }
  return client;
}

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    subscriber.on('error', logRedisError);
  }
  return subscriber;
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

export async function publishRun(runId: string, event: RunSignal): Promise<void> {
  // cancel 走独立键：它不是 ChatEvent，也不该出现在事件流里被前端看到。
  if (event.type === 'cancel') {
    await getClient().set(runCancelKey(runId), RUN_CANCEL_PAYLOAD, 'EX', STREAM_TTL_SECONDS);
    await getClient().publish(runCancelKey(runId), RUN_CANCEL_PAYLOAD);
    return;
  }

  const redis = getClient();
  await redis.xadd(
    runStreamKey(runId),
    'MAXLEN',
    '~',
    RUN_STREAM_MAXLEN,
    '*',
    'payload',
    JSON.stringify(event),
  );
  // 事件流不会被读取者删除（可回放），单独给 TTL 兜底。
  await redis.expire(runStreamKey(runId), STREAM_TTL_SECONDS);

  // 唤醒正在 XREAD BLOCK 的订阅者。
  await redis.publish(runChannel(runId), '1');
}

export interface RunSubscription {
  /** 从第一条事件开始回放，并在有新事件时继续推送。 */
  close: () => void;
}

/** 每个订阅独占连接；close() 时 quit，避免一条连接的退订影响其他观众。 */
const subscriptions = new Map<Redis, () => Promise<void>>();

/**
 * 从流头回放并持续跟进。首次只回放最近 8MiB（超出时补一条截断标记），
 * 之后按 READ_PAGE_SIZE 分页跟随，不会一次把整条流读进内存。
 * 回调可以返回 Promise：写端背压时 drain 会停下等待，而不是在内存里堆事件。
 * 客户端断开时只需 close()（或 abort signal），不删除流（其他客户端还能回放）。
 */
export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubscription> {
  if (signal?.aborted) return { close: () => undefined };
  const redis = getSubscriber().duplicate();
  redis.on('error', logRedisError);
  // 订阅连接只跑 pub/sub；范围读取走共享的普通连接，避免订阅态下执行 XRANGE。
  const reader = getClient();
  const wakeChannel = runChannel(runId);
  const key = runStreamKey(runId);
  let closed = false;
  let lastId = '0-0';
  const drain = async (): Promise<void> => {
    while (!closed) {
      const start = lastId === '0-0' ? '-' : `(${lastId}`;
      const entries = (await reader.xrange(
        key,
        start,
        '+',
        'COUNT',
        READ_PAGE_SIZE,
      )) as StreamEntry[];
      for (const [id, fields] of entries) {
        if (closed) return;
        lastId = id;
        const event = parseEvent(payloadOf(fields) ?? '');
        if (event) await cb(event);
      }
      if (entries.length < READ_PAGE_SIZE) return;
    }
  };

  // 唤醒只是提示；drain 进行中收到的新唤醒只记一个 pending 标志，
  // 由同一个循环补跑，不会把 Promise 链越接越长。
  // 初始回放完成前不跟读，否则增量 drain 会用 lastId='0-0' 把整条流再读一遍。
  let ready = false;
  let draining = false;
  let pending = false;
  const kick = (): void => {
    if (!ready) return;
    pending = true;
    if (draining || closed) return;
    draining = true;
    void (async () => {
      try {
        while (pending && !closed) {
          pending = false;
          await drain();
        }
      } catch (err) {
        // close() 时 quit 会让在途的 XRANGE 失败，属于预期。
        if (!closed) logRedisError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        draining = false;
      }
    })();
  };

  const handler = (incoming: string): void => {
    if (incoming !== wakeChannel) return;
    kick();
  };

  // 唤醒可能落在两次 drain 之间被合并，最后一批事件会等不到新唤醒；
  // 低频轮询兜底（流有 1000 条上限，代价可忽略）。
  // shortcut: 2s 的补投延迟，需要更实时时改成阻塞的 XREAD。
  const poll = setInterval(kick, 2_000);
  poll.unref();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    closed = true;
    clearInterval(poll);
    signal?.removeEventListener('abort', onAbort);
    redis.off('message', handler);
    subscriptions.delete(redis);
    if (redis.status !== 'end') await redis.quit().catch(logRedisError);
  };
  const onAbort = (): void => {
    void release();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  subscriptions.set(redis, async () => {
    try {
      // Shutdown must not wait for a stalled viewer to drain.
      void Promise.resolve(cb({ type: 'error', message: 'Server shutting down' })).catch(
        (err: unknown) => {
          logRedisError(err instanceof Error ? err : new Error(String(err)));
        },
      );
    } finally {
      await release();
    }
  });

  // 先订阅再回放：回放按 id 继续，订阅前/回放期间到达的事件都不会丢。
  try {
    await redis.subscribe(wakeChannel);
    redis.on('message', handler);
    const { entries, newestId, truncated } = await readLatest(reader, key);
    if (newestId !== undefined) lastId = newestId;
    if (truncated && !closed) {
      await cb({ type: 'text_delta', text: '[…较早事件已截断，仅回放最近 8MiB]\n' });
    }
    for (const [, fields] of entries) {
      if (closed) break;
      const event = parseEvent(payloadOf(fields) ?? '');
      if (event) await cb(event);
    }
    ready = true;
    kick();
  } catch (err) {
    await release();
    throw err;
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      void release();
    },
  };
}

export async function closeProducer(): Promise<void> {
  const closing = [queue, evalQueue, client, subscriber] as const;
  queue = undefined;
  evalQueue = undefined;
  client = undefined;
  subscriber = undefined;
  await Promise.allSettled([
    closing[0]?.close(),
    closing[1]?.close(),
    closing[2]?.quit(),
    closing[3]?.quit(),
    ...[...subscriptions.values()].map((close) => close()),
  ]);
  subscriptions.clear();
}
