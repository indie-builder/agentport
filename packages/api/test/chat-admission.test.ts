import { repo } from '@agentport/db';
import type { Agent } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  queueIdle,
  startApp,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

const ACTIVE = ['queued', 'running'] as const;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timeout'] as const;

describe.skipIf(!ready)('chat admission', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    // 有 worker 消费时等待中的 run 会被真实执行，状态断言失去意义。
    expect(await queueIdle, 'worker must be stopped before chat admission tests').toBe(true);
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    const { getQueue } = await import('../src/queue/producer.js');
    for (const runId of runIds) {
      await getQueue()
        .getJob(runId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }
    await cleanup(app, { agentSlugs: createdAgents, runIds });
    await app.close();
  });

  const newAgent = async (): Promise<Agent> =>
    (
      await createAgent(app, cookie, { slug: unique('admit-agent'), track: createdAgents })
    ).json<Agent>();

  const newConversation = async (agentId: string): Promise<string> =>
    (
      await repo.chat.createConversation(app.db, {
        id: unique('admit-conv'),
        agentId,
        title: 'admission',
      })
    ).id;

  const post = (agentId: string, conversationId: string, message: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/chat',
      headers: { cookie },
      payload: { agentId, conversationId, message },
    });

  const runCount = async (conversationId: string): Promise<number> => {
    const res = await app.pool.query<{ count: string }>(
      'select count(*) from agent_runs where conversation_id = $1',
      [conversationId],
    );
    return Number(res.rows[0]?.count);
  };

  const userMessageCount = async (conversationId: string): Promise<number> => {
    const res = await app.pool.query<{ count: string }>(
      "select count(*) from messages where conversation_id = $1 and role = 'user'",
      [conversationId],
    );
    return Number(res.rows[0]?.count);
  };

  const requestedAuditCount = async (conversationId: string): Promise<number> => {
    const res = await app.pool.query<{ count: string }>(
      `select count(*) from audit_log
        where action = 'agent.run.requested'
          and target in (select id from agent_runs where conversation_id = $1)`,
      [conversationId],
    );
    return Number(res.rows[0]?.count);
  };

  const seedRun = async (
    conversationId: string,
    agentId: string,
    status: (typeof ACTIVE)[number] | (typeof TERMINAL)[number],
  ): Promise<string> => {
    const run = await repo.chat.createRun(app.db, {
      id: unique('admit-run'),
      conversationId,
      agentId,
    });
    runIds.push(run.id);
    if (status !== 'queued') {
      await repo.chat.updateRun(app.db, run.id, {
        status,
        ...(status === 'running' ? {} : { endedAt: new Date() }),
      });
    }
    return run.id;
  };

  it('admits exactly one of two concurrent posts to the same conversation', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);

    const [first, second] = await Promise.all([
      post(agent.id, conversationId, 'first question'),
      post(agent.id, conversationId, 'second question'),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 409]);

    const accepted = first.statusCode === 202 ? first : second;
    const rejected = first.statusCode === 409 ? first : second;
    const { runId } = accepted.json<{ runId: string }>();
    runIds.push(runId);

    expectProblem(rejected, 'CONFLICT');
    expect(await runCount(conversationId)).toBe(1);
    expect(await userMessageCount(conversationId)).toBe(1);
    expect(await requestedAuditCount(conversationId)).toBe(1);
  });

  for (const status of ACTIVE) {
    it(`rejects a new post while the conversation has a ${status} run`, async () => {
      const agent = await newAgent();
      const conversationId = await newConversation(agent.id);
      await seedRun(conversationId, agent.id, status);

      const res = await post(agent.id, conversationId, 'too early');
      expectProblem(res, 'CONFLICT');

      expect(await runCount(conversationId)).toBe(1);
      expect(await userMessageCount(conversationId)).toBe(0);
      expect(await requestedAuditCount(conversationId)).toBe(0);
    });
  }

  for (const status of TERMINAL) {
    it(`admits a new post after the conversation's last run ${status}`, async () => {
      const agent = await newAgent();
      const conversationId = await newConversation(agent.id);
      await seedRun(conversationId, agent.id, status);

      const res = await post(agent.id, conversationId, 'next question');
      expect(res.statusCode, res.body).toBe(202);
      const { runId } = res.json<{ runId: string }>();
      runIds.push(runId);

      expect(await runCount(conversationId)).toBe(2);
      expect(await userMessageCount(conversationId)).toBe(1);
      expect(await requestedAuditCount(conversationId)).toBe(1);
    });
  }

  it('does not reject parallel posts to different conversations', async () => {
    const agent = await newAgent();
    const [left, right] = await Promise.all([newConversation(agent.id), newConversation(agent.id)]);

    const [a, b] = await Promise.all([
      post(agent.id, left, 'left question'),
      post(agent.id, right, 'right question'),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    runIds.push(a.json<{ runId: string }>().runId, b.json<{ runId: string }>().runId);

    expect(await runCount(left)).toBe(1);
    expect(await runCount(right)).toBe(1);
  });

  it('admits one of two racing posts and queues only ids plus the new prompt', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    await repo.chat.appendMessage(app.db, {
      id: unique('admit-msg'),
      conversationId,
      role: 'assistant',
      content: { type: 'text', text: 'noted earlier' },
    });

    const [first, second] = await Promise.all([
      post(agent.id, conversationId, 'latest question'),
      post(agent.id, conversationId, 'latest question'),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 409]);
    const accepted = first.statusCode === 202 ? first : second;
    const { runId } = accepted.json<{ runId: string }>();
    runIds.push(runId);

    const { getQueue } = await import('../src/queue/producer.js');
    const job = await getQueue().getJob(runId);
    expect(job?.data).toEqual({
      runId,
      agentId: agent.id,
      conversationId,
      prompt: 'latest question',
    });
    // 续聊身份在准入时就固定：平台生成的 uuid 与用户消息一一对应。
    const [stored] = await app.pool
      .query<{ sdk_message_uuid: string }>(
        "select sdk_message_uuid from messages where run_id = $1 and role = 'user'",
        [runId],
      )
      .then((result) => result.rows);
    expect(stored?.sdk_message_uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('waits on the conversation row lock before admitting the run', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const locker = await app.pool.connect();
    const lockerPid = (await locker.query<{ pid: number }>('select pg_backend_pid() as pid'))
      .rows[0]?.pid;

    try {
      await locker.query('begin');
      await locker.query('select id from conversations where id = $1 for update', [conversationId]);

      const pending = post(agent.id, conversationId, 'queued behind a lock');
      const blocked = await waitFor(async () => {
        const res = await app.pool.query(
          `select pid from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%conversations%'
              and query ilike '%for update%'
              and $1 = any(pg_blocking_pids(pid))`,
          [lockerPid],
        );
        return (res.rowCount ?? 0) > 0;
      });
      expect(blocked, 'POST /api/chat must wait on the conversation row lock').toBe(true);
      expect(await runCount(conversationId)).toBe(0);

      await locker.query('commit');

      const res = await pending;
      expect(res.statusCode, res.body).toBe(202);
      runIds.push(res.json<{ runId: string }>().runId);
      expect(await runCount(conversationId)).toBe(1);
    } finally {
      await locker.query('rollback').catch(() => undefined);
      locker.release();
    }
  });

  it('checks the agent before taking the conversation lock, so a concurrent delete cannot deadlock', async () => {
    const agent = await newAgent();
    const conversationId = await newConversation(agent.id);
    const locker = await app.pool.connect();
    const probe = await app.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const own = await locker.query<{ pid: number }>('select pg_backend_pid() as pid');
      const lockerPid = own.rows[0]?.pid;
      await locker.query('begin');
      await locker.query('select id from agents where id = $1 for update', [agent.id]);

      pending = repo.chat
        .admitChatRun(app.db, { agentId: agent.id, message: 'racing delete', conversationId })
        .then(
          (value) => value,
          (error: unknown) => error,
        );

      const blocked = await waitFor(async () => {
        const res = await app.pool.query(
          `select pid from pg_stat_activity
            where wait_event_type = 'Lock'
              and $1 = any(pg_blocking_pids(pid))`,
          [lockerPid],
        );
        return (res.rowCount ?? 0) > 0;
      });
      expect(blocked, 'admission must wait on the agent row').toBe(true);
      expect(await runCount(conversationId)).toBe(0);

      // 等待中的准入不得持有会话行锁；否则与 DELETE agents 的级联锁形成环。
      await probe.query('begin');
      await expect(
        probe.query('select id from conversations where id = $1 for update nowait', [
          conversationId,
        ]),
      ).resolves.toBeDefined();
      await probe.query('rollback');

      await locker.query('delete from agents where id = $1', [agent.id]);
      await locker.query('commit');

      expect(await pending).toMatchObject({
        code: 'AGENT_NOT_FOUND',
        message: '智能体不存在，可能已被删除；请刷新后重新选择',
      });
    } finally {
      await locker.query('rollback').catch(() => undefined);
      locker.release();
      await probe.query('rollback').catch(() => undefined);
      probe.release();
      // 失败路径下准入可能仍在排队；等它落地再让 cleanup 删 agent。
      await pending;
    }
  });
});
