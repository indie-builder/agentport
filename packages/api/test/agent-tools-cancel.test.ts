import { fileURLToPath } from 'node:url';
import { createDb } from '@agentport/db';
import { Client } from '@modelcontextprotocol/client';
import { type CallToolResult, InMemoryTransport } from '@modelcontextprotocol/server';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvoker } from '../src/features/servers/agent-invoker.js';
import { buildAgentServer } from '../src/features/servers/agent-tools.js';

// 固定的一次性库：只验证 invoke 的取消路径，不读其他用例数据。
const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const ISOLATED_DB_NAME = 'agentport_capability_test_20261022';
const ISOLATED_DATABASE_URL = (() => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${ISOLATED_DB_NAME}`;
  return url.toString();
})();
process.env.DATABASE_URL = ISOLATED_DATABASE_URL;

async function prepareIsolatedDatabase(): Promise<boolean> {
  try {
    const admin = createDb(ADMIN_DATABASE_URL);
    try {
      await admin.pool.query(`create database "${ISOLATED_DB_NAME}"`);
    } catch (error) {
      // 42P04：并发重试已创建，复用即可。
      if ((error as { code?: string }).code !== '42P04') throw error;
    } finally {
      await admin.pool.end();
    }
    const target = createDb(ISOLATED_DATABASE_URL);
    try {
      await migrate(target.db, {
        migrationsFolder: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
      });
    } finally {
      await target.pool.end();
    }
    return true;
  } catch {
    return false;
  }
}

const isolated = await prepareIsolatedDatabase();
// helpers 在模块求值时读取 DATABASE_URL，必须等库准备好再加载。
const helpers = await import('./helpers.js');
const { cleanup, createAgent, loginCookie, startApp, unique, waitFor } = helpers;
const ready = await helpers.infraReady;

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
    await cleanup(app, { agentSlugs: createdAgents, runIds });
    await app.close();
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
