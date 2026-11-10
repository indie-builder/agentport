import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { connect } from 'node:net';
import { repo } from '@agentport/db';
import {
  type Channel,
  type ChannelEvent,
  type ChannelMessage,
  channelStreamKey,
} from '@agentport/shared';
import { RedisClient } from 'bun';
import { closeProducer } from '../src/queue/producer.js';
import {
  ADMIN_BUSINESS_ID,
  createTestAccount,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestAccount,
  type TestApp,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;

describe.skipIf(!ready)('channel resilience and authorization', () => {
  let app: TestApp;
  let server: TestServer;
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
    server = await listen(app);
    baseUrl = server.url;
  });

  afterEach(async () => {
    await closeProducer();
  });

  afterAll(async () => {
    await server.close();
    await app.client.unsafe('delete from channels where id = any($1::text[])', [
      app.client.array(ids, 'TEXT'),
    ]);
    await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
      app.client.array(ids, 'TEXT'),
    ]);
    const businessIds = [owner.businessId, member.businessId];
    await app.client.unsafe('delete from audit_log where actor = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    await app.client.unsafe('delete from user_roles where business_id = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    await app.client.unsafe('delete from "user" where business_id = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    cookie = owner.cookie,
    payload?: Record<string, unknown>,
  ) =>
    request(app, {
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
            const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
            if (line) {
              const event = JSON.parse(line.slice(6)) as ChannelEvent;
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
    expect(future.headers.get('content-type')).not.toContain('text/event-stream');
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
      const audit = await app.client.unsafe(
        "select actor, subject_business_id, action, request_id from audit_log where target = $1 and action = 'access.cross_user.conversations.read' order by created_at",
        [value.id],
      );
      expect(audit).toHaveLength(4);
      expect(new Set(audit.map((row) => row.request_id)).size).toBe(4);
      for (const row of audit)
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
    const query = app.client.unsafe.bind(app.client);
    let revoked = false;
    const spy = spyOn(app.client, 'unsafe').mockImplementation(((
      ...args: Parameters<typeof app.client.unsafe>
    ) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (!revoked && /from "channel_messages"/i.test(text) && /order by/i.test(text)) {
        revoked = true;
        const pending = query(
          'delete from channel_members where channel_id = $1 and business_id = $2',
          [value.id, member.businessId],
        ).then(() => query(...args));
        return Object.assign(pending, { values: () => pending });
      }
      return query(...args);
    }) as typeof app.client.unsafe);
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
    const total = 200;
    const body = 'x'.repeat(30_000);
    for (let index = 0; index < total; index += 1) {
      const posted = await post(value.id, `${index}:${body}`);
      expect(posted.statusCode, posted.body).toBe(201);
    }

    const url = new URL(baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      [
        `GET /api/channels/${value.id}/events?after=0 HTTP/1.1`,
        `Host: ${url.host}`,
        `Cookie: ${member.cookie}`,
        'Accept: text/event-stream',
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );

    // Slow consumer: do not read for a while so the server's cached page fills the socket buffer.
    await Bun.sleep(300);
    const removed = await call('DELETE', `/api/channels/${value.id}/members/${member.businessId}`);
    expect(removed.statusCode, removed.body).toBe(204);

    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.resume();
    await Promise.race([closed, Bun.sleep(8_000)]);
    socket.destroy();

    const text = Buffer.concat(chunks).toString('utf8');
    const events = text
      .split('\n\n')
      .flatMap((block) => {
        const line = block.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) return [];
        try {
          return [JSON.parse(line.slice(6)) as { type?: string; message?: { body?: string } }];
        } catch {
          return [];
        }
      })
      .filter((event) => event.type !== undefined);

    const created = events.filter((event) => event.type === 'message.created');
    expect(created.length).toBeLessThan(total);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('saves promptly and keeps DB replay and polling alive when channel Redis does not answer', async () => {
    const value = await channel();
    await post(value.id, 'history before failure');
    await closeProducer();
    const key = channelStreamKey(value.id);
    let blockedPublish = false;
    let blockedReplay = false;
    const originalSend = RedisClient.prototype.send;
    const spy = spyOn(RedisClient.prototype, 'send').mockImplementation(function (
      this: RedisClient,
      command: string,
      args: string[],
    ) {
      if (String(args[0]) === key) {
        if (command === 'XADD') {
          blockedPublish = true;
          return Promise.reject(new Error('redis down'));
        }
        if (command === 'XRANGE' || command === 'XREAD') {
          blockedReplay = true;
          return Promise.reject(new Error('redis down'));
        }
      }
      return originalSend.call(this, command, args);
    });
    let connection: Awaited<ReturnType<typeof stream>> | undefined;
    try {
      const started = performance.now();
      const saved = await post(value.id, 'saved despite redis');
      expect(saved.statusCode, saved.body).toBe(201);
      expect(performance.now() - started).toBeLessThan(2500);
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
      spy.mockRestore();
      await closeProducer();
    }
  });
});
