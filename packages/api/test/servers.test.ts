import { SECRET_MASK, type Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
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

  it('masks the generated token and rotates it once, invalidating the old one', async () => {
    const name = unique('token');
    created.push(name);
    const server = (
      await post(name, { kind: 'generated', baseUrl: 'https://jsonplaceholder.typicode.com' })
    ).json<Server>();

    const shown = await inject(app, {
      method: 'GET',
      url: `/api/servers/${server.id}/token`,
      headers: auth(),
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      // GET 只回掩码，字段名与 rotate 的明文 token 区分。
      maskedToken: SECRET_MASK,
      endpoint: expect.stringContaining(`/mcp/${server.id}`),
    });

    // 轮换接口是唯一返回明文的地方；再轮换一次，前一个 token 应失效。
    const rotate = () =>
      inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/rotate-token`,
        headers: auth(),
      });
    const first = await rotate();
    expect(first.statusCode).toBe(200);
    const oldToken = first.json<{ token: string }>().token;
    const second = await rotate();
    expect(second.statusCode).toBe(200);
    const newToken = second.json<{ token: string }>().token;
    expect(newToken).not.toBe(oldToken);

    const list = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(list.body).not.toContain(newToken);

    // 旧 token 失效，新 token 通过鉴权。
    const probe = (token: string) =>
      inject(app, {
        method: 'POST',
        url: `/mcp/${server.id}`,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        payload: {},
      });
    expect((await probe(oldToken)).statusCode).toBe(401);
    expect((await probe(newToken)).statusCode).not.toBe(401);
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

  it('rejects non-http protocols with 400', async () => {
    for (const url of ['ftp://example.com/mcp', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const res = await post(unique('proto'), { kind: 'http', url, headers: {} });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ message: '仅支持 http/https 地址' });
    }
  });

  it('rejects a private address in production and allows public addresses', async () => {
    // 只换 NODE_ENV，其余配置沿用测试环境；app.inject 直接带 cookie，Secure 不影响。
    const prodApp = await buildApp({ ...testConfig(), NODE_ENV: 'production' });
    await prodApp.ready();
    try {
      const res = await inject(prodApp, {
        method: 'POST',
        url: '/api/servers',
        headers: auth(),
        payload: { name: unique('prod-private'), kind: 'http', url: 'http://10.0.0.1/mcp' },
      });
      expect(res.statusCode).toBe(400);
      expect(expectProblem(res, 'INVALID_URL').message).toContain('内网');

      const publicName = unique('prod-public');
      created.push(publicName);
      const ok = await inject(prodApp, {
        method: 'POST',
        url: '/api/servers',
        headers: auth(),
        payload: { name: publicName, kind: 'http', url: 'https://example.com/mcp' },
      });
      expect(ok.statusCode).toBe(201);

      // PATCH 同样按库里的 kind 复查新地址。
      const patched = await inject(prodApp, {
        method: 'PATCH',
        url: `/api/servers/${ok.json<Server>().id}`,
        headers: auth(),
        payload: { url: 'http://192.168.1.10/mcp' },
      });
      expectProblem(patched, 'INVALID_URL');
    } finally {
      await prodApp.close();
    }
  });

  it('allows localhost in development', async () => {
    const name = unique('dev-local');
    created.push(name);
    const res = await post(name, {
      kind: 'http',
      url: 'http://127.0.0.1:3999/mcp',
      headers: {},
    });
    expect(res.statusCode).toBe(201);
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

  it('PATCH edits a generated tool definition in place', async () => {
    const created = await post(unique('patch-tool'), {
      kind: 'generated',
      baseUrl: 'https://jsonplaceholder.typicode.com',
    });
    const server = created.json<Server>();
    const toolRes = await inject(app, {
      method: 'POST',
      url: `/api/servers/${server.id}/tools`,
      headers: auth(),
      payload: {
        name: 'get-user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
      },
    });
    expect(toolRes.statusCode).toBe(201);
    const tool = toolRes.json<{ id: string }>();

    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: auth(),
      payload: { pathTemplate: '/users/{id}/posts', description: 'posts by user' },
    });
    expect(patched.statusCode).toBe(200);
    // 同一 id：编辑不能换掉工具，否则运行中的审批与外键会断。
    expect(patched.json<{ id: string; pathTemplate: string }>()).toMatchObject({
      id: tool.id,
      pathTemplate: '/users/{id}/posts',
      description: 'posts by user',
    });

    const empty = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: auth(),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
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

  it('PATCH rejects a stale expectedUpdatedAt with 409', async () => {
    const name = unique('stale');
    created.push(name);
    const server = (
      await post(name, { kind: 'stdio', command: 'echo', args: [], env: {} })
    ).json<Server>();

    const ok = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}`,
      headers: auth(),
      payload: { description: 'first', expectedUpdatedAt: server.updatedAt },
    });
    expect(ok.statusCode).toBe(200);

    const stale = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}`,
      headers: auth(),
      payload: { description: 'second', expectedUpdatedAt: server.updatedAt },
    });
    expectProblem(stale, 'CONFLICT_STALE');
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
