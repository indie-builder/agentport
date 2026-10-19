import type { Agent, Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

interface WorkspaceFiles {
  mcpJson: string;
  claudeMd: string;
  agentMd: string;
  subAgents: Array<{ slug: string; content: string }>;
}

describe.skipIf(!ready)('agents', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdServers: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, serverNames: createdServers });
    await app.close();
  });

  const auth = () => ({ cookie });
  const createServer = async (name: string): Promise<Server> => {
    createdServers.push(name);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name, kind: 'generated', baseUrl: 'https://jsonplaceholder.typicode.com' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Server>();
  };

  const createAgent = async (slug: string, serverIds: string[] = []) => {
    createdAgents.push(slug);
    return inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Agent ${slug}`, systemPrompt: 'You are helpful.', serverIds },
    });
  };

  it('creates an agent with defaults', async () => {
    const res = await createAgent(unique('agent'));
    expect(res.statusCode).toBe(201);
    const body = res.json<Agent>();
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      maxTurns: 20,
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
      serverIds: [],
    });
    expect(body.id.startsWith('agt_')).toBe(true);
  });

  it('rejects a duplicate slug with 409', async () => {
    const slug = unique('dup');
    expect((await createAgent(slug)).statusCode).toBe(201);
    const res = await createAgent(slug);
    expect(res.statusCode).toBe(409);
  });

  it('PATCH updates fields and forbids slug changes', async () => {
    const slug = unique('patch');
    const agent = (await createAgent(slug)).json<Agent>();

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Renamed', systemPrompt: 'new prompt', maxTurns: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Agent>()).toMatchObject({
      name: 'Renamed',
      systemPrompt: 'new prompt',
      maxTurns: 7,
    });

    const slugChange = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { slug: unique('other') },
    });
    expect(slugChange.statusCode).toBe(400);
  });

  it('rejects a permissionMode the platform has not implemented', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug: unique('perms'), name: 'Perms', permissionMode: 'default' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('PATCH rejects a stale expectedUpdatedAt with 409', async () => {
    const agent = (await createAgent(unique('stale-agent'))).json<Agent>();

    const ok = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'First', expectedUpdatedAt: agent.updatedAt },
    });
    expect(ok.statusCode).toBe(200);

    const stale = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
      payload: { name: 'Second', expectedUpdatedAt: agent.updatedAt },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'CONFLICT_STALE' });
  });

  it('renders three workspace files with mcp tool wildcards', async () => {
    const server = await createServer(unique('files-srv'));
    const res = await createAgent(unique('files'), [server.id]);
    const agent = res.json<Agent>();

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files`,
      headers: auth(),
    });
    expect(files.statusCode).toBe(200);
    const body = files.json<WorkspaceFiles>();

    const mcp = JSON.parse(body.mcpJson) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers: Record<string, string>; _note?: string }
      >;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual([server.name]);
    expect(mcp.mcpServers[server.name]?.type).toBe('http');
    expect(mcp.mcpServers[server.name]?.url).toContain(`/mcp/${server.id}`);
    // 预览不返回明文 mcpToken：Authorization 省略，并注明运行时注入。
    expect(mcp.mcpServers[server.name]?.headers.Authorization).toBeUndefined();
    expect(mcp.mcpServers[server.name]?._note).toContain('运行时注入');

    // reveal=1 也不返回明文，只要求响应不被缓存。
    const reveal = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files?reveal=1`,
      headers: auth(),
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.headers['cache-control']).toBe('no-store');
    expect(reveal.body).not.toContain('Bearer ');
    expect(reveal.body).not.toContain('mcpToken');

    expect(body.claudeMd).toContain('You are helpful.');
    expect(body.claudeMd).toContain(`mcp__${server.name}__`);
    expect(body.agentMd).toContain(`name: "${agent.slug}"`);
    expect(body.agentMd).toContain(`"mcp__${server.name}__*"`);
    expect(body.agentMd).toContain('disallowedTools: ["Bash"');
  });

  it('returns 404 for unknown ids on get/patch/delete/files', async () => {
    const missing = 'agt_missing';
    const get = await inject(app, {
      method: 'GET',
      url: `/api/agents/${missing}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);
    const patch = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${missing}`,
      headers: auth(),
      payload: { name: 'x' },
    });
    expect(patch.statusCode).toBe(404);
    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${missing}/files`,
      headers: auth(),
    });
    expect(files.statusCode).toBe(404);
    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${missing}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(404);
  });

  it('DELETE removes the agent', async () => {
    const slug = unique('delete');
    const agent = (await createAgent(slug)).json<Agent>();
    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);
    const get = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}`,
      headers: auth(),
    });
    expect(get.statusCode).toBe(404);
  });

  it('delegates to sub-agents and renders them as agent files', async () => {
    const parentSlug = unique('parent');
    const childSlug = unique('child');
    const child = (await createAgent(childSlug)).json<Agent>();
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: {
        slug: parentSlug,
        name: `Agent ${parentSlug}`,
        systemPrompt: 'You are the lead.',
        subAgentIds: [child.id],
      },
    });
    createdAgents.push(parentSlug);
    expect(res.statusCode).toBe(201);
    const parent = res.json<Agent>();
    expect(parent.subAgentIds).toEqual([child.id]);

    const childGet = await inject(app, {
      method: 'GET',
      url: `/api/agents/${child.id}`,
      headers: auth(),
    });
    expect(childGet.json<Agent>().parentId).toBe(parent.id);

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}/files`,
      headers: auth(),
    });
    const body = files.json<WorkspaceFiles>();
    expect(body.subAgents.map((sub) => sub.slug)).toEqual([childSlug]);
    expect(body.claudeMd).toContain(childSlug);
    expect(body.agentMd).toContain('Agent');
    // 子智能体文件不再放行 Agent，保证只有一层。
    expect(body.subAgents[0]?.content).toContain('"Agent"');
  });

  it('rejects self-delegation and two-level delegation', async () => {
    const a = (await createAgent(unique('cycle-a'))).json<Agent>();
    const b = (await createAgent(unique('cycle-b'))).json<Agent>();

    const self = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      headers: auth(),
      payload: { subAgentIds: [a.id] },
    });
    expect(self.statusCode).toBe(400);

    const first = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${a.id}`,
      headers: auth(),
      payload: { subAgentIds: [b.id] },
    });
    expect(first.statusCode).toBe(200);

    // b 已经是 a 的子智能体，不能再被 c 委派，也不能自己再委派。
    const c = (await createAgent(unique('cycle-c'))).json<Agent>();
    const second = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${c.id}`,
      headers: auth(),
      payload: { subAgentIds: [b.id] },
    });
    expect(second.statusCode).toBe(400);

    const nested = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${b.id}`,
      headers: auth(),
      payload: { subAgentIds: [c.id] },
    });
    expect(nested.statusCode).toBe(400);
  });
});
