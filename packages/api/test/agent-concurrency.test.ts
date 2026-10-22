import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('agent update concurrency', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdSlugs: string[] = [];
  const createdIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      // audit_log 没有外键，删 agent 不会带走它。
      await app.pool.query('delete from audit_log where target = any($1::text[])', [createdIds]);
    }
    await cleanup(app, { agentSlugs: createdSlugs });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> => {
    const res = await createAgent(app, cookie, { track: createdSlugs });
    const agent = res.json<Agent>();
    createdIds.push(agent.id);
    return agent;
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    inject(app, {
      method: 'PATCH',
      url: `/api/agents/${id}`,
      headers: { cookie },
      payload,
    });

  const get = async (id: string): Promise<Agent> => {
    const res = await inject(app, { method: 'GET', url: `/api/agents/${id}`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Agent>();
  };

  const versionRows = async (id: string) => {
    const { rows } = await app.pool.query<{ version: number; snapshot: Agent }>(
      'select version, snapshot from agent_versions where agent_id = $1 order by version',
      [id],
    );
    return rows;
  };

  it('rejects a reused updatedAt when the clock is frozen in the same millisecond', async () => {
    const agent = await newAgent();
    // 把版本值固定在同一毫秒，并让 Node 的 new Date() 也停在这一刻：
    // 旧实现直接把 new Date() 写回，第二次请求仍能命中旧版本。
    const frozen = new Date(Date.now());
    await app.pool.query('update agents set updated_at = $2 where id = $1', [agent.id, frozen]);
    vi.useFakeTimers({ now: frozen, toFake: ['Date'] });
    try {
      const first = await patch(agent.id, { name: 'First', expectedUpdatedAt: frozen });
      expect(first.statusCode, first.body).toBe(200);

      const second = await patch(agent.id, { name: 'Second', expectedUpdatedAt: frozen });
      expectProblem(second, 'CONFLICT_STALE');
      expect(await get(agent.id)).toMatchObject({ name: 'First' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets exactly one of two same-version PATCHes win with one version and one audit row', async () => {
    const agent = await newAgent();

    const client = await app.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const holderPid = rows[0]?.pid;
      if (holderPid === undefined) throw new Error('no backend pid');
      await client.query('select id from agents where id = $1 for update', [agent.id]);

      const first = patch(agent.id, { name: 'Concurrent A', expectedUpdatedAt: agent.updatedAt });
      const second = patch(agent.id, { name: 'Concurrent B', expectedUpdatedAt: agent.updatedAt });
      // 两个写请求都停在行锁上才算真的并发；只等一个可能刚好一前一后完成。
      const blocked = await waitFor(async () => {
        const waiting = await app.pool.query<{ n: number }>(
          `with recursive blocked(pid) as (
             select a.pid from pg_stat_activity a
             where a.datname = current_database()
               and $1 = any(pg_blocking_pids(a.pid))
             union
             select a.pid from pg_stat_activity a join blocked b
               on b.pid = any(pg_blocking_pids(a.pid))
             where a.datname = current_database()
           ) select count(*)::int as n from blocked`,
          [holderPid],
        );
        return (waiting.rows[0]?.n ?? 0) === 2;
      });
      expect(blocked).toBe(true);
      await client.query('commit');

      const [a, b] = await Promise.all([first, second]);
      expect(
        [a.statusCode, b.statusCode].sort((x, y) => x - y),
        `${a.body} / ${b.body}`,
      ).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      expectProblem(loser, 'CONFLICT_STALE');

      const winnerName = winner.json<Agent>().name;
      const final = await get(agent.id);
      expect(final.name).toBe(winnerName);

      const versions = await versionRows(agent.id);
      expect(versions.map((row) => row.version)).toEqual([1, 2]);
      expect(versions[1]?.snapshot).toMatchObject({
        name: winnerName,
        updatedAt: final.updatedAt,
      });
      expect(versions.filter((row) => row.snapshot.name === winnerName)).toHaveLength(1);

      const audit = await app.pool.query<{ n: number }>(
        "select count(*)::int as n from audit_log where target = $1 and action = 'agent.updated'",
        [agent.id],
      );
      expect(audit.rows[0]?.n).toBe(1);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('keeps both fields when two disjoint PATCHes run without a version', async () => {
    const agent = await newAgent();

    const client = await app.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const holderPid = rows[0]?.pid;
      if (holderPid === undefined) throw new Error('no backend pid');
      await client.query('select id from agents where id = $1 for update', [agent.id]);

      // 不带 expectedUpdatedAt 的请求不受乐观锁保护，必须靠「只写传入字段」避免互相回填旧值。
      const first = patch(agent.id, { name: 'Disjoint name' });
      const second = patch(agent.id, { description: 'Disjoint description' });
      const blocked = await waitFor(async () => {
        const waiting = await app.pool.query<{ n: number }>(
          `with recursive blocked(pid) as (
             select a.pid from pg_stat_activity a
             where a.datname = current_database()
               and $1 = any(pg_blocking_pids(a.pid))
             union
             select a.pid from pg_stat_activity a join blocked b
               on b.pid = any(pg_blocking_pids(a.pid))
             where a.datname = current_database()
           ) select count(*)::int as n from blocked`,
          [holderPid],
        );
        return (waiting.rows[0]?.n ?? 0) === 2;
      });
      expect(blocked).toBe(true);
      await client.query('commit');

      const [a, b] = await Promise.all([first, second]);
      expect([a.statusCode, b.statusCode], `${a.body} / ${b.body}`).toEqual([200, 200]);
      expect(await get(agent.id)).toMatchObject({
        name: 'Disjoint name',
        description: 'Disjoint description',
      });
      const versions = await versionRows(agent.id);
      expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(versions.at(-1)?.snapshot).toMatchObject({
        name: 'Disjoint name',
        description: 'Disjoint description',
      });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('advances updatedAt on consecutive updates without waits and rejects the old version', async () => {
    const agent = await newAgent();
    // 起点放到未来：数据库 now() 不可能越过它，版本只能靠 +1ms 分支前进，
    // 这样不用 sleep 也能稳定测到同一毫秒内的单调推进。
    const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await app.pool.query('update agents set updated_at = $2 where id = $1', [agent.id, start]);

    let expected = start.toISOString();
    for (let i = 0; i < 5; i += 1) {
      const res = await patch(agent.id, { name: `Round ${i}`, expectedUpdatedAt: expected });
      expect(res.statusCode, res.body).toBe(200);
      const next = res.json<Agent>().updatedAt;
      expect(Date.parse(next) - Date.parse(expected)).toBe(1);
      expected = next;
    }
    expect(await get(agent.id)).toMatchObject({ name: 'Round 4' });

    const stale = await patch(agent.id, {
      name: 'Stale',
      expectedUpdatedAt: start.toISOString(),
    });
    expectProblem(stale, 'CONFLICT_STALE');
    expect(await get(agent.id)).toMatchObject({ name: 'Round 4' });
  });

  it('returns 404 for a missing agent even when a version is supplied', async () => {
    const missing = await patch('agt_missing', {
      name: 'x',
      expectedUpdatedAt: new Date().toISOString(),
    });
    expectProblem(missing, 'AGENT_NOT_FOUND');
  });
});
