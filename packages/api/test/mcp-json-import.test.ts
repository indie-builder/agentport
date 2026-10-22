import { decryptSecrets } from '@agentport/core';
import type { Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  testConfig,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface McpImportResult {
  servers: Array<{ id: string; name: string; kind: string; secretKeys: string[] }>;
  warnings: string[];
}

const doc = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

describe.skipIf(!ready)('mcp.json import', () => {
  let app: FastifyInstance;
  let cookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { serverNames: created });
    await app.close();
  });

  const post = (mcpJson: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/servers/import-file',
      headers: { cookie },
      payload: { mcpJson },
    });

  const stored = async (name: string) => {
    const { rows } = await app.pool.query<{
      id: string;
      config: string;
      secrets_encrypted: string | null;
    }>('select id, config::text as config, secrets_encrypted from servers where name = $1', [name]);
    return rows[0];
  };

  it('requires auth', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/servers/import-file',
      payload: { mcpJson: doc({ nope: { command: 'npx' } }) },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('imports stdio and http entries with encrypted secrets and key-only response', async () => {
    const stdioName = unique('import-stdio');
    const httpName = unique('import-http');
    created.push(stdioName, httpName);
    const stdioSecret = 'stdio-secret-value';
    const httpSecret = 'http-secret-value';

    const res = await post(
      doc({
        [stdioName]: { command: 'npx', args: ['-y', 'demo'], env: { API_KEY: stdioSecret } },
        [httpName]: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: `Bearer ${httpSecret}` },
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(stdioSecret);
    expect(res.body).not.toContain(httpSecret);

    const body = res.json<McpImportResult>();
    expect(body.warnings).toEqual(['仅导入连接配置；未测试连接或执行命令，请检查后再使用。']);
    expect(body.servers.map(({ name, kind, secretKeys }) => ({ name, kind, secretKeys }))).toEqual([
      { name: stdioName, kind: 'stdio', secretKeys: ['API_KEY'] },
      { name: httpName, kind: 'http', secretKeys: ['Authorization'] },
    ]);

    const key = testConfig().APP_SECRET_KEY;
    const stdio = await stored(stdioName);
    const http = await stored(httpName);
    if (!stdio?.secrets_encrypted || !http?.secrets_encrypted) throw new Error('missing secrets');
    // 落库的是密文：明文既不进配置也不进加密列。
    expect(stdio.config).not.toContain(stdioSecret);
    expect(stdio.secrets_encrypted).not.toContain(stdioSecret);
    expect(http.config).not.toContain(httpSecret);
    expect(http.secrets_encrypted).not.toContain(httpSecret);
    expect(decryptSecrets(stdio.secrets_encrypted, key)).toEqual({ API_KEY: stdioSecret });
    expect(decryptSecrets(http.secrets_encrypted, key)).toEqual({
      Authorization: `Bearer ${httpSecret}`,
    });

    const list = await inject(app, { method: 'GET', url: '/api/servers', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const listed = list.json<Server[]>().filter((server) => server.name === stdioName);
    expect(listed[0]).toMatchObject({ kind: 'stdio', env: { API_KEY: '••••' } });
    expect(list.body).not.toContain(stdioSecret);
  });

  it('rejects the whole batch when any entry conflicts with an existing name', async () => {
    const existing = unique('import-existing');
    const fresh = unique('import-fresh');
    created.push(existing);
    const seeded = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: existing, kind: 'stdio', command: 'npx' },
    });
    expect(seeded.statusCode, seeded.body).toBe(201);

    const res = await post(
      doc({
        [fresh]: { command: 'npx' },
        [existing]: { command: 'npx' },
      }),
    );
    expectProblem(res, 'CONFLICT');
    expect(res.body).not.toContain(existing);
    const { rows } = await app.pool.query('select 1 from servers where name = $1', [fresh]);
    expect(rows).toHaveLength(0);
  });

  it('lets exactly one of two concurrent identical imports win', async () => {
    const name = unique('import-race');
    created.push(name);
    const text = doc({ [name]: { command: 'npx' } });

    const results = await Promise.all([post(text), post(text)]);
    const statuses = results.map((res) => res.statusCode).sort();
    expect(statuses).toEqual([201, 409]);

    const { rows } = await app.pool.query('select id from servers where name = $1', [name]);
    expect(rows).toHaveLength(1);
  });

  it('does not insert earlier entries when a later entry is malformed', async () => {
    const first = unique('import-partial');
    created.push(first);
    const res = await post(
      doc({
        [first]: { command: 'npx' },
        later: { command: 'npx', unknownField: true },
      }),
    );
    expectProblem(res, 'INVALID_INPUT');
    const { rows } = await app.pool.query('select 1 from servers where name = $1', [first]);
    expect(rows).toHaveLength(0);
  });

  it('rejects unsupported types, template placeholders and URL credentials', async () => {
    for (const entry of [
      { type: 'sse', url: 'https://example.com/mcp' },
      { command: 'npx', env: { TOKEN: '$' + '{TOKEN}' } },
      { type: 'http', url: 'https://user:password@example.com/mcp' },
    ]) {
      expectProblem(await post(doc({ files: entry })), 'INVALID_INPUT');
    }
  });

  it('accepts a body envelope over 1 MiB as long as the parser byte cap holds', async () => {
    const name = unique('import-envelope');
    created.push(name);
    // 每个 `"` 在文件文本里转义成 2 字节、在请求体 JSON 字符串里再翻倍；信封超过默认 1 MiB。
    const value = '"'.repeat(500_000);
    const text = doc({ [name]: { command: 'npx', env: { TOKEN: value } } });
    expect(Buffer.byteLength(text)).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(JSON.stringify({ mcpJson: text }))).toBeGreaterThan(1_048_576);

    const res = await post(text);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('imports without testing connections or creating runs', async () => {
    const name = unique('import-noexec');
    created.push(name);
    const res = await post(doc({ [name]: { command: 'npx' } }));
    expect(res.statusCode, res.body).toBe(201);

    // 批次没有单一目标对象：审计行只保留摘要，target 为空。
    const audit = await app.pool.query<{ target: string | null; input_digest: string | null }>(
      `select target, input_digest from audit_log
       where action = 'server.imported' order by created_at desc limit 1`,
    );
    expect(audit.rows[0]?.target).toBeNull();
    expect(audit.rows[0]?.input_digest).not.toBeNull();
    const returned = res.json<McpImportResult>().servers[0];
    if (!returned) throw new Error('missing imported server');
    const bindings = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from agent_servers where server_id = $1',
      [returned.id],
    );
    expect(bindings.rows[0]?.count).toBe(0);
    const tested = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from audit_log where action = 'mcp.server.tested' and target = $1",
      [returned.id],
    );
    expect(tested.rows[0]?.count).toBe(0);
  });
});
