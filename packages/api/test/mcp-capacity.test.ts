import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** 平台端点在注册时直接读 process.env，必须先于 buildApp 设置。 */
const PLATFORM_TOKEN = 'capacity-platform-token-0123456789';
process.env.PLATFORM_MCP_TOKEN = PLATFORM_TOKEN;

/** 失败路径也要在有限时间内返回：旧实现会把第 5 个客户端卡死，不能等 vitest 20s 兜底。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // 超时后原 promise 可能才真正失败：先挂一个 catch，避免它变成 unhandled rejection。
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

/**
 * 旧实现在端点入口用 pLimit(4) 包住整个 MCP 会话：4 个 invoke 挂住后，第 5 个请求
 * 连 initialize 都进不来。这里的前 4 次调用一直占着 invoker，直到用例放行。
 */
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

describe.skipIf(!ready)('MCP capacity: suspended approvals must not block execution', () => {
  let app: AppRuntime;
  let listener: TestServer;
  let cookie: string;
  let mcpUrl: string;
  let server: Server;
  let token: string;
  const createdServers: string[] = [];
  const createdAgents: string[] = [];
  const runIds: string[] = [];
  const upstreamCalls = { count: 0 };
  const upstream = { close: () => undefined };

  beforeAll(async () => {
    // 等待窗口必须足够长：旧实现下 4 个挂起调用会一直占住整个 MCP 并发名额。
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

    const row = await app.client.unsafe<{ token: string }[]>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    token = row[0]?.token ?? '';
    expect(token).not.toBe('');
  });

  afterAll(async () => {
    upstream.close();
    if (!app) return;
    await cleanup(app, { serverNames: createdServers, agentSlugs: createdAgents, runIds });
    await listener?.close();
    await app.close();
  });

  it('runs a free call while 4 approval waits are parked, and refuses the 5th wait immediately', async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('capacity-agent'),
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<{ id: string }>();

    const runIdsForAgent: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { runId } = await seedRun(app, agent.id, { runId: unique(`capacity-run-${i}`) });
      runIds.push(runId);
      runIdsForAgent.push(runId);
    }

    const clients: Client[] = [];
    const pending: Array<Promise<CallResult>> = [];
    const connect = async (runId: string): Promise<Client> => {
      const client = new Client({ name: 'capacity-test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp/${server.id}`), {
          requestInit: {
            headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
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
      // 前 4 个真实 run 各挂起一次审批等待。
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

      // 4 条审批记录都已落库，说明前 4 个调用真的进了挂起路径（waiting 见 generated-mcp 用例）。
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

      // 第 5 个 run：连接、列工具、免费调用都必须不受 4 个挂起影响。
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

      // 第 5 个等待名额已满：立即拒绝（同一路径的原有立即拒绝语义），不排队等 10s。
      const started = Date.now();
      const refused = await withTimeout(
        fifth.callTool({ name: 'waiting-tool', arguments: {} }) as Promise<CallResult>,
        5_000,
        '第 5 次等待',
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('需要批准：waiting-tool');

      // 拒绝也要落审批记录，但没有等待窗口：expiresAt 为 null，页面不显示倒计时。
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
      expect(refusedRow).toMatchObject({ expiresAt: null, waiting: false });
    } finally {
      // 结束本用例自己的 run，让挂起的调用立刻以取消结束，再收客户端。
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
    // cleanup 只按 slug 删 agent；audit_log.target 存的是 id，一并删掉自己的行。
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
      // 4 次 invoke 真的进了挂起分支：旧实现下后续请求会卡在这里。
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
