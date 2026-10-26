import { repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PoolClient } from 'pg';
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
/** 与仓储里的绑定锁同一个键。 */
const BINDING_LOCK = "select pg_advisory_xact_lock(hashtext('agentport.subagent-bindings'))";

const files = [
  { path: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'demo' }) },
  { path: 'skills/review/SKILL.md', content: '# review', executable: false },
];

describe.skipIf(!ready)('agent plugin bindings', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const pluginIds: string[] = [];

  const auth = () => ({ cookie });

  async function createPlugin(): Promise<{ id: string; slug: string }> {
    const slug = unique('plugin');
    const row = await repo.plugins.createPluginWithFiles(
      app.db,
      {
        slug,
        runtimeName: slug,
        name: slug,
        description: '',
        version: '',
        manifest: { skills: ['review'], agents: [], hasHooks: false, mcpServers: [] },
      },
      files,
    );
    pluginIds.push(row.id);
    return { id: row.id, slug: row.slug };
  }

  async function createAgent(payload: Record<string, unknown>): Promise<Agent> {
    const slug = unique('agent');
    agentSlugs.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Agent ${slug}`, ...payload },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Agent>();
  }

  const get = async (id: string): Promise<Agent> =>
    (await inject(app, { method: 'GET', url: `/api/agents/${id}`, headers: auth() })).json<Agent>();

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs });
    if (pluginIds.length > 0) {
      await app.pool.query('delete from plugins where id = any($1::text[])', [pluginIds]);
    }
    await app.close();
  });

  it('creates a top-level agent with plugin bindings', async () => {
    const plugin = await createPlugin();
    const agent = await createAgent({
      pluginBindings: [{ pluginId: plugin.id, allowHooks: true, allowMcp: false }],
    });
    expect(agent.parentId).toBeNull();
    expect(agent.pluginBindings).toEqual([
      { pluginId: plugin.id, allowHooks: true, allowMcp: false },
    ]);
    expect((await get(agent.id)).pluginBindings).toEqual(agent.pluginBindings);
  });

  it('rejects a rollback that would re-add bindings after the agent became a sub-agent', async () => {
    const plugin = await createPlugin();
    const bound = await createAgent({
      pluginBindings: [{ pluginId: plugin.id, allowHooks: false, allowMcp: false }],
    });

    // 解绑：旧绑定留在 v2 快照里。
    const unbound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${bound.id}`,
      headers: auth(),
      payload: { pluginBindings: [] },
    });
    expect(unbound.statusCode, unbound.body).toBe(200);
    expect(unbound.json<Agent>().pluginBindings).toEqual([]);
    const latestVersion = (
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${bound.id}/versions`,
        headers: auth(),
      })
    ).json<Array<{ version: number }>>()[0]?.version;
    expect(latestVersion).toBe(2);

    // 解绑后成为子智能体。
    const parent = await createAgent({ subAgentIds: [bound.id] });
    const versionsBefore = (
      await inject(app, {
        method: 'GET',
        url: `/api/agents/${bound.id}/versions`,
        headers: auth(),
      })
    ).json<Array<{ version: number }>>();

    // 回滚到带绑定的 v1 必须失败，且关系与配置都不变。
    const rollback = await inject(app, {
      method: 'POST',
      url: `/api/agents/${bound.id}/rollback`,
      headers: auth(),
      payload: { version: 1 },
    });
    expectProblem(rollback, 'INVALID_INPUT');

    const after = await get(bound.id);
    expect(after.parentId).toBe(parent.id);
    expect(after.pluginBindings).toEqual([]);
    expect(after.name).toBe(bound.name);
    expect(
      (
        await inject(app, {
          method: 'GET',
          url: `/api/agents/${bound.id}/versions`,
          headers: auth(),
        })
      ).json<Array<{ version: number }>>(),
    ).toEqual(versionsBefore);
  });

  it('rejects binding a plugin to a sub-agent directly', async () => {
    const plugin = await createPlugin();
    const child = await createAgent({});
    await createAgent({ subAgentIds: [child.id] });

    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${child.id}`,
      headers: auth(),
      payload: { pluginBindings: [{ pluginId: plugin.id, allowHooks: false, allowMcp: false }] },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect((await get(child.id)).pluginBindings).toEqual([]);
  });

  it('rejects adopting an agent that still has plugin bindings', async () => {
    const plugin = await createPlugin();
    const bound = await createAgent({
      pluginBindings: [{ pluginId: plugin.id, allowHooks: true, allowMcp: true }],
    });

    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug: unique('parent'), name: 'Parent', subAgentIds: [bound.id] },
    });
    expectProblem(res, 'INVALID_INPUT');
    expect((await get(bound.id)).parentId).toBeNull();
    expect((await get(bound.id)).pluginBindings).toHaveLength(1);
  });

  const backendPid = async (client: PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    return pid;
  };

  /** 卡在 holder 后面、正在执行的语句；据此判断事务停在哪一步。 */
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

  /** 一个没被行锁占住的 agent 行才能 nowait 拿到；否则抛 55P03。 */
  const rowIsFree = async (id: string): Promise<boolean> => {
    const client = await app.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from agents where id = $1 for update nowait', [id]);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    inject(app, { method: 'PATCH', url: `/api/agents/${id}`, headers: auth(), payload });

  /**
   * 死锁回归：插件绑定事务必须「先 advisory、后 agent 行锁」。
   * 外部事务占住 advisory，绑定请求就会停在这把锁上；此时 agent 行必须仍然可 nowait 拿到，
   * 证明它还没先行锁。随后放行，委派事务一起完成，不出现 40P01。
   */
  it('takes the binding lock before the agent row lock', async () => {
    const plugin = await createPlugin();
    const bound = await createAgent({});
    const parent = await createAgent({});

    const holder = await app.pool.connect();
    let binding: Promise<LightMyRequestResponse> | undefined;
    let delegation: Promise<LightMyRequestResponse> | undefined;
    try {
      await holder.query('begin');
      const holderPid = await backendPid(holder);
      await holder.query(BINDING_LOCK);

      binding = patch(bound.id, {
        pluginBindings: [{ pluginId: plugin.id, allowHooks: true, allowMcp: false }],
      });
      expect(
        await waitFor(() => blockedOn(holderPid, /pg_advisory_xact_lock/), 3_000),
        'plugin binding never waited on the advisory lock',
      ).toBe(true);
      expect(
        await rowIsFree(bound.id),
        'plugin binding locked the agent row before the advisory lock',
      ).toBe(true);

      delegation = patch(parent.id, { subAgentIds: [bound.id] });
      expect(
        await waitFor(() => blockedOn(holderPid, /pg_advisory_xact_lock/), 3_000),
        'delegation never waited on the advisory lock',
      ).toBe(true);

      await holder.query('commit');

      const [bindRes, delegateRes] = await Promise.all([binding, delegation]);
      binding = undefined;
      delegation = undefined;
      expect(
        [bindRes.statusCode, delegateRes.statusCode].sort((x, y) => x - y),
        `${bindRes.body} / ${delegateRes.body}`,
      ).toEqual([200, 400]);

      const after = await get(bound.id);
      if (bindRes.statusCode === 200) {
        expect(after.parentId).toBeNull();
        expect(after.pluginBindings).toEqual([
          { pluginId: plugin.id, allowHooks: true, allowMcp: false },
        ]);
        expectProblem(delegateRes, 'INVALID_INPUT');
      } else {
        expect(after.parentId).toBe(parent.id);
        expect(after.pluginBindings).toEqual([]);
        expectProblem(bindRes, 'INVALID_INPUT');
      }
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await binding?.catch(() => undefined);
      await delegation?.catch(() => undefined);
    }
  }, 10_000);

  /**
   * 克隆会照抄源绑定；旧实现在 FOR SHARE 源行之后才拿 advisory，与「先 advisory 再改行」
   * 的委派事务互等。这里同样用外部 advisory 占位，证明克隆还没锁源行，放行后正常完成。
   */
  it('takes the binding lock before locking the duplicate source', async () => {
    const plugin = await createPlugin();
    const source = await createAgent({
      pluginBindings: [{ pluginId: plugin.id, allowHooks: true, allowMcp: false }],
    });

    const holder = await app.pool.connect();
    let clone: Promise<LightMyRequestResponse> | undefined;
    try {
      await holder.query('begin');
      const holderPid = await backendPid(holder);
      await holder.query(BINDING_LOCK);

      const slug = unique('cloned');
      agentSlugs.push(slug);
      clone = inject(app, {
        method: 'POST',
        url: `/api/agents/${source.id}/duplicate`,
        headers: auth(),
        payload: { slug, name: `Clone ${slug}` },
      });
      expect(
        await waitFor(() => blockedOn(holderPid, /pg_advisory_xact_lock/), 3_000),
        'clone never waited on the advisory lock',
      ).toBe(true);
      expect(
        await rowIsFree(source.id),
        'clone locked the source row (FOR SHARE) before the advisory lock',
      ).toBe(true);

      await holder.query('commit');

      const res = await clone;
      clone = undefined;
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<Agent>().pluginBindings).toEqual([
        { pluginId: plugin.id, allowHooks: true, allowMcp: false },
      ]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await clone?.catch(() => undefined);
    }
  }, 10_000);
});
