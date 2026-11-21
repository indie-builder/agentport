import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDb, repo } from '@agentport/db';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import {
  createTestAccount,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';

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
