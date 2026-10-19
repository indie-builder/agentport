import type { AgentRunJob, ChatEvent } from '@agentport/shared';
import { chatEventSchema } from '@agentport/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAME = 'agent-runs';

/** worker 用 ChatEvent 回传，API 用 cancel 通知 worker 终止。 */
export type RunSignal = ChatEvent | { type: 'cancel' };

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function channelFor(runId: string): string {
  return `run:${runId}`;
}

// ioredis 的 error 事件没有监听器会直接终止进程，这里只落 stderr（重连由 ioredis 自己处理）。
function logRedisError(err: Error): void {
  process.stderr.write(`[queue] redis error: ${err.message}\n`);
}

let queue: Queue<AgentRunJob> | undefined;
let publisher: Redis | undefined;
let subscriber: Redis | undefined;
const listeners = new Map<string, Set<(event: ChatEvent) => void>>();

export function getQueue(): Queue<AgentRunJob> {
  if (!queue) {
    queue = new Queue<AgentRunJob>(QUEUE_NAME, { connection: { url: REDIS_URL } });
    queue.on('error', logRedisError);
  }
  return queue;
}

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    publisher.on('error', logRedisError);
  }
  return publisher;
}

function getSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    subscriber.on('error', logRedisError);
    subscriber.on('message', (channel: string, payload: string) => {
      const event = parseEvent(payload);
      if (!event) return; // 非契约事件（如 cancel）不转发给 SSE 客户端
      for (const listener of listeners.get(channel) ?? []) {
        try {
          listener(event);
        } catch (err) {
          logRedisError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
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
  await getPublisher().publish(channelFor(runId), JSON.stringify(event));
}

/** 返回幂等的取消订阅函数。 */
export async function subscribeRun(
  runId: string,
  cb: (event: ChatEvent) => void,
): Promise<() => void> {
  const channel = channelFor(runId);
  const redis = getSubscriber();
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);

  try {
    await redis.subscribe(channel);
  } catch (err) {
    set.delete(cb);
    if (set.size === 0) listeners.delete(channel);
    throw err;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = listeners.get(channel);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) {
      listeners.delete(channel);
      void redis.unsubscribe(channel).catch(logRedisError);
    }
  };
}

export async function closeProducer(): Promise<void> {
  const closing = [queue, publisher, subscriber] as const;
  queue = undefined;
  publisher = undefined;
  subscriber = undefined;
  listeners.clear();
  await Promise.allSettled([closing[0]?.close(), closing[1]?.quit(), closing[2]?.quit()]);
}
