import type { AddressInfo } from 'node:net';
import { repo } from '@agentport/db';
import {
  type Channel,
  type ChannelEvent,
  type ChatEvent,
  channelStreamKey,
  runCancelKey,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeProducer,
  publishRun,
  type RunSubscription,
  subscribeChannel,
} from '../src/queue/producer.js';
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
type ActiveRun = {
  runId: string;
  agentId: string;
  status: 'queued' | 'running';
  startedAt: string | null;
};
type RunRow = {
  id: string;
  agent_id: string;
  status: string;
  initiated_by: string | null;
  started_at: Date | null;
};

const cancelState = vi.hoisted(() => ({ failFor: new Set<string>() }));

// 取消信号是控制面唯一无法用 DB 行模拟的失败点：让指定 run 的 NX 写入抛错，其余走真实实现。
vi.mock('../src/queue/producer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queue/producer.js')>();
  return {
    ...actual,
    requestRunCancel: (runId: string) =>
      cancelState.failFor.has(runId)
        ? Promise.reject(new Error('cancel signal failed'))
        : actual.requestRunCancel(runId),
  };
});

const ready = await infraReady;

/** M3 控制面：活动 run 列表、run 事件流、stop / disconnect / close 与真实操作人审计。 */
describe.skipIf(!ready)('channel control', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let baseUrl: string;
  let redis: Redis;
  let owner: TestAccount;
  let member: TestAccount;
  let other: TestAccount;
  let viewer: TestAccount;
  let channelAdmin: TestAccount;
  let outsider: TestAccount;
  const channelIds: string[] = [];
  const agentSlugs: string[] = [];
  const agentIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    redis = new Redis(testConfig().REDIS_URL);
    owner = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    member = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    other = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    viewer = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    channelAdmin = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    outsider = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });

    for (let index = 0; index < 2; index += 1) {
      const agent = (
        await createAgent(app, adminCookie, {
          slug: unique(`control-agent-${index}`),
          track: agentSlugs,
        })
      ).json<{ id: string }>();
      agentIds.push(agent.id);
      await setAgentMember(app, adminCookie, agent.id, owner.businessId, {
        canUse: true,
        canMaintain: false,
      });
    }
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
      other.businessId,
      viewer.businessId,
      channelAdmin.businessId,
      outsider.businessId,
    ];
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from audit_log where target = any($1::text[])', [channelIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await app.pool.query('delete from audit_log where actor = $1', [owner.businessId]);
    await redis.quit().catch(() => undefined);
    await closeProducer();
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
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
    const res = await call('POST', '/api/channels', owner.cookie, { name: unique('control') });
    expect(res.statusCode, res.body).toBe(201);
    const channel = res.json<Channel>();
    channelIds.push(channel.id);
    return channel;
  };

  const addMember = async (
    channelId: string,
    account: TestAccount,
    role: MemberRole,
  ): Promise<void> => {
    const res = await call('POST', `/api/channels/${channelId}/members`, owner.cookie, {
      businessId: account.businessId,
      role,
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  const bindAgent = async (channelId: string, agentId: string): Promise<void> => {
    const res = await call('POST', `/api/channels/${channelId}/agents`, owner.cookie, {
      agentId,
      autoWakeOnAll: false,
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  /** 每个用例独立频道，避免成员/绑定状态在用例间串味。 */
  const setup = async (agentCount = 1) => {
    const channel = await createChannel();
    await addMember(channel.id, member, 'member');
    await addMember(channel.id, other, 'member');
    await addMember(channel.id, viewer, 'viewer');
    await addMember(channel.id, channelAdmin, 'admin');
    const agents = agentIds.slice(0, agentCount);
    for (const agentId of agents) await bindAgent(channel.id, agentId);
    return { channel, agents };
  };

  const mention = async (channelId: string, cookie: string, agentIdsToWake: string[]) =>
    call('POST', `/api/channels/${channelId}/messages`, cookie, {
      body: unique('control-message'),
      mentions: agentIdsToWake,
    });

  const channelRuns = async (channelId: string): Promise<RunRow[]> => {
    const result = await app.pool.query<RunRow>(
      `select id, agent_id, status, initiated_by, started_at
         from agent_runs
        where channel_id = $1
        order by created_at, id`,
      [channelId],
    );
    return result.rows;
  };

  const setRunStatus = async (runId: string, status: 'running' | 'succeeded'): Promise<void> => {
    await app.pool.query(
      `update agent_runs
          set status = $2,
              started_at = case when $2 = 'running' then coalesce(started_at, now()) else started_at end,
              ended_at = case when $2 = 'succeeded' then now() else ended_at end
        where id = $1`,
      [runId, status],
    );
  };

  const runIdFor = async (channelId: string, agentId: string): Promise<string> => {
    const runs = await channelRuns(channelId);
    const run = runs.find((row) => row.agent_id === agentId && row.status === 'queued');
    if (!run) throw new Error('expected a queued channel run');
    return run.id;
  };

  it('lists active runs for members and hides the channel from non-members including platform admins', async () => {
    const { channel, agents } = await setup(2);
    const posted = await mention(channel.id, member.cookie, agents);
    expect(posted.statusCode, posted.body).toBe(201);
    const [first, second] = await channelRuns(channel.id);
    if (!first || !second) throw new Error('expected two channel runs');
    await setRunStatus(second.id, 'running');

    const listed = await call(
      'GET',
      `/api/channels/${channel.id}/runs?status=active`,
      member.cookie,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    const items = listed.json<{ items: ActiveRun[] }>().items;
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((item) => [item.runId, item]));
    expect(byId.get(first.id)).toMatchObject({
      runId: first.id,
      agentId: first.agent_id,
      status: 'queued',
      startedAt: null,
    });
    expect(byId.get(second.id)).toMatchObject({
      runId: second.id,
      agentId: second.agent_id,
      status: 'running',
    });
    expect(byId.get(second.id)?.startedAt).toEqual(expect.any(String));

    await setRunStatus(first.id, 'succeeded');
    const remaining = await call('GET', `/api/channels/${channel.id}/runs`, member.cookie);
    expect(remaining.statusCode, remaining.body).toBe(200);
    expect(remaining.json<{ items: ActiveRun[] }>().items.map((item) => item.runId)).toEqual([
      second.id,
    ]);

    const viewerList = await call('GET', `/api/channels/${channel.id}/runs`, viewer.cookie);
    expect(viewerList.statusCode, viewerList.body).toBe(200);

    for (const cookie of [outsider.cookie, adminCookie]) {
      const hidden = await call('GET', `/api/channels/${channel.id}/runs`, cookie);
      expect(hidden.statusCode, hidden.body).toBe(404);
    }
    const invalid = await call(
      'GET',
      `/api/channels/${channel.id}/runs?status=done`,
      member.cookie,
    );
    expect(invalid.statusCode, invalid.body).toBe(400);
  });

  it('stops a queued run with CAS, publishes channel run.finished, and audits the real actor', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    const posted = await mention(channel.id, member.cookie, [agentId]);
    expect(posted.statusCode, posted.body).toBe(201);
    const runId = await runIdFor(channel.id, agentId);

    const events: ChannelEvent[] = [];
    let subscription: RunSubscription | undefined;
    subscription = await subscribeChannel(channel.id, (event) => {
      events.push(event);
    });
    try {
      const stopped = await call(
        'POST',
        `/api/channels/${channel.id}/runs/${runId}/stop`,
        member.cookie,
      );
      expect(stopped.statusCode, stopped.body).toBe(202);
      expect(stopped.json()).toEqual({ ok: true });

      const [run] = await channelRuns(channel.id);
      expect(run?.status).toBe('cancelled');
      expect(
        await waitFor(() =>
          events.some(
            (event) =>
              event.type === 'run.finished' &&
              event.runId === runId &&
              event.status === 'cancelled',
          ),
        ),
      ).toBe(true);

      const audit = await app.pool.query<{ actor: string; action: string }>(
        'select actor, action from audit_log where target = $1',
        [runId],
      );
      expect(audit.rows).toContainEqual({
        actor: member.businessId,
        action: 'agent.run.cancelled',
      });
    } finally {
      subscription.close();
    }

    // 重复停止幂等：不再发信号，也不再写第二条审计。
    const repeat = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${runId}/stop`,
      member.cookie,
    );
    expect(repeat.statusCode, repeat.body).toBe(202);
    const audits = await app.pool.query('select id from audit_log where target = $1', [runId]);
    expect(audits.rows).toHaveLength(1);
  });

  it('limits member stop to own runs while owner and channel admin may stop any run', async () => {
    const { channel, agents } = await setup(2);
    const [agentOne, agentTwo] = agents;
    if (!agentOne || !agentTwo) throw new Error('expected two agents');
    expect((await mention(channel.id, member.cookie, [agentOne])).statusCode).toBe(201);
    expect((await mention(channel.id, other.cookie, [agentTwo])).statusCode).toBe(201);
    const ownRun = await runIdFor(channel.id, agentOne);
    const otherRun = await runIdFor(channel.id, agentTwo);

    const denied = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${otherRun}/stop`,
      member.cookie,
    );
    expect(denied.statusCode, denied.body).toBe(403);
    const viewerDenied = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${ownRun}/stop`,
      viewer.cookie,
    );
    expect(viewerDenied.statusCode, viewerDenied.body).toBe(403);
    const outsiderHidden = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${ownRun}/stop`,
      outsider.cookie,
    );
    expect(outsiderHidden.statusCode, outsiderHidden.body).toBe(404);
    const adminHidden = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${ownRun}/stop`,
      adminCookie,
    );
    expect(adminHidden.statusCode, adminHidden.body).toBe(404);

    const adminStop = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${otherRun}/stop`,
      channelAdmin.cookie,
    );
    expect(adminStop.statusCode, adminStop.body).toBe(202);
    const ownerStop = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${ownRun}/stop`,
      owner.cookie,
    );
    expect(ownerStop.statusCode, ownerStop.body).toBe(202);
    const runs = await channelRuns(channel.id);
    expect(runs.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('signals a running run instead of writing a terminal state', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);
    await setRunStatus(runId, 'running');

    const stopped = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${runId}/stop`,
      owner.cookie,
    );
    expect(stopped.statusCode, stopped.body).toBe(202);
    const [run] = await channelRuns(channel.id);
    expect(run?.status).toBe('running');
    expect(await redis.exists(runCancelKey(runId))).toBe(1);
    await redis.del(runCancelKey(runId));
  });

  it('does not publish channel run.finished when the run was claimed between stop and cancel', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);
    // worker 已领取 run：DB 是 running，但控制面读到的是领取前的 queued 快照。
    await setRunStatus(runId, 'running');
    const stop = vi.spyOn(repo.channelControl, 'stopRun').mockResolvedValue({
      kind: 'ok',
      run: {
        id: runId,
        agentId,
        status: 'queued',
        initiatedBy: member.businessId,
        startedAt: null,
      },
    });
    try {
      const stopped = await call(
        'POST',
        `/api/channels/${channel.id}/runs/${runId}/stop`,
        owner.cookie,
      );
      expect(stopped.statusCode, stopped.body).toBe(202);

      // 本次只发出了 running 信号，不能依据陈旧快照补发频道终态。
      const [run] = await channelRuns(channel.id);
      expect(run?.status).toBe('running');
      expect(await redis.exists(runCancelKey(runId))).toBe(1);
      const entries = (await redis.xrange(channelStreamKey(channel.id), '-', '+')) as Array<
        [string, string[]]
      >;
      const events = entries.map(([, fields]) => {
        const index = fields.indexOf('payload');
        return JSON.parse(fields[index + 1] ?? '{}') as ChannelEvent;
      });
      expect(events.some((event) => event.type === 'run.finished')).toBe(false);
    } finally {
      stop.mockRestore();
      await redis.del(runCancelKey(runId));
    }
  });

  it('disconnects a lane only for the owner or channel admin, cancelling its active runs', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    await runIdFor(channel.id, agentId);

    // 断开是频道级管理动作：member 即使有自己触发的活动 run 也不能断开，只能停自己的 run。
    for (const cookie of [member.cookie, viewer.cookie]) {
      const denied = await call(
        'POST',
        `/api/channels/${channel.id}/agents/${agentId}/disconnect`,
        cookie,
      );
      expect(denied.statusCode, denied.body).toBe(403);
    }
    const outsiderHidden = await call(
      'POST',
      `/api/channels/${channel.id}/agents/${agentId}/disconnect`,
      outsider.cookie,
    );
    expect(outsiderHidden.statusCode, outsiderHidden.body).toBe(404);

    const disconnected = await call(
      'POST',
      `/api/channels/${channel.id}/agents/${agentId}/disconnect`,
      channelAdmin.cookie,
    );
    expect(disconnected.statusCode, disconnected.body).toBe(204);
    const binding = await app.pool.query<{ status: string }>(
      'select status from channel_agent_bindings where channel_id = $1 and agent_id = $2',
      [channel.id, agentId],
    );
    expect(binding.rows[0]?.status).toBe('disconnected');
    const [run] = await channelRuns(channel.id);
    expect(run?.status).toBe('cancelled');

    const audit = await app.pool.query<{ actor: string; action: string }>(
      'select actor, action from audit_log where target = $1 order by created_at',
      [agentId],
    );
    expect(audit.rows).toContainEqual({
      actor: channelAdmin.businessId,
      action: 'channel.agent.disconnected',
    });

    const refused = await mention(channel.id, owner.cookie, [agentId]);
    expect(refused.statusCode, refused.body).toBe(400);
  });

  it('closes the channel only for the owner, cancels every active run, rejects messages and audits the actor', async () => {
    const { channel, agents } = await setup(2);
    expect((await mention(channel.id, member.cookie, agents)).statusCode).toBe(201);
    const runs = await channelRuns(channel.id);
    expect(runs).toHaveLength(2);

    for (const cookie of [member.cookie, channelAdmin.cookie, viewer.cookie]) {
      const denied = await call('POST', `/api/channels/${channel.id}/close`, cookie);
      expect(denied.statusCode, denied.body).toBe(403);
    }
    for (const cookie of [outsider.cookie, adminCookie]) {
      const hidden = await call('POST', `/api/channels/${channel.id}/close`, cookie);
      expect(hidden.statusCode, hidden.body).toBe(404);
    }

    const closed = await call('POST', `/api/channels/${channel.id}/close`, owner.cookie);
    expect(closed.statusCode, closed.body).toBe(200);
    const archivedAt = closed.json<{ archivedAt: string }>().archivedAt;
    expect(typeof archivedAt).toBe('string');
    const stored = await app.pool.query<{ archived_at: Date | null }>(
      'select archived_at from channels where id = $1',
      [channel.id],
    );
    expect(stored.rows[0]?.archived_at).not.toBeNull();
    const cancelled = await channelRuns(channel.id);
    expect(cancelled.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);

    const repeat = await call('POST', `/api/channels/${channel.id}/close`, owner.cookie);
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect(repeat.json<{ archivedAt: string }>().archivedAt).toBe(archivedAt);

    const refused = await call('POST', `/api/channels/${channel.id}/messages`, owner.cookie, {
      body: 'after close',
    });
    expect(refused.statusCode, refused.body).toBe(409);

    const audit = await app.pool.query<{ actor: string; action: string }>(
      'select actor, action from audit_log where target = $1',
      [channel.id],
    );
    expect(audit.rows).toContainEqual({ actor: owner.businessId, action: 'channel.closed' });
  });

  it('reports 503 when close cannot stop one of two runs, keeping the archive and allowing retry', async () => {
    const { channel, agents } = await setup(2);
    expect((await mention(channel.id, member.cookie, agents)).statusCode).toBe(201);
    const runs = await channelRuns(channel.id);
    const [first, second] = runs;
    if (!first || !second) throw new Error('expected two channel runs');
    await setRunStatus(first.id, 'running');
    await setRunStatus(second.id, 'running');
    cancelState.failFor.add(first.id);

    try {
      const closed = await call('POST', `/api/channels/${channel.id}/close`, owner.cookie);
      expect(closed.statusCode, closed.body).toBe(503);
      expect(closed.json()).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
        retryable: true,
      });

      // 关闭已提交，不回滚；只有第二个 run 收到了取消信号。
      const stored = await app.pool.query<{ archived_at: Date | null }>(
        'select archived_at from channels where id = $1',
        [channel.id],
      );
      expect(stored.rows[0]?.archived_at).not.toBeNull();
      expect(await redis.exists(runCancelKey(first.id))).toBe(0);
      expect(await redis.exists(runCancelKey(second.id))).toBe(1);
      const failedAudit = await app.pool.query<{ status: string }>(
        "select status from audit_log where target = $1 and action = 'channel.closed'",
        [channel.id],
      );
      expect(failedAudit.rows.map((row) => row.status)).toContain('error');

      // 调用者用同一个 close 重试，补停剩余 run。
      cancelState.failFor.clear();
      const retried = await call('POST', `/api/channels/${channel.id}/close`, owner.cookie);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(await redis.exists(runCancelKey(first.id))).toBe(1);
    } finally {
      cancelState.failFor.clear();
      await redis.del(runCancelKey(first.id), runCancelKey(second.id));
    }
  });

  it('reports 503 when disconnect cannot stop one of two runs, keeping the binding and allowing retry', async () => {
    const { channel, agents } = await setup(2);
    expect((await mention(channel.id, member.cookie, agents)).statusCode).toBe(201);
    const runs = await channelRuns(channel.id);
    const [first, second] = runs;
    if (!first || !second) throw new Error('expected two channel runs');
    // 正常准入会因 lane 忙碌拒绝第二条；把两条 run 收拢到同一 lane 以覆盖批量取消。
    await app.pool.query('update agent_runs set agent_id = $2 where id = $1', [
      second.id,
      first.agent_id,
    ]);
    const agentId = first.agent_id;
    await setRunStatus(first.id, 'running');
    await setRunStatus(second.id, 'running');
    cancelState.failFor.add(first.id);

    try {
      const disconnected = await call(
        'POST',
        `/api/channels/${channel.id}/agents/${agentId}/disconnect`,
        channelAdmin.cookie,
      );
      expect(disconnected.statusCode, disconnected.body).toBe(503);
      expect(disconnected.json()).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
        retryable: true,
      });

      const binding = await app.pool.query<{ status: string }>(
        'select status from channel_agent_bindings where channel_id = $1 and agent_id = $2',
        [channel.id, agentId],
      );
      expect(binding.rows[0]?.status).toBe('disconnected');
      expect(await redis.exists(runCancelKey(first.id))).toBe(0);
      expect(await redis.exists(runCancelKey(second.id))).toBe(1);

      cancelState.failFor.clear();
      const retried = await call(
        'POST',
        `/api/channels/${channel.id}/agents/${agentId}/disconnect`,
        owner.cookie,
      );
      expect(retried.statusCode, retried.body).toBe(204);
      expect(await redis.exists(runCancelKey(first.id))).toBe(1);
    } finally {
      cancelState.failFor.clear();
      await redis.del(runCancelKey(first.id), runCancelKey(second.id));
    }
  });

  const openRunEvents = async (
    channelId: string,
    runId: string,
    cookie: string,
  ): Promise<{
    events: ChatEvent[];
    done: Promise<void>;
    next: (predicate: (event: ChatEvent) => boolean) => Promise<ChatEvent>;
    close: () => Promise<void>;
  }> => {
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/api/channels/${channelId}/runs/${runId}/events`, {
      headers: { cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing SSE body');
    const events: ChatEvent[] = [];
    const waiters: Array<{
      predicate: (event: ChatEvent) => boolean;
      resolve: (event: ChatEvent) => void;
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
              const event = JSON.parse(frame.slice(6)) as ChatEvent;
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
      done: pump,
      next(predicate) {
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

  it('streams real run events, replays terminal state and hides the stream from non-members', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);

    for (const cookie of [outsider.cookie, adminCookie]) {
      const hidden = await call('GET', `/api/channels/${channel.id}/runs/${runId}/events`, cookie);
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect(hidden.headers['content-type']).not.toContain('text/event-stream');
    }
    const viewerStream = await openRunEvents(channel.id, runId, viewer.cookie);
    await viewerStream.close();

    const stream = await openRunEvents(channel.id, runId, member.cookie);
    try {
      await publishRun(runId, { type: 'text_delta', text: 'live token' });
      const live = await stream.next((event) => event.type === 'text_delta');
      expect(live).toMatchObject({ type: 'text_delta', text: 'live token' });

      await setRunStatus(runId, 'succeeded');
      await publishRun(runId, { type: 'run_finished', status: 'succeeded' });
      const finished = await stream.next((event) => event.type === 'run_finished');
      expect(finished).toMatchObject({ type: 'run_finished', status: 'succeeded' });
      await stream.close();
    } finally {
      await stream.close();
    }

    // 重连到已结束的 run：只订阅未来事件会漏终态，必须从 DB 回放。
    const replay = await openRunEvents(channel.id, runId, member.cookie);
    const replayFinished = await replay.next((event) => event.type === 'run_finished');
    expect(replayFinished).toMatchObject({ type: 'run_finished', status: 'succeeded' });
    expect(await waitFor(() => replay.events.length > 0)).toBe(true);
    await replay.close();
  });

  it('stops an open run stream when membership is revoked', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);

    const stream = await openRunEvents(channel.id, runId, member.cookie);
    try {
      const removed = await call(
        'DELETE',
        `/api/channels/${channel.id}/members/${member.businessId}`,
        owner.cookie,
      );
      expect(removed.statusCode, removed.body).toBe(204);
      const lost = await stream.next((event) => event.type === 'run_unavailable');
      expect(lost).toMatchObject({ type: 'run_unavailable' });
      expect((lost as { message: string }).message).toContain('无权');
      await stream.close();
    } finally {
      await stream.close();
    }
  });

  it('checks membership per replayed event and withholds the rest after revocation', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);
    for (const text of ['before-1', 'before-2', 'before-3']) {
      await publishRun(runId, { type: 'text_delta', text });
    }

    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateReached!: () => void;
    const gateHit = new Promise<void>((resolve) => {
      gateReached = resolve;
    });
    let checks = 0;
    const original = repo.channelControl.getChannelRunForMember;
    // 第 1 次是 hijack 前的预检；第 2 次是回放首个事件的逐事件核验，先卡在这里。
    const spy = vi
      .spyOn(repo.channelControl, 'getChannelRunForMember')
      .mockImplementation(async (...args) => {
        checks += 1;
        if (checks === 2) {
          gateReached();
          await gateReleased;
        }
        return original(...args);
      });

    let stream: Awaited<ReturnType<typeof openRunEvents>> | undefined;
    try {
      stream = await openRunEvents(channel.id, runId, member.cookie);
      await gateHit;
      const removed = await call(
        'DELETE',
        `/api/channels/${channel.id}/members/${member.businessId}`,
        owner.cookie,
      );
      expect(removed.statusCode, removed.body).toBe(204);
      releaseGate();

      const lost = await stream.next((event) => event.type === 'run_unavailable');
      expect(lost).toMatchObject({ type: 'run_unavailable' });
      // 撤权后的剩余回放 token 一条都不能送给已非成员的连接。
      expect(stream.events.filter((event) => event.type === 'text_delta')).toHaveLength(0);
    } finally {
      releaseGate();
      spy.mockRestore();
      await stream?.close();
    }
  });

  it('sends a fixed error and ends the stream when the per-event membership check fails', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);
    for (const text of ['lost-1', 'lost-2']) {
      await publishRun(runId, { type: 'text_delta', text });
    }
    await publishRun(runId, { type: 'run_finished', status: 'succeeded' });

    let checks = 0;
    const original = repo.channelControl.getChannelRunForMember;
    // 第 1 次是 hijack 前的预检；第 2 次（首条回放事件）抛错，之后恢复正常查询。
    const spy = vi
      .spyOn(repo.channelControl, 'getChannelRunForMember')
      .mockImplementation(async (...args) => {
        checks += 1;
        if (checks === 2) throw new Error('membership lookup unavailable');
        return original(...args);
      });

    let stream: Awaited<ReturnType<typeof openRunEvents>> | undefined;
    try {
      stream = await openRunEvents(channel.id, runId, member.cookie);
      await stream.done;
    } finally {
      spy.mockRestore();
      await stream?.close();
    }

    // 数据库失败时不能继续回放：只发一条固定 error，后续 token 与 run_finished 都被丢弃。
    expect(stream?.events).toEqual([{ type: 'error', message: '事件流中断，请刷新页面或重试' }]);
  });

  it('publishes channel run.finished to the channel stream when a queued run is cancelled', async () => {
    const { channel, agents } = await setup(1);
    const agentId = agents[0];
    if (!agentId) throw new Error('expected an agent');
    expect((await mention(channel.id, member.cookie, [agentId])).statusCode).toBe(201);
    const runId = await runIdFor(channel.id, agentId);
    const stopped = await call(
      'POST',
      `/api/channels/${channel.id}/runs/${runId}/stop`,
      owner.cookie,
    );
    expect(stopped.statusCode, stopped.body).toBe(202);
    const entries = (await redis.xrange(channelStreamKey(channel.id), '-', '+')) as Array<
      [string, string[]]
    >;
    const events = entries.map(([, fields]) => {
      const index = fields.indexOf('payload');
      return JSON.parse(fields[index + 1] ?? '{}') as ChannelEvent;
    });
    expect(events).toContainEqual({
      type: 'run.finished',
      channelId: channel.id,
      runId,
      agentId,
      status: 'cancelled',
    });
  });
});
