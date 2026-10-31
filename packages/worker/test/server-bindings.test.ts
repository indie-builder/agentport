import { createDb, newId, schema } from '@agentport/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRunServerBindings } from '../src/server-bindings.js';
import { agentOwnership } from './fixtures/access.js';

const url = process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
const { db, pool } = createDb(url);
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe.skipIf(!ready)('run server bindings', () => {
  const agentIds: string[] = [];
  const serverIds: string[] = [];
  const parentId = newId('agent');
  const childAId = newId('agent');
  const childBId = newId('agent');
  const disabledChildId = newId('agent');
  const serverNames = new Map<string, string>();
  const subAgentRows = [
    { id: childAId, enabled: true },
    { id: childBId, enabled: true },
    { id: disabledChildId, enabled: false },
  ];

  async function agent(id: string, parent: string | null, enabled = true) {
    agentIds.push(id);
    await db.insert(schema.agents).values({
      id,
      slug: `binding-${id}`,
      name: id,
      model: 'test-model',
      parentId: parent,
      enabled,
      ...agentOwnership,
    });
  }

  async function server(name: string) {
    const id = newId('server');
    serverIds.push(id);
    serverNames.set(id, name);
    await db.insert(schema.servers).values({
      id,
      name,
      kind: 'generated',
      description: '',
      config: { baseUrl: 'https://example.com' },
    });
    return id;
  }

  async function bind(agentId: string, serverId: string) {
    await db.insert(schema.agentServers).values({ agentId, serverId });
  }

  let childServer = '';
  let parentServer = '';
  let sharedServer = '';
  let bServer = '';
  let disabledServer = '';

  beforeAll(async () => {
    childServer = await server('binding-child');
    parentServer = await server('binding-parent');
    sharedServer = await server('binding-shared');
    bServer = await server('binding-b');
    disabledServer = await server('binding-disabled');

    await agent(parentId, null);
    await agent(childAId, parentId);
    await agent(childBId, parentId);
    await agent(disabledChildId, parentId, false);

    await bind(parentId, parentServer);
    await bind(parentId, sharedServer);
    await bind(childAId, childServer);
    await bind(childAId, sharedServer);
    await bind(childBId, bServer);
    await bind(disabledChildId, disabledServer);
  });

  afterAll(async () => {
    if (agentIds.length > 0)
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    if (serverIds.length > 0)
      await db.delete(schema.servers).where(inArray(schema.servers.id, serverIds));
    await pool.end();
  });

  it('keeps parent and each child server names strictly to their own bindings', async () => {
    const { serverNamesByAgent } = await loadRunServerBindings(db, parentId, subAgentRows);
    const names = (ids: string[]) => ids.sort(byId).map((id) => serverNames.get(id));

    expect(serverNamesByAgent.get(parentId)).toEqual(names([parentServer, sharedServer]));
    expect(serverNamesByAgent.get(childAId)).toEqual(names([childServer, sharedServer]));
    expect(serverNamesByAgent.get(childBId)).toEqual(names([bServer]));
    expect(serverNamesByAgent.has(disabledChildId)).toBe(false);
  });

  it('dedupes shared servers and orders the workspace union by server id', async () => {
    const { serverRows } = await loadRunServerBindings(db, parentId, subAgentRows);
    const expected = [childServer, parentServer, sharedServer, bServer].sort(byId);

    expect(serverRows.map((row) => row.id)).toEqual(expected);
    expect(serverRows.map((row) => row.name)).toEqual(expected.map((id) => serverNames.get(id)));
    expect(serverRows.filter((row) => row.id === sharedServer)).toHaveLength(1);
    expect(serverRows.some((row) => row.id === disabledServer)).toBe(false);
  });
});
