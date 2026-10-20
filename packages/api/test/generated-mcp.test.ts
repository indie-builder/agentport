import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { hashMcpToken } from '@agentport/core';
import type { Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('generated MCP endpoint', () => {
  let app: FastifyInstance;
  let cookie: string;
  let baseUrl: string;
  let server: Server;
  let token: string;
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    // 测试里不要让审批挂起 5 分钟；默认配置仍是 300s。
    process.env.APPROVAL_WAIT_MS = '0';
    app = await startApp();
    cookie = await loginCookie(app);
    // MCP client 走真实 HTTP，app.inject 无法承载 StreamableHTTP 会话，因此临时监听端口。
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const name = unique('mcp');
    createdServers.push(name);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: 'https://jsonplaceholder.typicode.com' },
    });
    expect(res.statusCode).toBe(201);
    server = res.json<Server>();
    await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'get-user',
        description: 'fetch one user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
      },
    });

    // mcpToken 是给沙盒/外部 host 的凭据，刻意不出现在 API 响应里。
    const row = await app.pool.query<{ token: string }>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    token = row.rows[0]?.token ?? '';
    expect(token).not.toBe('');
  });

  afterAll(async () => {
    await cleanup(app, { serverNames: createdServers, agentSlugs: createdAgents, runIds });
    await app.close();
    delete process.env.APPROVAL_WAIT_MS;
  });

  it('rejects a wrong bearer token with 401', async () => {
    const res = await fetch(`${baseUrl}/mcp/${server.id}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown server id', async () => {
    const res = await fetch(`${baseUrl}/mcp/srv_missing`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('initializes with the correct token and lists registered tools', async () => {
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe(server.name);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get-user');
    } finally {
      await client.close();
    }
  });

  it('rejects a tool requiring approval until the run approves it', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'approved-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
        requiresApproval: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const tool = res.json<{ id: string; requiresApproval: boolean }>();
    expect(tool.requiresApproval).toBe(true);

    // 审批只接受该 run 所属智能体实际绑定、且要求批准的工具，因此落一个真实 agent。
    const agentSlug = unique('approval-agent');
    createdAgents.push(agentSlug);
    const agentRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { slug: agentSlug, name: agentSlug, serverIds: [server.id] },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json<{ id: string }>().id;

    const runId = unique('run');
    runIds.push(runId);
    // agent_runs 现在有外键，先落一个真实会话。
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      `conv_test_${runId}`,
      agentId,
    ]);
    await app.pool.query(
      'insert into agent_runs (id, conversation_id, agent_id) values ($1, $2, $3)',
      [runId, `conv_test_${runId}`, agentId],
    );

    const call = async (): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> => {
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
        },
      });
      try {
        await client.connect(transport);
        return await client.callTool({
          name: 'approved-user',
          arguments: { id: 1 },
        });
      } finally {
        await client.close();
      }
    };

    const denied = await call();
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('需要批准：approved-user');

    // 拒绝时 MCP 端点写入结构化审批请求，UI 不再依赖错误文本。
    const pending = await inject(app, {
      method: 'GET',
      url: `/api/runs/${runId}/approvals`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(
      pending.json<{ items: Array<{ serverId: string; toolName: string; approvedAt: string }> }>()
        .items,
    ).toMatchObject([{ serverId: server.id, toolName: 'approved-user', approvedAt: null }]);

    // 缺少 serverId 的旧式请求不再被接受。
    const legacy = await inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { toolName: 'approved-user' },
    });
    expect(legacy.statusCode).toBe(400);

    const approve = await inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { serverId: server.id, toolName: 'approved-user' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ serverId: string; toolName: string }>()).toMatchObject({
      serverId: server.id,
      toolName: 'approved-user',
    });

    const allowed = await call();
    expect(allowed.isError).toBeFalsy();
  });

  it('suspends the call and resumes it after approval when a wait is configured', async () => {
    process.env.APPROVAL_WAIT_MS = '5000';
    // 配置在 startApp 时读取；这一步需要新实例。
    const waiting = await startApp();
    try {
      await waiting.listen({ port: 0, host: '127.0.0.1' });
      const address = waiting.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;

      const toolRes = await inject(waiting, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: { cookie },
        payload: {
          name: 'suspended-user',
          method: 'GET',
          pathTemplate: '/users/{id}',
          inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
          paramsIn: 'query',
          requiresApproval: true,
        },
      });
      expect(toolRes.statusCode).toBe(201);

      const agentSlug = unique('suspend-agent');
      createdAgents.push(agentSlug);
      const agentRes = await inject(waiting, {
        method: 'POST',
        url: '/api/agents',
        headers: { cookie },
        payload: { slug: agentSlug, name: agentSlug, serverIds: [server.id] },
      });
      expect(agentRes.statusCode).toBe(201);
      const agentId = agentRes.json<{ id: string }>().id;

      const runId = unique('run');
      runIds.push(runId);
      await waiting.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
        `conv_test_${runId}`,
        agentId,
      ]);
      await waiting.pool.query(
        'insert into agent_runs (id, conversation_id, agent_id) values ($1, $2, $3)',
        [runId, `conv_test_${runId}`, agentId],
      );

      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
        },
      });
      await client.connect(transport);
      try {
        const pendingCall = client.callTool({ name: 'suspended-user', arguments: { id: 1 } });

        // 调用应挂起：立刻批准，然后同一次调用返回真实结果。
        await new Promise((resolve) => setTimeout(resolve, 800));
        const approve = await inject(waiting, {
          method: 'POST',
          url: `/api/runs/${runId}/approve`,
          headers: { cookie },
          payload: { serverId: server.id, toolName: 'suspended-user' },
        });
        expect(approve.statusCode).toBe(200);

        const result = await pendingCall;
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.content)).toContain('Leanne Graham');
      } finally {
        await client.close();
      }
    } finally {
      await waiting.close();
      process.env.APPROVAL_WAIT_MS = '0';
    }
  });

  it('accepts a per-run token until it expires or the run ends', async () => {
    const agentSlug = unique('run-token-agent');
    createdAgents.push(agentSlug);
    const agentRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { slug: agentSlug, name: agentSlug, serverIds: [server.id] },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json<{ id: string }>().id;

    const runId = unique('run-token');
    runIds.push(runId);
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      `conv_test_${runId}`,
      agentId,
    ]);
    const runToken = randomBytes(32).toString('base64url');
    const tokenHash = hashMcpToken(runToken);
    await app.pool.query(
      `insert into agent_runs (id, conversation_id, agent_id, mcp_token_hash, mcp_token_expires_at)
       values ($1, $2, $3, $4, now() + interval '5 minutes')`,
      [runId, `conv_test_${runId}`, agentId, tokenHash],
    );

    const call = async (bearer: string): Promise<Response> =>
      fetch(`${baseUrl}/mcp/${server.id}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-agentport-run-id': runId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

    // 有效期内可用；长期 token 若随请求带来也不能替代已过期的 run token 以外的路径。
    expect((await call(runToken)).status).toBe(200);

    // 过期即拒绝。
    await app.pool.query(
      "update agent_runs set mcp_token_expires_at = now() - interval '1 second' where id = $1",
      [runId],
    );
    expect((await call(runToken)).status).toBe(401);

    // run 结束后 worker 清空 hash，token 立即失效。
    await app.pool.query(
      'update agent_runs set mcp_token_hash = null, mcp_token_expires_at = null where id = $1',
      [runId],
    );
    expect((await call(runToken)).status).toBe(401);

    // 长期 token 仍对没有 run token 的外部客户端可用。
    expect(
      (
        await fetch(`${baseUrl}/mcp/${server.id}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        })
      ).status,
    ).toBe(200);
  });

  it('does not accept a run header whose agent is not bound to the server', async () => {
    const agentSlug = unique('unbound-agent');
    createdAgents.push(agentSlug);
    const agentRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { slug: agentSlug, name: agentSlug },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json<{ id: string }>().id;

    const runId = unique('unbound-run');
    runIds.push(runId);
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      `conv_test_${runId}`,
      agentId,
    ]);
    await app.pool.query(
      'insert into agent_runs (id, conversation_id, agent_id) values ($1, $2, $3)',
      [runId, `conv_test_${runId}`, agentId],
    );

    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
      },
    });
    try {
      await client.connect(transport);
      // 未绑定的 run 不被采信，因此审批工具仍被拒。
      const res = await client.callTool({ name: 'approved-user', arguments: { id: 1 } });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }

    // 不受信的 run header 不应产生任何审批记录，也不会让审批工具通过。
    const rows = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from approval_requests where run_id = $1',
      [runId],
    );
    expect(rows.rows[0]?.count).toBe(0);

    const approve = await inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { serverId: server.id, toolName: 'approved-user' },
    });
    expect(approve.statusCode).toBe(404);
  });
});
