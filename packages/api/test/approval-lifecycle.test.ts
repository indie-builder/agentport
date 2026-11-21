import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { repo } from '@agentport/db';
import type { Server } from '@agentport/shared';
import { createApprovalEvaluator } from '../src/modules/servers/approval-policy.js';
import {
  ADMIN_BUSINESS_ID,
  cleanup,
  createAgent,
  createServer,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
  waitFor,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('approval lifecycle', () => {
  let app: TestApp;
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
    const tool = await repo.servers.createApiTool(app.db, {
      serverId: server.id,
      name: toolName,
      description: '',
      method: 'GET',
      pathTemplate: '/',
      inputSchema: {},
      paramsIn: 'query',
      approvalMode: 'ask',
    });
    const { decisionHash } = await createApprovalEvaluator({
      db: app.db,
      runId: run.id,
      serverId: server.id,
    })({ ...tool, method: 'GET' });
    const row = await app.db.transaction((tx) =>
      repo.runs.requestApproval(tx, {
        runId: run.id,
        serverId: server.id,
        toolName,
        decisionHash,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    return { runId: run.id, requestId: row.id };
  };

  const approve = (runId: string, payload: unknown) =>
    request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });

  const requestState = async (requestId: string) => {
    const res = await app.client.unsafe<{ approved_at: Date | null }[]>(
      'select approved_at from approval_requests where id = $1',
      [requestId],
    );
    return res[0];
  };

  const approvedAuditCount = async (runId: string): Promise<number> => {
    const res = await app.client.unsafe<{ count: number }[]>(
      "select count(*)::int as count from audit_log where action = 'agent.run.approved' and target = $1",
      [runId],
    );
    return res[0]?.count ?? 0;
  };

  it('approves a pending request while the run is running', async () => {
    const { runId, requestId } = await seed('running');
    const res = await approve(runId, { approvalId: requestId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ approvedAt: string }>().approvedAt).toEqual(expect.any(String));
    expect(await approvedAuditCount(runId)).toBe(1);
  });

  it.each(['queued', 'succeeded', 'failed', 'cancelled', 'timeout'] as const)(
    'rejects approval when the run is %s',
    async (status) => {
      const { runId, requestId } = await seed(status);
      expectProblem(await approve(runId, { approvalId: requestId }), 'CONFLICT');
      expect((await requestState(requestId))?.approved_at).toBeNull();
      expect(await approvedAuditCount(runId)).toBe(0);
    },
  );

  it('returns NOT_FOUND for a request that was never recorded', async () => {
    const { runId } = await seed('running');
    expectProblem(await approve(runId, { approvalId: unique('absent') }), 'NOT_FOUND', 'approval');
  });

  it('returns NOT_FOUND for an unknown run', async () => {
    expectProblem(
      await approve(unique('missing-run'), { approvalId: unique('approval') }),
      'NOT_FOUND',
      'run',
    );
  });

  it('keeps repeated approvals idempotent while running', async () => {
    const { runId, requestId } = await seed('running');
    const first = await approve(runId, { approvalId: requestId });
    expect(first.statusCode, first.body).toBe(200);
    const firstApprovedAt = (await requestState(requestId))?.approved_at;

    const second = await approve(runId, { approvalId: requestId });
    expect(second.statusCode, second.body).toBe(200);
    expect((await requestState(requestId))?.approved_at).toEqual(firstApprovedAt);
  });

  it('waits on the run row lock before deciding approval', async () => {
    const { runId, requestId } = await seed('running');
    const locker = await app.client.reserve();
    let settled = false;
    try {
      const own = await locker.unsafe<{ pid: number }[]>('select pg_backend_pid() as pid');
      const lockerPid = own[0]?.pid;
      await locker.unsafe('begin');
      await locker.unsafe("update agent_runs set status = 'cancelled' where id = $1", [runId]);

      const approval = approve(runId, { approvalId: requestId }).finally(() => {
        settled = true;
      });

      // 不以耗时判断：等 PostgreSQL 明确记录该后端正被本连接的行锁阻塞。
      const blocked = await waitFor(async () => {
        const res = await app.client.unsafe(
          `select pid from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%agent_runs%'
              and query ilike '%for update%'
              and $1 = any(pg_blocking_pids(pid))`,
          [lockerPid],
        );
        return res.length > 0;
      });
      expect(blocked, 'approval should wait on the run row lock').toBe(true);
      expect(settled).toBe(false);

      await locker.unsafe('commit');

      expectProblem(await approval, 'CONFLICT');
      expect((await requestState(requestId))?.approved_at).toBeNull();
      expect(await approvedAuditCount(runId)).toBe(0);
    } finally {
      await locker.unsafe('rollback').catch(() => undefined);
      locker.release();
    }
  });
});
