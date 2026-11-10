import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from '@agentport/shared';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;

const serverId = 'srv_kb_guard_test';
let plainServerId = '';

describe.skipIf(!ready)('knowledge server is owned by the knowledge lifecycle', () => {
  let app: TestApp;
  let cookie: string;
  const serverNames: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    await app.client.unsafe(
      `insert into servers (id, name, kind, config) values ($1, $2, 'knowledge', $3)
       on conflict (id) do nothing`,
      [serverId, 'kb-guard-test', JSON.stringify({ knowledgeBaseId: 'kb_missing' })],
    );
    // 带加密 env 的普通连接器：列表必须能用同一密钥解密，否则 GET 会 500。
    const name = unique('guard-plain');
    serverNames.push(name);
    const created = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        kind: 'stdio',
        name,
        description: '',
        command: 'npx',
        args: ['-y', 'server-everything'],
        env: { API_TOKEN: 'guard-test-token' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    plainServerId = created.json<Server>().id;
  });

  afterAll(async () => {
    if (!app) return;
    await app.client.unsafe('delete from servers where id = any($1::text[])', [
      app.client.array([serverId, plainServerId], 'TEXT'),
    ]);
    await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
      app.client.array([serverId, plainServerId], 'TEXT'),
    ]);
    await app.close();
  });

  it('lists ordinary connectors without knowledge servers', async () => {
    const response = await request(app, {
      method: 'GET',
      url: '/api/servers',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json<Array<{ id: string }>>();
    expect(rows.some((row) => row.id === plainServerId)).toBe(true);
    expect(rows.some((row) => row.id === serverId)).toBe(false);
  });

  it('refuses to delete a knowledge server through the generic endpoint', async () => {
    const response = await request(app, {
      method: 'DELETE',
      url: `/api/servers/${serverId}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('keeps the knowledge server in the database after the refused delete', async () => {
    const rows = await app.client.unsafe('select kind from servers where id = $1', [serverId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'knowledge' });
  });
});
