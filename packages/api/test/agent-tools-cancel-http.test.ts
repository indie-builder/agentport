import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId, repo } from '@agentport/db';
import { runEnqueueOptions } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import type { AgentInvoker } from '../src/modules/servers/agent-tools.js';
import { registerServersHttp } from '../src/modules/servers/http.js';
import { getQueue } from '../src/queue/producer.js';
import type { AppRuntime } from '../src/types.js';
import { contextApp } from './hono-app.js';
import { listen, type TestServer } from './server.js';

const isolated = await createIsolatedDatabase(
  'api_agent_tools_cancel_http',
  process.env.DATABASE_URL ?? '',
);
if (isolated) process.env.DATABASE_URL = isolated.url;

const helpers = await import('./helpers.js');
const { cleanup, createAgent, loginCookie, startApp, unique, waitFor } = helpers;
const ready = await helpers.infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

const PLATFORM_TOKEN = 'cancel-platform-token-0123456789';
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

interface Call {
  signal: AbortSignal;
  runId: string;
  prompt: string;
}

function stubInvoker(app: { db: AppRuntime['db'] }, agentId: string) {
  const calls: Call[] = [];
  const pending = new Set<() => void>();
  const invoker: AgentInvoker = {
    async invoke({ prompt, signal }) {
      if (signal === undefined) throw new Error('invoker did not receive a signal');
      const conversation = await repo.chat.createConversation(app.db, {
        id: newId('conversation'),
        agentId,
        title: `stub: ${prompt}`,
        subject: { kind: 'service', serviceId: 'mcp' },
      });
      const run = await repo.chat.createRun(app.db, {
        id: newId('run'),
        conversationId: conversation.id,
        agentId,
        subject: { kind: 'service', serviceId: 'mcp' },
      });
      await getQueue().add(
        'run',
        { runId: run.id, agentId, conversationId: conversation.id, prompt },
        runEnqueueOptions(run.id),
      );
      calls.push({ signal, runId: run.id, prompt });
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          void (async () => {
            await repo.chat.cancelRun(app.db, run.id);
            const job = await getQueue()
              .getJob(run.id)
              .catch(() => undefined);
            await job?.remove().catch(() => undefined);
            reject(new Error('agent run cancelled'));
          })();
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        pending.add(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return `done:${prompt}`;
    },
  };
  return {
    invoker,
    calls,
    releaseAll: () => {
      for (const release of pending) release();
    },
  };
}

describe.skipIf(!(ready && isolated))('platform MCP over real HTTP: cancellation', () => {
  let app: AppRuntime;
  let platform: TestServer;
  let cookie: string;
  let toolName: string;
  let agentId: string;
  let platformUrl: string;
  let stub: ReturnType<typeof stubInvoker>;
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  const connect = async (name: string): Promise<Client> => {
    const client = new Client({ name, version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(platformUrl), {
        requestInit: { headers: { authorization: `Bearer ${PLATFORM_TOKEN}` } },
      }),
    );
    return client;
  };
  const runStatus = async (runId: string): Promise<string | undefined> => {
    const rows = await app.client.unsafe<{ status: string }[]>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    return rows[0]?.status;
  };
  const nextCall = async (): Promise<Call> => {
    const index = stub.calls.length;
    expect(await waitFor(() => stub.calls.length > index, 5_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const call = stub.calls[index];
    if (!call) throw new Error('stub never received a call');
    return call;
  };

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    const slug = unique('cancel-http-agent');
    toolName = `run_${slug.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}`;
    agentId = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>().id;

    stub = stubInvoker(app, agentId);
    const platformApp = contextApp(app);
    registerServersHttp(platformApp as never, {
      db: app.db,
      client: app.client,
      config: app.config,
      log: app.log,
      auth: app.auth,
      invoker: stub.invoker,
    });
    platform = await listen({ app: platformApp as never });
    platformUrl = `${platform.url}/mcp`;
  });

  afterAll(async () => {
    if (!app) {
      await isolated?.close();
      return;
    }
    try {
      stub.releaseAll();
      runIds.push(...stub.calls.map((call) => call.runId));
      for (const runId of runIds) {
        await repo.chat.cancelRun(app.db, runId).catch(() => undefined);
        const job = await getQueue()
          .getJob(runId)
          .catch(() => undefined);
        await job?.remove().catch(() => undefined);
      }
      await cleanup(app, { agentSlugs: createdAgents, runIds });
    } finally {
      try {
        if (platform) await platform.close();
      } finally {
        try {
          if (app) await app.close();
        } finally {
          await isolated?.close();
        }
      }
    }
  });

  it('aborts the running invoke and cancels its run when the client disconnects', async () => {
    const client = await connect('cancel-disconnect-client');
    const pending = client.callTool({ name: toolName, arguments: { prompt: 'disconnect me' } });
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    try {
      const call = await nextCall();
      expect(call.signal.aborted).toBe(false);
      expect(await getQueue().getJob(call.runId)).toBeDefined();

      await withTimeout(client.close(), 5_000, 'client.close');

      expect(await withTimeout(settled, 5_000, '断开后结算')).toBe('rejected');
      expect(await waitFor(() => call.signal.aborted, 5_000)).toBe(true);
      expect(
        await waitFor(async () => (await getQueue().getJob(call.runId)) === undefined, 5_000),
      ).toBe(true);
      expect(await runStatus(call.runId)).toBe('cancelled');
    } finally {
      await withTimeout(client.close(), 5_000, 'client.close 兜底').catch(() => undefined);
    }
  }, 15_000);

  /**
   * 2025 协议下客户端 abort 只会另发一条 notifications/cancelled POST；
   * 平台端点用 stateless legacy serving，每个 POST 是独立实例，
   * 这条通知没有对应的 in-flight 请求可中止，因此服务端 signal 不会 abort。
   * 这是 SDK 时代的限制，不是本端点的缺陷；真正的取消路径是连接断开。
   */
  it('rejects the call locally on abort, but a 2025-era cancellation notification reaches no instance', async () => {
    const client = await connect('cancel-abort-client');
    const controller = new AbortController();
    const pending = client.callTool(
      { name: toolName, arguments: { prompt: 'cancel me' } },
      { signal: controller.signal },
    );
    const settled = pending.then(
      () => 'resolved',
      () => 'rejected',
    );
    try {
      const call = await nextCall();
      controller.abort();
      expect(await withTimeout(settled, 5_000, '客户端中止后结算')).toBe('rejected');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(call.signal.aborted).toBe(false);
      expect(await runStatus(call.runId)).toBe('queued');
      expect(await getQueue().getJob(call.runId)).toBeDefined();
    } finally {
      await withTimeout(client.close(), 5_000, 'client.close').catch(() => undefined);
    }
  }, 15_000);

  it('keeps the signal live and returns the result when no cancellation happens', async () => {
    const client = await connect('cancel-normal-client');
    const pending = client.callTool({ name: toolName, arguments: { prompt: 'keep going' } });
    try {
      const call = await nextCall();
      expect(call.prompt).toBe('keep going');
      expect(call.signal.aborted).toBe(false);
      stub.releaseAll();
      const result = await withTimeout(pending, 5_000, '正常调用');
      expect(JSON.stringify(result.content)).toContain('done:keep going');
      expect(result.isError).toBeFalsy();
    } finally {
      await withTimeout(client.close(), 5_000, 'client.close').catch(() => undefined);
    }
  }, 15_000);
});
