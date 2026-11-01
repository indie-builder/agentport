import { newId, repo, schema } from '@agentport/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_BUSINESS_ID, type FastifyInstance, infraReady, startApp } from './helpers.js';

// run token 的授权边界：父智能体自己的绑定，加上启用的直接子级绑定。
// 这里只验证 SQL 谓词本身，不经过沙盒；外部伪造 run header 时会走到同一函数。
const ready = await infraReady;

describe.skipIf(!ready)('run token server scope', () => {
  let app: FastifyInstance;
  const agents: string[] = [];
  const servers: string[] = [];

  beforeAll(async () => {
    app = await startApp();
  });

  afterEach(async () => {
    if (agents.length > 0)
      await app.pool.query('delete from agents where id = any($1::text[])', [agents]);
    if (servers.length > 0)
      await app.pool.query('delete from servers where id = any($1::text[])', [servers]);
    agents.length = 0;
    servers.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  async function agent(values: { id: string; slug: string; parentId?: string; enabled?: boolean }) {
    agents.push(values.id);
    await app.db.insert(schema.agents).values({
      id: values.id,
      slug: values.slug,
      name: values.slug,
      model: 'test-model',
      createdBy: ADMIN_BUSINESS_ID,
      ownerBusinessId: ADMIN_BUSINESS_ID,
      parentId: values.parentId ?? null,
      enabled: values.enabled ?? true,
    });
    return values.id;
  }

  async function server(name: string) {
    const id = newId('server');
    servers.push(id);
    await app.db.insert(schema.servers).values({
      id,
      name,
      kind: 'generated',
      description: '',
      config: { baseUrl: 'https://example.com' },
    });
    return id;
  }

  async function bind(agentId: string, serverId: string) {
    await app.db.insert(schema.agentServers).values({ agentId, serverId });
  }

  async function seedRun(agentId: string, token?: { hash: string; expiresAt: Date }) {
    const conversationId = newId('conversation');
    const runId = newId('run');
    await app.db
      .insert(schema.conversations)
      .values({ id: conversationId, agentId, createdBy: ADMIN_BUSINESS_ID });
    await app.db.insert(schema.agentRuns).values({
      id: runId,
      conversationId,
      agentId,
      status: 'running',
      subjectKind: 'user',
      initiatedBy: ADMIN_BUSINESS_ID,
      mcpTokenHash: token?.hash ?? null,
      mcpTokenExpiresAt: token?.expiresAt ?? null,
    });
    return runId;
  }

  const token = { hash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) };

  it('allows the parent binding and a direct enabled child binding', async () => {
    const parent = await agent({ id: newId('agent'), slug: `scope-parent-${newId('agent')}` });
    const child = await agent({
      id: newId('agent'),
      slug: `scope-child-${newId('agent')}`,
      parentId: parent,
    });
    const ownServer = await server(`scope-own-${newId('server')}`);
    const childServer = await server(`scope-child-${newId('server')}`);
    await bind(parent, ownServer);
    await bind(child, childServer);
    const runId = await seedRun(parent, token);

    expect(await repo.runs.isRunBoundToServer(app.db, runId, ownServer)).toBe(true);
    expect(await repo.runs.isRunBoundToServer(app.db, runId, childServer)).toBe(true);
    expect(await repo.runs.getRunToken(app.db, runId, ownServer)).toEqual(token);
    expect(await repo.runs.getRunToken(app.db, runId, childServer)).toEqual(token);
  });

  it('rejects a disabled child, a non-direct descendant, and a sibling', async () => {
    const parent = await agent({ id: newId('agent'), slug: `scope-parent-${newId('agent')}` });
    const disabledChild = await agent({
      id: newId('agent'),
      slug: `scope-disabled-${newId('agent')}`,
      parentId: parent,
      enabled: false,
    });
    const grandChild = await agent({
      id: newId('agent'),
      slug: `scope-grand-${newId('agent')}`,
      parentId: disabledChild,
    });
    const sibling = await agent({ id: newId('agent'), slug: `scope-sibling-${newId('agent')}` });
    const disabledServer = await server(`scope-d-${newId('server')}`);
    const grandServer = await server(`scope-g-${newId('server')}`);
    const siblingServer = await server(`scope-s-${newId('server')}`);
    await bind(disabledChild, disabledServer);
    await bind(grandChild, grandServer);
    await bind(sibling, siblingServer);
    const runId = await seedRun(parent, token);

    expect(await repo.runs.isRunBoundToServer(app.db, runId, disabledServer)).toBe(false);
    expect(await repo.runs.isRunBoundToServer(app.db, runId, grandServer)).toBe(false);
    expect(await repo.runs.isRunBoundToServer(app.db, runId, siblingServer)).toBe(false);
    expect(await repo.runs.getRunToken(app.db, runId, disabledServer)).toBeNull();
    expect(await repo.runs.getRunToken(app.db, runId, grandServer)).toBeNull();
    expect(await repo.runs.getRunToken(app.db, runId, siblingServer)).toBeNull();
    expect(await repo.runs.getRunToken(app.db, newId('run'), siblingServer)).toBeNull();
  });
});
