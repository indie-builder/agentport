import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/**
 * 真实 HTTP 下的取消：不 mock MCP 与 SSRF，用未改动的外部上游验证
 * 「run 取消后，挂起中的工具调用不再打上游」。
 */
describe.skipIf(!ready)('generated MCP cancellation over real HTTP', () => {
  let app: FastifyInstance;
  let cookie: string;
  let baseUrl: string;
  let server: Server;
  let token: string;
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const upstreamCalls = { count: 0 };
  const upstream = { abort: () => undefined };

  beforeAll(async () => {
    app = await startApp({ APPROVAL_WAIT_MS: '1000' });
    cookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 本机上游：调用计数就是「取消后是否真打了上游」的唯一证据。
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
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: `http://127.0.0.1:${upstreamAddress.port}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    server = res.json<Server>();

    const toolRes = await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: { cookie },
      payload: {
        name: 'blocked-user',
        method: 'GET',
        pathTemplate: '/thing',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'query',
        requiresApproval: true,
      },
    });
    expect(toolRes.statusCode, toolRes.body).toBe(201);

    const row = await app.pool.query<{ token: string }>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    token = row.rows[0]?.token ?? '';
    expect(token).not.toBe('');
  });

  afterAll(async () => {
    upstream.abort();
    await cleanup(app, { serverNames: createdServers, agentSlugs: createdAgents, runIds });
    await app.close();
  });

  it('ends the suspended call when the run is cancelled, and never calls the upstream', async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('cancel-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();
    const { runId } = await seedRun(app, agent.id, { runId: unique('cancel-run') });
    runIds.push(runId);

    const client = new Client({ name: 'agentport-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
      },
    });
    await client.connect(transport);
    try {
      const pendingCall = client.callTool({ name: 'blocked-user', arguments: {} });

      // 等挂起请求落库并带未来截止时间，再取消；顺序固定，不靠 sleep 猜时序。
      const seeded = await waitFor(async () => {
        const res = await inject(app, {
          method: 'GET',
          url: `/api/runs/${runId}/approvals`,
          headers: { cookie },
        });
        return res.statusCode === 200 && res.json<{ items: unknown[] }>().items.length > 0;
      });
      expect(seeded).toBe(true);

      const cancel = await inject(app, {
        method: 'POST',
        url: `/api/chat/${runId}/cancel`,
        headers: { cookie },
      });
      expect(cancel.statusCode, cancel.body).toBe(202);

      const result = await pendingCall;
      const text = JSON.stringify(result.content);
      expect(result.isError).toBe(true);
      // 取消在 1000ms 截止之前发生，文案不能是「已等待 N 秒」的超时。
      expect(text).toMatch(/cancel|取消|结束/i);
      expect(text).not.toContain('已等待');
      expect(upstreamCalls.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
