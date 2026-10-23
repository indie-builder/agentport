import { SECRET_MASK, type Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('server concurrent writes', () => {
  let app: FastifyInstance;
  let cookie: string;
  let baseUrl: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    // MCP 端点走真实 HTTP 才能验证 token 是否仍然有效。
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no listen address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await cleanup(app, { serverNames: created });
    await app.close();
  });

  const post = (body: Record<string, unknown>) =>
    inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: body,
    });

  const patch = (id: string, payload: Record<string, unknown>) =>
    inject(app, {
      method: 'PATCH',
      url: `/api/servers/${id}`,
      headers: { cookie },
      payload,
    });

  const get = (id: string) =>
    inject(app, { method: 'GET', url: `/api/servers/${id}`, headers: { cookie } });

  /**
   * 用一条独立连接持有行锁，让所有写请求都在同一时刻到达锁点：
   * 没有它，两次请求可能刚好一前一后完成，测试就测不到竞态。
   */
  async function holdRowLock(id: string): Promise<{
    pid: number;
    release: () => Promise<void>;
  }> {
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      await client.query('select id from servers where id = $1 for update', [id]);
      return {
        pid,
        release: async () => {
          try {
            await client.query('commit');
          } catch (err) {
            await client.query('rollback').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        },
      };
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /**
   * 等到两个写请求都停在锁上。第二个请求可能排在第一请求后面而不是直接排在
   * 持锁连接后面，所以只数「正在等锁且与 servers 相关的会话」，不认具体阻塞者。
   */
  const waitingOnServerWrites = async (holderPid: number): Promise<number> => {
    const { rows } = await app.pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where datname = current_database()
         and pid <> $1
         and wait_event_type = 'Lock'
         and query ilike '%servers%'`,
      [holderPid],
    );
    return rows[0]?.n ?? 0;
  };

  it('lets exactly one of two same-version PATCHes win and keeps the secret', async () => {
    const name = unique('race');
    created.push(name);
    const server = (
      await post({ name, kind: 'stdio', command: 'echo', args: [], env: { TOKEN: 'original' } })
    ).json<Server>();

    const lock = await holdRowLock(server.id);
    try {
      const first = patch(server.id, {
        description: 'first',
        env: { TOKEN: SECRET_MASK, FIRST: 'a' },
        expectedUpdatedAt: server.updatedAt,
      });
      const second = patch(server.id, {
        description: 'second',
        env: { TOKEN: SECRET_MASK, SECOND: 'b' },
        expectedUpdatedAt: server.updatedAt,
      });
      expect(await waitFor(async () => (await waitingOnServerWrites(lock.pid)) === 2)).toBe(true);
      await lock.release();
      const [a, b] = await Promise.all([first, second]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      expectProblem(loser, 'CONFLICT_STALE');

      const winnerBody = winner.json<Server>();
      const final = (await get(server.id)).json<Server>();
      // 后到的请求只能看到 409，不能把自己的草稿写进去。
      expect(final.description).toBe(winnerBody.description);
      if (final.kind !== 'stdio') throw new Error('unexpected kind');
      const winnerKey = final.description === 'first' ? 'FIRST' : 'SECOND';
      const loserKey = winnerKey === 'FIRST' ? 'SECOND' : 'FIRST';
      expect(Object.keys(final.env).sort()).toEqual(['TOKEN', winnerKey].sort());
      expect(final.env[loserKey]).toBeUndefined();
      // 掩码合并仍然读到最新的密钥，而不是某个请求的旧快照。
      expect(final.env.TOKEN).toBe(SECRET_MASK);
    } finally {
      await lock.release().catch(() => undefined);
    }
  });

  it('advances updatedAt on every serialized update and rejects a reused version', async () => {
    const name = unique('mono');
    created.push(name);
    const server = (
      await post({ name, kind: 'stdio', command: 'echo', args: [], env: {} })
    ).json<Server>();

    let expected = server.updatedAt;
    for (const description of ['one', 'two', 'three']) {
      const res = await patch(server.id, { description, expectedUpdatedAt: expected });
      expect(res.statusCode, res.body).toBe(200);
      const next = res.json<Server>().updatedAt;
      // 同一毫秒内的连续写入也必须推进版本，否则旧版本号还能再次命中。
      expect(Date.parse(next)).toBeGreaterThan(Date.parse(expected));
      expected = next;
    }

    expectProblem(
      await patch(server.id, { description: 'reused', expectedUpdatedAt: server.updatedAt }),
      'CONFLICT_STALE',
    );
  });

  it('serializes concurrent token rotation and PATCH without losing either change', async () => {
    const name = unique('rotate-race');
    created.push(name);
    const oldBaseUrl = 'http://127.0.0.1:3999/old';
    const newBaseUrl = 'http://127.0.0.1:3999/new';
    const server = (await post({ name, kind: 'generated', baseUrl: oldBaseUrl })).json<Server>();

    const oldTokenRow = await app.pool.query<{ token: string }>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    const oldToken = oldTokenRow.rows[0]?.token ?? '';
    expect(oldToken).not.toBe('');

    const lock = await holdRowLock(server.id);
    try {
      // 两个请求都不带版本号：它们在锁外读到的都是旧配置。
      const rotate = inject(app, {
        method: 'POST',
        url: `/api/servers/${server.id}/rotate-token`,
        headers: { cookie },
      });
      const edited = patch(server.id, { baseUrl: newBaseUrl });
      expect(await waitFor(async () => (await waitingOnServerWrites(lock.pid)) === 2)).toBe(true);
      await lock.release();

      const [rotated, patched] = await Promise.all([rotate, edited]);
      // 失败消息里只有状态码：rotate 的响应体是明文 token。
      expect(rotated.statusCode).toBe(200);
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json<Server>()).toMatchObject({ baseUrl: newBaseUrl });

      // 最终行必须同时包含新地址和新 token：map 结果用布尔值，避免失败时打印 token。
      const final = await app.pool.query<{ same: boolean; url: string }>(
        "select config->>'mcpToken' = $2 as same, config->>'baseUrl' as url from servers where id = $1",
        [server.id, rotated.json<{ token: string }>().token],
      );
      expect(final.rows[0]).toEqual({ same: true, url: newBaseUrl });

      // 旧 token 必须真的失效，新 token 必须能初始化 MCP 会话。
      const initialize = (token: string) =>
        fetch(`${baseUrl}/mcp/${server.id}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'server-concurrency-test', version: '0.0.0' },
            },
          }),
        });
      expect((await initialize(oldToken)).status).toBe(401);
      expect((await initialize(rotated.json<{ token: string }>().token)).status).toBe(200);
    } finally {
      await lock.release().catch(() => undefined);
    }
  });
});
