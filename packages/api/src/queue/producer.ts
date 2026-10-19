import type { AgentRunJob, ChatEvent } from '@agentport/shared';
import { chatEventSchema } from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAME = 'agent-runs';

/** worker 用 ChatEvent 回传，API 用 cancel 通知 worker 终止。 */
export type RunSignal = ChatEvent | { type: 'cancel' };

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * 事件通道用 Redis Stream 而不是 pub/sub：
 * pub/sub 在订阅建立前发出的事件会永久丢失（客户端从 POST 到建连之间常见）。
 * Stream 允许从 0 回放，且由 TTL 清理，不需要额外维护。
 */
const STREAM_MAXLEN = 1000;
const STREAM_TTL_SECONDS = 3600;

function streamKey(runId: string): string {
  return `run:${runId}:events`;
}

function cancelKey(runId: string): string {
  return `run:${runId}:cancel`;
}

function logRedisError(err: Error): void {
  process.stderr.write(`[queue] redis error: ${err.message}\n`);
}

let queue: Queue<AgentRunJob> | undefined;
let client: Redis | undefined;
let subscriber: Redis | undefined;

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(QUEUE_NAME, { connection: { url: REDIS_URL } });
    queue.on('error', logRedisError);
  }
  return queue;
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
    await getClient().set(cancelKey(runId), '1', 'EX', STREAM_TTL_SECONDS);
    await getClient().publish(cancelKey(runId), '1');
    return;
  }

  const redis = getClient();
  await redis.xadd(
    streamKey(runId),
    'MAXLEN',
    '~',
    STREAM_MAXLEN,
    '*',
    'payload',
    JSON.stringify(event),
  );
  // 事件流不会被读取者删除（可回放），单独给 TTL 兜底。
  await redis.expire(streamKey(runId), STREAM_TTL_SECONDS);

  // 唤醒正在 XREAD BLOCK 的订阅者。
  await redis.publish(`${streamKey(runId)}:wake`, '1');
}

/** 等待取消信号；返回取消订阅函数。 */
export async function onCancel(runId: string, cb: () => void): Promise<() => void> {
  const redis = getSubscriber();
  const channel = cancelKey(runId);
  const handler = (incoming: string): void => {
    if (incoming === channel) cb();
  };
  redis.on('message', handler);
  await redis.subscribe(channel);
  return () => {
    redis.off('message', handler);
    void redis.unsubscribe(channel).catch(logRedisError);
  };
}

export async function isCancelled(runId: string): Promise<boolean> {
  return (await getClient().exists(cancelKey(runId))) === 1;
}

export interface RunSubscription {
  /** 从第一条事件开始回放，并在有新事件时继续推送。 */
  close: () => void;
}

/**
 * 从流头回放并持续跟进。lastId 从 '0' 开始，因此订阅前的 run_started 不会丢。
 * 客户端断开时只需 close()，不删除流（其他客户端还能回放）。
 */
export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void,
): Promise<RunSubscription> {
  const redis = getSubscriber();
  const wakeChannel = `${streamKey(runId)}:wake`;
  const key = streamKey(runId);
  let closed = false;
  let lastId = '0-0';

  const handler = (): void => {
    void drain();
  };
  redis.on('message', handler);
  await redis.subscribe(wakeChannel);

  const drain = async (): Promise<void> => {
    if (closed) return;
    const start = lastId === '0-0' ? '-' : `(${lastId}`;
    const entries = (await redis.xrange(key, start, '+')) as Array<[string, string[]]>;
    for (const [id, fields] of entries) {
      if (closed) return;
      lastId = id;
      const index = fields.indexOf('payload');
      const payload = index >= 0 ? fields[index + 1] : undefined;
      if (payload === undefined) continue;
      const event = parseEvent(payload);
      if (event) cb(event);
    }
  };

  await drain();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      redis.off('message', handler);
      void redis.unsubscribe(wakeChannel).catch(logRedisError);
    },
  };
}

export async function closeProducer(): Promise<void> {
  const closing = [queue, client, subscriber] as const;
  queue = undefined;
  client = undefined;
  subscriber = undefined;
  await Promise.allSettled([closing[0]?.close(), closing[1]?.quit(), closing[2]?.quit()]);
}
