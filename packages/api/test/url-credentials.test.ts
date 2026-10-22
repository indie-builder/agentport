import { maskUrlCredentials, type Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const RAW_USER = 'legacy-user';
const RAW_PASS = 'legacy-pass-9f3a';
const RAW_URL = `https://${RAW_USER}:${RAW_PASS}@legacy.example.com/mcp`;

describe.skipIf(!ready)('URL embedded credentials', () => {
  let app: FastifyInstance;
  let cookie: string;
  const serverNames: string[] = [];
  const agentSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { serverNames, agentSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });

  /** 旧数据：加密改造前写入的 URL 直接落在 config 里，只能绕过 schema 直接落库。 */
  async function seedLegacy(
    kind: 'http' | 'generated',
    config: Record<string, unknown>,
  ): Promise<{ id: string; name: string }> {
    const name = unique(`legacy-${kind}`);
    serverNames.push(name);
    const id = `srv_${name}`;
    await app.pool.query(
      "insert into servers (id, name, kind, description, config) values ($1, $2, $3, '', $4::jsonb)",
      [id, name, kind, JSON.stringify(config)],
    );
    return { id, name };
  }

  async function bindAgent(serverId: string): Promise<string> {
    const res = await createAgent(app, cookie, { serverIds: [serverId], track: agentSlugs });
    return res.json<{ id: string }>().id;
  }

  const serverUrl = async (id: string): Promise<Server> => {
    const res = await inject(app, { method: 'GET', url: `/api/servers/${id}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Server>();
  };

  it('masks a legacy http URL on read and never rewrites the stored value', async () => {
    const { id } = await seedLegacy('http', { url: RAW_URL });

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/servers/${id}`,
      headers: auth(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(RAW_USER);
    expect(detail.body).not.toContain(RAW_PASS);
    const body = detail.json<Server>();
    expect(body.kind).toBe('http');
    if (body.kind !== 'http') throw new Error('unexpected kind');
    expect(body.url).toBe(maskUrlCredentials(RAW_URL));
    expect(body.url).toContain('legacy.example.com');

    const list = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(list.body).not.toContain(RAW_PASS);

    const stored = await app.pool.query(
      'select config->>$$url$$ as url from servers where id = $1',
      [id],
    );
    expect(stored.rows[0]?.url).toBe(RAW_URL);
  });

  it('masks a legacy generated baseUrl on read', async () => {
    const rawBase = `https://${RAW_USER}:${RAW_PASS}@legacy.example.com/api`;
    const { id } = await seedLegacy('generated', { baseUrl: rawBase, mcpToken: unique('token') });

    const body = await serverUrl(id);
    if (body.kind !== 'generated') throw new Error('unexpected kind');
    expect(body.baseUrl).toBe(maskUrlCredentials(rawBase));
    const list = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(list.body).not.toContain(RAW_USER);
    expect(list.body).not.toContain(RAW_PASS);
  });

  it('masks the URL in workspace previews and exports', async () => {
    const { id } = await seedLegacy('http', { url: RAW_URL });
    const agentId = await bindAgent(id);

    const files = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agentId}/files`,
      headers: auth(),
    });
    expect(files.statusCode).toBe(200);
    expect(files.body).not.toContain(RAW_USER);
    expect(files.body).not.toContain(RAW_PASS);
    expect(files.body).toContain('legacy.example.com');

    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${agentId}`,
      headers: auth(),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(RAW_USER);
    expect(exported.body).not.toContain(RAW_PASS);
    const payload = exported.json<{
      servers: Array<{ config: { url?: string } }>;
      workspace: { mcpJson: string };
    }>();
    expect(payload.servers[0]?.config.url).toBe(maskUrlCredentials(RAW_URL));
    expect(JSON.parse(payload.workspace.mcpJson).mcpServers).toBeDefined();
  });

  it('masks a legacy generated baseUrl in exports', async () => {
    const rawBase = `https://${RAW_USER}:${RAW_PASS}@legacy.example.com/api`;
    const { id } = await seedLegacy('generated', { baseUrl: rawBase, mcpToken: unique('token') });
    const agentId = await bindAgent(id);

    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${agentId}`,
      headers: auth(),
    });
    expect(exported.body).not.toContain(RAW_USER);
    expect(exported.body).not.toContain(RAW_PASS);
    const payload = exported.json<{ servers: Array<{ config: { baseUrl?: string } }> }>();
    expect(payload.servers[0]?.config.baseUrl).toBe(maskUrlCredentials(rawBase));
  });

  it('rejects legacy credential URLs before connection testing without echoing them', async () => {
    const raw = `http://${RAW_USER}:${RAW_PASS}@127.0.0.1:9/mcp`;
    const { id } = await seedLegacy('http', { url: raw });
    const tested = await inject(app, {
      method: 'POST',
      url: `/api/servers/${id}/test`,
      headers: auth(),
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: false });
    expect(tested.json<{ error: string }>().error).toContain('URL不能包含账号密码');
    expect(tested.body).not.toContain(RAW_USER);
    expect(tested.body).not.toContain(RAW_PASS);
  });

  it('rejects userinfo on create for both URL kinds and writes nothing', async () => {
    for (const kind of ['http', 'generated'] as const) {
      const name = unique(`new-${kind}`);
      serverNames.push(name);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/servers',
        headers: auth(),
        payload: kind === 'http' ? { name, kind, url: RAW_URL } : { name, kind, baseUrl: RAW_URL },
      });
      expectProblem(res, 'INVALID_INPUT');
      expect(res.body).not.toContain(RAW_PASS);
      const rows = await app.pool.query('select id from servers where name = $1', [name]);
      expect(rows.rowCount).toBe(0);
    }
  });

  it('rejects userinfo on PATCH and keeps the stored URL', async () => {
    const name = unique('patch-http');
    serverNames.push(name);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name, kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<Server>();

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${id}`,
      headers: auth(),
      payload: { url: RAW_URL },
    });
    expectProblem(patched, 'INVALID_INPUT');
    expect(patched.body).not.toContain(RAW_PASS);

    const after = await serverUrl(id);
    if (after.kind !== 'http') throw new Error('unexpected kind');
    expect(after.url).toBe('https://example.com/mcp');
  });

  it('rejects userinfo in an agent import file before creating anything', async () => {
    const slug = unique('imp-cred');
    const serverName = unique('imp-cred-srv');
    agentSlugs.push(slug);
    serverNames.push(serverName);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: auth(),
      payload: {
        format: 'agentport/agent@1',
        exportedAt: new Date().toISOString(),
        agent: { slug, name: `Imported ${slug}`, systemPrompt: 'You are imported.' },
        servers: [{ name: serverName, kind: 'http', config: { url: RAW_URL }, secretKeys: [] }],
        skills: [],
      },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect(res.body).not.toContain(RAW_USER);
    expect(res.body).not.toContain(RAW_PASS);

    const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(agents.body).not.toContain(slug);
    const servers = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(servers.body).not.toContain(serverName);
  });
});
