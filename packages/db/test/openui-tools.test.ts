import { createDb, newId, repo, schema } from '@agentport/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];
const serverIds: string[] = [];

async function newAgent(allowedTools: string[] = [], disallowedTools: string[] = []) {
  const id = newId('agent');
  agentIds.push(id);
  await db.insert(schema.agents).values({
    id,
    slug: `oui-cat-${id.slice(4)}`,
    name: 'catalog',
    model: 'test',
    allowedTools,
    disallowedTools,
  });
  return id;
}

async function newServer(kind: 'stdio' | 'http' | 'generated' | 'knowledge', name: string) {
  const id = newId('server');
  serverIds.push(id);
  await db.insert(schema.servers).values({
    id,
    name,
    kind,
    config:
      kind === 'stdio'
        ? { command: 'echo', args: [] }
        : kind === 'http'
          ? {
              url: 'https://example.com/mcp',
              // worker 渲染提示词时无法连 MCP：目录来自最近一次测试连接的快照。
              toolCatalog: [
                {
                  name: 'search',
                  description: 'search the web',
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                },
              ],
            }
          : kind === 'knowledge'
            ? { knowledgeBaseId: 'kb-test' }
            : { baseUrl: 'https://example.com', mcpToken: 'token' },
    secretsEncrypted: null,
  });
  return id;
}

async function bind(agentId: string, serverId: string) {
  await db.insert(schema.agentServers).values({ agentId, serverId });
}

async function addGeneratedTool(serverId: string, name: string, enabled = true) {
  await db.insert(schema.apiTools).values({
    id: newId('tool'),
    serverId,
    name,
    description: `${name} tool`,
    method: 'GET',
    pathTemplate: `/${name}`,
    inputSchema: { type: 'object', properties: {} },
    enabled,
  });
}

describe.skipIf(!ready)('listOpenUiTools', () => {
  afterAll(async () => {
    // agents 级联清 binding；servers 级联清 api_tools。
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    if (serverIds.length > 0) {
      await db.delete(schema.servers).where(inArray(schema.servers.id, serverIds));
    }
    await pool.end();
  });

  it('includes http and generated tools, excludes stdio', async () => {
    const agentId = await newAgent();
    const httpId = await newServer('http', `oui-http-${agentId.slice(4)}`);
    const generatedId = await newServer('generated', `oui-gen-${agentId.slice(4)}`);
    const stdioId = await newServer('stdio', `oui-stdio-${agentId.slice(4)}`);
    await addGeneratedTool(generatedId, 'create-user');
    for (const id of [httpId, generatedId, stdioId]) await bind(agentId, id);

    const names = (await repo.openui.listOpenUiTools(db, agentId)).map((tool) => tool.name).sort();
    expect(names).toEqual([
      `mcp__oui-gen-${agentId.slice(4)}__create-user`,
      `mcp__oui-http-${agentId.slice(4)}__search`,
    ]);
  });

  it('excludes bound knowledge servers from the OpenUI tool catalog', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('knowledge', `oui-kb-${agentId.slice(4)}`);
    await bind(agentId, serverId);

    expect(await repo.openui.listOpenUiTools(db, agentId)).toEqual([]);
  });

  it('drops disabled generated tools', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('generated', `oui-dis-${agentId.slice(4)}`);
    await addGeneratedTool(serverId, 'live', true);
    await addGeneratedTool(serverId, 'dead', false);
    await bind(agentId, serverId);

    const names = (await repo.openui.listOpenUiTools(db, agentId)).map((tool) => tool.name);
    expect(names).toEqual([`mcp__oui-dis-${agentId.slice(4)}__live`]);
  });

  it('honours disallowedTools, including the whole-server form', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('generated', `oui-deny-${agentId.slice(4)}`);
    await addGeneratedTool(serverId, 'a');
    await addGeneratedTool(serverId, 'b');
    await bind(agentId, serverId);
    await db
      .update(schema.agents)
      .set({ disallowedTools: [`mcp__oui-deny-${agentId.slice(4)}__a`] })
      .where(eq(schema.agents.id, agentId));

    const names = (await repo.openui.listOpenUiTools(db, agentId)).map((tool) => tool.name);
    expect(names).toEqual([`mcp__oui-deny-${agentId.slice(4)}__b`]);
  });

  it('treats a non-empty allowedTools as an allowlist', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('generated', `oui-allow-${agentId.slice(4)}`);
    await addGeneratedTool(serverId, 'keep');
    await addGeneratedTool(serverId, 'drop');
    await bind(agentId, serverId);
    await db
      .update(schema.agents)
      .set({ allowedTools: [`mcp__oui-allow-${agentId.slice(4)}__keep`] })
      .where(eq(schema.agents.id, agentId));

    const names = (await repo.openui.listOpenUiTools(db, agentId)).map((tool) => tool.name);
    expect(names).toEqual([`mcp__oui-allow-${agentId.slice(4)}__keep`]);
  });

  it('supports the server wildcard in allowedTools', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('generated', `oui-wild-${agentId.slice(4)}`);
    await addGeneratedTool(serverId, 'one');
    await addGeneratedTool(serverId, 'two');
    await bind(agentId, serverId);
    await db
      .update(schema.agents)
      .set({ allowedTools: [`mcp__oui-wild-${agentId.slice(4)}__*`] })
      .where(eq(schema.agents.id, agentId));

    expect(await repo.openui.listOpenUiTools(db, agentId)).toHaveLength(2);
  });

  it('returns nothing for an unknown agent', async () => {
    expect(await repo.openui.listOpenUiTools(db, newId('agent'))).toEqual([]);
  });

  it('feeds the http catalog from the cached test-connection result', async () => {
    const agentId = await newAgent();
    const name = `oui-cache-${agentId.slice(4)}`;
    const serverId = await newServer('stdio', name);
    // 先登记成 http：cacheServerToolCatalog 只写 config，不改 kind。
    await db.update(schema.servers).set({ kind: 'http' }).where(eq(schema.servers.id, serverId));
    await bind(agentId, serverId);

    await repo.openui.cacheServerToolCatalog(db, serverId, [
      {
        name: 'lookup',
        title: 'Lookup', // 展示字段不进快照
        description: 'look something up',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
      { name: 'bare' },
    ]);

    const tools = await repo.openui.listOpenUiTools(db, agentId);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      `mcp__${name}__bare`,
      `mcp__${name}__lookup`,
    ]);
    expect(tools.find((tool) => tool.name.endsWith('__lookup'))?.description).toBe(
      'look something up',
    );
  });
});
