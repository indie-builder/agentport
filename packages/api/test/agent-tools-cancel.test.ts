import { Client } from '@modelcontextprotocol/client';
import { type CallToolResult, InMemoryTransport } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { createInvoker } from '../src/features/servers/agent-invoker.js';
import { buildAgentServer } from '../src/features/servers/agent-tools.js';

// 每次运行建独立库：只验证 invoke 的取消路径，也能并跑多条回归。
const isolated = await createIsolatedDatabase(
  'api_agent_tools_cancel',
  process.env.DATABASE_URL ?? '',
);
if (isolated) process.env.DATABASE_URL = isolated.url;

// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { cleanup, createAgent, loginCookie, startApp, unique, waitFor } = helpers;
const ready = await helpers.infraReady;
// skipIf 的 describe 不跑 hook；Redis 缺失时这里回收自己刚建的库。
if (!ready && isolated) await isolated.close();

describe.skipIf(!(ready && isolated))('platform agent tools: cancellation', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) {
        try {
          await cleanup(app, { agentSlugs: createdAgents, runIds });
        } finally {
          await app.close();
        }
      }
    } finally {
      await isolated?.close();
    }
  });

  it('passes the MCP request abort signal to the invoker', async () => {
    let seen: AbortSignal | undefined;
    const invoker = {
      async invoke(input: { prompt: string; signal?: AbortSignal }) {
        seen = input.signal;
        return `done:${input.prompt}`;
      },
    };
    const server = buildAgentServer(
      [{ slug: 'demo-agent', name: 'Demo', description: '' }],
      invoker,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cancel-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: 'run_demo-agent',
        arguments: { prompt: 'hi' },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('done:hi');
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen?.aborted).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the prompt-required error before the invoker is called', async () => {
    let calls = 0;
    const invoker = {
      async invoke() {
        calls += 1;
        return 'never';
      },
    };
    const server = buildAgentServer(
      [{ slug: 'demo-agent', name: 'Demo', description: '' }],
      invoker,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cancel-test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: 'run_demo-agent',
        arguments: { prompt: '' },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('prompt is required');
      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not create a run when the signal is already aborted', async () => {
    const slug = unique('cancel-agent');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const invoker = createInvoker(app);

    await expect(
      invoker.invoke({
        slug,
        prompt: 'should not start',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/cancelled/);

    const runs = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from agent_runs where agent_id = $1',
      [agent.id],
    );
    expect(runs.rows[0]?.count).toBe(0);
    const conversations = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from conversations where agent_id = $1',
      [agent.id],
    );
    expect(conversations.rows[0]?.count).toBe(0);
  });

  it('cancels the queued run when the signal aborts during polling', async () => {
    const slug = unique('cancel-agent');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<{
      id: string;
    }>();
    const invoker = createInvoker(app);
    const controller = new AbortController();

    const pending = invoker.invoke({ slug, prompt: 'cancel me', signal: controller.signal });
    const created = await waitFor(async () => {
      const rows = await app.pool.query<{ id: string }>(
        'select id from agent_runs where agent_id = $1',
        [agent.id],
      );
      const id = rows.rows[0]?.id;
      if (id === undefined) return false;
      runIds.push(id);
      return true;
    });
    expect(created).toBe(true);
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
    const runId = runIds.at(-1) ?? '';
    const run = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    expect(run.rows[0]?.status).toBe('cancelled');
    const { getQueue } = await import('../src/queue/producer.js');
    expect(await getQueue().getJob(runId)).toBeUndefined();
  });
});
