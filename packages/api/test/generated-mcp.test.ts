import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashMcpToken } from '@agentport/core';
import type { Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  startApp,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('generated MCP endpoint', () => {
  let app: FastifyInstance;
  let cookie: string;
  let baseUrl: string;
  let server: Server;
  let token: string;
  const upstream = createServer((request, response) => {
    if (request.url?.split('?')[0] !== '/users/1') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 1, name: 'Fixture user' }));
  });
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    // 测试里不要让审批挂起 5 分钟；默认配置仍是 300s。
    app = await startApp({ APPROVAL_WAIT_MS: '0' });
    cookie = await loginCookie(app);
    // MCP client 走真实 HTTP，app.inject 无法承载 StreamableHTTP 会话，因此临时监听端口。
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const name = unique('mcp');
    createdServers.push(name);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: upstreamUrl },
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
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
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
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('approval-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const { runId } = await seedRun(app, agent.id, { runId: unique('run') });
    runIds.push(runId);

    const call = async (): Promise<{
      isError?: boolean | undefined;
      content: Array<{ text?: string | undefined } & Record<string, unknown>>;
    }> => {
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
    // 立即拒绝（wait=0）没有等待窗口：waiting 为 false、没有截止时间。
    const pending = await inject(app, {
      method: 'GET',
      url: `/api/runs/${runId}/approvals`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(
      pending.json<{
        items: Array<{
          serverId: string;
          toolName: string;
          approvedAt: string | null;
          expiresAt: string | null;
          waiting: boolean;
        }>;
      }>().items,
    ).toMatchObject([
      {
        serverId: server.id,
        toolName: 'approved-user',
        approvedAt: null,
        expiresAt: null,
        waiting: false,
      },
    ]);

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
    expect(approve.json<{ serverId: string; toolName: string; waiting: boolean }>()).toMatchObject({
      serverId: server.id,
      toolName: 'approved-user',
      waiting: false,
    });

    const allowed = await call();
    expect(allowed.isError).toBeFalsy();
  });

  it('reports the tool catalog from a real self test connection', async () => {
    // 用已监听的真实端口做 SELF_URL：测试连接会以 MCP client 连回平台自身。
    const testServer = await startApp({ SELF_URL: baseUrl });
    try {
      const res = await inject(testServer, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = <Record<string, unknown>>res.json();
      expect(body.ok).toBe(true);

      // catalog 契约：每项只含 name/title/description/inputSchema，其余 SDK 元数据不外泄。
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools.map((t) => t.name)).toContain('get-user');
      for (const tool of tools) {
        expect(
          Object.keys(tool).every((key) =>
            ['name', 'title', 'description', 'inputSchema'].includes(key),
          ),
        ).toBe(true);
      }
      const getUser = tools.find((t) => t.name === 'get-user');
      expect(getUser?.inputSchema).toMatchObject({
        type: 'object',
        properties: { id: { type: 'integer' } },
      });
      expect(getUser?.description).toBe('fetch one user');

      // 平台自身的 mcpToken 不得随测试结果回显。
      expect(JSON.stringify(body)).not.toContain(token);
    } finally {
      await testServer.close();
    }
  });

  it('suspends the call and resumes it after approval when a wait is configured', async () => {
    // 配置在 startApp 时读取；这一步需要新实例。
    const waiting = await startApp({ APPROVAL_WAIT_MS: '5000' });
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

      const agent = (
        await createAgent(waiting, cookie, {
          slug: unique('suspend-agent'),
          serverIds: [server.id],
          track: createdAgents,
        })
      ).json<{ id: string }>();

      const { runId } = await seedRun(waiting, agent.id, { runId: unique('run') });
      runIds.push(runId);

      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
        },
      });
      await client.connect(transport);
      try {
        const pendingCall = client.callTool({ name: 'suspended-user', arguments: { id: 1 } });

        // 调用应挂起：等请求落库，确认它带未来截止时间并可等待，再批准同一次调用。
        const seeded = await waitFor(async () => {
          const res = await inject(waiting, {
            method: 'GET',
            url: `/api/runs/${runId}/approvals`,
            headers: { cookie },
          });
          return res.statusCode === 200 && res.json<{ items: unknown[] }>().items.length > 0;
        });
        expect(seeded).toBe(true);
        const pendingApproval = (
          await inject(waiting, {
            method: 'GET',
            url: `/api/runs/${runId}/approvals`,
            headers: { cookie },
          })
        ).json<{ items: Array<{ expiresAt: string | null; waiting: boolean }> }>().items[0];
        expect(pendingApproval?.waiting).toBe(true);
        expect(new Date(pendingApproval?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

        const approve = await inject(waiting, {
          method: 'POST',
          url: `/api/runs/${runId}/approve`,
          headers: { cookie },
          payload: { serverId: server.id, toolName: 'suspended-user' },
        });
        expect(approve.statusCode).toBe(200);
        expect(approve.json<{ waiting: boolean }>().waiting).toBe(true);

        const result = await pendingCall;
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.content)).toContain('Fixture user');
      } finally {
        await client.close();
      }
    } finally {
      await waiting.close();
    }
  });

  it('times out before the upstream call and records an expired request', async () => {
    // 100ms < 轮询间隔：调用在第一次轮询前就到截止，不会碰上游。
    const waiting = await startApp({ APPROVAL_WAIT_MS: '100' });
    try {
      await waiting.listen({ port: 0, host: '127.0.0.1' });
      const address = waiting.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;

      const toolRes = await inject(waiting, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: { cookie },
        payload: {
          name: 'timeout-user',
          method: 'GET',
          pathTemplate: '/users/{id}',
          inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
          paramsIn: 'query',
          requiresApproval: true,
        },
      });
      expect(toolRes.statusCode).toBe(201);

      const agent = (
        await createAgent(waiting, cookie, {
          slug: unique('timeout-agent'),
          serverIds: [server.id],
          track: createdAgents,
        })
      ).json<{ id: string }>();
      const { runId } = await seedRun(waiting, agent.id, { runId: unique('run') });
      runIds.push(runId);

      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
        },
      });
      await client.connect(transport);
      try {
        const result = await client.callTool({ name: 'timeout-user', arguments: { id: 1 } });
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining('本次调用取消') });
      } finally {
        await client.close();
      }

      const items = (
        await inject(waiting, {
          method: 'GET',
          url: `/api/runs/${runId}/approvals`,
          headers: { cookie },
        })
      ).json<{ items: Array<{ expiresAt: string | null; waiting: boolean }> }>().items;
      expect(items).toHaveLength(1);
      expect(new Date(items[0]?.expiresAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
      expect(items[0]?.waiting).toBe(false);
    } finally {
      await waiting.close();
    }
  });

  it('accepts a per-run token until it expires or the run ends', async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('run-token-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const runToken = randomBytes(32).toString('base64url');
    const { runId } = await seedRun(app, agent.id, {
      runId: unique('run-token'),
      mcpTokenHash: hashMcpToken(runToken),
    });
    runIds.push(runId);

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
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('unbound-agent'),
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const { runId } = await seedRun(app, agent.id, { runId: unique('unbound-run') });
    runIds.push(runId);

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
