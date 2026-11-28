import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Channel, Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RedisClient } from 'bun';
import { createApprovalEvaluator } from '../src/modules/runs/approval-policy.js';
import {
  cleanup,
  createAgent,
  createServer,
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestAccount,
  type TestApp,
  testConfig,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

const ready = await infraReady;

interface ApprovalItem {
  id: string;
  channelId: string;
  runId: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
}

describe.skipIf(!ready)('channel approvals', () => {
  let app: TestApp;
  let listener: TestServer;
  let adminCookie: string;
  let baseUrl: string;
  let redis: RedisClient;
  let owner: TestAccount;
  let member: TestAccount;
  let viewer: TestAccount;
  let channelAdmin: TestAccount;
  let outsider: TestAccount;
  let agentId: string;
  let server: Server;
  const channelIds: string[] = [];
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
    listener = await listen(app);
    baseUrl = listener.url;
    redis = new RedisClient(testConfig().REDIS_URL);
    owner = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    member = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    viewer = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    channelAdmin = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    outsider = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    server = await createServer(app, adminCookie, {
      name: unique('approval-srv'),
      track: serverNames,
    });
    const agent = await createAgent(app, adminCookie, {
      slug: unique('approval-agent'),
      serverIds: [server.id],
      track: agentSlugs,
    });
    agentId = agent.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await listener.close();
    if (channelIds.length > 0) {
      await app.client
        .unsafe('delete from channels where id = any($1::text[])', [
          app.client.array(channelIds, 'TEXT'),
        ])
        .catch(() => undefined);
    }
    await cleanup(app, { serverNames, agentSlugs });
    const businessIds = [
      owner.businessId,
      member.businessId,
      viewer.businessId,
      channelAdmin.businessId,
      outsider.businessId,
    ];
    await app.client.unsafe('delete from audit_log where actor = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    await app.client.unsafe('delete from audit_log where target = any($1::text[])', [
      app.client.array(channelIds, 'TEXT'),
    ]);
    await app.client.unsafe('delete from user_roles where business_id = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    await app.client.unsafe('delete from "user" where business_id = any($1::text[])', [
      app.client.array(businessIds, 'TEXT'),
    ]);
    redis.close();
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST',
    url: string,
    cookie: string,
    payload?: Record<string, unknown>,
  ) =>
    request(app, {
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });

  const createChannel = async (cookie: string): Promise<Channel> => {
    const res = await call('POST', '/api/channels', cookie, { name: unique('approval-ch') });
    expect(res.statusCode, res.body).toBe(201);
    const channel = res.json<Channel>();
    channelIds.push(channel.id);
    return channel;
  };

  const addMember = (
    channelId: string,
    account: TestAccount,
    role: MemberRole,
  ): Promise<{ statusCode: number; body: string }> =>
    call('POST', `/api/channels/${channelId}/members`, owner.cookie, {
      businessId: account.businessId,
      role,
    });

  const setupChannel = async (): Promise<Channel> => {
    const channel = await createChannel(owner.cookie);
    for (const [account, role] of [
      [viewer, 'viewer'],
      [member, 'member'],
      [channelAdmin, 'admin'],
    ] as const) {
      const res = await addMember(channel.id, account, role);
      expect(res.statusCode, res.body).toBe(201);
    }
    return channel;
  };

  const seedRun = async (
    channelId: string,
    trigger: TestAccount,
    status: 'queued' | 'running' | 'succeeded' = 'running',
  ): Promise<string> => {
    const [binding] = await app.client.unsafe<{ conversation_id: string | null }[]>(
      'select conversation_id from channel_agent_bindings where channel_id = $1 and agent_id = $2',
      [channelId, agentId],
    );
    let conversationId = binding?.conversation_id ?? null;
    if (conversationId === null) {
      conversationId = unique('approval-conv');
      await app.client.unsafe(
        'insert into conversations (id, agent_id, created_by, channel_id) values ($1, $2, $3, $4)',
        [conversationId, agentId, trigger.businessId, channelId],
      );
      await app.client.unsafe(
        `insert into channel_agent_bindings
           (channel_id, agent_id, conversation_id, status, added_by)
         values ($1, $2, $3, 'active', $4)`,
        [channelId, agentId, conversationId, trigger.businessId],
      );
    }
    const runId = unique('approval-run');
    await app.client.unsafe(
      `insert into agent_runs
         (id, conversation_id, agent_id, channel_id, trigger, status, subject_kind, initiated_by)
       values ($1, $2, $3, $4, 'channel', $5, 'user', $6)`,
      [runId, conversationId, agentId, channelId, status, trigger.businessId],
    );
    return runId;
  };

  const requestApproval = async (
    runId: string,
    options: { toolName?: string; expiresAt?: Date | null } = {},
  ): Promise<{ id: string; toolName: string }> => {
    const toolName = options.toolName ?? unique('tool');
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
    const [run] = await app.client.unsafe<{ status: string }[]>(
      'select status from agent_runs where id = $1',
      [runId],
    );
    const { decisionHash } =
      run?.status === 'running'
        ? await createApprovalEvaluator({
            db: app.db,
            runId,
            serverId: server.id,
          })({ ...tool, method: 'GET' })
        : { decisionHash: unique('stale-hash') };
    const row = await app.db.transaction((tx) =>
      repo.runs.requestApproval(tx, {
        runId,
        serverId: server.id,
        toolName,
        decisionHash,
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      }),
    );
    return { id: row.id, toolName };
  };

  const listApprovals = (channelId: string, cookie: string) =>
    call('GET', `/api/channels/${channelId}/approvals`, cookie);

  const approve = (channelId: string, approvalId: string, cookie: string) =>
    call('POST', `/api/channels/${channelId}/approvals/${approvalId}/approve`, cookie);

  const approvalState = async (
    approvalId: string,
  ): Promise<{ approved_at: Date | null; approved_by_business_id: string | null } | undefined> => {
    const res = await app.client.unsafe<
      {
        approved_at: Date | null;
        approved_by_business_id: string | null;
      }[]
    >('select approved_at, approved_by_business_id from approval_requests where id = $1', [
      approvalId,
    ]);
    return res[0];
  };

  const approvedAuditCount = async (runId: string): Promise<number> => {
    const res = await app.client.unsafe<{ count: number }[]>(
      "select count(*)::int as count from audit_log where action = 'agent.run.approved' and target = $1",
      [runId],
    );
    return res[0]?.count ?? 0;
  };

  it('lists pending approvals for every real member including viewer and hides non-members', async () => {
    const channel = await setupChannel();
    const runId = await seedRun(channel.id, owner);
    const pending = await requestApproval(runId, {
      expiresAt: new Date(Date.now() + 60_000),
      toolName: 'pending-tool',
    });
    const expired = await requestApproval(runId, { toolName: 'past-tool' });
    await app.client.unsafe(
      "update approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [expired.id],
    );
    const decided = await requestApproval(runId, { toolName: 'decided-tool' });
    await app.client.unsafe('update approval_requests set approved_at = now() where id = $1', [
      decided.id,
    ]);
    const terminalRun = await seedRun(channel.id, owner, 'succeeded');
    await requestApproval(terminalRun, { toolName: 'terminal-tool' });

    for (const account of [owner, member, viewer, channelAdmin]) {
      const res = await listApprovals(channel.id, account.cookie);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ items: ApprovalItem[] }>().items).toMatchObject([
        expect.objectContaining({
          id: pending.id,
          channelId: channel.id,
          runId,
          serverId: server.id,
          serverName: server.name,
          toolName: 'pending-tool',
          approvedAt: null,
        }),
      ]);
    }

    for (const cookie of [outsider.cookie, adminCookie]) {
      expectProblem(await listApprovals(channel.id, cookie), 'NOT_FOUND');
    }
  });

  it('lets owners/admins approve and rejects viewers and unrelated members', async () => {
    const channel = await setupChannel();
    const ownerRun = await seedRun(channel.id, owner);
    const ownerApproval = await requestApproval(ownerRun);

    expectProblem(await approve(channel.id, ownerApproval.id, viewer.cookie), 'FORBIDDEN');
    expectProblem(await approve(channel.id, ownerApproval.id, member.cookie), 'FORBIDDEN');
    expect((await approvalState(ownerApproval.id))?.approved_at).toBeNull();

    const accepted = await approve(channel.id, ownerApproval.id, channelAdmin.cookie);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<ApprovalItem>()).toMatchObject({
      id: ownerApproval.id,
      channelId: channel.id,
      runId: ownerRun,
      approvedAt: expect.any(String),
    });
    expect(await approvalState(ownerApproval.id)).toMatchObject({
      approved_by_business_id: channelAdmin.businessId,
    });
    expect(await approvedAuditCount(ownerRun)).toBe(1);

    const memberRun = await seedRun(channel.id, member);
    const memberApproval = await requestApproval(memberRun);
    const memberAccepted = await approve(channel.id, memberApproval.id, member.cookie);
    expect(memberAccepted.statusCode, memberAccepted.body).toBe(200);
    expect(await approvalState(memberApproval.id)).toMatchObject({
      approved_by_business_id: member.businessId,
    });
  });

  it('rejects expired approvals and approvals on terminal runs', async () => {
    const channel = await setupChannel();
    const runningRun = await seedRun(channel.id, owner);
    const expired = await requestApproval(runningRun, { toolName: 'expired' });
    await app.client.unsafe(
      "update approval_requests set expires_at = now() - interval '1 second' where id = $1",
      [expired.id],
    );
    expectProblem(await approve(channel.id, expired.id, owner.cookie), 'CONFLICT');
    expect((await approvalState(expired.id))?.approved_at).toBeNull();

    const terminalRun = await seedRun(channel.id, owner, 'succeeded');
    const terminal = await requestApproval(terminalRun, { toolName: 'terminal' });
    expectProblem(await approve(channel.id, terminal.id, owner.cookie), 'CONFLICT');
    expect((await approvalState(terminal.id))?.approved_at).toBeNull();

    const active = await requestApproval(runningRun, { toolName: 'active' });
    expect((await approve(channel.id, active.id, owner.cookie)).statusCode).toBe(200);
    expectProblem(await approve(channel.id, active.id, channelAdmin.cookie), 'CONFLICT');
    expect(await approvedAuditCount(runningRun)).toBe(1);

    const stale = await requestApproval(runningRun, { toolName: 'stale' });
    const policy = await call('POST', '/api/security/tool-policies', adminCookie, {
      serverId: server.id,
      httpMethod: 'GET',
      approvalMode: 'ask',
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const { id: policyId } = policy.json<{ id: string }>();
    try {
      expectProblem(await approve(channel.id, stale.id, owner.cookie), 'CONFLICT');
      expectProblem(
        await call('POST', `/api/channels/${channel.id}/approvals/${stale.id}/deny`, owner.cookie),
        'CONFLICT',
      );
      expect((await approvalState(stale.id))?.approved_at).toBeNull();
    } finally {
      await repo.toolApprovalPolicies.delete(app.db, policyId);
    }
  });

  it('returns 404 for an approval id from another channel', async () => {
    const first = await setupChannel();
    const second = await createChannel(member.cookie);
    const runId = await seedRun(first.id, member);
    const approval = await requestApproval(runId);

    expectProblem(await approve(second.id, approval.id, member.cookie), 'NOT_FOUND');
    expect((await approvalState(approval.id))?.approved_at).toBeNull();

    const listed = await listApprovals(second.id, member.cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: ApprovalItem[] }>().items).toEqual([]);
  });

  it('serializes concurrent approvals to exactly one winner', async () => {
    const channel = await setupChannel();
    const runId = await seedRun(channel.id, owner);
    const approval = await requestApproval(runId);

    const [first, second] = await Promise.all([
      approve(channel.id, approval.id, owner.cookie),
      approve(channel.id, approval.id, channelAdmin.cookie),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const winner = first.statusCode === 200 ? owner : channelAdmin;
    expect(await approvalState(approval.id)).toMatchObject({
      approved_by_business_id: winner.businessId,
    });
    expect(await approvedAuditCount(runId)).toBe(1);
  });

  it('publishes approval.requested to the channel stream and survives a publish failure', async () => {
    const channel = await setupChannel();
    const toolName = unique('mcp-approval-tool');
    const created = await call('POST', `/api/servers/${server.id}/tools`, adminCookie, {
      name: toolName,
      method: 'GET',
      pathTemplate: '/users/{id}',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
      paramsIn: 'query',
      approvalMode: 'ask',
    });
    expect(created.statusCode, created.body).toBe(201);

    const token = unique('mcp-run-token');
    const runId = await seedRun(channel.id, owner);
    await repo.runs.setRunMcpToken(
      app.db,
      runId,
      hashMcpToken(token),
      new Date(Date.now() + 60_000),
    );
    const callTool = async (): Promise<{
      isError?: boolean;
      content: Array<{ text?: string }>;
    }> => {
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-agentport-run-id': runId },
        },
      });
      try {
        await client.connect(transport);
        return await client.callTool({ name: toolName, arguments: { id: 1 } });
      } finally {
        await client.close();
      }
    };

    const denied = await callTool();
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain(`需要批准：${toolName}`);

    const [approval] = await app.client
      .unsafe<{ id: string; channel_id: string }[]>(
        'select id, channel_id from approval_requests where run_id = $1 and tool_name = $2',
        [runId, toolName],
      )
      .then((res) => res);
    if (!approval) throw new Error('approval row was not persisted');
    expect(approval.channel_id).toBe(channel.id);

    const entries = await redis.xrange(`channel:${channel.id}:events`, '-', '+');
    const events = entries.map(
      (entry) => JSON.parse(entry[1][1] ?? '{}') as Record<string, unknown>,
    );
    expect(events).toContainEqual({
      type: 'approval.requested',
      channelId: channel.id,
      runId,
      approvalId: approval.id,
      toolName,
    });

    const originalSend = RedisClient.prototype.send;
    let failed = false;
    const publishSpy = spyOn(RedisClient.prototype, 'send').mockImplementation(function (
      this: RedisClient,
      command: string,
      args: string[],
    ) {
      if (!failed && command === 'XADD' && String(args[0]).includes(channel.id)) {
        failed = true;
        return Promise.reject(new Error('redis down'));
      }
      return originalSend.call(this, command, args);
    });
    try {
      const afterFailure = await callTool();
      expect(afterFailure.isError).toBe(true);
      expect(afterFailure.content[0]?.text).toContain(`需要批准：${toolName}`);
    } finally {
      publishSpy.mockRestore();
    }
    expect((await approvalState(approval.id))?.approved_at).toBeNull();
  });
});
