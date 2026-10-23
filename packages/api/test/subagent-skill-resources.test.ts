import type { Agent, Skill, WorkspaceFiles } from '@agentport/shared';
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

describe.skipIf(!ready)('subagent skill resources in workspace previews', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const skillSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, skillSlugs });
    await app.close();
  });

  it('includes child-only resources while enabled and retains resources with a root binding', async () => {
    const slug = unique('child-resource');
    skillSlugs.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: {
        slug,
        name: 'API reference skill',
        description: 'Uses its bundled API reference',
        body: 'Consult references/api.md before calling the API.',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const skill = created.json<Skill>();
    const resource = { path: 'references/api.md', content: '# API reference\r\nGET /widgets\r\n' };
    const written = await inject(app, {
      method: 'PUT',
      url: `/api/skills/${skill.id}/files/${resource.path}`,
      headers: { cookie },
      payload: { content: resource.content },
    });
    expect(written.statusCode, written.body).toBe(200);

    const child = (
      await createAgent(app, cookie, { skillIds: [skill.id], track: agentSlugs })
    ).json<Agent>();
    const parent = (
      await createAgent(app, cookie, {
        skillIds: [],
        subAgentIds: [child.id],
        track: agentSlugs,
      })
    ).json<Agent>();
    const preview = async () => {
      const response = await inject(app, {
        method: 'GET',
        url: `/api/agents/${parent.id}/files`,
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<WorkspaceFiles>();
    };

    const files = await preview();
    expect(files.skills).toEqual([
      {
        slug,
        content: [
          '---',
          `name: "${slug}"`,
          'description: "Uses its bundled API reference"',
          '---',
          '',
          '# API reference skill',
          '',
          'Consult references/api.md before calling the API.',
          '',
        ].join('\n'),
        files: [resource],
      },
    ]);
    expect(files.subAgents).toHaveLength(1);
    expect(files.subAgents[0]?.content).toContain(`skills: ["${slug}"]`);
    expect(files.agentMd).not.toContain(`skills: ["${slug}"]`);
    expect(files.claudeMd).not.toContain(`\`${slug}\``);

    // 根和子同时绑定时只渲染一份；根绑定不能因子智能体停用而丢失资源。
    const bound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: { cookie },
      payload: { skillIds: [skill.id] },
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect((await preview()).skills).toEqual(files.skills);

    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${child.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const rootOnly = await preview();
    expect(rootOnly.skills).toEqual(files.skills);
    expect(rootOnly.subAgents).toEqual([]);

    const unbound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parent.id}`,
      headers: { cookie },
      payload: { skillIds: [] },
    });
    expect(unbound.statusCode, unbound.body).toBe(200);
    const omitted = await preview();
    expect(omitted.skills).toEqual([]);
    expect(omitted.subAgents).toEqual([]);
  });
});
