import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashMcpToken } from '@agentport/core';
import type { Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  request,
  seedRun,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;

describe.skipIf(!ready)('generated MCP endpoint', () => {
  let app: TestApp;
  let listener: TestServer;
  let cookie: string;
  let baseUrl: string;
  let server: Server;
  let token: string;
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    const path = request.url?.split('?')[0];
    if (path !== '/users/1' && path !== '/users/v1.2') {
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
    app = await startApp();
    cookie = await loginCookie(app);
    // MCP client 走真实 HTTP，app.inject 无法承载 StreamableHTTP 会话，因此临时监听端口。
    listener = await listen(app);
    baseUrl = listener.url;
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const name = unique('mcp');
    createdServers.push(name);
    const res = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: upstreamUrl },
    });
    expect(res.statusCode).toBe(201);
    server = res.json<Server>();
    await request(app, {
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
    const stringUser = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'string-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        paramsIn: 'query',
      },
    });
    expect(stringUser.statusCode).toBe(201);
    const nestedUser = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'nested-user',
        method: 'GET',
        pathTemplate: '/a/{x}/b/{y}',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'string' }, y: { type: 'string' } },
        },
        paramsIn: 'query',
      },
    });
    expect(nestedUser.statusCode).toBe(201);

    const row = await app.client.unsafe<{ token: string }[]>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    token = row[0]?.token ?? '';
    expect(token).not.toBe('');
  });

  afterAll(async () => {
    await listener.close();
    await app.client.unsafe('delete from audit_log where target = $1', [server.id]);
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
    const res = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'approved-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
        approvalMode: 'ask',
      },
    });
    expect(res.statusCode).toBe(201);
    const tool = res.json<{ id: string; approvalMode: 'allow' | 'ask' | 'deny' }>();
    expect(tool.approvalMode).toBe('ask');

    const agent = (
      await createAgent(app, cookie, {
        slug: unique('approval-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const runToken = randomBytes(32).toString('base64url');
    const { runId } = await seedRun(app, agent.id, {
      runId: unique('run'),
      mcpTokenHash: hashMcpToken(runToken),
    });
    runIds.push(runId);

    const call = async (): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> => {
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId },
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

    const pending = await request(app, {
      method: 'GET',
      url: `/api/runs/${runId}/approvals`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    const pendingItems = pending.json<{
      items: Array<{
        id: string;
        serverId: string;
        toolName: string;
        approvedAt: string | null;
        expiresAt: string | null;
        waiting: boolean;
      }>;
    }>().items;
    expect(pendingItems).toMatchObject([
      {
        serverId: server.id,
        toolName: 'approved-user',
        approvedAt: null,
        expiresAt: expect.any(String),
        waiting: true,
      },
    ]);

    const legacy = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { toolName: 'approved-user' },
    });
    expect(legacy.statusCode).toBe(400);

    const approve = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { approvalId: pendingItems[0]?.id },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ serverId: string; toolName: string; waiting: boolean }>()).toMatchObject({
      serverId: server.id,
      toolName: 'approved-user',
      waiting: true,
    });

    const allowed = await call();
    expect(allowed.isError).toBeFalsy();
  });

  it('denies a policy-blocked tool without calling upstream and audits it', async () => {
    const res = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'denied-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
        approvalMode: 'deny',
      },
    });
    expect(res.statusCode).toBe(201);

    const before = upstreamCalls;
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'denied-user', arguments: { id: 1 } });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('禁止调用') });
    } finally {
      await client.close();
    }
    expect(upstreamCalls).toBe(before);

    const rows = await app.client.unsafe<{ count: number }[]>(
      "select count(*)::int as count from audit_log where action = 'mcp.tool.denied' and target = $1",
      [server.id],
    );
    expect(rows[0]?.count).toBeGreaterThan(0);
  });

  const callRegisteredTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> => {
    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
    }
  };

  it('rejects "." and ".." path parameters without calling upstream', async () => {
    const before = upstreamCalls;
    const dotdot = await callRegisteredTool('string-user', { id: '..' });
    expect(dotdot.isError).toBe(true);
    expect(dotdot.content[0]?.text).toContain('不能是 "." 或 ".."');

    const dot = await callRegisteredTool('string-user', { id: '.' });
    expect(dot.isError).toBe(true);
    expect(dot.content[0]?.text).toContain('不能是 "." 或 ".."');
    expect(upstreamCalls).toBe(before);
  });

  it('allows dotted path parameter values', async () => {
    const before = upstreamCalls;
    const result = await callRegisteredTool('string-user', { id: 'v1.2' });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('Fixture user');
    expect(upstreamCalls).toBe(before + 1);
  });

  it('rejects ".." in any path segment', async () => {
    const before = upstreamCalls;
    const result = await callRegisteredTool('nested-user', { x: '..', y: 'ok' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('不能是 "." 或 ".."');
    expect(upstreamCalls).toBe(before);
  });

  it('reports the tool catalog from a real self test connection', async () => {
    const testServer = await startApp({ SELF_URL: baseUrl });
    try {
      const res = await request(testServer, {
        method: 'POST',
        url: `/api/servers/${server.id}/test`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = <Record<string, unknown>>res.json();
      expect(body.ok).toBe(true);

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

      expect(JSON.stringify(body)).not.toContain(token);
    } finally {
      await testServer.close();
    }
  });

  it('registers approval over short requests and executes only after approval', async () => {
    const waiting = await startApp({ APPROVAL_WAIT_MS: '5000' });
    const waitingServer = await listen(waiting);
    try {
      const toolRes = await request(waiting, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: { cookie },
        payload: {
          name: 'suspended-user',
          method: 'GET',
          pathTemplate: '/users/{id}',
          inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
          paramsIn: 'query',
          approvalMode: 'ask',
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
      const runToken = randomBytes(32).toString('base64url');
      const { runId } = await seedRun(waiting, agent.id, { mcpTokenHash: hashMcpToken(runToken) });
      runIds.push(runId);
      const approvalUrl = `${waitingServer.url}/tool-approvals/${runId}/${server.id}/suspended-user`;
      const headers = {
        authorization: `Bearer ${runToken}`,
        'x-agentport-run-id': runId,
        'content-type': 'application/json',
      };
      const firstResponse = await fetch(approvalUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ id: 1 }),
      });
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as {
        status: string;
        approvalId: string;
        expiresAt: string;
      };
      expect(first.status).toBe('pending');
      const retried = await fetch(approvalUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ id: 1 }),
      });
      expect(await retried.json()).toEqual(first);
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${waitingServer.url}/mcp/${server.id}`), {
          requestInit: { headers },
        }),
      );
      try {
        const before = upstreamCalls;
        const refused = await client.callTool({ name: 'suspended-user', arguments: { id: 1 } });
        expect(refused.isError).toBe(true);
        expect(upstreamCalls).toBe(before);
        const approve = await request(waiting, {
          method: 'POST',
          url: `/api/runs/${runId}/approve`,
          headers: { cookie },
          payload: { approvalId: first.approvalId },
        });
        expect(approve.statusCode).toBe(200);
        const state = await fetch(approvalUrl, { headers });
        expect(await state.json()).toMatchObject({
          status: 'approved',
          approvalId: first.approvalId,
          expiresAt: first.expiresAt,
        });
        const result = await client.callTool({ name: 'suspended-user', arguments: { id: 1 } });
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.content)).toContain('Fixture user');
      } finally {
        await client.close();
      }
    } finally {
      await waitingServer.close();
      await waiting.close();
    }
  });

  it('derives an expired request over HTTP without executing upstream', async () => {
    const waiting = await startApp({ APPROVAL_WAIT_MS: '0' });
    const waitingServer = await listen(waiting);
    try {
      const toolRes = await request(waiting, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: { cookie },
        payload: {
          name: 'timeout-user',
          method: 'GET',
          pathTemplate: '/users/{id}',
          approvalMode: 'ask',
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
      const runToken = randomBytes(32).toString('base64url');
      const { runId } = await seedRun(waiting, agent.id, { mcpTokenHash: hashMcpToken(runToken) });
      runIds.push(runId);
      const url = `${waitingServer.url}/tool-approvals/${runId}/${server.id}/timeout-user`;
      const headers = {
        authorization: `Bearer ${runToken}`,
        'x-agentport-run-id': runId,
        'content-type': 'application/json',
      };
      const before = upstreamCalls;
      const registered = await fetch(url, { method: 'PUT', headers, body: '{}' });
      expect(registered.status).toBe(200);
      const expired = (await registered.json()) as { status: string; approvalId: string };
      expect(expired.status).toBe('expired');
      const late = await request(waiting, {
        method: 'POST',
        url: `/api/runs/${runId}/approve`,
        headers: { cookie },
        payload: { approvalId: expired.approvalId },
      });
      expect(late.statusCode).toBe(409);
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${waitingServer.url}/mcp/${server.id}`), {
            requestInit: { headers },
          }),
        );
        expect(
          (await client.callTool({ name: 'timeout-user', arguments: { id: 1 } })).isError,
        ).toBe(true);
      } finally {
        await client.close();
      }
      expect(await (await fetch(url, { headers })).json()).toMatchObject({ status: 'expired' });
      expect(upstreamCalls).toBe(before);
    } finally {
      await waitingServer.close();
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

    expect((await call(runToken)).status).toBe(200);

    await app.client.unsafe(
      "update agent_runs set mcp_token_expires_at = now() - interval '1 second' where id = $1",
      [runId],
    );
    expect((await call(runToken)).status).toBe(401);

    await app.client.unsafe(
      'update agent_runs set mcp_token_hash = null, mcp_token_expires_at = null where id = $1',
      [runId],
    );
    expect((await call(runToken)).status).toBe(401);

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
      const res = await client.callTool({ name: 'approved-user', arguments: { id: 1 } });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }

    const rows = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from approval_requests where run_id = $1',
      [runId],
    );
    expect(rows[0]?.count).toBe(0);

    const approve = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { approvalId: 'unbound-approval' },
    });
    expect(approve.statusCode).toBe(404);
  });
});
