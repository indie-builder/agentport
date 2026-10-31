import {
  SESSION_CLEANUP_REQUEST_CHANNEL,
  SESSION_CLEANUP_TIMEOUT_MS,
  type SessionCleanupAck,
  type SessionCleanupRequest,
  sessionCleanupAckChannel,
  sessionCleanupRequestSchema,
} from '@agentport/shared';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { waitClose } from '../close-wait.js';
import { redactSecrets } from '../redact.js';
import type { SessionSandboxes } from './sessions.js';

/**
 * 会话删除的内部关闭信道：API 在删除事务里发请求，worker 关闭空闲容器后回一条 ACK。
 * 只是有限请求/应答，不是队列或第二套运行循环；请求不带凭据、宿主路径或 Docker 命令。
 */
export interface SessionCleanupChannelOptions {
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startSessionCleanupChannel(
  options: SessionCleanupChannelOptions,
): Promise<SessionCleanupChannel> {
  const { logger } = options;
  const requestChannel = options.requestChannel ?? SESSION_CLEANUP_REQUEST_CHANNEL;
  const subscriber = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const publisher = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  subscriber.on('error', (err) => logger.warn({ err }, 'session cleanup subscriber error'));
  publisher.on('error', (err) => logger.warn({ err }, 'session cleanup publisher error'));

  const inFlight = new Set<Promise<void>>();
  let closed = false;

  async function acknowledge(requestId: string, ack: SessionCleanupAck): Promise<void> {
    try {
      await publisher.publish(sessionCleanupAckChannel(requestId), JSON.stringify(ack));
    } catch (err) {
      // ACK 发不出去等价于没确认：API 会超时回滚，能安全重试。
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
      // 长关闭期间请求可能已经过期：不再开始新的目标，已完成的容器不回滚。
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

  subscriber.on('message', (channel, payload) => {
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
    // 入口只校验一次；无法识别的请求不执行也不回 ACK，API 会按超时失败。
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
  });

  try {
    await subscriber.subscribe(requestChannel);
  } catch (err) {
    subscriber.disconnect();
    publisher.disconnect();
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
            await subscriber.unsubscribe(requestChannel).catch(() => undefined);
            // 关停时不打断进行中的关闭确认：它们仍要回 ACK 并保留失败跟踪。
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
        subscriber.disconnect();
        publisher.disconnect();
      }
    },
  };
}

export interface CloseSessionRuntimeOptions {
  channel: SessionCleanupChannel;
  sessions: Pick<SessionSandboxes, 'close'>;
  provider: { destroyAll: () => Promise<void> };
  timeoutMs: number;
}

/**
 * provider close 的唯一顺序：有界 drain 关闭信道 → 关闭会话沙盒 → destroyAll。
 * 任何一路失败都继续后面的清理，最后抛出（多个失败聚合成 AggregateError），
 * 由 runShutdown 记录并非零退出；不能用 warning 代替失败。
 */
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
