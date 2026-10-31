import { randomUUID } from 'node:crypto';
import { AppError } from '@agentport/core';
import {
  errorText,
  SESSION_CLEANUP_REQUEST_CHANNEL,
  SESSION_CLEANUP_TIMEOUT_MS,
  type SessionCleanupAck,
  type SessionCleanupRequest,
  type SessionCleanupTarget,
  sessionCleanupAckChannel,
  sessionCleanupAckSchema,
} from '@agentport/shared';
import { Redis } from 'ioredis';

export interface CloseSessionSandboxesInput {
  targets: readonly SessionCleanupTarget[];
  redisUrl: string;
  timeoutMs?: number;
  /** 默认是部署内唯一信道；测试用独立后缀隔离共享 Redis 上的并行进程。 */
  requestChannel?: string;
}

function normalizeTargets(targets: readonly SessionCleanupTarget[]): SessionCleanupTarget[] {
  const byConversation = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = byConversation.get(target.conversationId) ?? new Set<string>();
    for (const id of target.sandboxIds) ids.add(id);
    byConversation.set(target.conversationId, ids);
  }
  // 按会话合并去重；同一容器被多轮运行复用也只关闭一次。
  return [...byConversation].map(([conversationId, ids]) => ({
    conversationId,
    sandboxIds: [...ids].sort(),
  }));
}

function unavailable(message: string, cause?: unknown): AppError {
  return new AppError('SERVICE_UNAVAILABLE', message, { cause });
}

/**
 * 删除流程的事务外关闭确认：向现有 worker 发一次有限请求，只有全部目标确认销毁才返回。
 * 连接、订阅、发送与 ACK 共用同一个从建立连接前开始的截止时间；超时、worker 不在线、
 * ACK 失败都抛可重试的 503，调用方不进入 tx B，目录与实体保留。
 */
export async function closeSessionSandboxes(input: CloseSessionSandboxesInput): Promise<void> {
  const targets = normalizeTargets(input.targets);
  if (targets.length === 0) return;

  const timeoutMs = input.timeoutMs ?? SESSION_CLEANUP_TIMEOUT_MS;
  const requestId = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const request: SessionCleanupRequest = { requestId, deadline, targets };
  const channel = sessionCleanupAckChannel(requestId);
  const requestChannel = input.requestChannel ?? SESSION_CLEANUP_REQUEST_CHANNEL;
  const subscriber = new Redis(input.redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2_000,
  });
  const publisher = new Redis(input.redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2_000,
  });
  subscriber.on('error', () => undefined);
  publisher.on('error', () => undefined);

  let timer: NodeJS.Timeout | undefined;
  // 订阅与 ACK 继续在后台完成时也必须被观察到，超时后由 finally 断开连接。
  const exchange = (async () => {
    await subscriber.subscribe(channel);
    const ack = await new Promise<SessionCleanupAck>((resolve, reject) => {
      let settled = false;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        return true;
      };
      subscriber.on('message', (received, payload) => {
        if (received !== channel) return;
        let raw: unknown;
        try {
          raw = JSON.parse(payload);
        } catch {
          return;
        }
        const parsed = sessionCleanupAckSchema.safeParse(raw);
        if (!parsed.success || parsed.data.requestId !== requestId) return;
        if (finish()) resolve(parsed.data);
      });
      // 订阅建立后再发送，避免 ACK 早于监听。
      void publisher.publish(requestChannel, JSON.stringify(request)).catch((err: unknown) => {
        if (finish()) reject(unavailable('无法发送会话容器关闭请求', err));
      });
    });
    if (!ack.ok) throw unavailable(`会话容器关闭失败：${ack.error}`);
  })();
  exchange.catch(() => undefined);

  try {
    await Promise.race([
      exchange,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(unavailable('等待会话容器关闭确认超时，删除未执行'));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable(`无法完成会话容器关闭确认：${errorText(err)}`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscriber.disconnect();
    publisher.disconnect();
  }
}
