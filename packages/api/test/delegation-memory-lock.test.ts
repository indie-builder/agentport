import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  seedRun,
  startApp,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

// 与 personal-memory.test.ts 共用会话级锁：两者都会以管理员身份写 memory_changes。
const MEMORY_TEST_LOCK = 'agentport.memory-tests';

describe.skipIf(!ready)('delegation memory occupancy', () => {
  let app: FastifyInstance;
  let cookie: string;
  let workspaces: string;
  let releaseLock: (() => Promise<void>) | undefined;
  const createdSlugs: string[] = [];
  const agentIds: string[] = [];
  const runIds: string[] = [];
  const scheduleIds: string[] = [];

  async function acquireMemoryLock(pool: FastifyInstance['pool']): Promise<() => Promise<void>> {
    const client = await pool.connect();
    // 等锁可能超过连接默认的 statement_timeout。
    await client.query('set statement_timeout = 0');
    await client.query('select pg_advisory_lock(hashtext($1))', [MEMORY_TEST_LOCK]);
    return async () => {
      await client.query('select pg_advisory_unlock(hashtext($1))', [MEMORY_TEST_LOCK]);
      client.release();
    };
  }

  beforeAll(async () => {
    // macOS 的 tmpdir 是符号链接；记忆文件写入会拒绝符号链接路径。
    workspaces = await mkdtemp(join(await realpath(tmpdir()), 'delegation-memory-'));
    app = await startApp({ WORKSPACES_DIR: workspaces });
    // 有 worker 消费时排队 run 会被真实执行，chat 准入断言失去意义。
    expect(await queueIdle, 'worker must be stopped before admission tests').toBe(true);
    releaseLock = await acquireMemoryLock(app.pool);
    cookie = await loginCookie(app);
  }, 60_000);

  afterEach(async () => {
    if (runIds.length > 0) {
      await app.pool.query('delete from agent_runs where id = any($1::text[])', [runIds]);
      runIds.length = 0;
    }
    if (scheduleIds.length > 0) {
      await app.pool.query('delete from agent_schedules where id = any($1::text[])', [scheduleIds]);
      scheduleIds.length = 0;
    }
    // 每次清理本用例产生的运行，避免下一条用例看到残留占用。
    await app.pool.query('delete from agent_runs where agent_id = any($1::text[])', [agentIds]);
  });

  afterAll(async () => {
    try {
      await cleanup(app, { agentSlugs: createdSlugs, runIds });
    } finally {
      await releaseLock?.();
      await app.close();
      await rm(workspaces, { recursive: true, force: true });
    }
  });

  const newAgent = async (prefix: string): Promise<Agent> => {
    const res = await createAgent(app, cookie, { slug: unique(prefix), track: createdSlugs });
    const agent = res.json<Agent>();
    agentIds.push(agent.id);
    return agent;
  };

  const bind = async (parentId: string, subAgentIds: string[]): Promise<void> => {
    const res = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${parentId}`,
      headers: { cookie },
      payload: { subAgentIds },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const patch = (id: string, payload: Record<string, unknown>) =>
    inject(app, { method: 'PATCH', url: `/api/agents/${id}`, headers: { cookie }, payload });

  const putMemory = (agentId: string, content = 'note') =>
    inject(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/memory/MEMORY.md`,
      headers: { cookie },
      payload: { content },
    });

  const seedRunning = async (agentId: string): Promise<void> => {
    const seeded = await seedRun(app, agentId);
    runIds.push(seeded.runId);
  };

  const insertSchedule = async (agentId: string): Promise<string> => {
    const id = newId('schedule');
    scheduleIds.push(id);
    await app.pool.query(
      `insert into agent_schedules
         (id, agent_id, name, created_by, execute_as_business_id, cron, prompt, enabled)
       values ($1, $2, $3,
         (select business_id from "user" where username = 'admin'),
         (select business_id from "user" where username = 'admin'),
         '* * * * *', 'tick', true)`,
      [id, agentId, `schedule-${id}`],
    );
    return id;
  };

  const backendPid = async (client: PoolClient): Promise<number> => {
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    return pid;
  };

  /** 等待图里的明确信号：某后端确实卡在 holder 的锁上，且卡的是指定语句。 */
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

  it('occupies an enabled child while the parent runs and still allows ordinary saves', async () => {
    const parent = await newAgent('deleg-parent');
    const child = await newAgent('deleg-child');
    const unrelated = await newAgent('deleg-unrelated');
    await bind(parent.id, [child.id]);
    await seedRunning(parent.id);

    expectProblem(await putMemory(child.id), 'CONFLICT');
    expect((await putMemory(unrelated.id)).statusCode).toBe(200);

    // 普通字段保存、无关专家、以及不改变集合的同一绑定都保持可用。
    expect((await patch(parent.id, { description: 'during-run' })).statusCode).toBe(200);
    expect((await patch(parent.id, { subAgentIds: [child.id] })).statusCode).toBe(200);
    expect((await patch(unrelated.id, { name: 'renamed-during-run' })).statusCode).toBe(200);

    // 启停、解绑、删除都会改变活动集合。
    expectProblem(await patch(child.id, { enabled: false }), 'CONFLICT');
    expectProblem(await patch(parent.id, { subAgentIds: [] }), 'CONFLICT');
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/agents/${child.id}`,
        headers: { cookie },
      }),
      'CONFLICT',
    );
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/agents/${parent.id}`,
        headers: { cookie },
      }),
      'CONFLICT',
    );
    expect(
      (
        await inject(app, {
          method: 'DELETE',
          url: `/api/agents/${unrelated.id}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(204);
  });

  it('occupies only the running child itself, not its parent', async () => {
    const parent = await newAgent('deleg-parent');
    const child = await newAgent('deleg-child');
    await bind(parent.id, [child.id]);
    await seedRunning(child.id);

    expectProblem(await putMemory(child.id), 'CONFLICT');
    expect((await putMemory(parent.id)).statusCode).toBe(200);
    // 普通字段保存不改变活动集合，运行中仍然允许。
    expect((await patch(child.id, { name: 'child-renamed' })).statusCode).toBe(200);
    expectProblem(await patch(child.id, { enabled: false }), 'CONFLICT');
    expectProblem(
      await inject(app, {
        method: 'DELETE',
        url: `/api/agents/${parent.id}`,
        headers: { cookie },
      }),
      'CONFLICT',
    );
  });

  it('rejects claiming a running agent as a child', async () => {
    const free = await newAgent('deleg-free');
    await seedRunning(free.id);
    const slug = unique('deleg-created');
    createdSlugs.push(slug);

    const res = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug,
        name: `Agent ${slug}`,
        systemPrompt: 'You are helpful.',
        subAgentIds: [free.id],
      },
    });
    expectProblem(res, 'CONFLICT');
  });

  it('a schedule claim occupies the initiator and its enabled children', async () => {
    const parent = await newAgent('deleg-sched-parent');
    const enabledChild = await newAgent('deleg-sched-enabled');
    const disabledChild = await newAgent('deleg-sched-disabled');
    await bind(parent.id, [enabledChild.id, disabledChild.id]);
    expect((await patch(disabledChild.id, { enabled: false })).statusCode).toBe(200);

    const scheduleId = await insertSchedule(parent.id);
    const claim = await repo.ops.claimScheduleTrigger(app.db, {
      scheduleId,
      runId: newId('run'),
      conversationId: newId('conversation'),
      messageId: newId('message'),
      triggerAt: Date.now(),
    });
    expect(claim).toBe('claimed');

    expectProblem(await putMemory(parent.id), 'CONFLICT');
    expectProblem(await putMemory(enabledChild.id), 'CONFLICT');
    // 停用的子级不在本次运行的资源集合内。
    expect((await putMemory(disabledChild.id)).statusCode).toBe(200);
  });

  it('blocks a schedule claim while a delegated child memory lock is held', async () => {
    const parent = await newAgent('deleg-lock-parent');
    const child = await newAgent('deleg-lock-child');
    await bind(parent.id, [child.id]);
    const scheduleId = await insertSchedule(parent.id);

    const client = await app.pool.connect();
    let pending: Promise<'claimed' | 'duplicate' | 'agent_disabled'> | undefined;
    try {
      await client.query('begin');
      const holder = await backendPid(client);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent:${child.id}`]);
      pending = repo.ops.claimScheduleTrigger(app.db, {
        scheduleId,
        runId: newId('run'),
        conversationId: newId('conversation'),
        messageId: newId('message'),
        triggerAt: Date.now(),
      });
      const blocked = await waitFor(() => blockedOn(holder, /pg_advisory_xact_lock/));
      expect(blocked, 'claim never entered the child memory lock').toBe(true);
      await client.query('commit');
      expect(await pending).toBe('claimed');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pending?.catch(() => undefined);
    }
  });

  it('blocks chat admission while a delegated child memory lock is held', async () => {
    const parent = await newAgent('deleg-chat-parent');
    const child = await newAgent('deleg-chat-child');
    await bind(parent.id, [child.id]);

    const client = await app.pool.connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      const holder = await backendPid(client);
      await client.query('select pg_advisory_lock(hashtext($1))', [`agent:${child.id}`]);
      pending = inject(app, {
        method: 'POST',
        url: '/api/chat',
        headers: { cookie },
        payload: { agentId: parent.id, message: 'hello' },
      });
      const blocked = await waitFor(() => blockedOn(holder, /pg_advisory_xact_lock/));
      expect(blocked, 'chat admission never entered the child memory lock').toBe(true);

      await client.query('select pg_advisory_unlock(hashtext($1))', [`agent:${child.id}`]);
      const res = await pending;
      pending = undefined;
      expect(res.statusCode, res.body).toBe(202);
      const { runId } = res.json<{ runId: string }>();
      runIds.push(runId);
      const { rows } = await app.pool.query<{ status: string; trigger: string }>(
        'select status, trigger from agent_runs where id = $1',
        [runId],
      );
      expect(rows[0]).toEqual({ status: 'queued', trigger: 'chat' });
      const { getQueue } = await import('../src/queue/producer.js');
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    } finally {
      await client.query('select pg_advisory_unlock_all()').catch(() => undefined);
      client.release();
      await pending?.catch(() => undefined);
    }
  });

  it('does not let a review run occupy memory or delegation', async () => {
    const parent = await newAgent('deleg-review-parent');
    const child = await newAgent('deleg-review-child');
    await bind(parent.id, [child.id]);
    const { runId } = await seedRun(app, child.id);
    runIds.push(runId);
    await app.pool.query("update agent_runs set trigger = 'review' where id = $1", [runId]);

    // 审核 run 不挂可写目录，不占记忆，也不阻止改变委派集合。
    expect((await putMemory(child.id)).statusCode).toBe(200);
    expect((await patch(parent.id, { subAgentIds: [] })).statusCode).toBe(200);
    const after = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}`,
      headers: { cookie },
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json<Agent>().subAgentIds).toEqual([]);
  });

  it('rejects re-enabling a disabled child while its parent has an execution run', async () => {
    const parent = await newAgent('deleg-enable-parent');
    const child = await newAgent('deleg-enable-child');
    await bind(parent.id, [child.id]);
    expect((await patch(child.id, { enabled: false })).statusCode).toBe(200);
    await seedRunning(parent.id);

    expectProblem(await patch(child.id, { enabled: true }), 'CONFLICT');
  });
});
