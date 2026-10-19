import type { Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, infraReady, inject, loginCookie, startApp, unique } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('servers', () => {
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

  const auth = () => ({ cookie });
  const post = (name: string, body: Record<string, unknown>) =>
    inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name, ...body },
    });

  it('creates a stdio server and never returns secret values', async () => {
    const name = unique('stdio');
    created.push(name);
    const res = await post(name, {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', 'demo'],
      env: { TOKEN: 'secret-value' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Server>();
    expect(body).toMatchObject({ name, kind: 'stdio', command: 'npx', args: ['-y', 'demo'] });
    if (body.kind !== 'stdio') throw new Error('unexpected kind');
    expect(body.env).toEqual({ TOKEN: '••••' });
    expect(res.body).not.toContain('secret-value');

    const list = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('secret-value');
  });

  it('creates an http server and masks headers', async () => {
    const name = unique('http');
    created.push(name);
    const res = await post(name, {
      kind: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer top-secret' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Server>();
    if (body.kind !== 'http') throw new Error('unexpected kind');
    expect(body.url).toBe('https://example.com/mcp');
    expect(body.headers).toEqual({ Authorization: '••••' });
  });

  it('creates a generated server with an MCP token hidden from the API', async () => {
    const name = unique('gen');
    created.push(name);
    const res = await post(name, {
      kind: 'generated',
      baseUrl: 'https://jsonplaceholder.typicode.com',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Server>();
    if (body.kind !== 'generated') throw new Error('unexpected kind');
    expect(body.baseUrl).toBe('https://jsonplaceholder.typicode.com');
    expect(JSON.stringify(body)).not.toContain('mcpToken');
  });

  it('rejects invalid input with 400', async () => {
    const cases = [
      { kind: 'stdio', name: unique('bad'), command: '', args: [], env: {} },
      { kind: 'http', name: unique('bad'), url: 'not-a-url', headers: {} },
      { kind: 'generated', name: 'Bad Name With Spaces', baseUrl: 'https://example.com' },
      { kind: 'unknown', name: unique('bad') },
    ];
    for (const payload of cases) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/servers',
        headers: auth(),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  // 已知缺陷（不在本测试文件的修改范围）：servers/routes.ts 的 rethrowConflict 只看顶层
  // error.code，drizzle 把 pg 的 23505 包在 DrizzleQueryError.cause 里，所以实际返回 500。
  // agents/routes.ts 已顺着 cause 链查找，servers 侧需同样处理。
  it('rejects a duplicate name with 409', async () => {
    const name = unique('dup');
    created.push(name);
    expect(
      (await post(name, { kind: 'stdio', command: 'echo', args: [], env: {} })).statusCode,
    ).toBe(201);
    const res = await post(name, { kind: 'stdio', command: 'echo', args: [], env: {} });
    expect(res.statusCode).toBe(409);
  });

  it('GET /api/servers/:id returns 404 for an unknown id', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: '/api/servers/srv_missing',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH updates fields and keeps masked secrets', async () => {
    const name = unique('patch');
    created.push(name);
    const createdServer = (
      await post(name, { kind: 'stdio', command: 'echo', args: [], env: { TOKEN: 'original' } })
    ).json<Server>();

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${createdServer.id}`,
      headers: auth(),
      payload: { description: 'updated', env: { TOKEN: '••••', EXTRA: 'x' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Server>();
    expect(body.description).toBe('updated');
    if (body.kind !== 'stdio') throw new Error('unexpected kind');
    expect(body.env).toEqual({ TOKEN: '••••', EXTRA: '••••' });

    const bad = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${createdServer.id}`,
      headers: auth(),
      payload: { kind: 'http' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('serves CRUD on tools only for generated servers', async () => {
    const genName = unique('tools');
    const stdioName = unique('notools');
    created.push(genName, stdioName);
    const gen = (
      await post(genName, { kind: 'generated', baseUrl: 'https://jsonplaceholder.typicode.com' })
    ).json<Server>();
    const stdio = (
      await post(stdioName, { kind: 'stdio', command: 'echo', args: [], env: {} })
    ).json<Server>();

    const toolInput = {
      name: 'get-user',
      description: 'fetch a user',
      method: 'GET',
      pathTemplate: '/users/{id}',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
      paramsIn: 'query',
    };
    const createdTool = await inject(app, {
      method: 'POST',
      url: `/api/servers/${gen.id}/tools`,
      headers: auth(),
      payload: toolInput,
    });
    expect(createdTool.statusCode).toBe(201);
    const toolId = createdTool.json<{ id: string }>().id;

    const list = await inject(app, {
      method: 'GET',
      url: `/api/servers/${gen.id}/tools`,
      headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<Array<{ name: string }>>().map((t) => t.name)).toContain('get-user');

    const rejected = await inject(app, {
      method: 'POST',
      url: `/api/servers/${stdio.id}/tools`,
      headers: auth(),
      payload: toolInput,
    });
    expect(rejected.statusCode).toBe(400);

    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/servers/${gen.id}/tools/${toolId}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);

    const missing = await inject(app, {
      method: 'DELETE',
      url: `/api/servers/${gen.id}/tools/${toolId}`,
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE removes the server and returns 404 afterwards', async () => {
    const name = unique('del');
    const server = (
      await post(name, { kind: 'stdio', command: 'echo', args: [], env: {} })
    ).json<Server>();
    const del = await inject(app, {
      method: 'DELETE',
      url: `/api/servers/${server.id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);
    const again = await inject(app, {
      method: 'DELETE',
      url: `/api/servers/${server.id}`,
      headers: auth(),
    });
    expect(again.statusCode).toBe(404);
  });
});
