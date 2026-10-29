import type { Agent, WorkspaceFiles } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import { sidecarOf, unzipPackage } from './package-fixtures.js';

const ready = await infraReady;

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
    const { rows } = await app.pool.query<{ effort: string | null }>(
      'select effort from agents where id = $1',
      [id],
    );
    return rows[0];
  };

  const versionCount = async (id: string) => {
    const { rows } = await app.pool.query<{ count: string }>(
      'select count(*) from agent_versions where agent_id = $1',
      [id],
    );
    return Number(rows[0]?.count);
  };

  const latestSnapshot = async (id: string) => {
    const { rows } = await app.pool.query<{ snapshot: Agent }>(
      'select snapshot from agent_versions where agent_id = $1 order by version desc limit 1',
      [id],
    );
    return rows[0]?.snapshot;
  };

  it('clears configured effort with null', async () => {
    const agent = await create({ effort: 'high' });
    expect(agent).toMatchObject({ effort: 'high' });

    const res = await patch(agent.id, { effort: null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Agent>()).not.toHaveProperty('effort');

    expect(await stored(agent.id)).toEqual({ effort: null });
    const snapshot = await latestSnapshot(agent.id);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty('effort');
  });

  it('keeps configured effort through unrelated and falsey updates', async () => {
    const agent = await create({ effort: 'high' });
    const res = await patch(agent.id, { name: 'Renamed', enabled: false, description: '' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Agent>()).toMatchObject({ effort: 'high', enabled: false, description: '' });
    expect(await stored(agent.id)).toEqual({ effort: 'high' });
  });

  it('rejects null on create for effort and other fields', async () => {
    for (const field of ['effort', 'maxTurns']) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: auth(),
        payload: { slug: unique('defaults-null'), name: 'Null', [field]: null },
      });
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400);
    }
  });

  it('rejects the removed fixed thinking budget without writing or versioning', async () => {
    const slug = unique('defaults-thinking');
    for (const value of [2048, null]) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: auth(),
        payload: { slug, name: 'Legacy thinking', maxThinkingTokens: value },
      });
      expect(res.statusCode, `create ${String(value)}: ${res.body}`).toBe(400);
    }
    const created = await app.pool.query('select id from agents where slug = $1', [slug]);
    expect(created.rows).toEqual([]);

    const agent = await create({ effort: 'high' });
    const versions = await versionCount(agent.id);
    for (const value of [2048, null]) {
      const res = await patch(agent.id, { maxThinkingTokens: value });
      expect(res.statusCode, `patch ${String(value)}: ${res.body}`).toBe(400);
    }
    expect(await stored(agent.id)).toEqual({ effort: 'high' });
    expect(await versionCount(agent.id)).toBe(versions);
  });

  it('drops cleared effort from rendered workspace files', async () => {
    const parent = await create({ effort: 'high' });
    const child = await create({ effort: 'low' });
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

  it('omits cleared effort from export and round-trips configured values', async () => {
    const agent = await create({ effort: 'xhigh' });
    const exportPackage = async (id: string) => {
      const res = await injectZip(app, 'GET', `/api/export/agents/${id}`, cookie);
      expect(res.statusCode, res.body).toBe(200);
      return { zip: res.rawPayload, files: unzipPackage(res.rawPayload) };
    };

    const exported = await exportPackage(agent.id);
    expect(sidecarOf(exported.files).agent).toMatchObject({ effort: 'xhigh' });

    const imported = await injectZip(app, 'POST', '/api/import/agents', cookie, exported.zip);
    expect(imported.statusCode, imported.body).toBe(201);
    const created = imported.json<{ agent: Agent }>().agent;
    agentSlugs.push(created.slug);
    agentIds.push(created.id);
    expect(created).toMatchObject({ effort: 'xhigh' });

    // 清空后导出：侧车不写 effort，包仍可导入。
    const cleared = await patch(agent.id, { effort: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const clearedPackage = await exportPackage(agent.id);
    expect(sidecarOf(clearedPackage.files).agent).not.toHaveProperty('effort');
    const reimported = await injectZip(
      app,
      'POST',
      '/api/import/agents',
      cookie,
      clearedPackage.zip,
    );
    expect(reimported.statusCode, reimported.body).toBe(201);
    const clearedAgent = reimported.json<{ agent: Agent }>().agent;
    agentSlugs.push(clearedAgent.slug);
    agentIds.push(clearedAgent.id);
    expect(clearedAgent).not.toHaveProperty('effort');
  });
});
