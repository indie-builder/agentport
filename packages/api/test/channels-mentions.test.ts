import type { AddressInfo } from 'node:net';
import {
  type Agent,
  type Channel,
  type ChannelEvent,
  type ChannelMessage,
  RUN_QUEUE_MAX_WAITING,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { persistRunMessages } from '../../worker/src/messages.js';
import { getQueue } from '../src/queue/producer.js';
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

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

interface RunRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  trigger: string;
  channel_id: string | null;
  channel_trigger_message_id: string | null;
  status: string;
}

const ready = await infraReady;

describe.skipIf(!ready)('channel mentions', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let baseUrl: string;
  let redis: Redis;
  let owner: TestAccount;
  let member: TestAccount;
  let viewer: TestAccount;
  const channelIds: string[] = [];
  const agentSlugs: string[] = [];

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
  });

  afterAll(async () => {
    if (channelIds.length > 0) {
      const runs = await app.pool
        .query<{ id: string }>('select id from agent_runs where channel_id = any($1::text[])', [
          channelIds,
        ])
        .catch(() => ({ rows: [] }));
      for (const row of runs.rows) {
        await getQueue()
          .remove(row.id)
          .catch(() => undefined);
      }
      await app.pool
        .query('delete from channels where id = any($1::text[])', [channelIds])
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs });
    const businessIds = [owner.businessId, member.businessId, viewer.businessId];
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await redis.quit().catch(() => undefined);
    await app.close();
  });

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

  const createChannel = async (): Promise<Channel> => {
    const res = await call('POST', '/api/channels', owner.cookie, { name: unique('channel') });
    expect(res.statusCode, res.body).toBe(201);
    const channel = res.json<Channel>();
    channelIds.push(channel.id);
    return channel;
  };

  const addMember = async (channelId: string, account: TestAccount, role: MemberRole) => {
    const res = await call('POST', `/api/channels/${channelId}/members`, owner.cookie, {
      businessId: account.businessId,
      role,
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  const createBoundAgent = async (channelId: string, autoWakeOnAll = false): Promise<Agent> => {
    const created = await createAgent(app, adminCookie, {
      slug: unique('channel-agent'),
      track: agentSlugs,
    });
    const agent = created.json<Agent>();
    await setAgentMember(app, adminCookie, agent.id, owner.businessId, {
      canUse: true,
      canMaintain: false,
    });
    const bound = await call('POST', `/api/channels/${channelId}/agents`, owner.cookie, {
      agentId: agent.id,
      autoWakeOnAll,
    });
    expect(bound.statusCode, bound.body).toBe(201);
    return agent;
  };

  const post = (channelId: string, cookie: string, payload: Record<string, unknown>) =>
    call('POST', `/api/channels/${channelId}/messages`, cookie, payload);

  const channelRuns = async (channelId: string): Promise<RunRow[]> => {
    const result = await app.pool.query<RunRow>(
      `select id, agent_id, conversation_id, trigger, channel_id,
              channel_trigger_message_id, status
         from agent_runs
        where channel_id = $1
        order by created_at, id`,
      [channelId],
    );
    return result.rows;
  };

  // 复用 worker 的真实落库/频道投影路径，不手写等价写入。
  const finishRunWithReply = async (run: RunRow, agentId: string, text: string) => {
    await app.pool.query(
      "update agent_runs set status = 'running', started_at = now() where id = $1",
      [run.id],
    );
    await persistRunMessages(app.db, {
      agentId,
      conversationId: run.conversation_id,
      runId: run.id,
      events: [{ type: 'assistant_text', text }],
    });
    await app.pool.query(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [run.id],
    );
  };

  const runUserContent = async (runId: string) => {
    const result = await app.pool.query<{ content: { type: string; text: string } }>(
      "select content from messages where run_id = $1 and role = 'user'",
      [runId],
    );
    return result.rows;
  };

  it('wakes only mentioned agents and reuses one lane across members', async () => {
    const channel = await createChannel();
    await addMember(channel.id, member, 'member');
    const agent = await createBoundAgent(channel.id);
    const other = await createBoundAgent(channel.id);

    const first = await post(channel.id, owner.cookie, {
      body: 'hello agent',
      mentions: [agent.id],
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstMessage = first.json<ChannelMessage>();

    const started = await channelRuns(channel.id);
    expect(started).toHaveLength(1);
    const run = started[0];
    if (!run) throw new Error('expected a run');
    expect(run).toMatchObject({
      agent_id: agent.id,
      trigger: 'channel',
      channel_id: channel.id,
      channel_trigger_message_id: firstMessage.id,
      status: 'queued',
    });
    expect(await getQueue().getJob(run.id)).toBeDefined();

    const lane = await app.pool.query<{ channel_id: string; agent_id: string }>(
      'select channel_id, agent_id from conversations where id = $1',
      [run.conversation_id],
    );
    expect(lane.rows[0]).toEqual({ channel_id: channel.id, agent_id: agent.id });
    const binding = await app.pool.query<{ conversation_id: string }>(
      'select conversation_id from channel_agent_bindings where channel_id = $1 and agent_id = $2',
      [channel.id, agent.id],
    );
    expect(binding.rows[0]?.conversation_id).toBe(run.conversation_id);

    // 释放 lane 后由第二个成员继续，验证同一 (channel, agent) 只复用一个会话。
    await app.pool.query(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [run.id],
    );
    const second = await post(channel.id, member.cookie, {
      body: 'second member',
      mentions: [agent.id],
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondMessage = second.json<ChannelMessage>();

    const after = await channelRuns(channel.id);
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.agent_id)).toEqual([agent.id, agent.id]);
    expect(after[1]?.conversation_id).toBe(run.conversation_id);
    expect(after[1]?.channel_trigger_message_id).toBe(secondMessage.id);
    expect(after.some((row) => row.agent_id === other.id)).toBe(false);
  });

  it('injects lane context on the second round without rewriting channel messages', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);
    const other = await createBoundAgent(channel.id);
    const firstReply = `第一轮回复 ${unique('reply')}`;

    const first = await post(channel.id, owner.cookie, {
      body: 'first round prompt',
      mentions: [agent.id],
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstMessage = first.json<ChannelMessage>();
    const firstRun = (await channelRuns(channel.id)).find(
      (run) => run.channel_trigger_message_id === firstMessage.id,
    );
    if (!firstRun) throw new Error('expected the first round run');
    await finishRunWithReply(firstRun, agent.id, firstReply);

    const projected = await app.pool.query<{ body: string }>(
      "select body from channel_messages where channel_id = $1 and run_id = $2 and kind = 'agent'",
      [channel.id, firstRun.id],
    );
    expect(projected.rows.map((row) => row.body)).toEqual([firstReply]);

    const second = await post(channel.id, owner.cookie, {
      body: 'second round prompt',
      mentions: [agent.id, other.id],
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondMessage = second.json<ChannelMessage>();
    const secondRuns = (await channelRuns(channel.id)).filter(
      (run) => run.channel_trigger_message_id === secondMessage.id,
    );
    expect(secondRuns).toHaveLength(2);
    expect(secondRuns.map((run) => run.agent_id)).toEqual(
      expect.arrayContaining([agent.id, other.id]),
    );

    for (const run of secondRuns) {
      const [user] = await runUserContent(run.id);
      expect(user?.content.type).toBe('text');
      const text = user?.content.text ?? '';
      expect(text).toContain(firstReply);
      expect(text).toContain('【频道上下文】');
      expect(text).toContain('【当前消息】');
      expect(text).toContain('second round prompt');
    }

    const human = await app.pool.query<{ body: string }>(
      "select body from channel_messages where channel_id = $1 and kind = 'human' order by seq",
      [channel.id],
    );
    expect(human.rows.map((row) => row.body)).toEqual([
      'first round prompt',
      'second round prompt',
    ]);
    const injected = await app.pool.query<{ count: string }>(
      "select count(*) from channel_messages where channel_id = $1 and body like '%【频道上下文】%'",
      [channel.id],
    );
    expect(Number(injected.rows[0]?.count)).toBe(0);
  });

  it('does not enqueue without a mention', async () => {
    const channel = await createChannel();
    await createBoundAgent(channel.id);

    const posted = await post(channel.id, owner.cookie, { body: 'nobody mentioned' });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(await channelRuns(channel.id)).toHaveLength(0);
  });

  it('checks channel post access before the run queue for mentions', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);
    await addMember(channel.id, viewer, 'viewer');
    const waiting = vi
      .spyOn(getQueue(), 'getWaitingCount')
      .mockResolvedValue(RUN_QUEUE_MAX_WAITING + 1);
    const mentionPayload: Record<string, unknown> = {
      body: 'mention full',
      mentions: [agent.id],
    };
    const mentionPayloads: Array<Record<string, unknown>> = [
      mentionPayload,
      { body: 'mention all full', mentionAll: true },
    ];
    try {
      // 普通非成员与平台管理员都不能借 @ 进入队列容量分支。
      for (const cookie of [member.cookie, adminCookie]) {
        for (const payload of mentionPayloads) {
          const res = await post(channel.id, cookie, payload);
          expect(res.statusCode, res.body).toBe(404);
          expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
        }
      }
      expect(waiting).not.toHaveBeenCalled();

      for (const payload of mentionPayloads) {
        const res = await post(channel.id, viewer.cookie, payload);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
      }
      expect(waiting).not.toHaveBeenCalled();

      // 真实成员保留原行为：队列满时 503，并且确实访问了队列。
      const full = await post(channel.id, owner.cookie, mentionPayload);
      expect(full.statusCode, full.body).toBe(503);
      expect(full.json<{ code: string }>().code).toBe('SERVICE_UNAVAILABLE');
      expect(waiting).toHaveBeenCalledTimes(1);
    } finally {
      waiting.mockRestore();
    }
  });

  it('rejects invalid explicit mentions before writing the message', async () => {
    const channel = await createChannel();
    await addMember(channel.id, viewer, 'viewer');

    const unbound = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();

    const paused = await createBoundAgent(channel.id);
    await app.pool.query(
      "update channel_agent_bindings set status = 'paused' where channel_id = $1 and agent_id = $2",
      [channel.id, paused.id],
    );

    const disabled = await createBoundAgent(channel.id);
    await app.pool.query('update agents set enabled = false where id = $1', [disabled.id]);

    const active = await createBoundAgent(channel.id);

    const rejected: Array<[string, string, string[]]> = [
      [owner.cookie, `invalid-unbound-${unique('c')}`, [unbound.id]],
      [owner.cookie, `invalid-paused-${unique('c')}`, [paused.id]],
      [owner.cookie, `invalid-disabled-${unique('c')}`, [disabled.id]],
    ];
    for (const [cookie, clientMessageId, mentions] of rejected) {
      const res = await post(channel.id, cookie, {
        body: 'invalid mention',
        clientMessageId,
        mentions,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('INVALID_INPUT');
      const stored = await app.pool.query<{ count: string }>(
        'select count(*) from channel_messages where channel_id = $1 and client_message_id = $2',
        [channel.id, clientMessageId],
      );
      expect(Number(stored.rows[0]?.count)).toBe(0);
    }

    const viewerPost = await post(channel.id, viewer.cookie, {
      body: 'viewer mention',
      mentions: [active.id],
    });
    expect(viewerPost.statusCode, viewerPost.body).toBe(403);
    expect(viewerPost.json<{ code: string }>().code).toBe('FORBIDDEN');

    expect(await channelRuns(channel.id)).toHaveLength(0);
  });

  it('wakes on mentionAll only for opt-in bindings', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id, false);

    const optedOut = await post(channel.id, owner.cookie, {
      body: 'all without opt-in',
      mentionAll: true,
    });
    expect(optedOut.statusCode, optedOut.body).toBe(201);
    expect(await channelRuns(channel.id)).toHaveLength(0);

    await app.pool.query(
      'update channel_agent_bindings set auto_wake_on_all = true where channel_id = $1 and agent_id = $2',
      [channel.id, agent.id],
    );
    const optedIn = await post(channel.id, owner.cookie, {
      body: 'all with opt-in',
      mentionAll: true,
    });
    expect(optedIn.statusCode, optedIn.body).toBe(201);
    const runs = await channelRuns(channel.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent_id).toBe(agent.id);
  });

  it('writes a system notice and skips a busy lane', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);

    const first = await post(channel.id, owner.cookie, {
      body: 'first turn',
      mentions: [agent.id],
    });
    expect(first.statusCode, first.body).toBe(201);

    const busy = await post(channel.id, owner.cookie, {
      body: 'second turn while busy',
      mentions: [agent.id],
    });
    expect(busy.statusCode, busy.body).toBe(201);
    expect(await channelRuns(channel.id)).toHaveLength(1);

    const notices = await app.pool.query<{ kind: string; agent_id: string; body: string }>(
      "select kind, agent_id, body from channel_messages where channel_id = $1 and kind = 'system'",
      [channel.id],
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]).toMatchObject({ kind: 'system', agent_id: agent.id });
    expect(notices.rows[0]?.body).toContain('处理上一轮');
  });

  it('does not wake again for a repeated client message id', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);
    const clientMessageId = unique('client');

    const first = await post(channel.id, owner.cookie, {
      body: 'idempotent mention',
      clientMessageId,
      mentions: [agent.id],
    });
    expect(first.statusCode, first.body).toBe(201);
    const runs = await channelRuns(channel.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error('expected a run');
    await app.pool.query(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [run.id],
    );

    const repeated = await post(channel.id, owner.cookie, {
      body: 'idempotent mention',
      clientMessageId,
      mentions: [agent.id],
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<ChannelMessage>().id).toBe(first.json<ChannelMessage>().id);
    expect(await channelRuns(channel.id)).toHaveLength(1);
  });

  it('keeps channel lanes out of private conversation list, search, and chat entry points', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);

    const posted = await post(channel.id, owner.cookie, {
      body: 'lane isolation marker',
      mentions: [agent.id],
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const run = (await channelRuns(channel.id))[0];
    if (!run) throw new Error('expected a run');
    const laneId = run.conversation_id;

    const listed = await call('GET', '/api/conversations', owner.cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<Array<{ id: string }>>().some((entry) => entry.id === laneId)).toBe(false);

    const searched = await call(
      'GET',
      `/api/conversations/search?q=${encodeURIComponent('lane isolation marker')}`,
      owner.cookie,
    );
    expect(searched.statusCode, searched.body).toBe(200);
    expect(
      searched.json<{ items: Array<{ id: string }> }>().items.some((entry) => entry.id === laneId),
    ).toBe(false);

    const detail = await call('GET', `/api/conversations/${laneId}`, owner.cookie);
    expect(detail.statusCode, detail.body).toBe(404);
    expect(detail.json<{ code: string }>().code).toBe('CONVERSATION_NOT_FOUND');

    const chat = await call('POST', '/api/chat', owner.cookie, {
      agentId: agent.id,
      message: 'must not enter through chat',
      conversationId: laneId,
    });
    expect(chat.statusCode, chat.body).toBe(404);
    expect(chat.json<{ code: string }>().code).toBe('CONVERSATION_NOT_FOUND');

    const cancel = await call('POST', `/api/chat/${run.id}/cancel`, owner.cookie);
    expect(cancel.statusCode, cancel.body).toBe(404);
    expect(cancel.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');
  });

  it('compensates a failed enqueue and keeps the channel message', async () => {
    const channel = await createChannel();
    const agent = await createBoundAgent(channel.id);
    const queue = getQueue();
    const add = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis down'));
    let posted: Awaited<ReturnType<typeof post>>;
    try {
      posted = await post(channel.id, owner.cookie, {
        body: 'enqueue failure',
        mentions: [agent.id],
      });
    } finally {
      add.mockRestore();
    }

    expect(posted.statusCode, posted.body).toBe(503);
    expect(posted.json<{ code: string }>().code).toBe('SERVICE_UNAVAILABLE');
    const runs = await channelRuns(channel.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });

    const messages = await call('GET', `/api/channels/${channel.id}/messages`, owner.cookie);
    expect(messages.statusCode, messages.body).toBe(200);
    expect(
      messages.json<ChannelMessage[]>().some((message) => message.body === 'enqueue failure'),
    ).toBe(true);
  });

  it('forwards run lifecycle hints only while the viewer is still a member', async () => {
    const channel = await createChannel();
    await addMember(channel.id, member, 'member');
    const agent = await createBoundAgent(channel.id);

    const streamKey = `channel:${channel.id}:events`;
    const events: ChannelEvent[] = [];
    let ended = false;
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/channels/${channel.id}/events`, {
      headers: { cookie: member.cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
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

    const publish = (payload: Record<string, unknown>) =>
      redis.xadd(streamKey, '*', 'payload', JSON.stringify(payload));

    try {
      await publish({
        type: 'run.started',
        channelId: channel.id,
        runId: unique('run'),
        agentId: agent.id,
      });
      expect(
        await waitFor(() => events.some((event) => event.type === 'run.started'), 10_000),
      ).toBe(true);

      const removed = await call(
        'DELETE',
        `/api/channels/${channel.id}/members/${encodeURIComponent(member.businessId)}`,
        owner.cookie,
      );
      expect(removed.statusCode, removed.body).toBe(204);

      await publish({
        type: 'run.finished',
        channelId: channel.id,
        runId: unique('run'),
        agentId: agent.id,
        status: 'succeeded',
      });
      expect(await waitFor(() => ended, 10_000)).toBe(true);
      expect(events.some((event) => event.type === 'run.finished')).toBe(false);
      expect(events.some((event) => event.type === 'error')).toBe(true);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    }
  });
});
