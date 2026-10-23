import type { Agent, WorkspaceFiles } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;
const FIELDS = ['effort', 'maxThinkingTokens'] as const;

describe.skipIf(!ready)('agent reasoning defaults', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const agentIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (agentIds.length > 0) {
      await app.pool.query('delete from audit_log where target = any($1::text[])', [agentIds]);
    }
    await cleanup(app, { agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

  const create = async (extra: Record<string, unknown> = {}): Promise<Agent> => {
    const slug = unique('defaults');
    agentSlugs.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Agent ${slug}`, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    const agent = res.json<Agent>();
    agentIds.push(agent.id);
    return agent;
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    inject(app, { method: 'PATCH', url: `/api/agents/${id}`, headers: auth(), payload });

  const stored = async (id: string) => {
    const { rows } = await app.pool.query<{
      effort: string | null;
      max_thinking_tokens: number | null;
    }>('select effort, max_thinking_tokens from agents where id = $1', [id]);
    return rows[0];
  };

  const latestSnapshot = async (id: string) => {
    const { rows } = await app.pool.query<{ snapshot: Agent }>(
      'select snapshot from agent_versions where agent_id = $1 order by version desc limit 1',
      [id],
    );
    return rows[0]?.snapshot;
  };

  it('clears configured reasoning fields with null', async () => {
    const agent = await create({ effort: 'high', maxThinkingTokens: 2048 });
    expect(agent).toMatchObject({ effort: 'high', maxThinkingTokens: 2048 });

    const res = await patch(agent.id, { effort: null, maxThinkingTokens: null });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Agent>();
    for (const field of FIELDS) expect(body).not.toHaveProperty(field);

    expect(await stored(agent.id)).toEqual({ effort: null, max_thinking_tokens: null });
    const snapshot = await latestSnapshot(agent.id);
    expect(snapshot).toBeDefined();
    for (const field of FIELDS) expect(snapshot).not.toHaveProperty(field);
  });

  it('keeps configured fields through unrelated and falsey updates', async () => {
    const agent = await create({ effort: 'high', maxThinkingTokens: 2048 });
    const res = await patch(agent.id, { name: 'Renamed', enabled: false, description: '' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Agent>()).toMatchObject({
      effort: 'high',
      maxThinkingTokens: 2048,
      enabled: false,
      description: '',
    });
    expect(await stored(agent.id)).toEqual({ effort: 'high', max_thinking_tokens: 2048 });
  });

  it('rejects null on create for reasoning and other fields', async () => {
    for (const field of [...FIELDS, 'maxTurns']) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: auth(),
        payload: { slug: unique('defaults-null'), name: 'Null', [field]: null },
      });
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400);
    }
  });

  it('drops cleared effort from rendered workspace files', async () => {
    const parent = await create({ effort: 'high', maxThinkingTokens: 2048 });
    const child = await create({ effort: 'low', maxThinkingTokens: 1024 });
    const bind = await patch(parent.id, { subAgentIds: [child.id] });
    expect(bind.statusCode, bind.body).toBe(200);

    const files = async (): Promise<WorkspaceFiles> => {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/agents/${parent.id}/files`,
        headers: auth(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<WorkspaceFiles>();
    };
    const childMd = (workspace: WorkspaceFiles) =>
      workspace.subAgents.find((entry) => entry.slug === child.slug)?.content;

    const before = await files();
    expect(before.agentMd).toContain('effort: "high"');
    expect(childMd(before)).toContain('effort: "low"');

    expect((await patch(child.id, { effort: null })).statusCode).toBe(200);
    expect((await patch(parent.id, { effort: null })).statusCode).toBe(200);
    const after = await files();
    for (const content of [after.agentMd, childMd(after) ?? '']) {
      expect(content).not.toContain('effort:');
    }
  });

  it('omits cleared fields from export and round-trips configured ones', async () => {
    const agent = await create({ effort: 'xhigh', maxThinkingTokens: 4096 });
    const exportAgent = async (id: string) => {
      const res = await inject(app, {
        method: 'GET',
        url: `/api/export/agents/${id}`,
        headers: auth(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ agent: Record<string, unknown> }>();
    };

    const file = await exportAgent(agent.id);
    expect(file.agent).toMatchObject({ effort: 'xhigh', maxThinkingTokens: 4096 });

    const imported = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: auth(),
      payload: file,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const created = imported.json<{ agent: Agent }>().agent;
    agentSlugs.push(created.slug);
    agentIds.push(created.id);
    expect(created).toMatchObject({ effort: 'xhigh', maxThinkingTokens: 4096 });

    const cleared = await patch(agent.id, { effort: null, maxThinkingTokens: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const clearedFile = await exportAgent(agent.id);
    for (const field of FIELDS) expect(clearedFile.agent).not.toHaveProperty(field);
  });
});
