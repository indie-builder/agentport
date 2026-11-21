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
import { RedisClient } from 'bun';

export interface CloseSessionSandboxesInput {
  targets: readonly SessionCleanupTarget[];
  redisUrl: string;
  timeoutMs?: number;
  requestChannel?: string;
}

function normalizeTargets(targets: readonly SessionCleanupTarget[]): SessionCleanupTarget[] {
  const byConversation = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = byConversation.get(target.conversationId) ?? new Set<string>();
    for (const id of target.sandboxIds) ids.add(id);
    byConversation.set(target.conversationId, ids);
  }
  return [...byConversation].map(([conversationId, ids]) => ({
    conversationId,
    sandboxIds: [...ids].sort(),
  }));
}

function unavailable(message: string, cause?: unknown): AppError {
  return new AppError('SERVICE_UNAVAILABLE', message, { cause });
}

export async function closeSessionSandboxes(input: CloseSessionSandboxesInput): Promise<void> {
  const targets = normalizeTargets(input.targets);
  if (targets.length === 0) return;

  const timeoutMs = input.timeoutMs ?? SESSION_CLEANUP_TIMEOUT_MS;
  const requestId = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const request: SessionCleanupRequest = { requestId, deadline, targets };
  const channel = sessionCleanupAckChannel(requestId);
  const requestChannel = input.requestChannel ?? SESSION_CLEANUP_REQUEST_CHANNEL;
  const subscriber = new RedisClient(input.redisUrl, {
    autoReconnect: false,
    connectionTimeout: 2_000,
  });
  const publisher = new RedisClient(input.redisUrl, {
    autoReconnect: false,
    connectionTimeout: 2_000,
  });

  let timer: NodeJS.Timeout | undefined;
  const exchange = (async () => {
    const { promise: ackPromise, resolve } = Promise.withResolvers<SessionCleanupAck>();
    await subscriber.subscribe(channel, (payload, received) => {
      if (received !== channel) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const parsed = sessionCleanupAckSchema.safeParse(raw);
      if (!parsed.success || parsed.data.requestId !== requestId) return;
      resolve(parsed.data);
    });
    await publisher.publish(requestChannel, JSON.stringify(request));
    const ack = await ackPromise;
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
    subscriber.close();
    publisher.close();
  }
}
