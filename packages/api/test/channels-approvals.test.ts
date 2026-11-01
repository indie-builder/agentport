import type { AddressInfo } from 'node:net';
import { hashMcpToken } from '@agentport/core';
import { repo } from '@agentport/db';
import type { Channel, Server } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  createTestAccount,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  type TestAccount,
  testConfig,
  unique,
} from './helpers.js';

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
  let app: FastifyInstance;
  let adminCookie: string;
  let baseUrl: string;
  let redis: Redis;
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
    // 审批不挂起：调用立即落 pending 行并返回拒绝文本，事件与行都能立刻断言。
    app = await startApp({ APPROVAL_WAIT_MS: '0' });
    adminCookie = await loginCookie(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    redis = new Redis(testConfig().REDIS_URL);
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
    if (channelIds.length > 0) {
      await app.pool
        .query('delete from channels where id = any($1::text[])', [channelIds])
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
    await app.pool.query('delete from audit_log where actor = any($1::text[])', [businessIds]);
    await app.pool.query('delete from audit_log where target = any($1::text[])', [channelIds]);
    await app.pool.query('delete from user_roles where business_id = any($1::text[])', [
      businessIds,
    ]);
    await app.pool.query('delete from "user" where business_id = any($1::text[])', [businessIds]);
    await redis.quit().catch(() => undefined);
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST',
    url: string,
    cookie: string,
    payload?: Record<string, unknown>,
  ) =>
    inject(app, {
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

  /** 频道成员齐全的频道：owner / viewer / member / admin 各一个。 */
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

  /** 直接落一条频道 run；审批 API 只读 agent_runs.channel_id 与状态/触发者。 */
  const seedRun = async (
    channelId: string,
    trigger: TestAccount,
    status: 'queued' | 'running' | 'succeeded' = 'running',
  ): Promise<string> => {
    const conversationId = unique('approval-conv');
    const runId = unique('approval-run');
    await app.pool.query(
      'insert into conversations (id, agent_id, created_by) values ($1, $2, $3)',
      [conversationId, agentId, trigger.businessId],
    );
    await app.pool.query(
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
    const row = await repo.runs.requestApproval(app.db, {
      runId,
      serverId: server.id,
      toolName,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    return { id: row.id, toolName };
  };

  const listApprovals = (channelId: string, cookie: string) =>
    call('GET', `/api/channels/${channelId}/approvals`, cookie);

  const approve = (channelId: string, approvalId: string, cookie: string) =>
    call('POST', `/api/channels/${channelId}/approvals/${approvalId}/approve`, cookie);

  const approvalState = async (
    approvalId: string,
  ): Promise<{ approved_at: Date | null; approved_by_business_id: string | null } | undefined> => {
    const res = await app.pool.query<{
      approved_at: Date | null;
      approved_by_business_id: string | null;
    }>('select approved_at, approved_by_business_id from approval_requests where id = $1', [
      approvalId,
    ]);
    return res.rows[0];
  };

  const approvedAuditCount = async (runId: string): Promise<number> => {
    const res = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from audit_log where action = 'agent.run.approved' and target = $1",
      [runId],
    );
    return res.rows[0]?.count ?? 0;
  };

  it('lists pending approvals for every real member including viewer and hides non-members', async () => {
    const channel = await setupChannel();
    const runId = await seedRun(channel.id, owner);
    const pending = await requestApproval(runId, {
      expiresAt: new Date(Date.now() + 60_000),
      toolName: 'pending-tool',
    });
    // 已决定、已过期、run 已终态的审批都不在列表里。
    const expired = await requestApproval(runId, { toolName: 'past-tool' });
    await app.pool.query(
      "update approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [expired.id],
    );
    const decided = await requestApproval(runId, { toolName: 'decided-tool' });
    await app.pool.query('update approval_requests set approved_at = now() where id = $1', [
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

    // 非成员严格 404，平台管理员非成员也不能借平台权限读取。
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

    // 触发该 run 的普通 member 也可以批准自己的 run。
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
    await app.pool.query(
      "update approval_requests set expires_at = now() - interval '1 second' where id = $1",
      [expired.id],
    );
    expectProblem(await approve(channel.id, expired.id, owner.cookie), 'CONFLICT');
    expect((await approvalState(expired.id))?.approved_at).toBeNull();

    const terminalRun = await seedRun(channel.id, owner, 'succeeded');
    const terminal = await requestApproval(terminalRun, { toolName: 'terminal' });
    expectProblem(await approve(channel.id, terminal.id, owner.cookie), 'CONFLICT');
    expect((await approvalState(terminal.id))?.approved_at).toBeNull();

    // 已批准后再次批准同样 409，不会重复写审计。
    const active = await requestApproval(runningRun, { toolName: 'active' });
    expect((await approve(channel.id, active.id, owner.cookie)).statusCode).toBe(200);
    expectProblem(await approve(channel.id, active.id, channelAdmin.cookie), 'CONFLICT');
    expect(await approvedAuditCount(runningRun)).toBe(1);
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
      requiresApproval: true,
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
    const row = await app.pool.query<{ token: string }>(
      "select config->>'mcpToken' as token from servers where id = $1",
      [server.id],
    );
    const serverToken = row.rows[0]?.token ?? '';
    expect(serverToken).not.toBe('');

    const callTool = async (): Promise<{
      isError?: boolean;
      content: Array<{ text?: string }>;
    }> => {
      const client = new Client({ name: 'agentport-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server.id}`), {
        requestInit: {
          headers: { authorization: `Bearer ${serverToken}`, 'x-agentport-run-id': runId },
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

    const [approval] = await app.pool
      .query<{ id: string; channel_id: string }>(
        'select id, channel_id from approval_requests where run_id = $1 and tool_name = $2',
        [runId, toolName],
      )
      .then((res) => res.rows);
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

    // 发布失败只影响实时提示：调用照常返回审批文本，审批行仍 pending。
    const pipeline = vi.spyOn(Redis.prototype, 'pipeline').mockImplementationOnce(() => {
      throw new Error('redis down');
    });
    try {
      const afterFailure = await callTool();
      expect(afterFailure.isError).toBe(true);
      expect(afterFailure.content[0]?.text).toContain(`需要批准：${toolName}`);
    } finally {
      pipeline.mockRestore();
    }
    expect((await approvalState(approval.id))?.approved_at).toBeNull();
  });
});
