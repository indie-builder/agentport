import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('chat', () => {
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

  const auth = () => ({ cookie });

  const createAgent = async (): Promise<Agent> => {
    const slug = unique('chat-agent');
    createdAgents.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Chat ${slug}`, systemPrompt: 'be brief' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Agent>();
  };

  it('POST /api/chat creates a run and returns 202', async () => {
    const agent = await createAgent();
    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'hello there' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ runId: string; conversationId: string }>();
    expect(body.runId.startsWith('run_')).toBe(true);
    expect(body.conversationId.startsWith('conv_')).toBe(true);
    runIds.push(body.runId);

    const conversation = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${body.conversationId}`,
      headers: auth(),
    });
    expect(conversation.statusCode).toBe(200);
    const detail = conversation.json<{ messages: Array<{ role: string }> }>();
    expect(detail.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('POST /api/chat returns 404 for an unknown agent', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: 'agt_missing', message: 'hi' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('GET /api/chat/:runId/events returns 404 for an unknown run', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/chat/run_missing/events',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('cancel is idempotent for an already terminal run', async () => {
    const agent = await createAgent();
    const created = await inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: auth(),
      payload: { agentId: agent.id, message: 'will be cancelled' },
    });
    const { runId } = created.json<{ runId: string }>();
    runIds.push(runId);
    await app.pool.query(
      "update agent_runs set status = 'cancelled', ended_at = now() where id = $1",
      [runId],
    );

    for (let i = 0; i < 2; i += 1) {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/chat/${runId}/cancel`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
    }

    const row = await app.pool.query<{ status: string }>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    expect(row.rows[0]?.status).toBe('cancelled');
  });
});
