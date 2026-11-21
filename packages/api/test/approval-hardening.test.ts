import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { hashMcpToken } from '@agentport/core';
import { toolApprovalResponseSchema } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import {
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestAccount,
  type TestApp,
  unique,
} from './helpers.js';
import { listen, type TestServer } from './server.js';

const ready = await infraReady;
const isolated = ready ? await createIsolatedDatabase('approval_hardening_') : null;

describe.skipIf(!ready || isolated === null)('approval hardening', () => {
  let app: TestApp;
  let cookie: string;
  let listener: TestServer;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    app = await startApp({ DATABASE_URL: isolated.url });
    cookie = await loginCookie(app);
    listener = await listen(app);
  });

  afterAll(async () => {
    await listener.close();
    await app.close();
    await isolated?.close();
  });

  const createServer = async (baseUrl: string) => {
    const res = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: unique('hard-srv'), kind: 'generated', baseUrl },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  };

  const createTool = async (
    serverId: string,
    input: { name: string; approvalMode: 'allow' | 'ask' | 'deny' },
  ) => {
    const res = await request(app, {
      method: 'POST',
      url: `/api/servers/${serverId}/tools`,
      headers: { cookie },
      payload: {
        name: input.name,
        method: 'GET',
        pathTemplate: `/${input.name}`,
        approvalMode: input.approvalMode,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; name: string }>();
  };

  const createAgent = async (input: { serverIds?: string[]; subAgentIds?: string[] }) => {
    const res = await request(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: unique('hard-agent'),
        name: 'Hardening agent',
        systemPrompt: 'You are helpful.',
        ...input,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  };

  const publish = async (agentId: string): Promise<number> => {
    const res = await request(app, {
      method: 'POST',
      url: `/api/agents/${agentId}/publish`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const published = res.json<{ publishedVersion: number | null }>().publishedVersion;
    if (published === null) throw new Error('publish did not set a version');
    return published;
  };

  const createChannel = async (): Promise<{ id: string }> => {
    const res = await request(app, {
      method: 'POST',
      url: '/api/channels',
      headers: { cookie },
      payload: { name: unique('hard-channel') },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>();
  };

  const addMember = async (
    channelId: string,
    account: TestAccount,
    role: 'owner' | 'admin' | 'member' | 'viewer',
  ) => {
    const res = await request(app, {
      method: 'POST',
      url: `/api/channels/${channelId}/members`,
      headers: { cookie },
      payload: { businessId: account.businessId, role },
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  const seedRun = async (input: {
    agentId: string;
    businessId: string;
    token: string;
    agentVersion?: number;
    channelId?: string;
    conversationId?: string;
    binding?: boolean;
  }) => {
    const conversationId = input.conversationId ?? unique('hard-conv');
    if (input.conversationId === undefined) {
      await app.client.unsafe(
        'insert into conversations (id, agent_id, created_by, channel_id) values ($1, $2, $3, $4)',
        [conversationId, input.agentId, input.businessId, input.channelId ?? null],
      );
    }
    if (input.channelId !== undefined && input.binding !== false) {
      await app.client.unsafe(
        `insert into channel_agent_bindings
           (channel_id, agent_id, conversation_id, status, added_by)
         values ($1, $2, $3, 'active', $4)`,
        [input.channelId, input.agentId, conversationId, input.businessId],
      );
    }
    const runId = unique('hard-run');
    await app.client.unsafe(
      `insert into agent_runs
         (id, conversation_id, agent_id, status, trigger, channel_id, subject_kind, initiated_by,
          agent_version, mcp_token_hash, mcp_token_expires_at, started_at)
       values ($1, $2, $3, 'running', $4, $5, 'user', $6, $7, $8, $9, $10)`,
      [
        runId,
        conversationId,
        input.agentId,
        input.channelId === undefined ? 'chat' : 'channel',
        input.channelId ?? null,
        input.businessId,
        input.agentVersion ?? null,
        hashMcpToken(input.token),
        new Date(Date.now() + 5 * 60_000).toISOString(),
        new Date(),
      ],
    );
    return { runId, conversationId };
  };

  const callTool = async (input: {
    serverId: string;
    runId: string;
    token: string;
    name: string;
  }) => {
    const client = new Client({ name: 'hardening', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${listener.url}/mcp/${input.serverId}`), {
          requestInit: {
            headers: {
              authorization: `Bearer ${input.token}`,
              'x-agentport-run-id': input.runId,
            },
          },
        }),
      );
      return await client.callTool({ name: input.name, arguments: {} });
    } finally {
      await client.close();
    }
  };

  const approvalState = async (input: {
    runId: string;
    serverId: string;
    name: string;
    token: string;
    method: 'PUT' | 'GET';
    approvalId?: string;
  }) => {
    const query = input.approvalId === undefined ? '' : `?approvalId=${input.approvalId}`;
    const res = await request(app, {
      method: input.method,
      url: `/tool-approvals/${input.runId}/${input.serverId}/${input.name}${query}`,
      headers: {
        authorization: `Bearer ${input.token}`,
        'x-agentport-run-id': input.runId,
      },
      ...(input.method === 'PUT' ? { payload: {} } : {}),
    });
    return res;
  };

  it('rejects an active run after its current tool definition is deleted', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(upstream.url.origin);
    const tool = await createTool(server.id, {
      name: unique('deleted-tool'),
      approvalMode: 'allow',
    });
    const policy = await request(app, {
      method: 'POST',
      url: '/api/security/tool-policies',
      headers: { cookie },
      payload: { serverId: server.id, toolId: tool.id, approvalMode: 'deny' },
    });
    expect(policy.statusCode, policy.body).toBe(201);

    const agent = await createAgent({ serverIds: [server.id] });
    const version = await publish(agent.id);
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: agent.id,
      businessId: 'bootstrap-admin',
      token,
      agentVersion: version,
    });

    const denied = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(denied.isError).toBe(true);
    expect(upstreamCalls).toBe(0);

    const removed = await request(app, {
      method: 'DELETE',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const missing = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(missing.isError).toBe(true);
    expect(upstreamCalls).toBe(0);
  });

  it('rejects a child snapshot deny that the live tool relaxed to allow', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(upstream.url.origin);
    const tool = await createTool(server.id, { name: unique('drift-tool'), approvalMode: 'deny' });
    const child = await createAgent({ serverIds: [server.id] });
    await publish(child.id);
    const relaxed = await request(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: { cookie },
      payload: { approvalMode: 'allow' },
    });
    expect(relaxed.statusCode, relaxed.body).toBe(200);

    const root = await createAgent({ subAgentIds: [child.id] });
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: root.id,
      businessId: 'bootstrap-admin',
      token,
    });

    const denied = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(denied.isError).toBe(true);
    expect(upstreamCalls).toBe(0);

    await publish(child.id);
    const republished = await callTool({
      serverId: server.id,
      runId,
      token,
      name: tool.name,
    }).catch(() => null);
    expect(republished?.isError ?? true).toBe(true);
    expect(upstreamCalls).toBe(0);
  });

  it('stops a channel run once its initiator is demoted to viewer', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(upstream.url.origin);
    const tool = await createTool(server.id, {
      name: unique('channel-tool'),
      approvalMode: 'allow',
    });
    const agent = await createAgent({ serverIds: [server.id] });
    const channel = await createChannel();
    const member = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    await addMember(channel.id, member, 'member');
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: agent.id,
      businessId: member.businessId,
      token,
      channelId: channel.id,
    });

    const allowed = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(allowed.isError).toBeFalsy();
    expect(upstreamCalls).toBe(1);

    await app.client.unsafe(
      "update channel_members set role = 'viewer' where channel_id = $1 and business_id = $2",
      [channel.id, member.businessId],
    );
    const denied = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(denied.isError).toBe(true);
    expect(upstreamCalls).toBe(1);
  });

  it('stops a channel run after the channel is archived or its binding is disabled', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(upstream.url.origin);
    const tool = await createTool(server.id, { name: unique('guard-tool'), approvalMode: 'allow' });
    const agent = await createAgent({ serverIds: [server.id] });
    const member = await createTestAccount(app, cookie, { systemKeys: ['user'] });

    const archivedChannel = await createChannel();
    await addMember(archivedChannel.id, member, 'member');
    const archivedToken = crypto.randomUUID();
    const archivedRun = await seedRun({
      agentId: agent.id,
      businessId: member.businessId,
      token: archivedToken,
      channelId: archivedChannel.id,
    });
    expect(
      (
        await callTool({
          serverId: server.id,
          runId: archivedRun.runId,
          token: archivedToken,
          name: tool.name,
        })
      ).isError,
    ).toBeFalsy();
    expect(upstreamCalls).toBe(1);
    await app.client.unsafe('update channels set archived_at = now() where id = $1', [
      archivedChannel.id,
    ]);
    expect(
      (
        await callTool({
          serverId: server.id,
          runId: archivedRun.runId,
          token: archivedToken,
          name: tool.name,
        })
      ).isError,
    ).toBe(true);
    expect(upstreamCalls).toBe(1);

    const disabledChannel = await createChannel();
    await addMember(disabledChannel.id, member, 'member');
    const disabledToken = crypto.randomUUID();
    const disabledRun = await seedRun({
      agentId: agent.id,
      businessId: member.businessId,
      token: disabledToken,
      channelId: disabledChannel.id,
    });
    await app.client.unsafe(
      "update channel_agent_bindings set status = 'disconnected' where channel_id = $1",
      [disabledChannel.id],
    );
    expect(
      (
        await callTool({
          serverId: server.id,
          runId: disabledRun.runId,
          token: disabledToken,
          name: tool.name,
        })
      ).isError,
    ).toBe(true);
    expect(upstreamCalls).toBe(1);

    const orphanToken = crypto.randomUUID();
    const orphanRun = await seedRun({
      agentId: agent.id,
      businessId: member.businessId,
      token: orphanToken,
    });
    await app.client.unsafe("update agent_runs set trigger = 'channel' where id = $1", [
      orphanRun.runId,
    ]);
    expect(
      (
        await callTool({
          serverId: server.id,
          runId: orphanRun.runId,
          token: orphanToken,
          name: tool.name,
        })
      ).isError,
    ).toBe(true);
    expect(upstreamCalls).toBe(1);
  });

  it('keeps the original deny when one of two children sharing a server republishes', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(upstream.url.origin);
    const tool = await createTool(server.id, { name: unique('shared-tool'), approvalMode: 'deny' });
    const first = await createAgent({ serverIds: [server.id] });
    await publish(first.id);
    const second = await createAgent({ serverIds: [server.id] });
    await publish(second.id);
    const root = await createAgent({ subAgentIds: [first.id, second.id] });
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: root.id,
      businessId: 'bootstrap-admin',
      token,
    });

    const relaxed = await request(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: { cookie },
      payload: { approvalMode: 'allow' },
    });
    expect(relaxed.statusCode, relaxed.body).toBe(200);
    await publish(first.id);
    const denied = await callTool({ serverId: server.id, runId, token, name: tool.name }).catch(
      () => null,
    );
    expect(denied?.isError ?? true).toBe(true);
    expect(upstreamCalls).toBe(0);
  });

  it('invalidates a fixed approval when the outbound base URL changes', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    using first = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        firstCalls += 1;
        return Response.json({ ok: true });
      },
    });
    using second = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        secondCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const server = await createServer(first.url.origin);
    const tool = await createTool(server.id, {
      name: unique('base-url-tool'),
      approvalMode: 'ask',
    });
    const agent = await createAgent({ serverIds: [server.id] });
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: agent.id,
      businessId: 'bootstrap-admin',
      token,
    });

    const pending = toolApprovalResponseSchema.parse(
      (
        await approvalState({ runId, serverId: server.id, name: tool.name, token, method: 'PUT' })
      ).json(),
    );
    expect(pending.status).toBe('pending');
    if (pending.approvalId === null) throw new Error('approval missing');
    const approved = await request(app, {
      method: 'POST',
      url: `/api/runs/${runId}/approve`,
      headers: { cookie },
      payload: { approvalId: pending.approvalId },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const before = await approvalState({
      runId,
      serverId: server.id,
      name: tool.name,
      token,
      method: 'GET',
      approvalId: pending.approvalId,
    });
    expect(before.statusCode, before.body).toBe(200);

    const moved = await request(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}`,
      headers: { cookie },
      payload: { baseUrl: second.url.origin },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    expectProblem(
      await approvalState({
        runId,
        serverId: server.id,
        name: tool.name,
        token,
        method: 'GET',
        approvalId: pending.approvalId,
      }),
      'CONFLICT',
    );
    const blocked = await callTool({ serverId: server.id, runId, token, name: tool.name });
    expect(blocked.isError).toBe(true);
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(0);

    const replacement = toolApprovalResponseSchema.parse(
      (
        await approvalState({ runId, serverId: server.id, name: tool.name, token, method: 'PUT' })
      ).json(),
    );
    if (replacement.approvalId === null || replacement.approvalId === pending.approvalId)
      throw new Error('replacement approval missing');
    expect(
      (
        await request(app, {
          method: 'POST',
          url: `/api/runs/${runId}/approve`,
          headers: { cookie },
          payload: { approvalId: replacement.approvalId },
        })
      ).statusCode,
    ).toBe(200);
    expectProblem(
      await approvalState({
        runId,
        serverId: server.id,
        name: tool.name,
        token,
        method: 'GET',
        approvalId: pending.approvalId,
      }),
      'CONFLICT',
    );
    expect(
      (await callTool({ serverId: server.id, runId, token, name: tool.name })).isError,
    ).toBeFalsy();
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
  });

  it('returns 409 for a registered approval once its tool is deleted', async () => {
    const server = await createServer('http://127.0.0.1:9');
    const tool = await createTool(server.id, { name: unique('gone-tool'), approvalMode: 'ask' });
    const agent = await createAgent({ serverIds: [server.id] });
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: agent.id,
      businessId: 'bootstrap-admin',
      token,
    });
    const pending = toolApprovalResponseSchema.parse(
      (
        await approvalState({ runId, serverId: server.id, name: tool.name, token, method: 'PUT' })
      ).json(),
    );
    if (pending.approvalId === null) throw new Error('approval missing');
    const removed = await request(app, {
      method: 'DELETE',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expectProblem(
      await approvalState({
        runId,
        serverId: server.id,
        name: tool.name,
        token,
        method: 'GET',
        approvalId: pending.approvalId,
      }),
      'CONFLICT',
    );
  });

  it('invalidates a fixed approval when a policy change makes the call a direct allow', async () => {
    const server = await createServer('http://127.0.0.1:9');
    const tool = await createTool(server.id, { name: unique('allow-tool'), approvalMode: 'ask' });
    const agent = await createAgent({ serverIds: [server.id] });
    const token = crypto.randomUUID();
    const { runId } = await seedRun({
      agentId: agent.id,
      businessId: 'bootstrap-admin',
      token,
    });
    const pending = toolApprovalResponseSchema.parse(
      (
        await approvalState({ runId, serverId: server.id, name: tool.name, token, method: 'PUT' })
      ).json(),
    );
    if (pending.approvalId === null) throw new Error('approval missing');

    const relaxed = await request(app, {
      method: 'PATCH',
      url: `/api/servers/${server.id}/tools/${tool.id}`,
      headers: { cookie },
      payload: { approvalMode: 'allow' },
    });
    expect(relaxed.statusCode, relaxed.body).toBe(200);

    expectProblem(
      await approvalState({
        runId,
        serverId: server.id,
        name: tool.name,
        token,
        method: 'GET',
        approvalId: pending.approvalId,
      }),
      'CONFLICT',
    );
  });
});
