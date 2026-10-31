import { repo } from '@agentport/db';
import type { Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
  waitFor,
  ADMIN_BUSINESS_ID, } from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('approval lifecycle', () => {
  let app: FastifyInstance;
  let cookie: string;
  let server: Server;
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    server = await createServer(app, cookie, {
      name: unique('lifecycle-srv'),
      track: serverNames,
    });
  });

  afterAll(async () => {
    await cleanup(app, { serverNames, agentSlugs, runIds });
    await app.close();
  });

  /** 走真实 repo：会话 + run + 一条待批准请求，run 状态由用例给定。 */
  const seed = async (
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout',
  ) => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('lifecycle-agent'),
        serverIds: [server.id],
        track: agentSlugs,
      })
    ).json<{ id: string }>();
    const conversation = await repo.chat.createConversation(app.db, {
      id: unique('lifecycle-conv'),
      agentId: agent.id,
      title: 'approval lifecycle',
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
});
    const run = await repo.chat.createRun(app.db, {
      id: unique('lifecycle-run'),
      conversationId: conversation.id,
      agentId: agent.id,
      subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
    });
    runIds.push(run.id);
    await repo.chat.updateRun(app.db, run.id, { status });
    const toolName = unique('tool');
    await repo.runs.requestApproval(app.db, {
      runId: run.id,
      serverId: server.id,
      toolName,
    });
    const [request] = await app.pool
      .query<{ id: string }>('select id from approval_requests where run_id = $1', [run.id])
      .then((res) => res.rows);
    if (!request) throw new Error('approval request was not inserted');
    return { runId: run.id, requestId: request.id, toolName };
  };

  const approve = (runId: string, payload: unknown) =>
    inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });

  const requestState = async (requestId: string) => {
    const res = await app.pool.query<{ approved_at: Date | null }>(
      'select approved_at from approval_requests where id = $1',
      [requestId],
    );
    return res.rows[0];
  };

  const approvedAuditCount = async (runId: string): Promise<number> => {
    const res = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from audit_log where action = 'agent.run.approved' and target = $1",
      [runId],
    );
    return res.rows[0]?.count ?? 0;
  };

  it('approves a pending request while the run is running', async () => {
    const { runId, toolName } = await seed('running');
    const res = await approve(runId, { serverId: server.id, toolName });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ approvedAt: string }>().approvedAt).toEqual(expect.any(String));
    expect(await approvedAuditCount(runId)).toBe(1);
  });

  it.each(['queued', 'succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'rejects approval when the run is %s',
    async (status) => {
      const { runId, requestId, toolName } = await seed(status);
      expectProblem(await approve(runId, { serverId: server.id, toolName }), 'CONFLICT');
      expect((await requestState(requestId))?.approved_at).toBeNull();
      expect(await approvedAuditCount(runId)).toBe(0);
    },
  );

  it('returns APPROVAL_NOT_FOUND for a request that was never recorded', async () => {
    const { runId } = await seed('running');
    expectProblem(
      await approve(runId, { serverId: server.id, toolName: unique('absent') }),
      'APPROVAL_NOT_FOUND',
    );
  });

  it('returns RUN_NOT_FOUND for an unknown run', async () => {
    expectProblem(
      await approve(unique('missing-run'), { serverId: server.id, toolName: unique('tool') }),
      'RUN_NOT_FOUND',
    );
  });

  it('keeps repeated approvals idempotent while running', async () => {
    const { runId, requestId, toolName } = await seed('running');
    const first = await approve(runId, { serverId: server.id, toolName });
    expect(first.statusCode, first.body).toBe(200);
    const firstApprovedAt = (await requestState(requestId))?.approved_at;

    const second = await approve(runId, { serverId: server.id, toolName });
    expect(second.statusCode, second.body).toBe(200);
    expect((await requestState(requestId))?.approved_at).toEqual(firstApprovedAt);
  });

  it('waits on the run row lock before deciding approval', async () => {
    const { runId, requestId, toolName } = await seed('running');
    // 独立连接持有未提交的状态变更，模拟 cancel / worker 的并发写入。
    const locker = await app.pool.connect();
    let settled = false;
    try {
      const own = await locker.query<{ pid: number }>('select pg_backend_pid() as pid');
      const lockerPid = own.rows[0]?.pid;
      await locker.query('begin');
      await locker.query("update agent_runs set status = 'cancelled' where id = $1", [runId]);

      const approval = approve(runId, { serverId: server.id, toolName }).finally(() => {
        settled = true;
      });

      // 不以耗时判断：等 PostgreSQL 明确记录该后端正被本连接的行锁阻塞。
      const blocked = await waitFor(async () => {
        const res = await app.pool.query(
          `select pid from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%agent_runs%'
              and query ilike '%for update%'
              and $1 = any(pg_blocking_pids(pid))`,
          [lockerPid],
        );
        return res.rowCount !== null && res.rowCount > 0;
      });
      expect(blocked, 'approval should wait on the run row lock').toBe(true);
      expect(settled).toBe(false);

      await locker.query('commit');

      expectProblem(await approval, 'CONFLICT');
      expect((await requestState(requestId))?.approved_at).toBeNull();
      expect(await approvedAuditCount(runId)).toBe(0);
    } finally {
      await locker.query('rollback').catch(() => undefined);
      locker.release();
    }
  });
});
