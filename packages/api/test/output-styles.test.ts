import type { Agent, OutputStyle } from '@agentport/shared';
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

describe.skipIf(!ready)('output styles', () => {
  let app: FastifyInstance;
  let cookie: string;
  let agent: Agent;
  const createdAgents: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    const res = await createAgent(app, cookie, { track: createdAgents });
    agent = res.json<Agent>();
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    await app.close();
  });

  const auth = () => ({ cookie });
  const write = (slug: string, body: string) =>
    inject(app, {
      method: 'PUT',
      url: `/api/agents/${agent.id}/output-styles/${slug}`,
      headers: auth(),
      payload: { description: `${slug} style`, body },
    });
  const list = () =>
    inject(app, { method: 'GET', url: `/api/agents/${agent.id}/output-styles`, headers: auth() });

  it('writes a style and lists it as selected', async () => {
    const res = await write('concise', 'Answer in one sentence.');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<OutputStyle>()).toMatchObject({ slug: 'concise', isSelected: true });

    const rows = (await list()).json<OutputStyle[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'concise', isSelected: true });
  });

  it('selects only the latest written style', async () => {
    await write('verbose', 'Explain everything.');
    const rows = (await list()).json<OutputStyle[]>();
    expect(rows.filter((row) => row.isSelected).map((row) => row.slug)).toEqual(['verbose']);
  });

  it('deletes a style', async () => {
    const res = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}/output-styles/concise`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    const rows = (await list()).json<OutputStyle[]>();
    expect(rows.map((row) => row.slug)).toEqual(['verbose']);
  });

  it('serializes concurrent saves to a single selected style', async () => {
    const [a, b] = await Promise.all([
      write('concurrent-a', 'Style A.'),
      write('concurrent-b', 'Style B.'),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);

    const rows = (await list()).json<OutputStyle[]>();
    expect(rows.filter((row) => row.isSelected)).toHaveLength(1);
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${unique('missing')}/output-styles`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
