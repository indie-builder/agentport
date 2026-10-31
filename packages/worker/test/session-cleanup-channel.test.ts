import { randomUUID } from 'node:crypto';
import {
  SESSION_CLEANUP_REQUEST_CHANNEL,
  type SessionCleanupAck,
  type SessionCleanupRequest,
  sessionCleanupAckChannel,
  sessionCleanupAckSchema,
} from '@agentport/shared';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SessionCleanupChannel,
  startSessionCleanupChannel,
} from '../src/sandbox/session-cleanup.js';
import type { SessionSandboxes } from '../src/sandbox/sessions.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:1/9';

interface Task {
  conversationId: string;
  sandboxIds: string[];
}

class FakeSessions {
  readonly calls: Task[] = [];
  readonly failures = new Map<string, Error>();
  hold: Promise<void> | null = null;

  async closeIdle(conversationId: string, sandboxIds: readonly string[]): Promise<void> {
    this.calls.push({ conversationId, sandboxIds: [...sandboxIds] });
    await this.hold;
    const failure = this.failures.get(conversationId);
    if (failure !== undefined) throw failure;
  }
}

const channels: SessionCleanupChannel[] = [];
const connections: Redis[] = [];
let currentChannel = SESSION_CLEANUP_REQUEST_CHANNEL;

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.close()));
  for (const connection of connections.splice(0)) connection.disconnect();
});

async function startChannel(sessions: FakeSessions): Promise<SessionCleanupChannel> {
  currentChannel = `${SESSION_CLEANUP_REQUEST_CHANNEL}:${randomUUID()}`;
  const channel = await startSessionCleanupChannel({
    redisUrl: REDIS_URL,
    logger: pino({ level: 'silent' }),
    sessions: sessions as Pick<SessionSandboxes, 'closeIdle'>,
    requestChannel: currentChannel,
  });
  channels.push(channel);
  return channel;
}

function request(overrides: Partial<SessionCleanupRequest> = {}): SessionCleanupRequest {
  return {
    requestId: randomUUID(),
    deadline: Date.now() + 5_000,
    targets: [{ conversationId: 'conv_1', sandboxIds: ['sandbox-1'] }],
    ...overrides,
  };
}

async function send(
  payload: unknown,
  options: { expectAck?: boolean; timeoutMs?: number; requestChannel?: string } = {},
): Promise<SessionCleanupAck | null> {
  const requestId =
    typeof payload === 'object' && payload !== null && 'requestId' in payload
      ? String((payload as { requestId: unknown }).requestId)
      : randomUUID();
  const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  connections.push(subscriber, publisher);
  const channel = sessionCleanupAckChannel(requestId);
  await subscriber.subscribe(channel);
  const ack = new Promise<SessionCleanupAck | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), options.timeoutMs ?? 2_000);
    timer.unref();
    subscriber.on('message', (received, message) => {
      if (received !== channel) return;
      clearTimeout(timer);
      const parsed = sessionCleanupAckSchema.safeParse(JSON.parse(message));
      resolve(parsed.success ? parsed.data : null);
    });
  });
  await publisher.publish(options.requestChannel ?? currentChannel, JSON.stringify(payload));
  const result = await ack;
  if (options.expectAck === false) return result;
  expect(result).not.toBeNull();
  return result;
}

describe('session cleanup channel', () => {
  it('closes every target and acknowledges only after all succeed', async () => {
    const sessions = new FakeSessions();
    await startChannel(sessions);
    const payload = request({
      targets: [
        { conversationId: 'conv_1', sandboxIds: ['sandbox-1', 'sandbox-2'] },
        { conversationId: 'conv_2', sandboxIds: [] },
      ],
    });

    const ack = await send(payload);

    expect(ack).toEqual({ requestId: payload.requestId, ok: true });
    expect(sessions.calls).toEqual([
      { conversationId: 'conv_1', sandboxIds: ['sandbox-1', 'sandbox-2'] },
      { conversationId: 'conv_2', sandboxIds: [] },
    ]);
  });

  it('rejects an expired request without touching any container', async () => {
    const sessions = new FakeSessions();
    await startChannel(sessions);
    const payload = request({ deadline: Date.now() - 1 });

    const ack = await send(payload);

    expect(ack).toMatchObject({ requestId: payload.requestId, ok: false });
    expect(sessions.calls).toEqual([]);
  });

  it('does not acknowledge or execute a malformed request', async () => {
    const sessions = new FakeSessions();
    await startChannel(sessions);

    const ack = await send(
      { requestId: 'not-a-request', deadline: Date.now() + 1_000, targets: [] },
      { expectAck: false, timeoutMs: 150 },
    );

    expect(ack).toBeNull();
    expect(sessions.calls).toEqual([]);
  });

  it('reports a failure but still attempts the remaining targets', async () => {
    const sessions = new FakeSessions();
    sessions.failures.set('conv_1', new Error('sandbox busy'));
    await startChannel(sessions);
    const payload = request({
      targets: [
        { conversationId: 'conv_1', sandboxIds: ['sandbox-1'] },
        { conversationId: 'conv_2', sandboxIds: ['sandbox-2'] },
      ],
    });

    const ack = await send(payload);

    expect(ack).toMatchObject({ requestId: payload.requestId, ok: false });
    expect(ack?.ok === false ? ack.error : '').toContain('sandbox busy');
    expect(sessions.calls.map((call) => call.conversationId)).toEqual(['conv_1', 'conv_2']);
  });

  it('waits for an in-flight close before closing the channel', async () => {
    const sessions = new FakeSessions();
    let release!: () => void;
    sessions.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = await startChannel(sessions);
    const payload = request();
    const pending = send(payload);
    await vi.waitFor(() => expect(sessions.calls).toHaveLength(1));

    let closed = false;
    const closing = channel.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);

    release();
    await expect(pending).resolves.toEqual({ requestId: payload.requestId, ok: true });
    await closing;
  });

  it('times out a hanging drain, rejects, and still releases both Redis connections', async () => {
    const sessions = new FakeSessions();
    let release!: () => void;
    sessions.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = await startChannel(sessions);
    const payload = request();
    const pending = send(payload, { expectAck: false, timeoutMs: 500 });
    await vi.waitFor(() => expect(sessions.calls).toHaveLength(1));
    const disconnects = vi.spyOn(Redis.prototype, 'disconnect');

    await expect(channel.close(80)).rejects.toThrow(/drain exceeded/);
    expect(disconnects).toHaveBeenCalledTimes(2);

    // 放行后迟到 ACK 不能复活已超时的关闭，也不会留下新连接。
    release();
    await expect(pending).resolves.toBeNull();
  });
});
