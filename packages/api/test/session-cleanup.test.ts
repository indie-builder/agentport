import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import {
  SESSION_CLEANUP_REQUEST_CHANNEL,
  type SessionCleanupRequest,
  sessionCleanupAckChannel,
  sessionCleanupRequestSchema,
} from '@agentport/shared';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSessionSandboxes } from '../src/queue/session-cleanup.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:1/9';
const connections: Redis[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.disconnect();
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  vi.restoreAllMocks();
});

async function worker(
  handler: (request: SessionCleanupRequest, publisher: Redis) => Promise<void>,
): Promise<string> {
  const requestChannel = `${SESSION_CLEANUP_REQUEST_CHANNEL}:${randomUUID()}`;
  const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  connections.push(subscriber, publisher);
  await subscriber.subscribe(requestChannel);
  subscriber.on('message', (_channel, payload) => {
    const parsed = sessionCleanupRequestSchema.safeParse(JSON.parse(payload));
    if (parsed.success) void handler(parsed.data, publisher);
  });
  return requestChannel;
}

async function close(input: Parameters<typeof closeSessionSandboxes>[0]): Promise<unknown> {
  return closeSessionSandboxes(input).then(
    () => null,
    (error: unknown) => error,
  );
}

describe('closeSessionSandboxes', () => {
  it('sends precise identities and resolves only on a matching success ack', async () => {
    let received: SessionCleanupRequest | undefined;
    const requestChannel = await worker(async (request, publisher) => {
      received = request;
      await publisher.publish(
        sessionCleanupAckChannel(request.requestId),
        JSON.stringify({ requestId: request.requestId, ok: true }),
      );
    });

    const result = await close({
      redisUrl: REDIS_URL,
      requestChannel,
      targets: [
        { conversationId: 'conv_1', sandboxIds: ['sandbox-1', 'sandbox-1'] },
        { conversationId: 'conv_1', sandboxIds: ['sandbox-2'] },
        { conversationId: 'conv_2', sandboxIds: [] },
      ],
    });

    expect(result).toBeNull();
    expect(received?.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(received?.deadline).toBeGreaterThan(Date.now());
    expect(received?.targets).toEqual([
      { conversationId: 'conv_1', sandboxIds: ['sandbox-1', 'sandbox-2'] },
      { conversationId: 'conv_2', sandboxIds: [] },
    ]);
  });

  it('fails with a retryable service error when the worker reports a close failure', async () => {
    const requestChannel = await worker(async (request, publisher) => {
      await publisher.publish(
        sessionCleanupAckChannel(request.requestId),
        JSON.stringify({ requestId: request.requestId, ok: false, error: 'sandbox busy' }),
      );
    });

    const error = await close({
      redisUrl: REDIS_URL,
      requestChannel,
      targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    });

    expect(error).toMatchObject({ name: 'AppError', code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(String((error as Error).message)).toContain('sandbox busy');
  });

  it('times out instead of treating a sent request as confirmed', async () => {
    const error = await close({
      redisUrl: REDIS_URL,
      timeoutMs: 200,
      requestChannel: `${SESSION_CLEANUP_REQUEST_CHANNEL}:${randomUUID()}`,
      targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    });
    expect(error).toMatchObject({
      name: 'AppError',
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('releases both Redis connections after a timeout and ignores a late ack', async () => {
    const requestChannel = await worker(async (request, publisher) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await publisher.publish(
        sessionCleanupAckChannel(request.requestId),
        JSON.stringify({ requestId: request.requestId, ok: true }),
      );
    });
    const disconnects = vi.spyOn(Redis.prototype, 'disconnect');

    const error = await close({
      redisUrl: REDIS_URL,
      requestChannel,
      timeoutMs: 100,
      targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    });

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(disconnects).toHaveBeenCalledTimes(2);
    // 迟到 ACK 不能把已失败的删除变成成功；完成后仍不留下连接。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(disconnects).toHaveBeenCalledTimes(2);
  });

  it('bounds a subscribe that never completes with the same deadline', async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.unref();
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    const disconnects = vi.spyOn(Redis.prototype, 'disconnect');
    const started = Date.now();

    const error = await close({
      redisUrl: `redis://127.0.0.1:${address.port}`,
      timeoutMs: 100,
      targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    });

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    // 连接自身的 2s connectTimeout 不能成为删除预算。
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(disconnects).toHaveBeenCalledTimes(2);
  });

  it('releases Redis connections when publishing the request fails', async () => {
    const requestChannel = await worker(async () => undefined);
    const disconnects = vi.spyOn(Redis.prototype, 'disconnect');
    vi.spyOn(Redis.prototype, 'publish').mockRejectedValueOnce(new Error('publish failed'));

    const error = await close({
      redisUrl: REDIS_URL,
      requestChannel,
      timeoutMs: 500,
      targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    });

    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
    expect(String((error as Error).message)).toContain('无法发送');
    expect(disconnects).toHaveBeenCalledTimes(2);
  });

  it('accepts only the ack matching this request id', async () => {
    const requestChannel = await worker(async (request, publisher) => {
      await publisher.publish(
        sessionCleanupAckChannel(request.requestId),
        JSON.stringify({ requestId: randomUUID(), ok: true }),
      );
      await publisher.publish(
        sessionCleanupAckChannel(request.requestId),
        JSON.stringify({ requestId: request.requestId, ok: true }),
      );
    });

    await expect(
      closeSessionSandboxes({
        redisUrl: REDIS_URL,
        requestChannel,
        timeoutMs: 1_000,
        targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when there is no target conversation', async () => {
    await expect(
      closeSessionSandboxes({ redisUrl: REDIS_URL, targets: [] }),
    ).resolves.toBeUndefined();
  });
});
