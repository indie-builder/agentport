import type { AddressInfo } from 'node:net';
import { newId } from '@agentport/db';
import type {
  Agent,
  Channel,
  ChannelAgentBinding,
  ChannelDetail,
  ChannelEvent,
  ChannelListItem,
  ChannelMember,
  ChannelMessage,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createTestAccount,
  infraReady,
  inject,
  loginCookie,
  setAgentMember,
  startApp,
  type TestAccount,
  testConfig,
  unique,
  waitFor,
} from './helpers.js';

type MemberRole = ChannelMember['role'];

const ready = await infraReady;
const READ_PATH = (channelId: string): string => `/api/channels/${channelId}/read`;

describe.skipIf(!ready)('channels', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let baseUrl: string;
  let redis: Redis;
  let owner: TestAccount;
  let member: TestAccount;
  let viewer: TestAccount;
  let channelAdmin: TestAccount;
  let outsider: TestAccount;
  const channelIds: string[] = [];
  const agentSlugs: string[] = [];
  const noGrantBusinessIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    redis = new Redis(testConfig().REDIS_URL);
    owner = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    member = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    viewer = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    channelAdmin = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    outsider = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
  });

  afterAll(async () => {
    for (const channelId of channelIds) {
      await app.pool
        .query('delete from channels where id = $1', [channelId])
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs });
    const businessIds = [
      owner.businessId,
      member.businessId,
      viewer.businessId,
      channelAdmin.businessId,
      outsider.businessId,
      ...noGrantBusinessIds,
    ];
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from audit_log where target = any($1::text[])', [channelIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await redis.quit().catch(() => undefined);
    await app.close();
  });

  const present = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('expected a value');
    return value;
  };

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    cookie: string,
    payload?: Record<string, unknown>,
  ) =>
    inject(app, {
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });

  const createChannel = async (
    cookie: string = owner.cookie,
    name: string = unique('channel'),
  ): Promise<Channel> => {
    const res = await call('POST', '/api/channels', cookie, { name });
    expect(res.statusCode, res.body).toBe(201);
    const channel = res.json<Channel>();
    channelIds.push(channel.id);
    return channel;
  };

  const addMember = (channelId: string, cookie: string, businessId: string, role: MemberRole) =>
    call('POST', `/api/channels/${channelId}/members`, cookie, { businessId, role });

  const postMessage = (channelId: string, cookie: string, body: string, clientMessageId?: string) =>
    call('POST', `/api/channels/${channelId}/messages`, cookie, {
      body,
      ...(clientMessageId === undefined ? {} : { clientMessageId }),
    });

  const listFor = async (
    cookie: string,
    channelId: string,
  ): Promise<ChannelListItem | undefined> => {
    const res = await call('GET', '/api/channels', cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ChannelListItem[]>().find((entry) => entry.id === channelId);
  };

  it('creates a channel with the creator as owner', async () => {
    const channel = await createChannel();
    expect(channel.id.startsWith('chn_')).toBe(true);
    expect(channel.createdBy).toBe(owner.businessId);
    expect(channel.archivedAt).toBeNull();

    const detail = await call('GET', `/api/channels/${channel.id}`, owner.cookie);
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json<ChannelDetail>();
    expect(body).toMatchObject({
      id: channel.id,
      name: channel.name,
      members: [
        expect.objectContaining({
          businessId: owner.businessId,
          role: 'owner',
          lastReadSeq: 0,
        }),
      ],
      agentBindings: [],
    });

    const item = await listFor(owner.cookie, channel.id);
    expect(item).toMatchObject({
      role: 'owner',
      lastReadSeq: 0,
      unreadCount: 0,
      lastMessage: null,
    });
  });

  it('hides every channel entry from non-members including platform admins', async () => {
    const channel = await createChannel();
    const agent = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();
    await setAgentMember(app, adminCookie, agent.id, owner.businessId, {
      canUse: true,
      canMaintain: false,
    });

    for (const cookie of [outsider.cookie, adminCookie]) {
      for (const url of [`/api/channels/${channel.id}`, `/api/channels/${channel.id}/messages`]) {
        const res = await call('GET', url, cookie);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
        expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
      }
      const events = await fetch(`${baseUrl}/api/channels/${channel.id}/events`, {
        headers: { cookie },
      });
      expect(events.status).toBe(404);
      expect(await listFor(cookie, channel.id)).toBeUndefined();
    }

    const adminWrites: Array<
      ['POST' | 'PATCH' | 'DELETE', string, Record<string, unknown> | undefined]
    > = [
      ['PATCH', `/api/channels/${channel.id}`, { name: 'platform edit' }],
      [
        'POST',
        `/api/channels/${channel.id}/members`,
        { businessId: outsider.businessId, role: 'viewer' },
      ],
      [
        'DELETE',
        `/api/channels/${channel.id}/members/${encodeURIComponent(owner.businessId)}`,
        undefined,
      ],
      ['POST', `/api/channels/${channel.id}/agents`, { agentId: agent.id }],
      ['POST', `/api/channels/${channel.id}/messages`, { body: 'platform message' }],
      ['POST', READ_PATH(channel.id), { seq: 0 }],
    ];
    for (const [method, url, payload] of adminWrites) {
      const res = await call(method, url, adminCookie, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
    }

    // 先由成员绑定，确认平台管理员随后也不能删除别人的绑定。
    expect(
      (
        await call('POST', `/api/channels/${channel.id}/agents`, owner.cookie, {
          agentId: agent.id,
        })
      ).statusCode,
    ).toBe(201);
    const adminDelete = await call(
      'DELETE',
      `/api/channels/${channel.id}/agents/${agent.id}`,
      adminCookie,
    );
    expect(adminDelete.statusCode, adminDelete.body).toBe(404);

    const messages = await app.pool.query('select id from channel_messages where channel_id = $1', [
      channel.id,
    ]);
    expect(messages.rows).toHaveLength(0);
    const bindings = await app.pool.query(
      'select agent_id from channel_agent_bindings where channel_id = $1',
      [channel.id],
    );
    expect(bindings.rows).toEqual([{ agent_id: agent.id }]);
  });

  it('lets viewers read but rejects their posts', async () => {
    const channel = await createChannel();
    const added = await addMember(channel.id, owner.cookie, viewer.businessId, 'viewer');
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json<ChannelMember>()).toMatchObject({
      channelId: channel.id,
      businessId: viewer.businessId,
      role: 'viewer',
      lastReadSeq: 0,
    });

    expect((await call('GET', `/api/channels/${channel.id}`, viewer.cookie)).statusCode).toBe(200);
    expect(
      (await call('GET', `/api/channels/${channel.id}/messages`, viewer.cookie)).statusCode,
    ).toBe(200);

    const posted = await postMessage(channel.id, viewer.cookie, 'viewer cannot send');
    expect(posted.statusCode, posted.body).toBe(403);
    expect(posted.json<{ code: string }>().code).toBe('FORBIDDEN');

    const patched = await call('PATCH', `/api/channels/${channel.id}`, viewer.cookie, {
      name: 'viewer edit',
    });
    expect(patched.statusCode, patched.body).toBe(403);
  });

  it('assigns increasing seq to sequential and concurrent posts and pages by after', async () => {
    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);

    const sequential: ChannelMessage[] = [];
    for (const [cookie, body] of [
      [owner.cookie, 'one'],
      [member.cookie, 'two'],
      [owner.cookie, 'three'],
    ] as const) {
      const res = await postMessage(channel.id, cookie, body);
      expect(res.statusCode, res.body).toBe(201);
      sequential.push(res.json<ChannelMessage>());
    }
    for (let index = 1; index < sequential.length; index += 1) {
      expect(present(sequential[index]).seq).toBeGreaterThan(present(sequential[index - 1]).seq);
    }
    expect(sequential[1]).toMatchObject({
      channelId: channel.id,
      kind: 'human',
      authorBusinessId: member.businessId,
      clientMessageId: null,
    });

    const concurrentBodies = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
    const responses = await Promise.all(
      concurrentBodies.map((body, index) =>
        postMessage(channel.id, index % 2 === 0 ? owner.cookie : member.cookie, body),
      ),
    );
    const concurrent = responses.map((res) => {
      expect(res.statusCode, res.body).toBe(201);
      return res.json<ChannelMessage>();
    });
    for (const message of concurrent) {
      expect(message.seq).toBeGreaterThan(present(sequential[2]).seq);
    }
    const all = [...sequential, ...concurrent];
    expect(new Set(all.map((message) => message.seq)).size).toBe(all.length);

    const listed = await call('GET', `/api/channels/${channel.id}/messages`, owner.cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    const messages = listed.json<ChannelMessage[]>();
    const bySeq = [...all].sort((left, right) => left.seq - right.seq);
    expect(messages.map((message) => message.seq)).toEqual(bySeq.map((message) => message.seq));
    expect(messages.map((message) => message.body)).toEqual(bySeq.map((message) => message.body));

    const cursor = present(messages[4]).seq;
    const after = await call(
      'GET',
      `/api/channels/${channel.id}/messages?after=${cursor}`,
      owner.cookie,
    );
    expect(after.statusCode, after.body).toBe(200);
    const tail = after.json<ChannelMessage[]>();
    expect(tail.map((message) => message.seq)).toEqual(
      messages.slice(5).map((message) => message.seq),
    );
    expect(tail.every((message) => message.seq > cursor)).toBe(true);
  });

  it('returns the same message for repeated and concurrent clientMessageId', async () => {
    const channel = await createChannel();
    const clientMessageId = unique('client');

    const first = await postMessage(channel.id, owner.cookie, 'first', clientMessageId);
    expect(first.statusCode, first.body).toBe(201);
    const firstMessage = first.json<ChannelMessage>();
    const repeated = await postMessage(channel.id, owner.cookie, 'first', clientMessageId);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<ChannelMessage>()).toEqual(firstMessage);

    const racyId = unique('client');
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postMessage(channel.id, owner.cookie, 'race', racyId)),
    );
    expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    const raced = responses.map((res) => res.json<ChannelMessage>());
    expect(new Set(raced.map((message) => message.id)).size).toBe(1);
    expect(new Set(raced.map((message) => message.seq)).size).toBe(1);

    for (const clientId of [clientMessageId, racyId]) {
      const rows = await app.pool.query<{ count: string }>(
        'select count(*) from channel_messages where channel_id = $1 and client_message_id = $2',
        [channel.id, clientId],
      );
      expect(Number(rows.rows[0]?.count)).toBe(1);
    }

    const listed = await call('GET', `/api/channels/${channel.id}/messages`, owner.cookie);
    expect(listed.json<ChannelMessage[]>().map((message) => message.body)).toEqual([
      'first',
      'race',
    ]);
  });

  it('tracks unread, marks read idempotently, and clamps future cursors', async () => {
    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);

    const sent: ChannelMessage[] = [];
    for (const body of ['alpha', 'beta', 'gamma']) {
      const res = await postMessage(channel.id, owner.cookie, body);
      expect(res.statusCode, res.body).toBe(201);
      sent.push(res.json<ChannelMessage>());
    }

    const unread = await listFor(member.cookie, channel.id);
    expect(unread).toMatchObject({ role: 'member', lastReadSeq: 0, unreadCount: 3 });
    expect(JSON.stringify(unread?.lastMessage)).toContain('gamma');

    const read = await call('POST', READ_PATH(channel.id), member.cookie, {
      seq: present(sent[1]).seq,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ lastReadSeq: number }>()).toMatchObject({
      lastReadSeq: present(sent[1]).seq,
    });
    expect(await listFor(member.cookie, channel.id)).toMatchObject({
      lastReadSeq: present(sent[1]).seq,
      unreadCount: 1,
    });

    const backwards = await call('POST', READ_PATH(channel.id), member.cookie, {
      seq: present(sent[0]).seq,
    });
    expect(backwards.statusCode, backwards.body).toBe(200);
    expect(backwards.json<{ lastReadSeq: number }>().lastReadSeq).toBe(present(sent[1]).seq);
    expect(await listFor(member.cookie, channel.id)).toMatchObject({
      lastReadSeq: present(sent[1]).seq,
      unreadCount: 1,
    });

    const ahead = await call('POST', READ_PATH(channel.id), member.cookie, {
      seq: present(sent[2]).seq + 1_000_000,
    });
    expect(ahead.statusCode, ahead.body).toBe(200);
    expect(ahead.json<{ lastReadSeq: number }>().lastReadSeq).toBe(present(sent[2]).seq);
    expect(await listFor(member.cookie, channel.id)).toMatchObject({
      lastReadSeq: present(sent[2]).seq,
      unreadCount: 0,
    });
  });

  it('limits member management to owners and admins and protects owners from admins', async () => {
    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);
    expect(
      (await addMember(channel.id, owner.cookie, channelAdmin.businessId, 'admin')).statusCode,
    ).toBe(201);

    for (const res of [
      await call('PATCH', `/api/channels/${channel.id}`, member.cookie, { name: 'member edit' }),
      await addMember(channel.id, member.cookie, outsider.businessId, 'viewer'),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }

    const renamed = await call('PATCH', `/api/channels/${channel.id}`, channelAdmin.cookie, {
      name: 'renamed by admin',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<Channel>().name).toBe('renamed by admin');

    const grantOwner = await addMember(
      channel.id,
      channelAdmin.cookie,
      outsider.businessId,
      'owner',
    );
    expect(grantOwner.statusCode, grantOwner.body).toBe(403);

    const removeOwner = await call(
      'DELETE',
      `/api/channels/${channel.id}/members/${encodeURIComponent(owner.businessId)}`,
      channelAdmin.cookie,
    );
    expect(removeOwner.statusCode, removeOwner.body).toBe(403);

    const addViewer = await addMember(
      channel.id,
      channelAdmin.cookie,
      outsider.businessId,
      'viewer',
    );
    expect(addViewer.statusCode, addViewer.body).toBe(201);
    const removeViewer = await call(
      'DELETE',
      `/api/channels/${channel.id}/members/${encodeURIComponent(outsider.businessId)}`,
      channelAdmin.cookie,
    );
    expect(removeViewer.statusCode, removeViewer.body).toBe(204);
    expect(removeViewer.body).toBe('');
  });

  it('keeps the last owner and lets an owner hand over ownership', async () => {
    const sole = await createChannel();
    const denied = await call(
      'DELETE',
      `/api/channels/${sole.id}/members/${encodeURIComponent(owner.businessId)}`,
      owner.cookie,
    );
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json<{ code: string }>().code).toBe('CONFLICT');

    const stillThere = await call('GET', `/api/channels/${sole.id}`, owner.cookie);
    expect(stillThere.json<ChannelDetail>().members).toEqual([
      expect.objectContaining({ businessId: owner.businessId, role: 'owner' }),
    ]);

    const shared = await createChannel();
    const granted = await addMember(shared.id, owner.cookie, outsider.businessId, 'owner');
    expect(granted.statusCode, granted.body).toBe(201);
    const leave = await call(
      'DELETE',
      `/api/channels/${shared.id}/members/${encodeURIComponent(owner.businessId)}`,
      owner.cookie,
    );
    expect(leave.statusCode, leave.body).toBe(204);

    const detail = await call('GET', `/api/channels/${shared.id}`, outsider.cookie);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<ChannelDetail>().members.map((entry) => entry.businessId)).toEqual([
      outsider.businessId,
    ]);
  });

  it('binds agents only for managers with use access, dedupes, and keeps M1 conversationId null', async () => {
    const agent = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();
    const forbiddenAgent = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();
    await setAgentMember(app, adminCookie, agent.id, owner.businessId, {
      canUse: true,
      canMaintain: false,
    });
    await setAgentMember(app, adminCookie, agent.id, channelAdmin.businessId, {
      canUse: true,
      canMaintain: false,
    });
    await setAgentMember(app, adminCookie, forbiddenAgent.id, channelAdmin.businessId, {
      canUse: true,
      canMaintain: false,
    });
    // 成员本人可用该专家，才能把 403 归因到频道角色而不是专家可用性。
    await setAgentMember(app, adminCookie, forbiddenAgent.id, member.businessId, {
      canUse: true,
      canMaintain: false,
    });

    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);
    expect(
      (await addMember(channel.id, owner.cookie, channelAdmin.businessId, 'admin')).statusCode,
    ).toBe(201);

    const bound = await call('POST', `/api/channels/${channel.id}/agents`, owner.cookie, {
      agentId: agent.id,
    });
    expect(bound.statusCode, bound.body).toBe(201);
    expect(bound.json<ChannelAgentBinding>()).toMatchObject({
      channelId: channel.id,
      agentId: agent.id,
      conversationId: null,
      status: 'active',
      autoWakeOnAll: false,
      addedBy: owner.businessId,
    });
    const rows = await app.pool.query<{ conversation_id: string | null }>(
      'select conversation_id from channel_agent_bindings where channel_id = $1 and agent_id = $2',
      [channel.id, agent.id],
    );
    expect(rows.rows).toEqual([{ conversation_id: null }]);

    const duplicate = await call('POST', `/api/channels/${channel.id}/agents`, owner.cookie, {
      agentId: agent.id,
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);

    const memberBind = await call('POST', `/api/channels/${channel.id}/agents`, member.cookie, {
      agentId: forbiddenAgent.id,
    });
    expect(memberBind.statusCode, memberBind.body).toBe(403);

    const noUse = await call('POST', `/api/channels/${channel.id}/agents`, owner.cookie, {
      agentId: forbiddenAgent.id,
    });
    expect([403, 404]).toContain(noUse.statusCode);

    const adminBound = await call(
      'POST',
      `/api/channels/${channel.id}/agents`,
      channelAdmin.cookie,
      { agentId: forbiddenAgent.id },
    );
    expect(adminBound.statusCode, adminBound.body).toBe(201);

    const detail = await call('GET', `/api/channels/${channel.id}`, owner.cookie);
    expect(
      detail
        .json<ChannelDetail>()
        .agentBindings.map((entry) => entry.agentId)
        .sort(),
    ).toEqual([agent.id, forbiddenAgent.id].sort());

    expect(
      (await call('DELETE', `/api/channels/${channel.id}/agents/${agent.id}`, owner.cookie))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await call(
          'DELETE',
          `/api/channels/${channel.id}/agents/${forbiddenAgent.id}`,
          channelAdmin.cookie,
        )
      ).statusCode,
    ).toBe(204);
    const remaining = await app.pool.query(
      'select agent_id from channel_agent_bindings where channel_id = $1',
      [channel.id],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it('answers channel membership before agent access when binding agents', async () => {
    const agent = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();
    const channel = await createChannel();
    // 真实账号：没有任何角色，因此没有 agents.use 叶；默认 user 带该叶会掩盖顺序问题。
    const noGrant = await createTestAccount(app, adminCookie, { systemKeys: [] });
    noGrantBusinessIds.push(noGrant.businessId);

    for (const agentId of [agent.id, 'agt_missing_for_channel_order_test']) {
      const res = await call('POST', `/api/channels/${channel.id}/agents`, noGrant.cookie, {
        agentId,
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
    }

    for (const role of ['member', 'viewer'] as const) {
      const account = await createTestAccount(app, adminCookie, { systemKeys: [] });
      noGrantBusinessIds.push(account.businessId);
      const added = await addMember(channel.id, owner.cookie, account.businessId, role);
      expect(added.statusCode, added.body).toBe(201);

      const res = await call('POST', `/api/channels/${channel.id}/agents`, account.cookie, {
        agentId: agent.id,
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
    }
  });

  it('replays history after the cursor, follows live messages once, and releases Redis subscriptions on disconnect', async () => {
    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);
    const first = (
      await postMessage(channel.id, owner.cookie, 'history one')
    ).json<ChannelMessage>();
    const second = (
      await postMessage(channel.id, owner.cookie, 'history two')
    ).json<ChannelMessage>();

    const channelEventConnections = async (): Promise<number> =>
      (await redis.client('LIST'))
        .split('\n')
        .filter((line) => line.includes(`name=channel-events:${channel.id}`)).length;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/channels/${channel.id}/events?after=${first.seq}`, {
      headers: { cookie: member.cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const events: ChannelEvent[] = [];
    const pump = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (
            let boundary = buffer.indexOf('\n\n');
            boundary >= 0;
            boundary = buffer.indexOf('\n\n')
          ) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) {
                events.push(JSON.parse(line.slice(5).trim()) as ChannelEvent);
              }
            }
          }
        }
      } catch {
        return;
      }
    })();

    try {
      expect(await waitFor(() => events.some((event) => event.seq === second.seq))).toBe(true);
      expect(events.some((event) => event.seq <= first.seq)).toBe(false);
      expect(events.filter((event) => event.seq === second.seq)).toHaveLength(1);
      expect(events.find((event) => event.seq === second.seq)).toMatchObject({
        type: 'message.created',
        channelId: channel.id,
        message: expect.objectContaining({ seq: second.seq, authorBusinessId: owner.businessId }),
      });
      expect(await waitFor(async () => (await channelEventConnections()) >= 1)).toBe(true);

      const live = (
        await postMessage(channel.id, member.cookie, 'live three')
      ).json<ChannelMessage>();
      expect(await waitFor(() => events.some((event) => event.seq === live.seq))).toBe(true);
      expect(events.filter((event) => event.seq === second.seq)).toHaveLength(1);
      expect(events.filter((event) => event.seq === live.seq)).toHaveLength(1);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    }

    expect(await waitFor(async () => (await channelEventConnections()) === 0, 5_000)).toBe(true);
  });

  it('preserves message whitespace and opaque client ids while rejecting malformed input', async () => {
    const channel = await createChannel();

    const spaced = await postMessage(channel.id, owner.cookie, '  原文\n', ' key');
    expect(spaced.statusCode, spaced.body).toBe(201);
    const spacedMessage = spaced.json<ChannelMessage>();
    expect(spacedMessage).toMatchObject({ body: '  原文\n', clientMessageId: ' key' });

    const plain = await postMessage(channel.id, owner.cookie, '  原文\n', 'key');
    expect(plain.statusCode, plain.body).toBe(201);
    const plainMessage = plain.json<ChannelMessage>();
    expect(plainMessage).toMatchObject({ body: '  原文\n', clientMessageId: 'key' });
    expect(plainMessage.id).not.toBe(spacedMessage.id);
    expect(plainMessage.seq).toBeGreaterThan(spacedMessage.seq);

    const listed = await call('GET', `/api/channels/${channel.id}/messages`, owner.cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<ChannelMessage[]>()).toMatchObject([
      expect.objectContaining({ body: '  原文\n', clientMessageId: ' key' }),
      expect.objectContaining({ body: '  原文\n', clientMessageId: 'key' }),
    ]);

    const blank = await postMessage(channel.id, owner.cookie, '   \n\t ');
    expect(blank.statusCode, blank.body).toBe(400);
    expect(blank.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const unknown = await call('POST', `/api/channels/${channel.id}/messages`, owner.cookie, {
      body: 'hello',
      clientMessageId: 'key',
      kind: 'agent',
    });
    expect(unknown.statusCode, unknown.body).toBe(400);
    expect(unknown.json<{ code: string }>().code).toBe('INVALID_INPUT');
  });

  it('replays more than one SSE page without gaps or duplicates', async () => {
    const channel = await createChannel();
    const total = 205;
    const ids = Array.from({ length: total }, () => newId('channelMessage'));
    const bodies = ids.map((_, index) => `bulk-${index}`);
    await app.pool.query(
      `insert into channel_messages (id, channel_id, kind, author_business_id, body)
       select id, $2, 'human', $3, body
       from unnest($1::text[], $4::text[]) as bulk(id, body)`,
      [ids, channel.id, owner.businessId, bodies],
    );
    const rows = await app.pool.query<{ seq: string }>(
      'select seq from channel_messages where channel_id = $1 order by seq',
      [channel.id],
    );
    expect(rows.rows).toHaveLength(total);
    const allSeqs = rows.rows.map((row) => Number(row.seq));
    const after = present(allSeqs[0]);
    const expected = allSeqs.slice(1);
    expect(expected).toHaveLength(total - 1);

    const channelEventConnections = async (): Promise<number> =>
      (await redis.client('LIST'))
        .split('\n')
        .filter((line) => line.includes(`name=channel-events:${channel.id}`)).length;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/channels/${channel.id}/events?after=${after}`, {
      headers: { cookie: owner.cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const events: ChannelEvent[] = [];
    const pump = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (
            let boundary = buffer.indexOf('\n\n');
            boundary >= 0;
            boundary = buffer.indexOf('\n\n')
          ) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) {
                events.push(JSON.parse(line.slice(5).trim()) as ChannelEvent);
              }
            }
          }
        }
      } catch {
        return;
      }
    })();

    try {
      expect(await waitFor(() => events.length >= expected.length, 10_000)).toBe(true);
      const seqs = events.map((event) => (event.type === 'message.created' ? event.seq : -1));
      expect(seqs).toEqual(expected);
      expect(new Set(seqs).size).toBe(expected.length);
      expect(await waitFor(async () => (await channelEventConnections()) >= 1)).toBe(true);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    }

    expect(await waitFor(async () => (await channelEventConnections()) === 0, 5_000)).toBe(true);
  });

  it('ends a live stream and releases Redis after the member is removed', async () => {
    const channel = await createChannel();
    expect(
      (await addMember(channel.id, owner.cookie, member.businessId, 'member')).statusCode,
    ).toBe(201);
    const before = (
      await postMessage(channel.id, owner.cookie, 'before removal')
    ).json<ChannelMessage>();

    const channelEventConnections = async (): Promise<number> =>
      (await redis.client('LIST'))
        .split('\n')
        .filter((line) => line.includes(`name=channel-events:${channel.id}`)).length;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/channels/${channel.id}/events?after=${before.seq}`, {
      headers: { cookie: member.cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const events: ChannelEvent[] = [];
    let ended = false;
    const pump = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          for (
            let boundary = buffer.indexOf('\n\n');
            boundary >= 0;
            boundary = buffer.indexOf('\n\n')
          ) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) {
                events.push(JSON.parse(line.slice(5).trim()) as ChannelEvent);
              }
            }
          }
        }
      } catch {
        return;
      }
    })();

    try {
      expect(await waitFor(async () => (await channelEventConnections()) >= 1)).toBe(true);

      const removed = await call(
        'DELETE',
        `/api/channels/${channel.id}/members/${encodeURIComponent(member.businessId)}`,
        owner.cookie,
      );
      expect(removed.statusCode, removed.body).toBe(204);

      await postMessage(channel.id, owner.cookie, 'after removal');
      expect(await waitFor(() => events.some((event) => event.type === 'error'), 10_000)).toBe(
        true,
      );
      expect(await waitFor(() => ended, 5_000)).toBe(true);
      expect(events.every((event) => event.type === 'error')).toBe(true);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    }

    expect(await waitFor(async () => (await channelEventConnections()) === 0, 5_000)).toBe(true);
  });

  it('lets only one of two concurrent owner removals win and keeps one owner', async () => {
    const channel = await createChannel();
    const granted = await addMember(channel.id, owner.cookie, channelAdmin.businessId, 'owner');
    expect(granted.statusCode, granted.body).toBe(201);

    const responses = await Promise.all([
      call(
        'DELETE',
        `/api/channels/${channel.id}/members/${encodeURIComponent(owner.businessId)}`,
        owner.cookie,
      ),
      call(
        'DELETE',
        `/api/channels/${channel.id}/members/${encodeURIComponent(channelAdmin.businessId)}`,
        channelAdmin.cookie,
      ),
    ]);
    expect(responses.map((res) => res.statusCode).sort()).toEqual([204, 409]);
    const conflict = present(responses.find((res) => res.statusCode === 409));
    expect(conflict.json<{ code: string }>().code).toBe('CONFLICT');

    const survivor = responses[0]?.statusCode === 204 ? channelAdmin.businessId : owner.businessId;
    const rows = await app.pool.query<{ business_id: string; role: string }>(
      'select business_id, role from channel_members where channel_id = $1',
      [channel.id],
    );
    expect(rows.rows).toEqual([{ business_id: survivor, role: 'owner' }]);

    const survivorCookie = survivor === owner.businessId ? owner.cookie : channelAdmin.cookie;
    const detail = await call('GET', `/api/channels/${channel.id}`, survivorCookie);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<ChannelDetail>().members).toHaveLength(1);
  });
});
