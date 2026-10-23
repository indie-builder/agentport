import type { Agent, RunListItem } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('run agent version pin', () => {
  let app: FastifyInstance;
  let cookie: string;
  let runId: string;
  let agentId: string;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    const agent = (await createAgent(app, cookie, { track: agentSlugs })).json<Agent>();
    agentId = agent.id;

    const conversationId = unique('version-pin-conv');
    runId = unique('version-pin-run');
    runIds.push(runId);
    await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
      conversationId,
      agent.id,
    ]);
    await app.pool.query(
      `insert into agent_runs (id, conversation_id, agent_id, status, agent_version)
       values ($1, $2, $3, 'succeeded', 3)`,
      [runId, conversationId, agent.id],
    );
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, runIds });
    await app.close();
  });

  it('returns the pinned version in the run list', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/runs?agentId=${encodeURIComponent(agentId)}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = res
      .json<{ items: RunListItem[] }>()
      .items.find((candidate) => candidate.id === runId);
    expect(item?.agentVersion).toBe(3);
  });

  it('returns the pinned version in the run detail', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ run: RunListItem }>().run.agentVersion).toBe(3);
  });
});
