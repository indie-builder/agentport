import {
  errorText,
  redactSecrets,
  SESSION_CLEANUP_REQUEST_CHANNEL,
  SESSION_CLEANUP_TIMEOUT_MS,
  type SessionCleanupAck,
  type SessionCleanupRequest,
  sessionCleanupAckChannel,
  sessionCleanupRequestSchema,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import { waitClose } from '../runs/close-wait.js';
import type { SessionSandboxes } from './sessions.js';

interface SessionCleanupChannelOptions {
  redisUrl: string;
  logger: Logger;
  sessions: Pick<SessionSandboxes, 'closeIdle'>;
  /** 默认是部署内唯一信道；测试用独立后缀隔离共享 Redis 上的并行进程。 */
  requestChannel?: string;
}

export interface SessionCleanupChannel {
  /** 停止接收新请求并有界等待在途关闭；超时则 reject，连接始终释放。 */
  close(timeoutMs?: number): Promise<void>;
}

export async function startSessionCleanupChannel(
  options: SessionCleanupChannelOptions,
): Promise<SessionCleanupChannel> {
  const { logger } = options;
  const requestChannel = options.requestChannel ?? SESSION_CLEANUP_REQUEST_CHANNEL;
  const subscriber = new RedisClient(options.redisUrl);
  const publisher = new RedisClient(options.redisUrl);
  let releasing = false;
  subscriber.onclose = (err) => {
    if (!releasing) logger.warn({ err }, 'session cleanup subscriber error');
  };
  publisher.onclose = (err) => {
    if (!releasing) logger.warn({ err }, 'session cleanup publisher error');
  };

  const inFlight = new Set<Promise<void>>();
  let closed = false;

  async function acknowledge(requestId: string, ack: SessionCleanupAck): Promise<void> {
    try {
      await publisher.publish(sessionCleanupAckChannel(requestId), JSON.stringify(ack));
    } catch (err) {
      logger.warn({ err, requestId }, 'session cleanup ack publish failed');
    }
  }

  async function handle(request: SessionCleanupRequest): Promise<void> {
    if (Date.now() >= request.deadline) {
      await acknowledge(request.requestId, {
        requestId: request.requestId,
        ok: false,
        error: 'request expired before the worker started',
      });
      return;
    }

    const errors: string[] = [];
    for (const target of request.targets) {
      if (Date.now() >= request.deadline) {
        errors.push('request expired during cleanup');
        break;
      }
      try {
        await options.sessions.closeIdle(target.conversationId, target.sandboxIds);
      } catch (err) {
        errors.push(redactSecrets(errorText(err)));
      }
    }

    await acknowledge(
      request.requestId,
      errors.length === 0
        ? { requestId: request.requestId, ok: true }
        : { requestId: request.requestId, ok: false, error: errors.join('; ') },
    );
  }

  const listener = (payload: string, channel: string) => {
    if (channel !== requestChannel || closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      logger.warn(
        { payload: redactSecrets(payload.slice(0, 500)) },
        'session cleanup request was not JSON',
      );
      return;
    }
    const parsed = sessionCleanupRequestSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.length, payload: redactSecrets(payload.slice(0, 500)) },
        'session cleanup request failed schema validation',
      );
      return;
    }
    const task = handle(parsed.data);
    inFlight.add(task);
    void task
      .catch((err: unknown) => {
        logger.warn({ err, requestId: parsed.data.requestId }, 'session cleanup request failed');
      })
      .finally(() => inFlight.delete(task));
  };

  let connected = false;
  subscriber.onconnect = () => {
    if (!connected) {
      connected = true;
      return;
    }
    if (!closed)
      void subscriber.subscribe(requestChannel, listener).catch((err: unknown) => {
        logger.warn({ err }, 'session cleanup resubscribe failed');
      });
  };

  try {
    await subscriber.subscribe(requestChannel, listener);
  } catch (err) {
    releasing = true;
    subscriber.close();
    publisher.close();
    throw err;
  }

  return {
    close: async (timeoutMs = SESSION_CLEANUP_TIMEOUT_MS) => {
      if (closed) return;
      closed = true;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          (async () => {
            await subscriber.unsubscribe(requestChannel, listener).catch(() => undefined);
            await Promise.allSettled([...inFlight]);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`session cleanup drain exceeded ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        releasing = true;
        subscriber.close();
        publisher.close();
      }
    },
  };
}

interface CloseSessionRuntimeOptions {
  channel: SessionCleanupChannel;
  sessions: Pick<SessionSandboxes, 'close'>;
  provider: { destroyAll: () => Promise<void> };
  timeoutMs: number;
}

export async function closeSessionRuntime(options: CloseSessionRuntimeOptions): Promise<void> {
  const failures: unknown[] = [];
  const closing = options.channel.close(options.timeoutMs).catch((err: unknown) => {
    failures.push(err);
  });
  const drained = await waitClose(closing, options.timeoutMs);
  if (!drained) {
    failures.push(new Error(`session cleanup channel did not drain within ${options.timeoutMs}ms`));
  }
  try {
    await options.sessions.close();
  } catch (err) {
    failures.push(err);
  } finally {
    try {
      await options.provider.destroyAll();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'session runtime shutdown failed');
  }
}
