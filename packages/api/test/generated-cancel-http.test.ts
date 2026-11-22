import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
  waitFor,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;

describe.skipIf(!ready)('generated MCP cancellation over real HTTP', () => {
  let app: TestApp;
  let listener: TestServer;
  let cookie: string;
  let baseUrl: string;
  let server: Server;
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const upstreamCalls = { count: 0 };
  const upstream = { abort: () => undefined };

  beforeAll(async () => {
    app = await startApp({ APPROVAL_WAIT_MS: '1000' });
    cookie = await loginCookie(app);
    listener = await listen(app);
    baseUrl = listener.url;

    const upstreamServer = createServer((_req, res) => {
      upstreamCalls.count += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream-ok');
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    upstream.abort = () => {
      upstreamServer.close();
    };

    const name = unique('cancel-mcp');
    createdServers.push(name);
    const res = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: `http://127.0.0.1:${upstreamAddress.port}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    server = res.json<Server>();

    const toolRes = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'blocked-user',
        method: 'GET',
        pathTemplate: '/thing',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'query',
        approvalMode: 'ask',
      },
    });
    expect(toolRes.statusCode, toolRes.body).toBe(201);
  });

  afterAll(async () => {
    await listener.close();
    upstream.abort();
    await cleanup(app, { serverNames: createdServers, agentSlugs: createdAgents, runIds });
    await app.close();
  });

  it('refuses an unapproved call and a subsequent call after cancellation without upstream execution', async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('cancel-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();
    const runToken = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: 'base64url', omitPadding: true });
    const { runId } = await seedRun(app, agent.id, {
      runId: unique('cancel-run'),
      mcpTokenHash: hashMcpToken(runToken),
    });
    runIds.push(runId);

    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: {
        headers: { authorization: `Bearer ${runToken}`, 'x-agentport-run-id': runId },
      },
    });
    await client.connect(transport);
    try {
      const refused = await client.callTool({ name: 'blocked-user', arguments: {} });
      expect(refused.isError).toBe(true);

      const seeded = await waitFor(async () => {
        const res = await request(app, {
          method: 'GET',
          url: `/api/runs/${runId}/approvals`,
          headers: { cookie },
        });
        return res.statusCode === 200 && res.json<{ items: unknown[] }>().items.length > 0;
      });
      expect(seeded).toBe(true);

      const cancel = await request(app, {
        method: 'POST',
        url: `/api/chat/${runId}/cancel`,
        headers: { cookie },
      });
      expect(cancel.statusCode, cancel.body).toBe(202);

      const result = await client.callTool({ name: 'blocked-user', arguments: {} });
      const text = JSON.stringify(result.content);
      expect(result.isError).toBe(true);
      expect(text).toMatch(/cancel|取消|结束/i);
      expect(text).not.toContain('已等待');
      expect(upstreamCalls.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
