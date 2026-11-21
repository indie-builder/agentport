import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { hashMcpToken } from '@agentport/core';
import { createDb, repo } from '@agentport/db';
import { toolApprovalResponseSchema } from '@agentport/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import {
  ADMIN_BUSINESS_ID,
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  seedRun,
  setAgentMember,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { listen } from './server.js';

const ready = await infraReady;
const isolated = ready ? await createIsolatedDatabase('tool_approval_') : null;

interface Policy {
  id: string;
  version: number;
  approvalMode: string;
  enabled: boolean;
  serverId: string | null;
}

interface AuditItem {
  action: string;
  detail: Record<string, string | null> | null;
}

function parsed(value: string | null | undefined): Record<string, unknown> | null {
  return value == null ? null : (JSON.parse(value) as Record<string, unknown>);
}

describe.skipIf(!ready || isolated === null)('tool approval policy governance', () => {
  let app: TestApp;
  let cookie: string;
  let serverId: string;
  let toolId: string;
  let otherServerId: string;
  let httpServerId: string;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    app = await startApp({ DATABASE_URL: isolated.url });
    cookie = await loginCookie(app);

    const created = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: unique('policy-server'), kind: 'generated', baseUrl: 'http://127.0.0.1:9' },
    });
    expect(created.statusCode, created.body).toBe(201);
    serverId = created.json<{ id: string }>().id;

    const other = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: unique('policy-other'),
        kind: 'generated',
        baseUrl: 'http://127.0.0.1:9',
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    otherServerId = other.json<{ id: string }>().id;

    const plain = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: unique('policy-http'), kind: 'http', url: 'http://127.0.0.1:9' },
    });
    expect(plain.statusCode, plain.body).toBe(201);
    httpServerId = plain.json<{ id: string }>().id;

    const tool = await request(app, {
      method: 'POST',
      url: `/api/servers/${serverId}/tools`,
      headers: { cookie },
      payload: {
        name: 'policy-tool',
        description: 'fetch one user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
      },
    });
    expect(tool.statusCode, tool.body).toBe(201);
    toolId = tool.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
    await isolated?.close();
  });

  const auditFor = async (target: string): Promise<AuditItem[]> => {
    const res = await request(app, {
      method: 'GET',
      url: '/api/audit',
      headers: { cookie },
      query: { target, limit: 100 },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: AuditItem[] }>().items;
  };

  const createPolicy = (body: Record<string, unknown>) =>
    request(app, {
      method: 'POST',
      url: '/api/security/tool-policies',
      headers: { cookie },
      payload: body,
    });

  it('guards direct run calls and binds approval IDs to the current decision', async () => {
    let upstreamCalls = 0;
    using upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const listener = await listen(app);
    const admin = (url: string, method: string, payload?: unknown) =>
      request(app, { url, method, headers: { cookie }, payload });
    try {
      const connector = await admin('/api/servers', 'POST', {
        name: unique('policy-runtime'),
        kind: 'generated',
        baseUrl: upstream.url.origin,
      });
      expect(connector.statusCode, connector.body).toBe(201);
      const { id: target } = connector.json<{ id: string }>();
      for (const [name, method] of [
        ['write', 'POST'],
        ['read', 'GET'],
      ]) {
        const tool = await admin(`/api/servers/${target}/tools`, 'POST', {
          name,
          method,
          pathTemplate: `/${name}`,
          approvalMode: 'allow',
        });
        expect(tool.statusCode, tool.body).toBe(201);
      }
      const agent = await admin('/api/agents', 'POST', {
        slug: unique('policy-operator'),
        name: 'Policy operator',
        serverIds: [target],
      });
      expect(agent.statusCode, agent.body).toBe(201);
      const { id: agentId } = agent.json<{ id: string }>();
      const ownerPolicy = await createPolicy({
        serverId: target,
        approvalMode: 'ask',
        httpMethod: 'POST',
        role: 'agent:owner',
      });
      expect(ownerPolicy.statusCode, ownerPolicy.body).toBe(201);
      const { id: policyId } = ownerPolicy.json<Policy>();
      const member = await createTestAccount(app, cookie, { systemKeys: ['user'] });
      await setAgentMember(app, cookie, agentId, member.businessId, {
        canUse: true,
        canMaintain: false,
      });
      const [role] = (await repo.access.getUserAccess(app.db, member.businessId)).roles;
      if (!role) throw new Error('member role missing');
      const memberPolicy = await createPolicy({
        serverId: target,
        approvalMode: 'deny',
        httpMethod: 'POST',
        role: `platform:${role.id}`,
      });
      expect(memberPolicy.statusCode, memberPolicy.body).toBe(201);

      const openRun = async (
        subject?: { kind: 'user'; businessId: string },
        conversationId?: string,
      ) => {
        const token = crypto.randomUUID();
        const run =
          conversationId === undefined
            ? await seedRun(app, agentId, {
                mcpTokenHash: hashMcpToken(token),
                ...(subject ? { subject } : {}),
              })
            : {
                conversationId,
                runId: (
                  await repo.chat.createRun(app.db, {
                    id: unique('policy-run'),
                    conversationId,
                    agentId,
                    subject: { kind: 'user', businessId: ADMIN_BUSINESS_ID },
                  })
                ).id,
              };
        if (conversationId !== undefined) {
          await repo.chat.updateRun(app.db, run.runId, { status: 'running' });
          await repo.runs.setRunMcpToken(
            app.db,
            run.runId,
            hashMcpToken(token),
            new Date(Date.now() + 60_000),
          );
        }
        const headers = { authorization: `Bearer ${token}`, 'x-agentport-run-id': run.runId };
        return {
          ...run,
          async call(name: string) {
            const client = new Client({ name: 'policy-runtime', version: '1' });
            try {
              await client.connect(
                new StreamableHTTPClientTransport(new URL(`${listener.url}/mcp/${target}`), {
                  requestInit: { headers },
                }),
              );
              return await client.callTool({ name, arguments: {} });
            } finally {
              await client.close();
            }
          },
          async state(method = 'GET', name = 'write') {
            const response = await request(app, {
              method,
              url: `/tool-approvals/${run.runId}/${target}/${name}`,
              headers,
              ...(method === 'PUT' ? { payload: {} } : {}),
            });
            expect(response.statusCode, response.body).toBe(200);
            return toolApprovalResponseSchema.parse(response.json());
          },
          decide(approvalId: string, action = 'approve') {
            return admin(`/api/runs/${run.runId}/${action}`, 'POST', { approvalId });
          },
        };
      };
      const regular = await openRun({ kind: 'user', businessId: member.businessId });
      expect((await regular.call('write')).isError).toBe(true);
      expect(await regular.state('PUT')).toEqual({
        status: 'denied',
        approvalId: null,
        expiresAt: null,
      });
      expect(upstreamCalls).toBe(0);
      const owner = await openRun();
      expect((await owner.call('write')).isError).toBe(true);
      expect(upstreamCalls).toBe(0);
      const first = await owner.state();
      expect(first.status).toBe('pending');
      if (first.approvalId === null) throw new Error('approval missing');
      const changed = await admin(`/api/security/tool-policies/${policyId}`, 'PATCH', {
        enabled: true,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expectProblem(await owner.decide(first.approvalId), 'CONFLICT');
      expect(await owner.state()).toEqual({ status: 'pending', approvalId: null, expiresAt: null });
      const next = await owner.state('PUT');
      expect(next.approvalId).not.toBe(first.approvalId);
      if (next.approvalId === null) throw new Error('replacement approval missing');
      expect((await owner.decide(next.approvalId)).statusCode).toBe(200);
      expect((await owner.call('write')).isError).toBeFalsy();
      expect(upstreamCalls).toBe(1);
      const expiresAt = new Date(Date.now() - 1_000).toISOString();
      await app.client.unsafe('update approval_requests set expires_at = $2 where id = $1', [
        next.approvalId,
        expiresAt,
      ]);
      expect((await owner.call('write')).isError).toBeFalsy();
      expect(upstreamCalls).toBe(2);
      const nextRun = await openRun(undefined, owner.conversationId);
      expect((await nextRun.call('write')).isError).toBe(true);
      expect(upstreamCalls).toBe(2);
      const pending = await nextRun.state();
      if (pending.approvalId === null) throw new Error('second run approval missing');
      expect((await nextRun.decide(pending.approvalId, 'deny')).statusCode).toBe(200);
      expect((await nextRun.call('write')).isError).toBe(true);
      expect(upstreamCalls).toBe(2);
      expect(await regular.state('PUT', 'read')).toEqual({
        status: 'approved',
        approvalId: null,
        expiresAt: null,
      });
      expect((await regular.call('read')).isError).toBeFalsy();
      expect(upstreamCalls).toBe(3);
      await app.client.unsafe('update "user" set disabled = true where business_id = $1', [
        ADMIN_BUSINESS_ID,
      ]);
      try {
        expect((await owner.call('write')).isError).toBe(true);
        expect(upstreamCalls).toBe(3);
      } finally {
        await app.client.unsafe('update "user" set disabled = false where business_id = $1', [
          ADMIN_BUSINESS_ID,
        ]);
      }
      expect((await owner.call('write')).isError).toBe(true);
      expect(upstreamCalls).toBe(3);
      expectProblem(await owner.decide(next.approvalId), 'CONFLICT');
    } finally {
      await listener.close();
    }
  });

  it('creates a policy and records a stable audit snapshot', async () => {
    const res = await createPolicy({
      serverId,
      toolId,
      httpMethod: 'GET',
      pathTemplate: '/users/{id}',
      approvalMode: 'ask',
      role: 'agent:owner',
    });
    expect(res.statusCode, res.body).toBe(201);
    const policy = res.json<Policy>();
    expect(policy.version).toBe(1);
    expect(policy.enabled).toBe(true);

    const list = await request(app, {
      method: 'GET',
      url: '/api/security/tool-policies',
      headers: { cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<Policy[]>().some((row) => row.id === policy.id)).toBe(true);

    const created = (await auditFor(policy.id)).filter(
      (item) => item.action === 'security.tool_policy.created',
    );
    expect(created).toHaveLength(1);
    const detail = created[0]?.detail;
    expect(detail?.policyId).toBe(policy.id);
    expect(detail?.to).toBeString();
    expect(parsed(detail?.to)).toMatchObject({ serverId, toolId, approvalMode: 'ask', version: 1 });
  });

  it('increments the version and records from/to on update', async () => {
    const created = await createPolicy({ serverId, approvalMode: 'allow' });
    expect(created.statusCode, created.body).toBe(201);
    const policy = created.json<Policy>();

    const res = await request(app, {
      method: 'PATCH',
      url: `/api/security/tool-policies/${policy.id}`,
      headers: { cookie },
      payload: { approvalMode: 'deny', enabled: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = res.json<Policy>();
    expect(updated.version).toBe(2);
    expect(updated.approvalMode).toBe('deny');
    expect(updated.enabled).toBe(false);

    const changes = (await auditFor(policy.id)).filter(
      (item) => item.action === 'security.tool_policy.updated',
    );
    expect(changes).toHaveLength(1);
    const detail = changes[0]?.detail;
    expect(parsed(detail?.from)).toMatchObject({ approvalMode: 'allow', version: 1 });
    expect(parsed(detail?.to)).toMatchObject({ approvalMode: 'deny', version: 2 });
  });

  it('records the snapshot with a null target on delete', async () => {
    const created = await createPolicy({ serverId, agentId: null, approvalMode: 'ask' });
    const policy = created.json<Policy>();

    const res = await request(app, {
      method: 'DELETE',
      url: `/api/security/tool-policies/${policy.id}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(204);

    const removed = (await auditFor(policy.id)).filter(
      (item) => item.action === 'security.tool_policy.deleted',
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]?.detail?.policyId).toBe(policy.id);
    expect(parsed(removed[0]?.detail?.from)).toMatchObject({ approvalMode: 'ask' });
    expect(removed[0]?.detail?.to).toBeNull();
  });

  it('rejects editors without security.manage', async () => {
    const user = await createTestAccount(app, cookie, { systemKeys: ['user'] });
    const res = await request(app, {
      method: 'POST',
      url: '/api/security/tool-policies',
      headers: { cookie: user.cookie },
      payload: { serverId, approvalMode: 'allow' },
    });
    expectProblem(res, 'FORBIDDEN');
  });

  it('rejects selectors that do not belong together', async () => {
    const nonGenerated = await createPolicy({ serverId: httpServerId, approvalMode: 'allow' });
    expectProblem(nonGenerated, 'INVALID_INPUT');

    const foreignTool = await createPolicy({ serverId, toolId, approvalMode: 'allow' });
    expect(foreignTool.statusCode, foreignTool.body).toBe(201);
    const foreignId = foreignTool.json<Policy>().id;

    const mismatch = await request(app, {
      method: 'PATCH',
      url: `/api/security/tool-policies/${foreignId}`,
      headers: { cookie },
      payload: { serverId: otherServerId },
    });
    expectProblem(mismatch, 'INVALID_INPUT');

    const toolWithoutServer = await createPolicy({ toolId, approvalMode: 'allow' });
    expectProblem(toolWithoutServer, 'INVALID_INPUT');
  });

  it('keeps the audit chain verifiable after null-value details', async () => {
    const { db, client } = createDb(isolated.url);
    try {
      const result = await repo.audit.verifyAuditChain(db);
      expect(result.ok).toBe(true);
      expect(result.brokenSeq).toBeNull();
    } finally {
      await client.close();
    }
  });
});
