import { newId } from '@agentport/db';
import type { Agent, Channel, ChannelMessage } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  createServer,
  createTestAccount,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  setAgentMember,
  startApp,
  type TestAccount,
  unique,
} from './helpers.js';

interface RunRow {
  id: string;
  conversation_id: string;
  channel_id: string | null;
}

const ready = await infraReady;

/** M2 的私有运行入口（详情/提问/审批）不实现频道授权，频道 run 一律按不存在处理。 */
describe.skipIf(!ready)('channel run private entry points', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let owner: TestAccount;
  let member: TestAccount;
  const channelIds: string[] = [];
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const privateConversationIds: string[] = [];

  let agentId: string;
  let runId: string;
  let requestId: string;
  let serverId: string;
  const toolName = 'channel-private-entry-tool';
  const sensitiveError = 'channel-sensitive-error-body-should-stay-private';

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

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
    owner = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    member = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });

    const created = await call('POST', '/api/channels', owner.cookie, { name: unique('channel') });
    expect(created.statusCode, created.body).toBe(201);
    const channel = created.json<Channel>();
    channelIds.push(channel.id);

    const added = await call('POST', `/api/channels/${channel.id}/members`, owner.cookie, {
      businessId: member.businessId,
      role: 'member',
    });
    expect(added.statusCode, added.body).toBe(201);

    const agent = (
      await createAgent(app, adminCookie, { slug: unique('channel-agent'), track: agentSlugs })
    ).json<Agent>();
    agentId = agent.id;
    await setAgentMember(app, adminCookie, agent.id, owner.businessId, {
      canUse: true,
      canMaintain: false,
    });
    const bound = await call('POST', `/api/channels/${channel.id}/agents`, owner.cookie, {
      agentId: agent.id,
      autoWakeOnAll: false,
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // 普通成员触发频道 run：initiated_by 是触发者本人，正是旧私有入口放行的原因。
    const posted = await call('POST', `/api/channels/${channel.id}/messages`, member.cookie, {
      body: 'private entry probe',
      mentions: [agent.id],
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json<ChannelMessage>().body).toBe('private entry probe');

    const runs = await app.pool.query<RunRow>(
      `select id, conversation_id, channel_id
         from agent_runs
        where channel_id = $1
        order by created_at, id`,
      [channel.id],
    );
    expect(runs.rows).toHaveLength(1);
    const run = runs.rows[0];
    if (!run) throw new Error('expected a channel run');
    runId = run.id;
    expect(run.channel_id).toBe(channel.id);

    // 回答/批准都要求 run 仍在 running；worker 不在测试进程内消费，手动置为运行中。
    await app.pool.query("update agent_runs set status = 'running', error = $2 where id = $1", [
      runId,
      sensitiveError,
    ]);

    requestId = unique('question-request');
    await app.pool.query(
      `insert into run_questions (id, run_id, request_id, tool_use_id, questions, expires_at)
       values ($1, $2, $3, $4, $5::jsonb, now() + interval '10 minutes')`,
      [
        newId('question'),
        runId,
        requestId,
        unique('tool-use'),
        JSON.stringify([
          {
            question: '继续吗？',
            header: '继续',
            options: [
              { label: '继续', description: '继续执行' },
              { label: '停止', description: '停止执行' },
            ],
            multiSelect: false,
          },
        ]),
      ],
    );

    const server = await createServer(app, adminCookie, { track: serverNames });
    serverId = server.id;
    await app.pool.query(
      `insert into approval_requests (id, run_id, server_id, tool_name, expires_at)
       values ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [newId('approval'), runId, serverId, toolName],
    );

    const removed = await call(
      'DELETE',
      `/api/channels/${channel.id}/members/${encodeURIComponent(member.businessId)}`,
      owner.cookie,
    );
    expect(removed.statusCode, removed.body).toBe(204);
  });

  afterAll(async () => {
    if (runId !== undefined) {
      await getQueue()
        .remove(runId)
        .catch(() => undefined);
    }
    if (channelIds.length > 0) {
      await app.pool
        .query('delete from channels where id = any($1::text[])', [channelIds])
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs, serverNames });
    if (privateConversationIds.length > 0) {
      await app.pool.query('delete from conversations where id = any($1::text[])', [
        privateConversationIds,
      ]);
    }
    const businessIds = [owner.businessId, member.businessId];
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await app.close();
  });

  it('rejects run detail after the triggering member leaves', async () => {
    const res = await call('GET', `/api/runs/${runId}`, member.cookie);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');
  });

  it('rejects reading questions and answering them after the triggering member leaves', async () => {
    const listed = await call('GET', `/api/runs/${runId}/questions`, member.cookie);
    expect(listed.statusCode, listed.body).toBe(404);
    expect(listed.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');

    const answered = await call(
      'POST',
      `/api/runs/${runId}/questions/${encodeURIComponent(requestId)}/response`,
      member.cookie,
      { answers: { '0': '继续' } },
    );
    expect(answered.statusCode, answered.body).toBe(404);
    expect(answered.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');

    const stored = await app.pool.query<{ status: string; answers: unknown }>(
      'select status, answers from run_questions where run_id = $1',
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'pending', answers: null });
  });

  it('rejects reading approvals and approving them after the triggering member leaves', async () => {
    const listed = await call('GET', `/api/runs/${runId}/approvals`, member.cookie);
    expect(listed.statusCode, listed.body).toBe(404);
    expect(listed.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');

    const approved = await call('POST', `/api/runs/${runId}/approve`, member.cookie, {
      serverId,
      toolName,
    });
    expect(approved.statusCode, approved.body).toBe(404);
    expect(approved.json<{ code: string }>().code).toBe('RUN_NOT_FOUND');

    const stored = await app.pool.query<{ approved_at: Date | null }>(
      'select approved_at from approval_requests where run_id = $1',
      [runId],
    );
    expect(stored.rows[0]?.approved_at).toBeNull();
  });

  for (const scope of ['former member', 'platform'] as const) {
    it(`excludes channel runs from private lists and exports for ${scope}`, async () => {
      const cookie = scope === 'platform' ? adminCookie : member.cookie;
      const privateRun = await seedRun(app, agentId, {
        subject: { kind: 'user', businessId: member.businessId },
      });
      privateConversationIds.push(privateRun.conversationId);
      for (const endpoint of ['/api/runs', '/api/runs/export']) {
        const res = await call('GET', `${endpoint}?agentId=${agentId}`, cookie);
        expect(res.statusCode, res.body).toBe(200);
        const items = res.json<{ items: Array<{ id: string }> }>().items;
        expect.soft(items.map((item) => item.id)).toContain(privateRun.runId);
        expect.soft(items.map((item) => item.id)).not.toContain(runId);
        expect.soft(res.body).not.toContain(sensitiveError);
        const filtered = await call(
          'GET',
          `${endpoint}?agentId=${agentId}&trigger=channel`,
          cookie,
        );
        expect(filtered.statusCode, filtered.body).toBe(200);
        expect.soft(filtered.json<{ items: unknown[] }>().items).toEqual([]);
      }
    });
  }

  it('keeps private run detail readable for its creator', async () => {
    const privateRun = await seedRun(app, agentId, {
      subject: { kind: 'user', businessId: member.businessId },
    });
    privateConversationIds.push(privateRun.conversationId);

    const res = await call('GET', `/api/runs/${privateRun.runId}`, member.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ run: { id: string } }>().run.id).toBe(privateRun.runId);
  });
});
