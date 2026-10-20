import type { Agent, Skill, SkillWithAgentCount } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('skills', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents });
    if (createdSkills.length > 0) {
      await app.pool.query('delete from skills where slug = any($1::text[])', [createdSkills]);
    }
    await app.close();
  });

  const auth = () => ({ cookie });

  const createSkill = async (slug: string): Promise<Skill> => {
    createdSkills.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { slug, name: `Skill ${slug}`, description: 'agentCount test', body: '' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Skill>();
  };

  const createAgent = async (skillIds: string[]): Promise<Agent> => {
    const slug = unique('count-agent');
    createdAgents.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Agent ${slug}`, skillIds },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Agent>();
  };

  it('lists skills with the number of agents using them', async () => {
    const shared = await createSkill(unique('count-shared'));
    const unused = await createSkill(unique('count-unused'));
    await createAgent([shared.id]);
    await createAgent([shared.id]);

    const res = await inject(app, { method: 'GET', url: '/api/skills', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<SkillWithAgentCount[]>();

    expect(body.find((skill) => skill.id === shared.id)?.agentCount).toBe(2);
    expect(body.find((skill) => skill.id === unused.id)?.agentCount).toBe(0);
  });
});
