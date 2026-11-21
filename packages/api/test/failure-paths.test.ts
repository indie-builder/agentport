import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Agent, Server } from '@agentport/shared';
import { runCancelKey, runStreamKey } from '@agentport/shared';
import { RedisClient } from 'bun';
import { getQueue, publishRun } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  createServer,
  eventFollowerCount,
  expectProblem,
  infraReady,
  loginCookie,
  queueIdle,
  request,
  seedRun,
  startApp,
  type TestApp,
  testConfig,
  unique,
  waitFor,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;
const idle = await queueIdle;

describe.skipIf(!(ready && idle))('failure paths', () => {
  let app: TestApp;
  let server: TestServer;
  let cookie: string;
  let baseUrl: string;
  let redis: RedisClient;
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const skillSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    server = await listen(app);
    baseUrl = server.url;
    redis = new RedisClient(testConfig().REDIS_URL);
  });

  afterAll(async () => {
    await server.close();
    for (const runId of runIds) {
      await getQueue()
        .remove(runId)
        .catch(() => undefined);
      await redis.del(runStreamKey(runId), runCancelKey(runId)).catch(() => undefined);
    }
    await cleanup(app, { serverNames, agentSlugs, skillSlugs, runIds });
    redis.close();
    await app.close();
  });

  const auth = () => ({ cookie });

  const newAgent = async (serverIds: string[] = []): Promise<Agent> =>
    (
      await createAgent(app, cookie, {
        slug: unique('fail-agent'),
        serverIds,
        track: agentSlugs,
      })
    ).json<Agent>();

  const createGeneratedServer = (baseUrlValue = 'https://example.com'): Promise<Server> =>
    createServer(app, cookie, {
      name: unique('fail-srv'),
      baseUrl: baseUrlValue,
      track: serverNames,
    });

  const createRun = async (agent: Agent, message = 'hello'): Promise<string> => {
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message },
    });
    expect(res.statusCode).toBe(202);
    return res.json<{ runId: string }>().runId;
  };

  const runCount = async (agentId: string): Promise<number> => {
    const res = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_runs where agent_id = $1',
      [agentId],
    );
    return res[0]?.count ?? 0;
  };

  const openSse = async (
    runId: string,
  ): Promise<{
    abort: () => Promise<void>;
    next: () => Promise<string>;
    keepAlive: () => Promise<void>;
  }> => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/chat/${runId}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    await reader.read();
    return {
      abort: async () => {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      },
      next: async () => {
        const chunk = await Promise.race([reader.read(), delay(5_000).then(() => null)]);
        return chunk && !chunk.done ? decoder.decode(chunk.value) : '';
      },
      // 保持读取循环：某些 Node 版本会在无消费者时回收 fetch body，
      // 服务端随后收到 close，表现为「另一个客户端莫名断线」。
      keepAlive: async () => {
        try {
          await reader.read();
        } catch {}
      },
    };
  };

  it('releases the SSE subscription when the client aborts early', async () => {
    const agent = await newAgent();
    const runId = await createRun(agent, 'abort me');
    runIds.push(runId);

    for (const abortAfterMs of [0, 2, 4, 6, 8]) {
      for (let i = 0; i < 10; i += 1) {
        const controller = new AbortController();
        const res = await fetch(`${baseUrl}/api/chat/${runId}/events`, {
          headers: { cookie },
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        if (abortAfterMs > 0) await delay(abortAfterMs);
        controller.abort();
        await res.body?.cancel().catch(() => undefined);
        await delay(20);
      }
    }

    expect(await waitFor(async () => (await eventFollowerCount(redis, runId)) === 0)).toBe(true);
    const health = await request(app, { method: 'GET', url: '/health/live' });
    expect(health.statusCode).toBe(200);
  });

  it('keeps other SSE clients subscribed when one aborts', async () => {
    const agent = await newAgent();
    const runId = await createRun(agent, 'shared channel');
    runIds.push(runId);

    const first = await openSse(runId);
    const second = await openSse(runId);
    expect(await waitFor(async () => (await eventFollowerCount(redis, runId)) === 2)).toBe(true);

    await first.abort();
    await delay(300);
    expect(await eventFollowerCount(redis, runId)).toBe(1);

    await publishRun(runId, { type: 'text_delta', text: 'still-here' });
    let received = '';
    for (let i = 0; i < 6 && !received.includes('still-here'); i += 1) {
      received += await second.next();
    }
    expect(received).toContain('still-here');
    await second.abort();
    expect(await waitFor(async () => (await eventFollowerCount(redis, runId)) === 0)).toBe(true);
  });

  it('returns 404 for a missing run on events, cancel and approve', async () => {
    const events = await request(app, {
      method: 'GET',
      url: '/api/chat/run_missing/events',
      headers: auth(),
    });
    expectProblem(events, 'NOT_FOUND', 'run');

    const cancel = await request(app, {
      method: 'POST',
      url: '/api/chat/run_missing/cancel',
      headers: auth(),
    });
    expectProblem(cancel, 'NOT_FOUND', 'run');

    const approve = await request(app, {
      method: 'POST',
      url: '/api/runs/run_missing/approve',
      headers: auth(),
      payload: { approvalId: 'approval-missing' },
    });
    expectProblem(approve, 'NOT_FOUND', 'run');
  });

  it('enqueueing the same jobId twice does not create a second run', async () => {
    const agent = await newAgent();
    const created = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'only once' },
    });
    expect(created.statusCode).toBe(202);
    const { runId, conversationId } = created.json<{ runId: string; conversationId: string }>();
    runIds.push(runId);
    expect(await runCount(agent.id)).toBe(1);

    const payload = {
      runId,
      agentId: agent.id,
      conversationId,
      prompt: 'only once',
    };
    const [first, second] = await Promise.all([
      getQueue().add('run', payload, { jobId: runId }),
      getQueue().add('run', payload, { jobId: runId }),
    ]);
    expect(first.id).toBe(runId);
    expect(second.id).toBe(runId);
    expect(await runCount(agent.id)).toBe(1);

    const stored = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from agent_runs where conversation_id = $1',
      [conversationId],
    );
    expect(stored[0]?.count).toBe(1);
  });

  it('rejects malformed JSON on /api/chat and /api/servers with 400', async () => {
    for (const url of ['/api/chat', '/api/servers']) {
      const res = await request(app, {
        method: 'POST',
        url,
        headers: { ...auth(), 'content-type': 'application/json' },
        payload: '{"agentId": "agt_x", ',
      });
      expect(res.statusCode, url).toBe(400);
      expect(res.statusCode, url).not.toBe(500);
    }
  });

  it('rejects a prompt larger than 64KB with 400 and creates no run', async () => {
    const agent = await newAgent();
    const res = await request(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'x'.repeat(64 * 1024 + 1) },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect(await runCount(agent.id)).toBe(0);
  });

  it('returns 401/401/404 for missing token, wrong token and unknown MCP server id', async () => {
    const server = await createGeneratedServer();

    const missing = await request(app, { method: 'POST', url: `/mcp/${server.id}` });
    expectProblem(missing, 'UNAUTHORIZED');

    const wrong = await request(app, {
      method: 'POST',
      url: `/mcp/${server.id}`,
      headers: { authorization: 'Bearer definitely-wrong' },
    });
    expect(wrong.statusCode).toBe(401);

    const tokenRes = await app.client.unsafe<{ token: string }[]>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    const token = tokenRes[0]?.token ?? '';
    expect(token).not.toBe('');

    const unknown = await request(app, {
      method: 'POST',
      url: '/mcp/srv_missing',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rejects approving a request that does not exist', async () => {
    const server = await createGeneratedServer();
    const toolName = 'needs-approval';
    const tool = await request(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: auth(),
      payload: {
        name: toolName,
        method: 'GET',
        pathTemplate: '/users/{id}',
        paramsIn: 'query',
        approvalMode: 'ask',
      },
    });
    expect(tool.statusCode).toBe(201);

    const agent = await newAgent([server.id]);
    const { runId } = await seedRun(app, agent.id, { runId: unique('fail-run') });
    runIds.push(runId);

    const unknown = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: auth(),
      payload: { approvalId: 'approval-missing' },
    });
    expectProblem(unknown, 'NOT_FOUND', 'approval');

    const unchanged = await app.client.unsafe<{ count: number }[]>(
      'select count(*)::int as count from approval_requests where run_id = $1',
      [runId],
    );
    expect(unchanged[0]?.count).toBe(0);

    const approvalId = unique('apr');
    await app.client.unsafe(
      'insert into approval_requests (id, run_id, server_id, tool_name) values ($1, $2, $3, $4)',
      [approvalId, runId, server.id, toolName],
    );
    const legacy = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: auth(),
      payload: { approvalId },
    });
    expectProblem(legacy, 'CONFLICT');
    const other = await seedRun(app, agent.id);
    runIds.push(other.runId);
    const crossRun = await request(app, {
      method: 'POST',
      url: `/api/runs/${other.runId}/approve`,
      headers: auth(),
      payload: { approvalId },
    });
    expectProblem(crossRun, 'NOT_FOUND', 'approval');
  });

  it('returns 409 for a duplicate skill slug instead of 500', async () => {
    const slug = unique('fail-skill');
    skillSlugs.push(slug);
    const payload = { slug, name: 'Failure skill', description: 'dup check', body: '' };

    const first = await request(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await request(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload,
    });
    expectProblem(second, 'CONFLICT');
  });
});
