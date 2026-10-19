import type { Agent, Server, Skill } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  warnings: string[];
}

function exportFile(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    format: 'agentport/agent@1',
    exportedAt: new Date().toISOString(),
    agent: { slug, name: `Imported ${slug}`, systemPrompt: 'You are imported.' },
    servers: [],
    skills: [],
    ...overrides,
  };
}

describe.skipIf(!ready)('import agents', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdServers: string[] = [];
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, serverNames: createdServers });
    if (createdSkills.length > 0) {
      await app.pool.query('delete from skills where slug = any($1::text[])', [createdSkills]);
    }
    await app.close();
  });

  const auth = () => ({ cookie });
  const importAgent = (payload: unknown) =>
    inject(app, { method: 'POST', url: '/api/import/agents', headers: auth(), payload });

  it('imports an agent and creates missing servers and skills', async () => {
    const slug = unique('imp');
    const serverName = unique('imp-srv');
    const skillSlug = unique('imp-skill');
    createdAgents.push(slug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const res = await importAgent(
      exportFile(slug, {
        agent: {
          slug,
          name: `Imported ${slug}`,
          systemPrompt: 'You are imported.',
          description: 'from a file',
        },
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            description: 'local tools',
            config: { command: 'npx', args: ['-y', 'some-mcp'] },
            secretKeys: [],
          },
        ],
        skills: [
          { slug: skillSlug, name: 'Imported Skill', description: 'does things', body: '# steps' },
        ],
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent).toMatchObject({
      slug,
      name: `Imported ${slug}`,
      description: 'from a file',
      model: 'claude-sonnet-5-5',
      maxTurns: 20,
      serverIds: [expect.any(String)],
      skillIds: [expect.any(String)],
    });
    expect(body.createdServers).toEqual([serverName]);
    expect(body.reusedServers).toEqual([]);
    expect(body.createdSkills).toEqual([skillSlug]);
    expect(body.warnings).toEqual([]);

    const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(agents.json<Agent[]>().some((agent) => agent.id === body.agent.id)).toBe(true);
  });

  it('reuses an existing server by name', async () => {
    const serverName = unique('imp-reuse');
    const slug = unique('imp-reuse');
    createdServers.push(serverName);
    createdAgents.push(slug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: serverName, kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        servers: [{ name: serverName, kind: 'http', config: { url: 'https://example.com/mcp' } }],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.createdServers).toEqual([]);
    expect(body.agent.serverIds).toEqual([created.json<Server>().id]);
  });

  it('refuses to reuse an existing server with a different kind', async () => {
    const serverName = unique('imp-kind');
    const slug = unique('imp-kind');
    createdServers.push(serverName);
    createdAgents.push(slug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: serverName, kind: 'stdio', command: 'node', args: [] },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        servers: [{ name: serverName, kind: 'http', config: { url: 'https://example.com/mcp' } }],
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an http server pointing at a private address', async () => {
    const res = await importAgent(
      exportFile(unique('imp-ssrf'), {
        servers: [
          { name: unique('imp-ssrf-srv'), kind: 'http', config: { url: 'http://10.0.0.1/mcp' } },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('renames a conflicting slug and explains it in warnings', async () => {
    const slug = unique('imp-dup');
    createdAgents.push(slug, `${slug}-2`);
    const first = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Existing ${slug}` },
    });
    expect(first.statusCode).toBe(201);

    const res = await importAgent(exportFile(slug));
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.slug).toBe(`${slug}-2`);
    expect(body.agent.name).toBe(`Imported ${slug}`);
    expect(body.warnings.some((warning) => warning.includes(`${slug}-2`))).toBe(true);
  });

  it('rejects a file with an unsupported format', async () => {
    const res = await importAgent({
      format: 'agentport/agent@2',
      agent: { slug: unique('imp-bad'), name: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('never writes secret values and warns about secret keys', async () => {
    const slug = unique('imp-secret');
    const serverName = unique('imp-secret-srv');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const res = await importAgent(
      exportFile(slug, {
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            config: { command: 'node', args: [] },
            secretKeys: ['API_KEY', 'TOKEN'],
          },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('API_KEY');
    expect(body.warnings[0]).toContain('TOKEN');

    // 导出文件里的 secretKeys 只用于提示：数据库里不能出现任何密钥列。
    const row = await app.pool.query<{ secrets_encrypted: string | null }>(
      'select secrets_encrypted from servers where name = $1',
      [serverName],
    );
    expect(row.rows[0]?.secrets_encrypted).toBeNull();

    const servers = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    const imported = servers.json<Server[]>().find((server) => server.name === serverName);
    expect(imported?.kind === 'stdio' ? imported.env : imported?.headers).toEqual({});
  });

  it('creates missing skills but does not duplicate existing ones', async () => {
    const slug = unique('imp-skill-reuse');
    const skillSlug = unique('imp-existing-skill');
    createdAgents.push(slug);
    createdSkills.push(skillSlug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { slug: skillSlug, name: 'Existing', description: 'already here' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        skills: [
          { slug: skillSlug, name: 'Existing', description: 'already here' },
          { slug: `${skillSlug}-new`, name: 'New', description: 'fresh' },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    createdSkills.push(`${skillSlug}-new`);
    expect(body.createdSkills).toEqual([`${skillSlug}-new`]);
    expect(body.agent.skillIds).toHaveLength(2);

    const skills = await inject(app, { method: 'GET', url: '/api/skills', headers: auth() });
    expect(skills.json<Skill[]>().filter((skill) => skill.slug === skillSlug)).toHaveLength(1);
  });
});
