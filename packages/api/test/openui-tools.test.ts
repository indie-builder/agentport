import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId, repo } from '@agentport/db';
import type { Agent, Server } from '@agentport/shared';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer as createApiServer,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  roleIds,
  setAgentMember,
  startApp,
  unique,
  ADMIN_BUSINESS_ID, } from './helpers.js';
import { createRole } from './access-helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('openui tools', () => {
  let app: FastifyInstance;
  let cookie: string;
  let upstreamUrl: string;
  /** 真实 MCP 上游：覆盖 structuredContent、多 text 块与 isError 三种返回形状。 */
  let mcpUrl: string;
  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({ name: 'openui-fixture', version: '1.0.0' });
    server.registerTool('structured', { description: 'has structuredContent' }, () => ({
      content: [{ type: 'text', text: '{"from":"text"}' }],
      structuredContent: { from: 'structured' },
    }));
    server.registerTool('chunked', { description: 'text split across blocks' }, () => ({
      content: [
        { type: 'text', text: '{"rows":' },
        { type: 'text', text: '[1]}' },
      ],
    }));
    server.registerTool('plain', { description: 'plain text' }, () => ({
      content: [{ type: 'text', text: 'just text' }],
    }));
    server.registerTool('fails', { description: 'upstream error' }, () => ({
      isError: true,
      content: [
        { type: 'text', text: 'boom' },
        { type: 'text', text: 'detail' },
      ],
    }));
    return server;
  });
  const mcpHttp = createServer((request, response) => {
    void toNodeHandler(mcpHandler)(request, response);
  });
  const upstream = createServer((request, response) => {
    const url = request.url?.split('?')[0];
    if (url === '/users/1') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 1, name: 'Fixture user' }));
      return;
    }
    if (url === '/invoices') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ id: 'inv_1', total: 42 }]));
      return;
    }
    response.writeHead(404).end();
  });
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    app = await startApp({ APPROVAL_WAIT_MS: '0' });
    cookie = await loginCookie(app);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => mcpHttp.listen(0, '127.0.0.1', resolve));
    mcpUrl = `http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, serverNames });
    if (conversationIds.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [
        conversationIds,
      ]);
    }
    await app.close();
    await mcpHandler.close();
    await new Promise<void>((resolve, reject) =>
      mcpHttp.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const auth = () => ({ cookie });

  /** 主助手的真实生成式 UI 消息：s0 是一个完整 root，来源校验必须以它为准。 */
  const appendUiMessage = async (
    conversationId: string,
    options: {
      role?: 'assistant' | 'user';
      uiFormat?: 'markdown' | 'openui';
      text?: string;
      parentToolUseId?: string;
    } = {},
  ): Promise<string> => {
    const message = await repo.chat.appendMessage(app.db, {
      id: newId('message'),
      conversationId,
      role: options.role ?? 'assistant',
      content: {
        type: 'text',
        text: options.text ?? '界面\n\n```openui-lang\nroot = Card([])\n```',
        ...(options.parentToolUseId === undefined
          ? {}
          : { parentToolUseId: options.parentToolUseId }),
      },
    });
    await app.pool.query('update messages set ui_format = $2 where id = $1', [
      message.id,
      options.uiFormat ?? 'openui',
    ]);
    return message.id;
  };

  /** generated server + 两个工具：一个普通、一个需要批准。 */
  const seedAgent = async () => {
    const server = await createApiServer(app, cookie, {
      name: unique('oui-tool-srv'),
      baseUrl: upstreamUrl,
      track: serverNames,
    });
    for (const tool of [
      {
        name: 'get-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
      {
        name: 'list-invoices',
        method: 'GET',
        pathTemplate: '/invoices',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: true,
      },
    ]) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: auth(),
        payload: { ...tool, description: `${tool.name} fixture`, paramsIn: 'query' },
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    const agent = (
      await createAgent(app, cookie, {
        slug: unique('oui-tool-agent'),
        serverIds: [server.id],
        track: agentSlugs,
      })
    ).json<Agent>();
    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'tool bridge',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    conversationIds.push(conversationId);
    const messageId = await appendUiMessage(conversationId);
    return { server, agent, conversationId, messageId };
  };

  const callTool = (conversationId: string, toolName: string, body: Record<string, unknown> = {}) =>
    inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/tools/${toolName}`,
      headers: auth(),
      payload: { args: {}, blockKey: 's0', ...body },
    });

  it('requires auth', async () => {
    const { conversationId, messageId } = await seedAgent();
    const res = await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/tools/${encodeURIComponent('mcp__x__y')}`,
      payload: { args: {}, messageId, blockKey: 's0' },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('returns CONVERSATION_NOT_FOUND for an unknown conversation', async () => {
    const { messageId } = await seedAgent();
    expectProblem(
      await callTool('conv_missing', 'mcp__x__y', { messageId }),
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('rejects a message from another conversation', async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    expectProblem(
      await callTool(first.conversationId, 'mcp__x__y', { messageId: second.messageId }),
      'NOT_FOUND',
    );
  });

  // Mutation 会执行写操作：来源必须真的是主助手消息里存在的 UI 段，否则用户消息或
  // 子智能体消息上的伪造 blockKey 也能触发。
  it.each([
    ['a user message', { role: 'user' }, 'INVALID_INPUT'],
    ['a markdown assistant message', { uiFormat: 'markdown' }, 'INVALID_INPUT'],
    ['a sub-agent assistant message', { parentToolUseId: 'toolu_parent' }, 'FORBIDDEN'],
    ['an assistant message without any UI segment', { text: '纯文本回答' }, 'INVALID_INPUT'],
  ] as const)('rejects %s as an action source', async (_label, options, code) => {
    const { conversationId, server } = await seedAgent();
    const messageId = await appendUiMessage(conversationId, options);
    expectProblem(
      await callTool(conversationId, `mcp__${server.name}__get-user`, {
        messageId,
        args: { id: 1 },
      }),
      code,
    );
  });

  it('rejects a blockKey that does not exist in the message', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const res = await callTool(conversationId, `mcp__${server.name}__get-user`, {
      messageId,
      blockKey: 's1',
      args: { id: 1 },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect(res.json<{ message: string }>().message).toContain('s1');
  });

  it('rejects a tool that is not in the agent catalog', async () => {
    const { conversationId, messageId } = await seedAgent();
    expectProblem(await callTool(conversationId, 'mcp__missing__nope', { messageId }), 'FORBIDDEN');
  });

  it('rejects a knowledge server named by a malicious action instead of fetching it as http', async () => {
    const { agent, conversationId, messageId } = await seedAgent();
    const name = unique('oui-kb');
    const serverId = newId('server');
    // knowledge 连接由平台内置，用户 CRUD 不暴露；直接落库模拟已存在的绑定。
    await app.pool.query(
      `insert into servers (id, name, kind, config)
       values ($1, $2, 'knowledge', '{"knowledgeBaseId":"kb-test"}'::jsonb)`,
      [serverId, name],
    );
    serverNames.push(name);
    await app.pool.query('insert into agent_servers (agent_id, server_id) values ($1, $2)', [
      agent.id,
      serverId,
    ]);

    // 即便动作伪造 mcp__<knowledge>__<tool>，也必须在目录层被拒，不能落进 HTTP fetch 分支。
    expectProblem(
      await callTool(conversationId, `mcp__${name}__search`, { messageId }),
      'FORBIDDEN',
    );
  });

  it('rejects a disabled tool', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    await app.pool.query('update api_tools set enabled = false where server_id = $1', [server.id]);
    expectProblem(
      await callTool(conversationId, `mcp__${server.name}__get-user`, { messageId }),
      'FORBIDDEN',
    );
  });

  it('rejects args that do not match the tool inputSchema', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    expectProblem(
      await callTool(conversationId, `mcp__${server.name}__get-user`, {
        messageId,
        args: { id: 'not-a-number' },
      }),
      'INVALID_INPUT',
    );
  });

  it('returns INVALID_INPUT instead of 500 when the tool inputSchema is invalid', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    // 目录里的 JSON Schema 是不可信数据：写坏的 schema 是输入问题，不是服务端故障。
    await app.pool.query(
      `update api_tools set input_schema = '{"type":"object","properties":{"id":{"type":"nonsense"}}}'::jsonb
       where server_id = $1 and name = 'get-user'`,
      [server.id],
    );
    const res = await callTool(conversationId, `mcp__${server.name}__get-user`, {
      messageId,
      args: { id: 1 },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect(res.json<{ message: string }>().message).toContain('JSON Schema');
  });

  it('calls an enabled generated tool and returns its data', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const res = await callTool(conversationId, `mcp__${server.name}__get-user`, {
      messageId,
      args: { id: 1 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', data: { id: 1, name: 'Fixture user' } });

    const audit = await app.pool.query<{ status: string }>(
      "select status from audit_log where action = 'openui.tool.called' and target = $1 order by created_at desc limit 1",
      [conversationId],
    );
    expect(audit.rows[0]?.status).toBe('ok');
  });

  it('returns 202 approval_required, then runs after the approval route is used', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const toolName = `mcp__${server.name}__list-invoices`;

    const first = await callTool(conversationId, toolName, { messageId });
    expect(first.statusCode, first.body).toBe(202);
    const pending = first.json<{ status: string; approvalId: string }>();
    expect(pending.status).toBe('approval_required');
    expect(pending.approvalId.startsWith('apr_')).toBe(true);

    // 重复调用复用同一条待批记录，不堆积。
    const second = await callTool(conversationId, toolName, { messageId });
    expect(second.json<{ approvalId: string }>().approvalId).toBe(pending.approvalId);

    const approve = await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/approvals/${pending.approvalId}/approve`,
      headers: auth(),
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const approved = approve.json<{ approvedAt: string | null; expiresAt: string | null }>();
    expect(approved.approvedAt).toEqual(expect.any(String));
    // 批准有时效：8 小时后过期，前端据此展示剩余时间。
    expect(approved.expiresAt).toEqual(expect.any(String));
    expect(Date.parse(approved.expiresAt ?? '') - Date.parse(approved.approvedAt ?? '')).toBe(
      8 * 60 * 60 * 1000,
    );

    const retry = await callTool(conversationId, toolName, { messageId });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual({ status: 'ok', data: [{ id: 'inv_1', total: 42 }] });
  });

  it('does not extend an already valid approval when the request is repeated', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const toolName = `mcp__${server.name}__list-invoices`;
    const pending = (await callTool(conversationId, toolName, { messageId })).json<{
      approvalId: string;
    }>();
    const approve = () =>
      inject(app, {
        method: 'POST',
        url: `/api/chat/${conversationId}/openui/approvals/${pending.approvalId}/approve`,
        headers: auth(),
      });

    const first = await approve();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<{ expiresAt: string }>().expiresAt).toEqual(expect.any(String));
    // 把有效期压到 1 小时后：重放不能再把它推回 8 小时。
    await app.db.execute(sql`
      update approval_requests
      set approved_at = now() - interval '7 hours', expires_at = now() + interval '1 hour'
      where id = ${pending.approvalId}
    `);
    const before = await app.pool.query<{ approved_at: Date; expires_at: Date }>(
      'select approved_at, expires_at from approval_requests where id = $1',
      [pending.approvalId],
    );

    const again = await approve();
    expect(again.statusCode, again.body).toBe(200);
    const after = await app.pool.query<{ approved_at: Date; expires_at: Date }>(
      'select approved_at, expires_at from approval_requests where id = $1',
      [pending.approvalId],
    );
    expect(after.rows[0]?.approved_at).toEqual(before.rows[0]?.approved_at);
    expect(after.rows[0]?.expires_at).toEqual(before.rows[0]?.expires_at);
    expect(again.json<{ expiresAt: string }>().expiresAt).toBe(
      before.rows[0]?.expires_at.toISOString(),
    );
    expect((await callTool(conversationId, toolName, { messageId })).statusCode).toBe(200);
  });

  it('refuses to approve an expired row until a new request resets it', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const toolName = `mcp__${server.name}__list-invoices`;

    const pending = (await callTool(conversationId, toolName, { messageId })).json<{
      approvalId: string;
    }>();
    await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/approvals/${pending.approvalId}/approve`,
      headers: auth(),
    });
    expect((await callTool(conversationId, toolName, { messageId })).statusCode).toBe(200);

    // 把批准时间挪到有效期之外：下一次调用必须重新走审批，不能永久放行。
    await app.db.execute(sql`
      update approval_requests
      set expires_at = now() - interval '1 minute'
      where id = ${pending.approvalId}
    `);

    // 过期行不能直接批准，也不能被这次请求顺手复活。
    const stale = await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/approvals/${pending.approvalId}/approve`,
      headers: auth(),
    });
    expectProblem(stale, 'CONFLICT');
    const stillExpired = await app.pool.query<{ expires_at: Date }>(
      'select expires_at from approval_requests where id = $1',
      [pending.approvalId],
    );
    expect(stillExpired.rows[0]?.expires_at.getTime()).toBeLessThan(Date.now());

    const again = await callTool(conversationId, toolName, { messageId });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json<{ status: string }>().status).toBe('approval_required');

    // 重新发起工具调用会把该行重置为待批，此后才允许批准。
    const reRequested = (await callTool(conversationId, toolName, { messageId })).json<{
      approvalId: string;
      status: string;
    }>();
    expect(reRequested.status).toBe('approval_required');
    expect(reRequested.approvalId).toBe(pending.approvalId);

    const reapproved = await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/approvals/${reRequested.approvalId}/approve`,
      headers: auth(),
    });
    expect(reapproved.statusCode, reapproved.body).toBe(200);
    expect(Date.parse(reapproved.json<{ expiresAt: string }>().expiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect((await callTool(conversationId, toolName, { messageId })).statusCode).toBe(200);
  });

  it('does not treat a null expiry as a permanent approval', async () => {
    const { conversationId, messageId, server } = await seedAgent();
    const toolName = `mcp__${server.name}__list-invoices`;
    const pending = (await callTool(conversationId, toolName, { messageId })).json<{
      approvalId: string;
    }>();
    // 旧数据/手工写入的「已批准但没有有效期」：必须视同未批准。
    await app.db.execute(sql`
      update approval_requests
      set approved_at = now(), expires_at = null
      where id = ${pending.approvalId}
    `);

    const again = await callTool(conversationId, toolName, { messageId });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json<{ status: string }>().status).toBe('approval_required');

    // 重新走一次审批后，旧行会被清成待批，不会继续复用 null 有效期。
    const row = await app.pool.query<{ approved_at: Date | null; expires_at: Date | null }>(
      'select approved_at, expires_at from approval_requests where id = $1',
      [pending.approvalId],
    );
    expect(row.rows[0]?.approved_at).toBeNull();
    expect(row.rows[0]?.expires_at).toBeNull();
  });

  it('rejects an unknown or cross-conversation approval id', async () => {
    const first = await seedAgent();
    const otherConversation = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: otherConversation,
      agentId: first.agent.id,
      title: 'other',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    conversationIds.push(otherConversation);

    const pending = (
      await callTool(first.conversationId, `mcp__${first.server.name}__list-invoices`, {
        messageId: first.messageId,
      })
    ).json<{ approvalId: string }>();

    for (const [conversationId, approvalId] of [
      [otherConversation, pending.approvalId],
      [first.conversationId, 'apr_missing'],
    ] as const) {
      expectProblem(
        await inject(app, {
          method: 'POST',
          url: `/api/chat/${conversationId}/openui/approvals/${approvalId}/approve`,
          headers: auth(),
        }),
        'APPROVAL_NOT_FOUND',
      );
    }
  });

  it('keeps approvals scoped to one conversation', async () => {
    // 同一个 server/工具、两个会话：批准不能跨会话复用。
    const shared = await seedAgent();
    const otherConversation = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: otherConversation,
      agentId: shared.agent.id,
      title: 'tool bridge other',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    conversationIds.push(otherConversation);
    const otherMessageId = await appendUiMessage(otherConversation);

    const toolName = `mcp__${shared.server.name}__list-invoices`;
    const pending = (
      await callTool(shared.conversationId, toolName, { messageId: shared.messageId })
    ).json<{ approvalId: string }>();
    await repo.openui.approveOpenUiApproval(app.db, shared.conversationId, pending.approvalId);

    const secondCall = await callTool(otherConversation, toolName, {
      messageId: otherMessageId,
    });
    expect(secondCall.statusCode, secondCall.body).toBe(202);
  });

  it('refuses to approve an approval from another conversation', async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const pending = (
      await callTool(first.conversationId, `mcp__${first.server.name}__list-invoices`, {
        messageId: first.messageId,
      })
    ).json<{ approvalId: string }>();

    const cross = await repo.openui.approveOpenUiApproval(
      app.db,
      second.conversationId,
      pending.approvalId,
    );
    expect(cross).toBeNull();
  });

  it('rechecks agents.use on every tool call after membership revocation', async () => {
    const { agent, server } = await seedAgent();
    const viewer = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    await setAgentMember(app, cookie, agent.id, viewer.businessId, {
      canUse: true,
      canMaintain: false,
    });

    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'revoked history',
      subject: { kind: 'user', businessId: viewer.businessId },
    });
    conversationIds.push(conversationId);
    const messageId = await appendUiMessage(conversationId);
    const call = () =>
      inject(app, {
        method: 'POST',
        url: `/api/chat/${conversationId}/openui/tools/mcp__${server.name}__get-user`,
        headers: { cookie: viewer.cookie },
        payload: { args: { id: 1 }, messageId, blockKey: 's0' },
      });

    const allowed = await call();
    expect(allowed.statusCode, allowed.body).toBe(200);

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/members/${encodeURIComponent(viewer.businessId)}`,
      headers: auth(),
    });
    expect(removed.statusCode, removed.body).toBe(200);

    // 目录仍含该工具，但 agents.use 已失效：历史消息不能成为绕过授权的入口。
    expectProblem(await call(), 'NOT_FOUND');
  });

  it('requires runs.approve and the owner scope for the approval entry', async () => {
    const { agent, server } = await seedAgent();
    const approverRole = await createRole(app, cookie, unique('openui-approver'), [
      { permissionId: 'conversations.update', scope: 'own_data' },
      { permissionId: 'agents.use', scope: 'authorized_agents' },
    ]);
    const approver = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    const assign = await inject(app, {
      method: 'PUT',
      url: `/api/accounts/${encodeURIComponent(approver.businessId)}/roles`,
      headers: auth(),
      payload: { roleIds: [approverRole.id] },
    });
    expect(assign.statusCode, assign.body).toBe(200);
    await setAgentMember(app, cookie, agent.id, approver.businessId, {
      canUse: true,
      canMaintain: false,
    });

    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'approval permission',
      subject: { kind: 'user', businessId: approver.businessId },
    });
    conversationIds.push(conversationId);
    const messageId = await appendUiMessage(conversationId);
    const pending = await inject(app, {
      method: 'POST',
      url: `/api/chat/${conversationId}/openui/tools/mcp__${server.name}__list-invoices`,
      headers: { cookie: approver.cookie },
      payload: { args: {}, messageId, blockKey: 's0' },
    });
    expect(pending.statusCode, pending.body).toBe(202);
    const approvalId = pending.json<{ approvalId: string }>().approvalId;
    const approveAs = (approvalCookie: string) =>
      inject(app, {
        method: 'POST',
        url: `/api/chat/${conversationId}/openui/approvals/${approvalId}/approve`,
        headers: { cookie: approvalCookie },
      });

    // 只有重命名权限不能批准工具：403 是功能级拒绝，不是会话范围问题。
    expectProblem(await approveAs(approver.cookie), 'FORBIDDEN');

    // 有 runs.approve 但不是会话本人：own_data 范围不匹配，按不存在处理。
    const outsider = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    expectProblem(await approveAs(outsider.cookie), 'NOT_FOUND');

    const restore = await inject(app, {
      method: 'PUT',
      url: `/api/accounts/${encodeURIComponent(approver.businessId)}/roles`,
      headers: auth(),
      payload: { roleIds: [approverRole.id, (await roleIds(app, cookie, ['user']))[0]] },
    });
    expect(restore.statusCode, restore.body).toBe(200);
    const approved = await approveAs(approver.cookie);
    expect(approved.statusCode, approved.body).toBe(200);
  });

  it('calls tools on an http MCP server using the cached catalog', async () => {
    // 真实 MCP 上游：平台自身的 /mcp 端点挂一个 generated server 就够用，
    // 再用它注册成 http server，验证 StreamableHTTP 分支与目录快照。
    const name = unique('oui-http');
    serverNames.push(name);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name, kind: 'generated', baseUrl: upstreamUrl },
    });
    const generatedId = created.json<{ id: string }>().id;
    await inject(app, {
      method: 'POST',
      url: `/api/servers/${generatedId}/tools`,
      headers: auth(),
      payload: {
        name: 'get-user',
        description: 'fixture',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        paramsIn: 'query',
      },
    });
    const tokenRow = await app.pool.query<{ token: string }>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [generatedId],
    );
    const token = tokenRow.rows[0]?.token ?? '';

    // 平台 MCP 端点要求真实端口；app.inject 承载不了 StreamableHTTP 会话。
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    const httpName = unique('oui-http-client');
    serverNames.push(httpName);
    const httpServer = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: {
        name: httpName,
        kind: 'http',
        url: `http://127.0.0.1:${address.port}/mcp/${generatedId}`,
        headers: { authorization: `Bearer ${token}` },
      },
    });
    expect(httpServer.statusCode, httpServer.body).toBe(201);

    // 目录快照：真实调用走 test 按钮，成功即写入 servers.config.toolCatalog。
    const tested = await inject(app, {
      method: 'POST',
      url: `/api/servers/${httpServer.json<{ id: string }>().id}/test`,
      headers: auth(),
    });
    expect(tested.statusCode, tested.body).toBe(200);

    const agent = (
      await createAgent(app, cookie, {
        slug: unique('oui-http-agent'),
        serverIds: [httpServer.json<{ id: string }>().id],
        track: agentSlugs,
      })
    ).json<Agent>();
    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'http bridge',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    conversationIds.push(conversationId);
    const messageId = await appendUiMessage(conversationId);

    const res = await callTool(conversationId, `mcp__${httpName}__get-user`, {
      messageId,
      args: { id: 1 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', data: { id: 1, name: 'Fixture user' } });
  });

  /** 直接把 fixture MCP 上游注册成 http server，并缓存它的工具目录。 */
  const seedHttpServer = async (): Promise<{
    server: Server;
    conversationId: string;
    messageId: string;
  }> => {
    const name = unique('oui-mcp');
    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name, kind: 'http', url: mcpUrl },
    });
    expect(created.statusCode, created.body).toBe(201);
    const server = created.json<Server>();
    serverNames.push(server.name);
    const tested = await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/test`,
      headers: auth(),
    });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json<{ ok: boolean }>().ok).toBe(true);

    const agent = (
      await createAgent(app, cookie, {
        slug: unique('oui-mcp-agent'),
        serverIds: [server.id],
        track: agentSlugs,
      })
    ).json<Agent>();
    const conversationId = newId('conversation');
    await repo.chat.createConversation(app.db, {
      id: conversationId,
      agentId: agent.id,
      title: 'mcp bridge',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    conversationIds.push(conversationId);
    const messageId = await appendUiMessage(conversationId);
    return { server, conversationId, messageId };
  };

  it('prefers structuredContent over the text JSON', async () => {
    const { server, conversationId, messageId } = await seedHttpServer();
    const res = await callTool(conversationId, `mcp__${server.name}__structured`, { messageId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', data: { from: 'structured' } });
  });

  it('joins every text block before parsing JSON', async () => {
    const { server, conversationId, messageId } = await seedHttpServer();
    const res = await callTool(conversationId, `mcp__${server.name}__chunked`, { messageId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', data: { rows: [1] } });

    const plain = await callTool(conversationId, `mcp__${server.name}__plain`, { messageId });
    expect(plain.json()).toEqual({ status: 'ok', data: 'just text' });
  });

  it('returns an error result instead of data when the upstream reports isError', async () => {
    const { server, conversationId, messageId } = await seedHttpServer();
    const res = await callTool(conversationId, `mcp__${server.name}__fails`, { messageId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'error', error: 'boom\ndetail' });

    const audit = await app.pool.query<{ status: string }>(
      "select status from audit_log where action = 'openui.tool.called' and target = $1 order by created_at desc limit 1",
      [conversationId],
    );
    expect(audit.rows[0]?.status).toBe('error');
  });
});
