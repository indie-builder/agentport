import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  unique,
} from './helpers.js';

// 队列有活跃 worker 时会消费测试创建的 run，导致状态断言失败。
const ready = (await infraReady) && (await queueIdle);

describe.skipIf(!ready)('chat', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const createdServers: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, runIds, serverNames: createdServers });
    await app.close();
  });

  const auth = () => ({ cookie });

  const createAgent = async (): Promise<Agent> => {
    const slug = unique('chat-agent');
    createdAgents.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Chat ${slug}`, systemPrompt: 'be brief' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Agent>();
  };

  it('POST /api/chat creates a run and returns 202', async () => {
    const agent = await createAgent();
    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'hello there' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ runId: string; conversationId: string }>();
    expect(body.runId.startsWith('run_')).toBe(true);
    expect(body.conversationId.startsWith('conv_')).toBe(true);
    runIds.push(body.runId);

    const conversation = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${body.conversationId}`,
      headers: auth(),
    });
    expect(conversation.statusCode).toBe(200);
    const detail = conversation.json<{ messages: Array<{ role: string }> }>();
    expect(detail.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('POST /api/chat returns 404 for an unknown agent', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: 'agt_missing', message: 'hi' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('GET /api/chat/:runId/events returns 404 for an unknown run', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/chat/run_missing/events',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('passes prior messages as history on the next run', async () => {
    const agent = await createAgent();
    const first = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'remember this' },
    });
    const firstBody = first.json<{ runId: string; conversationId: string }>();
    runIds.push(firstBody.runId);
    await app.pool.query(
      "insert into messages (id, conversation_id, role, content) values ('msg_history_test', $1, 'assistant', $2)",
      [firstBody.conversationId, JSON.stringify({ type: 'text', text: 'noted' })],
    );

    const second = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: firstBody.conversationId,
        message: 'and now?',
      },
    });
    const secondBody = second.json<{ runId: string }>();
    runIds.push(secondBody.runId);

    const { getQueue } = await import('../src/queue/producer.js');
    const job = await getQueue().getJob(secondBody.runId);
    const history = (job?.data as { history?: string } | undefined)?.history ?? '';
    expect(history).toContain('用户：remember this');
    expect(history).toContain('助手：noted');
    expect(history).not.toContain('and now?');
  });

  it('branches a conversation up to the given message', async () => {
    const agent = await createAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'first' },
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    await app.pool.query(
      "insert into messages (id, conversation_id, role, content) values ('msg_branch_test', $1, 'assistant', $2)",
      [conversationId, JSON.stringify({ type: 'text', text: 'answer' })],
    );

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: auth(),
    });
    const messages = detail.json<{ messages: Array<{ id: string; role: string }> }>().messages;
    const userMessage = messages.find((message) => message.role === 'user');
    expect(userMessage).toBeDefined();

    const res = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/branch`,
      headers: auth(),
      payload: { fromMessageId: userMessage?.id },
    });
    expect(res.statusCode).toBe(201);
    const branch = res.json<{
      id: string;
      parentId: string | null;
      branchOfMessageId: string | null;
    }>();
    expect(branch.parentId).toBe(conversationId);
    expect(branch.branchOfMessageId).toBe(userMessage?.id);

    const branchDetail = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${branch.id}`,
      headers: auth(),
    });
    const copied = branchDetail.json<{ messages: Array<{ role: string }> }>().messages;
    expect(copied.map((message) => message.role)).toEqual(['user']);
  });

  it('inherits approvals from the previous run in the same conversation', async () => {
    const agent = await createAgent();
    const first = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'call the tool' },
    });
    const firstBody = first.json<{ runId: string; conversationId: string }>();
    runIds.push(firstBody.runId);

    const serverName = unique('inherit-srv');
    createdServers.push(serverName);
    const server = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: serverName, kind: 'generated', baseUrl: 'https://example.com' },
    });
    const serverId = server.json<{ id: string }>().id;
    await app.pool.query(
      'insert into approval_requests (id, run_id, server_id, tool_name, approved_at) values ($1, $2, $3, $4, now())',
      [unique('apr'), firstBody.runId, serverId, 'approved-tool'],
    );

    const second = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: {
        agentId: agent.id,
        conversationId: firstBody.conversationId,
        message: 'try again',
      },
    });
    expect(second.statusCode).toBe(202);
    const secondBody = second.json<{ runId: string }>();
    runIds.push(secondBody.runId);

    const approvals = await inject(app, {
      method: 'GET',
      url: `/api/runs/${secondBody.runId}/approvals`,
      headers: auth(),
    });
    expect(approvals.json()).toMatchObject({
      items: [{ toolName: 'approved-tool', approvedAt: expect.any(String) }],
    });

    const audit = await app.pool.query<{ action: string }>(
      "select action from audit_log where action = 'agent.run.approvals_inherited' and target = $1",
      [secondBody.runId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('POST /api/conversations/:id/branch rejects an unknown branch point', async () => {
    const agent = await createAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'first' },
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);

    const res = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${conversationId}/branch`,
      headers: auth(),
      payload: { fromMessageId: 'msg_missing' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cancel is idempotent for an already terminal run', async () => {
    const agent = await createAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'will be cancelled' },
    });
    const { runId } = created.json<{ runId: string }>();
    runIds.push(runId);
    await app.pool.query(
      "update agent_runs set status = 'cancelled', ended_at = now() where id = $1",
      [runId],
    );

    for (let i = 0; i < 2; i += 1) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/chat/${runId}/cancel`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
    }

    const row = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    expect(row.rows[0]?.status).toBe('cancelled');
  });
});
