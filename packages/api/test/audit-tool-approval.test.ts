import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';
import { infraReady, loginCookie, request, startApp, type TestApp, unique } from './helpers.js';

const ready = await infraReady;
const isolated = ready ? await createIsolatedDatabase('audit_tool_approval') : null;

interface AuditItem {
  action: string;
  detail: unknown;
}

describe.skipIf(!ready || isolated === null)('tool approval mode audit detail', () => {
  let app: TestApp;
  let cookie: string;
  let serverId: string;
  let toolId: string;

  beforeAll(async () => {
    if (!isolated) throw new Error('isolated database missing');
    app = await startApp({ DATABASE_URL: isolated.url });
    cookie = await loginCookie(app);

    const server = await request(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: unique('audit-approval'), kind: 'generated', baseUrl: 'http://127.0.0.1:9' },
    });
    expect(server.statusCode, server.body).toBe(201);
    serverId = server.json<{ id: string }>().id;

    const tool = await request(app, {
      method: 'POST',
      url: `/api/servers/${serverId}/tools`,
      headers: { cookie },
      payload: {
        name: 'approval-tool',
        description: 'fetch one user',
        method: 'GET',
        pathTemplate: '/users/{id}',
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        paramsIn: 'query',
        approvalMode: 'allow',
      },
    });
    expect(tool.statusCode, tool.body).toBe(201);
    toolId = tool.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
    await isolated?.close();
  });

  const auditItems = async (): Promise<AuditItem[]> => {
    const res = await request(app, {
      method: 'GET',
      url: '/api/audit',
      headers: { cookie },
      query: { target: serverId, limit: 100 },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ items: AuditItem[] }>().items;
  };

  const changed = (items: AuditItem[]) =>
    items.filter((item) => item.action === 'server.tool.approval_mode.changed');

  const updateTool = (body: Record<string, unknown>) =>
    request(app, {
      method: 'PATCH',
      url: `/api/servers/${serverId}/tools/${toolId}`,
      headers: { cookie },
      payload: body,
    });

  it('records readable from/to when the approval mode changes', async () => {
    const res = await updateTool({ approvalMode: 'ask' });
    expect(res.statusCode, res.body).toBe(200);

    const items = await auditItems();
    expect(items.some((item) => item.action === 'server.tool.updated')).toBe(true);
    expect(changed(items)).toHaveLength(1);
    expect(changed(items)[0]?.detail).toEqual({
      toolId,
      toolName: 'approval-tool',
      from: 'allow',
      to: 'ask',
    });
  });

  it('does not record a change for the same value', async () => {
    const res = await updateTool({ approvalMode: 'ask' });
    expect(res.statusCode, res.body).toBe(200);
    expect(changed(await auditItems())).toHaveLength(1);
  });

  it('does not record a change for a description-only update', async () => {
    const res = await updateTool({ description: 'updated description' });
    expect(res.statusCode, res.body).toBe(200);
    expect(changed(await auditItems())).toHaveLength(1);
  });

  it('exposes the detail in JSON and NDJSON exports', async () => {
    const json = await request(app, {
      method: 'GET',
      url: '/api/audit/export',
      headers: { cookie },
      query: { target: serverId, format: 'json' },
    });
    expect(json.statusCode, json.body).toBe(200);
    const body = json.json<{ items: AuditItem[] }>();
    expect(changed(body.items)[0]?.detail).toEqual({
      toolId,
      toolName: 'approval-tool',
      from: 'allow',
      to: 'ask',
    });

    const ndjson = await request(app, {
      method: 'GET',
      url: '/api/audit/export',
      headers: { cookie },
      query: { target: serverId, format: 'ndjson' },
    });
    expect(ndjson.statusCode, ndjson.body).toBe(200);
    const lines = ndjson.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditItem);
    expect(changed(lines)[0]?.detail).toEqual({
      toolId,
      toolName: 'approval-tool',
      from: 'allow',
      to: 'ask',
    });
  });
});
