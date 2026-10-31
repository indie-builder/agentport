import type { Agent } from '@agentport/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PoolClient } from 'pg';
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
  waitFor,
} from './helpers.js';

const ready = await infraReady;
/** 与仓储里的绑定锁同一个键：测试先占住它，两个写请求才会一起排队。 */
const BINDING_LOCK = "select pg_advisory_xact_lock(hashtext('agentport.subagent-bindings'))";

describe.skipIf(!ready)('sub-agent binding concurrency', () => {
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
    inject(app, { method: 'PATCH', url: `/api/agents/${id}`, headers: { cookie }, payload });

  const get = async (id: string): Promise<Agent> => {
    const res = await inject(app, { method: 'GET', url: `/api/agents/${id}`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Agent>();
  };

  const versions = async (id: string): Promise<number[]> => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${id}/versions`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Array<{ version: number }>>().map((row) => row.version);
  };

  /** 占住全局绑定锁和目标行锁，等两个请求都进入 pg 等待图再放行。 */
  const race = async (
    lockRowId: string,
    start: () => Promise<[LightMyRequestResponse, LightMyRequestResponse]>,
  ): Promise<[LightMyRequestResponse, LightMyRequestResponse]> => {
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const holder = rows[0]?.pid;
      if (holder === undefined) throw new Error('no backend pid');
      await client.query(BINDING_LOCK);
      await client.query('select id from agents where id = $1 for update', [lockRowId]);
      const both = start();
      const queued = await waitFor(async () => {
        const waiting = await app.pool.query<{ n: number }>(
          `with recursive blocked(pid) as (
             select a.pid from pg_stat_activity a
             where a.datname = current_database() and $1 = any(pg_blocking_pids(a.pid))
             union
             select a.pid from pg_stat_activity a join blocked b
               on b.pid = any(pg_blocking_pids(a.pid))
             where a.datname = current_database()
           ) select count(*)::int as n from blocked`,
          [holder],
        );
        return (waiting.rows[0]?.n ?? 0) >= 2;
      });
      expect(queued, 'both requests never entered the lock graph').toBe(true);
      await client.query('commit');
      return await both;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };

  it('lets only one parent claim the same free child', async () => {
    const a = await newAgent();
    const b = await newAgent();
    const child = await newAgent();

    const [ra, rb] = await race(child.id, () =>
      Promise.all([
        patch(a.id, { subAgentIds: [child.id] }),
        patch(b.id, { subAgentIds: [child.id] }),
      ]),
    );
    expect(
      [ra.statusCode, rb.statusCode].sort((x, y) => x - y),
      `${ra.body} / ${rb.body}`,
    ).toEqual([200, 400]);

    const winner = ra.statusCode === 200 ? a : b;
    const loser = ra.statusCode === 200 ? b : a;
    const loserRes = ra.statusCode === 200 ? rb : ra;
    expectProblem(loserRes, 'INVALID_INPUT');
    expect(loserRes.json<{ message: string }>().message).toContain('已经是其他智能体的子智能体');

    expect((await get(child.id)).parentId).toBe(winner.id);
    expect((await get(winner.id)).subAgentIds).toEqual([child.id]);
    expect((await get(loser.id)).subAgentIds).toEqual([]);
    expect(await versions(winner.id)).toEqual([2, 1]);
    expect(await versions(loser.id)).toEqual([1]);

    const snapshot = await inject(app, {
      method: 'GET',
      url: `/api/agents/${winner.id}/versions/2`,
      headers: { cookie },
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json<{ snapshot: Agent }>().snapshot.subAgentIds).toEqual([child.id]);
  });

  it('never stacks a child under an agent that is itself being attached', async () => {
    const parent = await newAgent();
    const middle = await newAgent();
    const leaf = await newAgent();

    const [attachMiddle, giveLeaf] = await race(middle.id, () =>
      Promise.all([
        patch(parent.id, { subAgentIds: [middle.id] }),
        patch(middle.id, { subAgentIds: [leaf.id] }),
      ]),
    );
    expect(
      [attachMiddle.statusCode, giveLeaf.statusCode].sort((x, y) => x - y),
      `${attachMiddle.body} / ${giveLeaf.body}`,
    ).toEqual([200, 400]);

    const parentWon = attachMiddle.statusCode === 200;
    const loser = parentWon ? giveLeaf : attachMiddle;
    expectProblem(loser, 'INVALID_INPUT');
    expect(loser.json<{ message: string }>().message).toContain(
      parentWon ? 'a sub-agent cannot have its own sub-agents' : '自己还有子智能体',
    );

    const after = await get(middle.id);
    expect(after.parentId !== null && after.subAgentIds.length > 0).toBe(false);
    expect(after.parentId).toBe(parentWon ? parent.id : null);
    expect(after.subAgentIds).toEqual(parentWon ? [] : [leaf.id]);
    expect((await get(parent.id)).subAgentIds).toEqual(parentWon ? [middle.id] : []);
    expect((await get(leaf.id)).parentId).toBe(parentWon ? null : middle.id);
  });

  it('never lets create and patch both claim the same child', async () => {
    const owner = await newAgent();
    const child = await newAgent();
    const slug = unique('race-created');
    createdSlugs.push(slug);

    const [patched, created] = await race(child.id, () =>
      Promise.all([
        patch(owner.id, { subAgentIds: [child.id] }),
        inject(app, {
          method: 'POST',
          url: '/api/agents',
          headers: { cookie },
          payload: {
            slug,
            name: `Agent ${slug}`,
            systemPrompt: 'You are helpful.',
            subAgentIds: [child.id],
          },
        }),
      ]),
    );

    const failed = patched.statusCode === 400 ? patched : created;
    const succeeded = patched.statusCode === 400 ? created : patched;
    expect(failed.statusCode, `${patched.body} / ${created.body}`).toBe(400);
    expectProblem(failed, 'INVALID_INPUT');
    expect([200, 201]).toContain(succeeded.statusCode);

    const childAfter = await get(child.id);
    if (succeeded === created) {
      const row = created.json<Agent>();
      createdIds.push(row.id);
      expect(childAfter.parentId).toBe(row.id);
      expect((await get(owner.id)).subAgentIds).toEqual([]);
    } else {
      expect(childAfter.parentId).toBe(owner.id);
      const list = await inject(app, { method: 'GET', url: '/api/agents', headers: { cookie } });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json<Agent[]>().some((agent) => agent.slug === slug)).toBe(false);
    }
  });

  /** 外部连接执行到一半的语句，卡在 holder 后面；同时验明卡的是哪条 SQL。 */
  const blockedOn = async (holder: number, pattern: RegExp): Promise<boolean> => {
    const { rows } = await app.pool.query<{ query: string }>(
      `select a.query from pg_stat_activity a
       where a.datname = current_database()
         and a.wait_event_type = 'Lock'
         and $1 = any(pg_blocking_pids(a.pid))`,
      [holder],
    );
    return rows.some((row) => pattern.test(row.query));
  };

  const backendPid = async (client: PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    return pid;
  };

  const childExists = async (id: string): Promise<boolean> => {
    const { rows } = await app.pool.query<{ n: number }>(
      'select count(*)::int as n from agents where id = $1',
      [id],
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  it('rejects a patch whose child is deleted after the repo read but before the claim', async () => {
    const parent = await newAgent();
    const child = await newAgent();
    const before = await get(parent.id);
    const versionsBefore = await versions(parent.id);

    const client = await app.pool.connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      await client.query('begin');
      const pid = await backendPid(client);
      // 只锁父行、不拿 advisory 锁：请求必须走完仓储校验才会停在这里。
      await client.query('select id from agents where id = $1 for update', [parent.id]);

      pending = patch(parent.id, { subAgentIds: [child.id], name: 'renamed-during-delete' });
      // 卡在父行 UPDATE 上，证明绑定校验已通过、已经进入写事务。
      const reached = await waitFor(() => blockedOn(pid, /^update "agents"/));
      expect(reached, 'patch never reached the parent row update').toBe(true);

      await app.pool.query('delete from agents where id = $1', [child.id]);
      await client.query('commit');

      const res = await pending;
      pending = undefined;
      expectProblem(res, 'INVALID_INPUT');
      expect(res.json<{ message: string }>().message).toContain('选中的子智能体已被删除');

      const after = await get(parent.id);
      expect(after.name).toBe(before.name);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await versions(parent.id)).toEqual(versionsBefore);
      expect(await childExists(child.id)).toBe(false);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await pending?.catch(() => undefined);
      client.release();
    }
  });

  it('rejects a create whose child is deleted while the root insert waits on its slug', async () => {
    const child = await newAgent();
    const slug = unique('reserved-root');
    createdSlugs.push(slug);

    const client = await app.pool.connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      await client.query('begin');
      const pid = await backendPid(client);
      // 未提交的同 slug 行把请求的 INSERT 挡在唯一索引上，但请求先完成校验。
      await client.query(
        `insert into agents (id, slug, name, model, system_prompt_md, created_by, owner_business_id) values ($1, $2, $3, $4, '', 'bootstrap-admin', 'bootstrap-admin')`,
        [unique('reservation'), slug, `Reservation ${slug}`, 'claude-sonnet-5-5'],
      );

      pending = inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: { cookie },
        payload: {
          slug,
          name: `Agent ${slug}`,
          systemPrompt: 'You are helpful.',
          subAgentIds: [child.id],
        },
      });
      const reached = await waitFor(() => blockedOn(pid, /^insert into "agents"/));
      expect(reached, 'create never reached the root insert').toBe(true);

      await app.pool.query('delete from agents where id = $1', [child.id]);
      await client.query('rollback');

      const res = await pending;
      pending = undefined;
      expectProblem(res, 'INVALID_INPUT');
      expect(res.json<{ message: string }>().message).toContain('选中的子智能体已被删除');

      const { rows } = await app.pool.query<{ agents: number; versions: number }>(
        `select count(distinct a.id)::int as agents, count(v.id)::int as versions
         from agents a left join agent_versions v on v.agent_id = a.id
         where a.slug = $1`,
        [slug],
      );
      expect(rows[0]).toEqual({ agents: 0, versions: 0 });
      expect(await childExists(child.id)).toBe(false);
    } finally {
      await client.query('rollback').catch(() => undefined);
      await pending?.catch(() => undefined);
      client.release();
    }
  });
});
