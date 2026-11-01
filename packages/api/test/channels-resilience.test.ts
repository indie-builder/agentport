import { ServerResponse } from 'node:http';
import { type AddressInfo, createConnection, createServer, type Server } from 'node:net';
import { repo } from '@agentport/db';
import type { Channel, ChannelEvent, ChannelMessage } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeProducer } from '../src/queue/producer.js';
import {
  ADMIN_BUSINESS_ID,
  createTestAccount,
  infraReady,
  inject,
  loginCookie,
  startApp,
  type TestAccount,
  testConfig,
  unique,
} from './helpers.js';

const faults = vi.hoisted(() => ({ redisUrl: '', ready: undefined as (() => void) | undefined }));
vi.mock('ioredis', async (original) => {
  const actual = await original<typeof import('ioredis')>();
  return {
    ...actual,
    Redis: class extends actual.Redis {
      constructor(...args: ConstructorParameters<typeof actual.Redis>) {
        const options = args[1];
        const name = options && typeof options === 'object' ? options.connectionName : undefined;
        if (
          faults.redisUrl &&
          (name === 'channel-producer' || name?.startsWith('channel-events:'))
        ) {
          super(faults.redisUrl, options);
          if (name === 'channel-producer') this.once('ready', () => faults.ready?.());
        } else {
          super(...args);
        }
      }
    },
  };
});

const ready = await infraReady;

describe.skipIf(!ready)('channel resilience and authorization', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let owner: TestAccount;
  let member: TestAccount;
  let baseUrl: string;
  const ids: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
    owner = await createTestAccount(app, adminCookie, { systemKeys: [] });
    member = await createTestAccount(app, adminCookie, { systemKeys: [] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    faults.redisUrl = '';
    faults.ready = undefined;
    vi.restoreAllMocks();
    await closeProducer();
  });

  afterAll(async () => {
    await app.pool.query('delete from channels where id = any($1::text[])', [ids]);
    await app.pool.query('delete from audit_log where target = any($1::text[])', [ids]);
    const businessIds = [owner.businessId, member.businessId];
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    cookie = owner.cookie,
    payload?: Record<string, unknown>,
  ) =>
    inject(app, {
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });

  const channel = async (): Promise<Channel> => {
    const response = await call('POST', '/api/channels', owner.cookie, {
      name: unique('resilience'),
    });
    expect(response.statusCode, response.body).toBe(201);
    const value = response.json<Channel>();
    ids.push(value.id);
    return value;
  };

  const post = (id: string, body: string) =>
    call('POST', `/api/channels/${id}/messages`, owner.cookie, { body });

  const join = async (id: string) => {
    const response = await call('POST', `/api/channels/${id}/members`, owner.cookie, {
      businessId: member.businessId,
      role: 'viewer',
    });
    expect(response.statusCode, response.body).toBe(201);
  };

  const stream = async (id: string, cookie = owner.cookie, after = 0) => {
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/channels/${id}/events?after=${after}`, {
      headers: { cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing SSE body');
    const events: ChannelEvent[] = [];
    const waiters: Array<{
      predicate: (event: ChannelEvent) => boolean;
      resolve: (event: ChannelEvent) => void;
    }> = [];
    const decoder = new TextDecoder();
    const pump = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.startsWith('data: ')) {
              const event = JSON.parse(frame.slice(6)) as ChannelEvent;
              events.push(event);
              for (const waiter of waiters) if (waiter.predicate(event)) waiter.resolve(event);
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();
    return {
      events,
      pump,
      next(predicate: (event: ChannelEvent) => boolean): Promise<ChannelEvent> {
        const existing = events.find(predicate);
        return existing
          ? Promise.resolve(existing)
          : new Promise((resolve) => waiters.push({ predicate, resolve }));
      },
      async close() {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        await pump;
      },
    };
  };

  it('rejects future SSE cursors before headers, keeps GET after semantics, and accepts zero on empty channels', async () => {
    const value = await channel();
    const future = await call('GET', `/api/channels/${value.id}/events?after=1000000`);
    expect(future.statusCode, future.body).toBe(400);
    expect(future.json()).toMatchObject({ code: 'INVALID_INPUT' });
    expect(future.headers['content-type']).not.toContain('text/event-stream');
    const empty = await stream(value.id);
    await empty.close();
    const saved = (await post(value.id, 'current maximum')).json<ChannelMessage>();
    const access = await repo.channels.getChannelReadAccess(
      app.db,
      { businessId: owner.businessId },
      value.id,
    );
    expect(access?.maxSeq).toBe(saved.seq);
    await join(value.id);
    const latest = (await post(value.id, 'after maximum')).json<ChannelMessage>();
    const current = await stream(value.id, member.cookie, saved.seq);
    await current.next((event) => event.type === 'message.created' && event.seq === latest.seq);
    await current.close();
    const invalid = await call('GET', `/api/channels/${value.id}/events?after=${latest.seq + 1}`);
    expect(invalid.statusCode, invalid.body).toBe(400);
    const messages = await call('GET', `/api/channels/${value.id}/messages?after=1000000`);
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual([]);
  });

  it('requires membership for platform admins and audits their cross-user reads exactly once per request', async () => {
    const value = await channel();
    await post(value.id, 'private');

    for (const path of [`/api/channels/${value.id}`, `/api/channels/${value.id}/messages`]) {
      const response = await call('GET', path, adminCookie);
      expect(response.statusCode, response.body).toBe(404);
    }
    const isolated = await call('GET', '/api/channels', adminCookie);
    expect(isolated.statusCode, isolated.body).toBe(200);
    expect(isolated.json<Array<{ id: string }>>().map((item) => item.id)).not.toContain(value.id);

    const joined = await call('POST', `/api/channels/${value.id}/members`, owner.cookie, {
      businessId: ADMIN_BUSINESS_ID,
      role: 'viewer',
    });
    expect(joined.statusCode, joined.body).toBe(201);

    for (const path of [
      `/api/channels/${value.id}`,
      `/api/channels/${value.id}/messages`,
      '/api/channels',
    ]) {
      const response = await call('GET', path, adminCookie);
      expect(response.statusCode, response.body).toBe(200);
    }
    const connection = await stream(value.id, adminCookie);
    try {
      await connection.next((event) => event.type === 'message.created');
      await post(value.id, 'another');
      await connection.next(
        (event) => event.type === 'message.created' && event.message.body === 'another',
      );
      const audit = await app.pool.query(
        'select actor, subject_business_id, action, request_id from audit_log where target = $1 order by created_at',
        [value.id],
      );
      expect(audit.rows).toHaveLength(4);
      expect(new Set(audit.rows.map((row) => row.request_id)).size).toBe(4);
      for (const row of audit.rows)
        expect(row).toMatchObject({
          actor: ADMIN_BUSINESS_ID,
          subject_business_id: owner.businessId,
          action: 'access.cross_user.conversations.read',
        });
    } finally {
      await connection.close();
    }
  });

  it('filters the actual message SELECT if membership disappears after the access query', async () => {
    const value = await channel();
    await join(value.id);
    await post(value.id, 'secret after access check');
    const query = app.pool.query.bind(app.pool);
    let revoked = false;
    const spy = vi.spyOn(app.pool, 'query').mockImplementation((async (
      ...args: Parameters<typeof app.pool.query>
    ) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (!revoked && /from "channel_messages"/i.test(text) && /order by/i.test(text)) {
        revoked = true;
        await query('delete from channel_members where channel_id = $1 and business_id = $2', [
          value.id,
          member.businessId,
        ]);
      }
      return query(...args);
    }) as typeof app.pool.query);
    try {
      const result = await repo.channels.listMessages(
        app.db,
        { businessId: member.businessId },
        value.id,
        { after: 0, limit: 200 },
      );
      expect(revoked).toBe(true);
      expect(result).toMatchObject({ kind: 'not_found' });
    } finally {
      spy.mockRestore();
    }
    expect(
      (await call('GET', `/api/channels/${value.id}/messages`, member.cookie)).statusCode,
    ).toBe(404);
  });

  it('stops a cached SSE page after membership is removed during backpressure', async () => {
    const value = await channel();
    await join(value.id);
    await post(value.id, 'already written');
    await post(value.id, 'must stay private');
    let blockedResponse: ServerResponse | undefined;
    const blocked = Promise.withResolvers<void>();
    const originalWrite = ServerResponse.prototype.write;
    vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse['write']>
    ) {
      const frame = String(args[0]);
      const result = originalWrite.apply(this, args);
      if (
        frame.startsWith('data: ') &&
        frame.includes('already written') &&
        frame.includes(value.id)
      ) {
        blockedResponse = this;
        blocked.resolve();
        return false;
      }
      return result;
    });
    const connecting = stream(value.id, member.cookie);
    await blocked.promise;
    const connection = await connecting;
    try {
      const removed = await call(
        'DELETE',
        `/api/channels/${value.id}/members/${member.businessId}`,
      );
      expect(removed.statusCode, removed.body).toBe(204);
      blockedResponse?.emit('drain');
      await connection.pump;
      expect(
        connection.events
          .filter((event) => event.type === 'message.created')
          .map((event) => event.message.body),
      ).toEqual(['already written']);
      expect(connection.events.at(-1)).toMatchObject({ type: 'error' });
    } finally {
      blockedResponse?.emit('drain');
      await connection.close();
    }
  });

  it('saves promptly and keeps DB replay and polling alive when channel Redis does not answer', async () => {
    const value = await channel();
    await post(value.id, 'history before failure');
    await closeProducer();
    const sockets = new Set<import('node:net').Socket>();
    const redisUrl = new URL(testConfig().REDIS_URL);
    let blockedPublish = false;
    let blockedReplay = false;
    const blackhole: Server = createServer((socket) => {
      const upstream = createConnection({ host: redisUrl.hostname, port: Number(redisUrl.port) });
      sockets.add(socket);
      sockets.add(upstream);
      socket.on('error', () => undefined);
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        upstream.destroy();
      });
      upstream.on('close', () => sockets.delete(upstream));
      upstream.pipe(socket);
      socket.on('data', (data) => {
        const command = data.toString().toLowerCase();
        if (command.includes('xadd')) {
          blockedPublish = true;
          return;
        }
        if (command.includes('xrange')) {
          blockedReplay = true;
          return;
        }
        upstream.write(data);
      });
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    faults.redisUrl = `redis://127.0.0.1:${(blackhole.address() as AddressInfo).port}`;
    let connection: Awaited<ReturnType<typeof stream>> | undefined;
    const channelReady = Promise.withResolvers<void>();
    faults.ready = () => channelReady.resolve();
    try {
      const started = performance.now();
      const saved = await post(value.id, 'saved despite redis');
      expect(saved.statusCode, saved.body).toBe(201);
      expect(performance.now() - started).toBeLessThan(2500);
      await channelReady.promise;
      connection = await stream(value.id);
      await connection.next(
        (event) => event.type === 'message.created' && event.message.body === 'saved despite redis',
      );
      const commandStarted = performance.now();
      const later = await post(value.id, 'DB polling after failed handshake');
      expect(later.statusCode, later.body).toBe(201);
      expect(performance.now() - commandStarted).toBeLessThan(2500);
      await connection.next(
        (event) =>
          event.type === 'message.created' &&
          event.message.body === 'DB polling after failed handshake',
      );
      expect(blockedPublish).toBe(true);
      expect(blockedReplay).toBe(true);
      expect(
        connection.events.some(
          (event) =>
            event.type === 'message.created' && event.message.body === 'history before failure',
        ),
      ).toBe(true);
    } finally {
      await connection?.close();
      await closeProducer();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        blackhole.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
