import { repo } from '@agentport/db';
import type { Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

/** 直接建 run（不经过队列），避免 worker 把状态从 running 改走。 */
async function seedRun(app: FastifyInstance, agentId: string): Promise<string> {
  const conversationId = unique('wait-conv');
  const runId = unique('wait-run');
  await app.pool.query('insert into conversations (id, agent_id) values ($1, $2)', [
    conversationId,
    agentId,
  ]);
  await app.pool.query(
    "insert into agent_runs (id, conversation_id, agent_id, status) values ($1, $2, $3, 'running')",
    [runId, conversationId, agentId],
  );
  return runId;
}

describe.skipIf(!ready)('approval wait state', () => {
  let app: FastifyInstance;
  let cookie: string;
  let server: Server;
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    server = await createServer(app, cookie, { name: unique('wait-srv'), track: serverNames });
  });

  afterAll(async () => {
    await cleanup(app, { serverNames, agentSlugs, runIds });
    await app.close();
  });

  const seed = async () => {
    const agent = (
      await createAgent(app, cookie, {
        slug: unique('wait-agent'),
        serverIds: [server.id],
        track: agentSlugs,
      })
    ).json<{ id: string }>();
    const runId = await seedRun(app, agent.id);
    runIds.push(runId);
    return { runId, toolName: unique('tool') };
  };

  const list = async (runId: string) => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/runs/${runId}/approvals`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      items: Array<{ toolName: string; expiresAt: string | null; waiting: boolean }>;
    }>().items;
  };

  const approve = (runId: string, toolName: string) =>
    inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { serverId: server.id, toolName },
    });

  it('lists future, past and null deadlines with the right waiting state', async () => {
    const { runId } = await seed();
    const future = unique('future');
    const past = unique('past');
    const none = unique('none');
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName: future,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName: past,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await repo.runs.requestApproval(app.db, { runId, serverId: server.id, toolName: none });

    const items = await list(runId);
    const byName = new Map(items.map((item) => [item.toolName, item]));
    expect(byName.get(future)).toMatchObject({ waiting: true, expiresAt: expect.any(String) });
    expect(byName.get(past)).toMatchObject({ waiting: false, expiresAt: expect.any(String) });
    expect(byName.get(none)).toMatchObject({ waiting: false, expiresAt: null });

    // 批准不改截止时间：过期的仍不等待，未来的继续等待。
    expect((await approve(runId, past)).json<{ waiting: boolean }>().waiting).toBe(false);
    expect((await approve(runId, future)).json<{ waiting: boolean }>().waiting).toBe(true);
    expect((await approve(runId, none)).json<{ waiting: boolean }>().waiting).toBe(false);
  });

  it('extends but never shortens an unapproved deadline, and keeps approvals immutable', async () => {
    const { runId, toolName } = await seed();
    const deadline = new Date(Date.now() + 60_000);
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName,
      expiresAt: deadline,
    });

    // 更早的重复请求不能缩短正在等待的调用。
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName,
      expiresAt: new Date(Date.now() + 1_000),
    });
    expect((await list(runId))[0]?.expiresAt).toBe(deadline.toISOString());

    // 更晚的重复请求延长等待。
    const later = new Date(deadline.getTime() + 60_000);
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName,
      expiresAt: later,
    });
    expect((await list(runId))[0]?.expiresAt).toBe(later.toISOString());

    // 已批准的行不再被重复请求改动。
    expect((await approve(runId, toolName)).statusCode).toBe(200);
    await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName,
      expiresAt: new Date(Date.now() + 120_000),
    });
    const [row] = await app.pool
      .query<{ expires_at: Date; approved_at: Date | null }>(
        'select expires_at, approved_at from approval_requests where run_id = $1',
        [runId],
      )
      .then((res) => res.rows);
    expect(row?.expires_at).toEqual(later);
    expect(row?.approved_at).not.toBeNull();
  });
});
