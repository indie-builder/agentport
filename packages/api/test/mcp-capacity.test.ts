import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentInvoker } from '../src/modules/servers/agent-tools.js';
import { registerServersHttp } from '../src/modules/servers/http.js';
import type { AppRuntime } from '../src/types.js';
import {
  cleanup,
  createAgent,
  infraReady,
  loginCookie,
  request,
  seedRun,
  startApp,
  unique,
  waitFor,
} from './helpers.js';
import { contextApp } from './hono-app.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;

const PLATFORM_TOKEN = 'capacity-platform-token-0123456789';
process.env.PLATFORM_MCP_TOKEN = PLATFORM_TOKEN;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  promise.catch(() => undefined);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms`)), ms);
      timer.unref();
    }),
  ]);
}

interface CallResult {
  isError?: boolean;
  content: Array<{ text?: string }>;
}

function boundedInvoker(): { invoker: AgentInvoker; release: () => void; calls: () => number } {
  const ADMITTED = 4;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    calls: () => calls,
    invoker: {
      async invoke({ prompt }) {
        calls += 1;
        if (calls <= ADMITTED) await gate;
        return `done:${prompt}`;
      },
    },
  };
}

describe.skipIf(!ready)('MCP capacity: approval requests must not block execution', () => {
  let app: AppRuntime;
  let listener: TestServer;
  let cookie: string;
  let mcpUrl: string;
  let server: Server;
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const upstreamCalls = { count: 0 };
  const upstream = { close: () => undefined };

  beforeAll(async () => {
    app = await startApp({ APPROVAL_WAIT_MS: '10000' });
    cookie = await loginCookie(app);
    listener = await listen(app);
    mcpUrl = listener.url;

    const upstreamServer = createServer((_req, res) => {
      upstreamCalls.count += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('upstream-ok');
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstream.close = () => upstreamServer.close();
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const name = unique('capacity-mcp');
    createdServers.push(name);
    const res = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name, kind: 'generated', baseUrl: `http://127.0.0.1:${upstreamPort}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    server = res.json<Server>();

    for (const tool of [
      { name: 'waiting-tool', approvalMode: 'ask' },
      { name: 'free-tool', approvalMode: 'allow' },
    ]) {
      const toolRes = await request(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/tools`,
        headers: { cookie },
        payload: {
          ...tool,
          method: 'GET',
          pathTemplate: '/thing',
          inputSchema: { type: 'object', properties: {} },
          paramsIn: 'query',
        },
      });
      expect(toolRes.statusCode, toolRes.body).toBe(201);
    }
  });

  afterAll(async () => {
    upstream.close();
    if (!app) return;
    await cleanup(app, { serverNames: createdServers, agentSlugs: createdAgents, runIds });
    await listener?.close();
    await app.close();
  });

  it('runs a free call alongside unapproved calls and refuses each unapproved call immediately', async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('capacity-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const runIdsForAgent: string[] = [];
    const runTokens = new Map<string, string>();
    for (let i = 0; i < 5; i += 1) {
      const runToken = randomBytes(32).toString('base64url');
      const { runId } = await seedRun(app, agent.id, {
        runId: unique(`capacity-run-${i}`),
        mcpTokenHash: hashMcpToken(runToken),
      });
      runIds.push(runId);
      runIdsForAgent.push(runId);
      runTokens.set(runId, runToken);
    }

    const clients: Client[] = [];
    const pending: Array<Promise<CallResult>> = [];
    const connect = async (runId: string): Promise<Client> => {
      const client = new Client({ name: 'capacity-test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp/${server.id}`), {
          requestInit: {
            headers: {
              authorization: `Bearer ${runTokens.get(runId)}`,
              'x-agentport-run-id': runId,
            },
          },
        }),
      );
      clients.push(client);
      return client;
    };
    const safeClose = async (client: Client): Promise<void> => {
      await withTimeout(client.close(), 3_000, 'client.close').catch(() => undefined);
    };

    try {
      for (const runId of runIdsForAgent.slice(0, 4)) {
        const client = await withTimeout(connect(runId), 5_000, 'connect');
        pending.push(
          withTimeout(
            client.callTool({ name: 'waiting-tool', arguments: {} }) as Promise<CallResult>,
            15_000,
            '等待中的调用',
          ),
        );
      }

      for (const runId of runIdsForAgent.slice(0, 4)) {
        const parked = await waitFor(async () => {
          const res = await request(app, {
            method: 'GET',
            url: `/api/runs/${runId}/approvals`,
            headers: { cookie },
          });
          return res.statusCode === 200 && res.json<{ items: unknown[] }>().items.length === 1;
        });
        expect(parked, `run ${runId} 没有进入等待`).toBe(true);
      }

      const fifthRunId = runIdsForAgent[4] ?? '';
      const fifth = await withTimeout(connect(fifthRunId), 5_000, '第 5 个客户端连接');

      const tools = await withTimeout(fifth.listTools(), 5_000, '第 5 个客户端 listTools');
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['waiting-tool', 'free-tool']),
      );

      const free = await withTimeout(
        fifth.callTool({ name: 'free-tool', arguments: {} }) as Promise<CallResult>,
        5_000,
        '免费调用',
      );
      expect(free.isError).toBeFalsy();
      expect(JSON.stringify(free.content)).toContain('upstream-ok');
      expect(upstreamCalls.count).toBe(1);

      const started = Date.now();
      const refused = await withTimeout(
        fifth.callTool({ name: 'waiting-tool', arguments: {} }) as Promise<CallResult>,
        5_000,
        '第 5 次等待',
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('需要批准：waiting-tool');

      const rows = await waitFor(async () => {
        const res = await request(app, {
          method: 'GET',
          url: `/api/runs/${fifthRunId}/approvals`,
          headers: { cookie },
        });
        return res.statusCode === 200 && res.json<{ items: unknown[] }>().items.length === 1;
      });
      expect(rows).toBe(true);
      const refusedRow = (
        await request(app, {
          method: 'GET',
          url: `/api/runs/${fifthRunId}/approvals`,
          headers: { cookie },
        })
      ).json<{ items: Array<{ expiresAt: string | null; waiting: boolean }> }>().items[0];
      expect(refusedRow).toMatchObject({ expiresAt: expect.any(String), waiting: true });
    } finally {
      for (const runId of runIdsForAgent) {
        await repo.chat.cancelRun(app.db, runId).catch(() => undefined);
      }
      await withTimeout(Promise.allSettled(pending), 10_000, '清理挂起调用').catch(() => undefined);
      for (const client of clients) await safeClose(client);
    }
  }, 15_000);
});

describe.skipIf(!ready)('platform MCP: long tool invokes must not block new sessions', () => {
  let app: AppRuntime;
  let platform: TestServer;
  let cookie: string;
  let platformUrl: string;
  let slug: string;
  let toolName: string;
  let agentId: string;
  let mock: ReturnType<typeof boundedInvoker>;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    slug = unique('capacity-platform-agent');
    toolName = `run_${slug.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`;
    agentId = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>().id;

    mock = boundedInvoker();
    const platformApp = contextApp(app);
    registerServersHttp(platformApp as never, {
      db: app.db,
      client: app.client,
      config: app.config,
      log: app.log,
      auth: app.auth,
      invoker: mock.invoker,
    });
    platform = await listen({ app: platformApp as never });
    platformUrl = `${platform.url}/mcp`;
  });

  afterAll(async () => {
    mock.release();
    if (!app) return;
    await app.client.unsafe('delete from audit_log where target = $1', [agentId]);
    await cleanup(app, { agentSlugs: createdAgents });
    await platform?.close();
    await app.close();
  });

  it('completes a new client call while 4 invokes are parked', async () => {
    const clients: Client[] = [];
    const connect = async (n: number): Promise<Client> => {
      const client = new Client({ name: `platform-capacity-${n}`, version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(platformUrl), {
          requestInit: { headers: { authorization: `Bearer ${PLATFORM_TOKEN}` } },
        }),
      );
      clients.push(client);
      return client;
    };
    const invokeOn = (client: Client, n: number): Promise<CallResult> =>
      client.callTool({ name: toolName, arguments: { prompt: `p${n}` } }) as Promise<CallResult>;
    const parked: Array<Promise<CallResult>> = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const client = await withTimeout(connect(i), 5_000, `第 ${i + 1} 个客户端连接`);
        parked.push(withTimeout(invokeOn(client, i), 15_000, `第 ${i + 1} 个调用`));
      }
      expect(await waitFor(() => mock.calls() === 4)).toBe(true);
      const fifth = await withTimeout(connect(4), 5_000, '第 5 个客户端连接');
      const result = await withTimeout(invokeOn(fifth, 4), 5_000, '第 5 个调用完成');
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('done:p4');
      expect(mock.calls()).toBe(5);
    } finally {
      mock.release();
      await withTimeout(Promise.allSettled(parked), 5_000, '清理挂起调用').catch(() => undefined);
      for (const client of clients) {
        await withTimeout(client.close(), 2_000, 'client.close').catch(() => undefined);
      }
    }
  }, 15_000);
});
