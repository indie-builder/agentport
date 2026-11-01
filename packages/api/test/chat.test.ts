import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '@agentport/shared';
import { chatEventSchema, RUN_CANCEL_PAYLOAD, runCancelKey } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMessageRows } from '../../worker/src/messages.js';
import { getQueue } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  testConfig,
  unique,
} from './helpers.js';

// 队列有活跃 worker 时会消费测试创建的 run，导致状态断言失败。
const ready = (await infraReady) && (await queueIdle);

describe.skipIf(!ready)('chat', () => {
  let app: FastifyInstance;
  let cookie: string;
  let testRedis: Redis;
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const createdServers: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    testRedis = new Redis(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    // waiting 的 job 不会自行过期；只清理本文件创建的 run。
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    await testRedis.quit().catch(() => undefined);
    await cleanup(app, { agentSlugs: createdAgents, runIds, serverNames: createdServers });
    await app.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, {
        slug: unique('chat-agent'),
        track: createdAgents,
      })
    ).json<Agent>();

  it('POST /api/chat creates a run and returns 202', async () => {
    const agent = await newAgent();
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
    const detail = conversation.json<{
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    }>();
    expect(detail.messages.find((message) => message.role === 'user')?.content).toEqual({
      type: 'text',
      text: 'hello there',
    });
  });

  it('persists parentToolUseId on messages produced inside a sub-agent', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'delegate this' },
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);

    // worker 的事件落库逻辑；这里直接写同一张表，验证 content 结构可被读回。
    const events = chatEventSchema.array().parse([
      { type: 'tool_start', toolUseId: 'toolu_parent', name: 'Agent' },
      {
        type: 'tool_start',
        toolUseId: 'toolu_child',
        name: 'mcp__x__get-user',
        parentToolUseId: 'toolu_parent',
      },
      {
        type: 'tool_input',
        toolUseId: 'toolu_child',
        json: '{"id":1}',
        parentToolUseId: 'toolu_parent',
      },
      {
        type: 'tool_result',
        toolUseId: 'toolu_child',
        content: '{"id":1}',
        parentToolUseId: 'toolu_parent',
      },
      { type: 'tool_result', toolUseId: 'toolu_parent', content: 'done' },
    ]);
    for (const [index, row] of buildMessageRows(events).entries()) {
      await app.pool.query(
        'insert into messages (id, conversation_id, role, content, run_id) values ($1, $2, $3, $4, $5)',
        [`msg_parent_test_${index}`, conversationId, row.role, JSON.stringify(row.content), runId],
      );
    }

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: auth(),
    });
    const messages = detail.json<{ messages: Array<{ content: Record<string, unknown> }> }>()
      .messages;
    const childUse = messages.find((message) => message.content.id === 'toolu_child');
    const parentUse = messages.find((message) => message.content.id === 'toolu_parent');
    expect(childUse?.content.parentToolUseId).toBe('toolu_parent');
    expect(parentUse?.content).not.toHaveProperty('parentToolUseId');
  });

  it('POST /api/chat returns 404 for an unknown agent', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: 'agt_missing', message: 'hi' },
    });
    expectProblem(res, 'AGENT_NOT_FOUND');
  });

  it('GET /api/chat/:runId/events returns 404 for an unknown run', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/chat/run_missing/events',
      headers: auth(),
    });
    expectProblem(res, 'RUN_NOT_FOUND');
  });

  it('does not put conversation history in the queue job', async () => {
    const agent = await newAgent();
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
    await app.pool.query(
      "update agent_runs set status = 'succeeded', ended_at = now() where id = $1",
      [firstBody.runId],
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
    expect(second.statusCode, second.body).toBe(202);
    const secondBody = second.json<{ runId: string }>();
    runIds.push(secondBody.runId);

    // 上下文恢复靠 DB 里的 SDK session；队列只带标识与本次输入。
    const job = await getQueue().getJob(secondBody.runId);
    expect(job?.data).toEqual({
      runId: secondBody.runId,
      agentId: agent.id,
      conversationId: firstBody.conversationId,
      prompt: 'and now?',
    });
  });

  it('branches a conversation up to the given message', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'first' },
    });
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    // 分支要求线上消息都有 SDK uuid：这里模拟已完成的一轮 assistant 输出。
    await app.pool.query(
      "insert into messages (id, conversation_id, role, content, sdk_message_uuid) values ('msg_branch_test', $1, 'assistant', $2, $3)",
      [
        conversationId,
        JSON.stringify({ type: 'text', text: 'answer' }),
        '7a1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      ],
    );
    await app.pool.query('update conversations set sdk_session_id = $2 where id = $1', [
      conversationId,
      '11111111-2222-4333-8444-555555555555',
    ]);
    // 分支会复制来源 transcript 目录；必须存在，否则首轮无从 fork。
    const sessionsDir = join(
      app.config.WORKSPACES_DIR,
      agent.slug,
      'sdk-sessions',
      conversationId,
      'projects',
      'workspace',
    );
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, '11111111-2222-4333-8444-555555555555.jsonl'), '');

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
    const branch = res.json<Record<string, unknown>>();
    expect(Object.keys(branch).sort()).toEqual(
      ['agentId', 'branchOfMessageId', 'createdAt', 'id', 'parentId', 'title'].sort(),
    );
    expect(branch.createdAt).toEqual(expect.any(String));
    expect(branch).not.toHaveProperty('sdkSessionId');
    expect(branch).not.toHaveProperty('forkFromSdkMessageUuid');
    expect(branch).not.toHaveProperty('createdBy');
    expect(branch).not.toHaveProperty('serviceId');
    expect(branch).not.toHaveProperty('lastMessageAt');
    expect(branch.parentId).toBe(conversationId);
    expect(branch.branchOfMessageId).toBe(userMessage?.id);
    expect(branch.id).not.toBe(conversationId);

    const branchDetail = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${branch.id as string}`,
      headers: auth(),
    });
    const copied = branchDetail.json<{ messages: Array<{ role: string }> }>().messages;
    expect(copied.map((message) => message.role)).toEqual(['user']);
  });

  it('inherits approvals from the previous run in the same conversation', async () => {
    const agent = await newAgent();
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
    await app.pool.query(
      "update agent_runs set status = 'failed', ended_at = now() where id = $1",
      [firstBody.runId],
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
    const agent = await newAgent();
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
    const agent = await newAgent();
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

  const cancelAuditCount = async (runId: string): Promise<number> => {
    const res = await app.pool.query<{ count: string }>(
      "select count(*) from audit_log where action = 'agent.run.cancelled' and target = $1",
      [runId],
    );
    return Number(res.rows[0]?.count);
  };

  const runStatus = async (runId: string): Promise<string | undefined> => {
    const row = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    return row.rows[0]?.status;
  };

  it('cancel of a queued run removes the waiting job so it never reaches a worker', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'never run' },
    });
    const { runId } = created.json<{ runId: string }>();
    runIds.push(runId);
    expect(await getQueue().getJob(runId)).toBeDefined();

    const res = await inject(app, {
      method: 'POST',
      url: `/api/chat/${runId}/cancel`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runStatus(runId)).toBe('cancelled');
    expect(await getQueue().getJob(runId)).toBeUndefined();
    expect(await cancelAuditCount(runId)).toBe(1);
  });

  it('second cancel of a queued run is idempotent and leaves no job behind', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'cancel twice' },
    });
    const { runId } = created.json<{ runId: string }>();
    runIds.push(runId);

    for (let i = 0; i < 2; i += 1) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/chat/${runId}/cancel`,
        headers: auth(),
      });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ ok: true });
    }

    expect(await runStatus(runId)).toBe('cancelled');
    expect(await getQueue().getJob(runId)).toBeUndefined();
    expect(await cancelAuditCount(runId)).toBe(1);
  });

  it('cancel of a running run keeps the queued job untouched and leaves the terminal state to the worker', async () => {
    const agent = await newAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'already running' },
    });
    const { runId } = created.json<{ runId: string }>();
    runIds.push(runId);
    // 直接把 DB 状态改成 running：模拟 worker 已领取，job 不再是 waiting。
    await app.pool.query("update agent_runs set status = 'running' where id = $1", [runId]);

    const res = await inject(app, {
      method: 'POST',
      url: `/api/chat/${runId}/cancel`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(202);
    // 终态由 worker 写完消息与产出后落库；API 只发信号，不抢 worker 的 updateRun。
    expect(await runStatus(runId)).toBe('running');
    expect(await getQueue().getJob(runId)).toBeDefined();
    expect(await cancelAuditCount(runId)).toBe(1);
    expect(await testRedis.get(runCancelKey(runId))).toBe(RUN_CANCEL_PAYLOAD);
  });
});
