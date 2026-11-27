import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { repo } from '@agentport/db';
import type { Server } from '@agentport/shared';
import { createApprovalEvaluator } from '../src/modules/runs/approval-policy.js';
import {
  cleanup,
  createAgent,
  createServer,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

async function seedRun(app: TestApp, agentId: string): Promise<string> {
  const conversationId = unique('wait-conv');
  const runId = unique('wait-run');
  await app.client.unsafe(
    "insert into conversations (id, agent_id, created_by) values ($1, $2, 'bootstrap-admin')",
    [conversationId, agentId],
  );
  await app.client.unsafe(
    "insert into agent_runs (id, conversation_id, agent_id, status, subject_kind, initiated_by) values ($1, $2, $3, 'running', 'user', 'bootstrap-admin')",
    [runId, conversationId, agentId],
  );
  return runId;
}

describe.skipIf(!ready)('approval wait state', () => {
  let app: TestApp;
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
    const res = await request(app, {
      method: 'GET',
      url: `/api/runs/${runId}/approvals`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      items: Array<{ toolName: string; expiresAt: string | null; waiting: boolean }>;
    }>().items;
  };

  const approve = (runId: string, approvalId: string) =>
    request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { approvalId },
    });

  const register = async (runId: string, toolName: string, expiresAt?: Date) => {
    const tool =
      (await repo.servers.getApiToolByName(app.db, server.id, toolName)) ??
      (await repo.servers.createApiTool(app.db, {
        serverId: server.id,
        name: toolName,
        description: '',
        method: 'GET',
        pathTemplate: '/',
        inputSchema: {},
        paramsIn: 'query',
        approvalMode: 'ask',
      }));
    const { decisionHash } = await createApprovalEvaluator({
      db: app.db,
      runId,
      serverId: server.id,
    })({ ...tool, method: 'GET' });
    return app.db.transaction((tx) =>
      repo.runs.requestApproval(tx, {
        runId,
        serverId: server.id,
        toolName,
        decisionHash,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    );
  };

  it('lists future, past and null deadlines with the right waiting state', async () => {
    const { runId } = await seed();
    const future = unique('future');
    const past = unique('past');
    const none = unique('none');
    const waiting = await register(runId, future, new Date(Date.now() + 60_000));
    const expired = await register(runId, past, new Date(Date.now() - 1_000));
    const noDeadline = await register(runId, none);

    const items = await list(runId);
    const byName = new Map(items.map((item) => [item.toolName, item]));
    expect(byName.get(future)).toMatchObject({ waiting: true, expiresAt: expect.any(String) });
    expect(byName.get(past)).toMatchObject({ waiting: false, expiresAt: expect.any(String) });
    expect(byName.get(none)).toMatchObject({ waiting: false, expiresAt: null });

    expect((await approve(runId, expired.id)).statusCode).toBe(409);
    const replacement = await register(runId, past, new Date(Date.now() + 60_000));
    expect(replacement.id).not.toBe(expired.id);
    expect((await approve(runId, expired.id)).statusCode).toBe(409);
    expect((await approve(runId, replacement.id)).statusCode).toBe(200);
    expect((await approve(runId, waiting.id)).json<{ waiting: boolean }>().waiting).toBe(true);
    expect((await approve(runId, noDeadline.id)).json<{ waiting: boolean }>().waiting).toBe(false);
  });

  it('fixes the first deadline across retries, and keeps approvals immutable', async () => {
    const { runId, toolName } = await seed();
    const deadline = new Date(Date.now() + 60_000);
    const first = await register(runId, toolName, deadline);
    expect((await register(runId, toolName, new Date(Date.now() + 1_000))).id).toBe(first.id);
    expect((await list(runId))[0]?.expiresAt).toBe(deadline.toISOString());

    const later = new Date(deadline.getTime() + 60_000);
    expect((await register(runId, toolName, later)).id).toBe(first.id);
    expect((await list(runId))[0]?.expiresAt).toBe(deadline.toISOString());

    expect((await approve(runId, first.id)).statusCode).toBe(200);
    expect((await register(runId, toolName, later)).id).toBe(first.id);
    const [row] = await app.client
      .unsafe<{ expires_at: Date; approved_at: Date | null }[]>(
        'select expires_at, approved_at from approval_requests where run_id = $1',
        [runId],
      )
      .then((res) => res);
    expect(row?.expires_at).toEqual(deadline);
    expect(row?.approved_at).not.toBeNull();
  });
});
