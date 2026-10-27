import type { AddressInfo } from 'node:net';
import { newId, repo } from '@agentport/db';
import { runEnqueueOptions } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import type { AgentInvoker } from '../src/features/servers/agent-tools.js';
import { registerAgentToolsEndpoint } from '../src/features/servers/agent-tools-endpoint.js';
import { getQueue } from '../src/queue/producer.js';

// 每次运行建独立库：只验证取消路径，也能并跑多条回归。
const isolated = await createIsolatedDatabase(
  'api_agent_tools_cancel_http',
  process.env.DATABASE_URL ?? '',
);
if (isolated) process.env.DATABASE_URL = isolated.url;

// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { cleanup, createAgent, loginCookie, startApp, unique, waitFor } = helpers;
const ready = await helpers.infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

/** 平台端点在注册时直接读 process.env，必须先于 buildApp 设置。 */
const PLATFORM_TOKEN = 'cancel-platform-token-0123456789';
process.env.PLATFORM_MCP_TOKEN = PLATFORM_TOKEN;

/** 任何挂起都必须有界，不能等 vitest 20s 兜底。 */
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

/**
 * 桩执行器照真实 invoker 的语义落 run、入队，然后挂起；
 * 收到中止就取消 run、清掉队列 job 再抛错。
 * 端点的责任只是把客户端的 signal 传到这里。
 */
function stubInvoker(app: FastifyInstance, agentId: string) {
  const calls: Call[] = [];
  const pending = new Set<() => void>();
  const invoker: AgentInvoker = {
    async invoke({ prompt, signal }) {
      if (signal === undefined) throw new Error('invoker did not receive a signal');
      const conversation = await repo.chat.createConversation(app.db, {
        id: newId('conversation'),
        agentId,
        title: `stub: ${prompt}`,
      });
      const run = await repo.chat.createRun(app.db, {
        id: newId('run'),
        conversationId: conversation.id,
        agentId,
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
        // 非取消路径由用例显式放行，避免断言依赖真实 worker。
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
  let app: FastifyInstance;
  let platform: FastifyInstance;
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
    const rows = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    return rows.rows[0]?.status;
  };
  /** 等下一次 invoke 真的进到桩里；只按总数等待会拿到上一个用例的调用。 */
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

    // 独立 Fastify：端点只依赖 PLATFORM_MCP_TOKEN 与 app.db，不需要认证/cookie 链路。
    stub = stubInvoker(app, agentId);
    platform = Fastify({ logger: false });
    platform.decorate('db', app.db);
    registerAgentToolsEndpoint(platform, stub.invoker);
    await platform.listen({ port: 0, host: '127.0.0.1' });
    platformUrl = `http://127.0.0.1:${(platform.server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
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

      // HTTP 断开 → toNodeHandler 中止 fetch → ctx.mcpReq.signal 中止。
      expect(await withTimeout(settled, 5_000, '断开后结算')).toBe('rejected');
      expect(await waitFor(() => call.signal.aborted, 5_000)).toBe(true);
      expect(await waitFor(async () => (await runStatus(call.runId)) === 'cancelled')).toBe(true);
      expect(await getQueue().getJob(call.runId)).toBeUndefined();
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
      // 给取消通知留出送达时间，再确认它确实没有落到正在执行的那个实例上。
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
