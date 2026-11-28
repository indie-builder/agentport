import { afterAll, describe, expect, it } from 'bun:test';
import { newId, repo, schema } from '@agentport/db';
import { eq, inArray } from 'drizzle-orm';
import { probeTestDb } from './db-probe.js';

const { db, client, ready } = await probeTestDb();

const agentIds: string[] = [];
const serverIds: string[] = [];
const businessId = 'openui-owner';

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
    createdBy: businessId,
    ownerBusinessId: businessId,
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

async function addGeneratedTool(
  serverId: string,
  name: string,
  enabled = true,
  metadata: {
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    approvalMode?: 'allow' | 'ask' | 'deny';
  } = {},
) {
  await db.insert(schema.apiTools).values({
    id: newId('tool'),
    serverId,
    name,
    description: metadata.description ?? `${name} tool`,
    method: 'GET',
    pathTemplate: `/${name}`,
    inputSchema: metadata.inputSchema ?? { type: 'object', properties: {} },
    ...(metadata.outputSchema === undefined ? {} : { outputSchema: metadata.outputSchema }),
    approvalMode: metadata.approvalMode ?? 'allow',
    enabled,
  });
}

describe.skipIf(!ready)('listOpenUiTools', () => {
  afterAll(async () => {
    if (agentIds.length > 0) {
      await db.delete(schema.agents).where(inArray(schema.agents.id, agentIds));
    }
    if (serverIds.length > 0) {
      await db.delete(schema.servers).where(inArray(schema.servers.id, serverIds));
    }
    await client.close();
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

  it('keeps per-server tool order and isolation across http and generated servers', async () => {
    const agentId = await newAgent();
    const suffix = agentId.slice(4);
    const httpName = `oui-multi-a-${suffix}`;
    const firstGenName = `oui-multi-b-${suffix}`;
    const emptyGenName = `oui-multi-c-${suffix}`;
    const lastGenName = `oui-multi-d-${suffix}`;
    const httpId = await newServer('http', httpName);
    const firstGenId = await newServer('generated', firstGenName);
    const emptyGenId = await newServer('generated', emptyGenName);
    const lastGenId = await newServer('generated', lastGenName);

    await addGeneratedTool(firstGenId, 'gamma');
    await addGeneratedTool(firstGenId, 'beta');
    await addGeneratedTool(firstGenId, 'alpha');
    await addGeneratedTool(firstGenId, 'delta', false);
    await addGeneratedTool(lastGenId, 'bravo', true, {
      description: 'bravo tool',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      approvalMode: 'ask',
    });
    await addGeneratedTool(lastGenId, 'alpha', true);
    for (const id of [httpId, firstGenId, emptyGenId, lastGenId]) await bind(agentId, id);
    await db
      .update(schema.agents)
      .set({ disallowedTools: [`mcp__${firstGenName}__beta`] })
      .where(eq(schema.agents.id, agentId));

    expect(await repo.openui.listOpenUiTools(db, agentId)).toEqual([
      {
        serverId: httpId,
        serverName: httpName,
        kind: 'http',
        name: `mcp__${httpName}__search`,
        description: 'search the web',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        approvalMode: 'allow',
      },
      {
        serverId: firstGenId,
        serverName: firstGenName,
        kind: 'generated',
        name: `mcp__${firstGenName}__alpha`,
        description: 'alpha tool',
        inputSchema: { type: 'object', properties: {} },
        approvalMode: 'allow',
        toolId: expect.any(String),
        method: 'GET',
        pathTemplate: '/alpha',
        paramsIn: 'query',
        baseUrl: 'https://example.com',
      },
      {
        serverId: firstGenId,
        serverName: firstGenName,
        kind: 'generated',
        name: `mcp__${firstGenName}__gamma`,
        description: 'gamma tool',
        inputSchema: { type: 'object', properties: {} },
        approvalMode: 'allow',
        toolId: expect.any(String),
        method: 'GET',
        pathTemplate: '/gamma',
        paramsIn: 'query',
        baseUrl: 'https://example.com',
      },
      {
        serverId: lastGenId,
        serverName: lastGenName,
        kind: 'generated',
        name: `mcp__${lastGenName}__alpha`,
        description: 'alpha tool',
        inputSchema: { type: 'object', properties: {} },
        approvalMode: 'allow',
        toolId: expect.any(String),
        method: 'GET',
        pathTemplate: '/alpha',
        paramsIn: 'query',
        baseUrl: 'https://example.com',
      },
      {
        serverId: lastGenId,
        serverName: lastGenName,
        kind: 'generated',
        name: `mcp__${lastGenName}__bravo`,
        description: 'bravo tool',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        approvalMode: 'ask',
        toolId: expect.any(String),
        method: 'GET',
        pathTemplate: '/bravo',
        paramsIn: 'query',
        baseUrl: 'https://example.com',
      },
    ]);
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
    await db.update(schema.servers).set({ kind: 'http' }).where(eq(schema.servers.id, serverId));
    await bind(agentId, serverId);

    await repo.openui.cacheServerToolCatalog(db, serverId, [
      {
        name: 'lookup',
        title: 'Lookup',
        description: 'look something up',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { items: { type: 'array' } } },
      },
      { name: 'bare' },
    ]);

    const tools = await repo.openui.listOpenUiTools(db, agentId);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      `mcp__${name}__bare`,
      `mcp__${name}__lookup`,
    ]);
    const lookup = tools.find((tool) => tool.name.endsWith('__lookup'));
    expect(lookup?.description).toBe('look something up');
    expect(lookup?.outputSchema).toEqual({
      type: 'object',
      properties: { items: { type: 'array' } },
    });
    expect(tools.find((tool) => tool.name.endsWith('__bare'))?.outputSchema).toBeUndefined();
  });

  it('preserves outputSchema on generated tools', async () => {
    const agentId = await newAgent();
    const serverId = await newServer('generated', `oui-out-${agentId.slice(4)}`);
    await addGeneratedTool(serverId, 'report', true, {
      outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    });
    await bind(agentId, serverId);

    const [tool] = await repo.openui.listOpenUiTools(db, agentId);
    expect(tool?.outputSchema).toEqual({
      type: 'object',
      properties: { total: { type: 'number' } },
    });
  });
});

describe('listOpenUiToolsFromSnapshot', () => {
  it('builds sorted http and generated tool rows from a version snapshot with mcp filtering', () => {
    const now = new Date().toISOString();
    const tools = repo.openui.listOpenUiToolsFromSnapshot(
      {
        allowedTools: [],
        disallowedTools: ['mcp__srv-b__hidden'],
      },
      [
        {
          id: 'srv_2',
          name: 'srv-b',
          kind: 'generated',
          config: { baseUrl: 'https://api.example.com' },
          updatedAt: now,
          tools: [
            {
              id: 'tool_z',
              serverId: 'srv_2',
              name: 'zebra',
              description: 'z',
              method: 'POST',
              pathTemplate: '/z',
              inputSchema: { type: 'object', properties: {} },
              outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              paramsIn: 'body',
              approvalMode: 'ask',
              enabled: true,
              createdAt: now,
            },
            {
              id: 'tool_a',
              serverId: 'srv_2',
              name: 'alpha',
              description: 'a',
              method: 'GET',
              pathTemplate: '/a',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'query',
              approvalMode: 'allow',
              enabled: true,
              createdAt: now,
            },
            {
              id: 'tool_h',
              serverId: 'srv_2',
              name: 'hidden',
              description: 'h',
              method: 'GET',
              pathTemplate: '/h',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'query',
              approvalMode: 'allow',
              enabled: true,
              createdAt: now,
            },
            {
              id: 'tool_d',
              serverId: 'srv_2',
              name: 'disabled',
              description: 'd',
              method: 'GET',
              pathTemplate: '/d',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'query',
              approvalMode: 'allow',
              enabled: false,
              createdAt: now,
            },
          ],
        },
        {
          id: 'srv_1',
          name: 'srv-a',
          kind: 'http',
          config: {
            url: 'https://mcp.example.com',
            toolCatalog: [
              {
                name: 'query',
                description: 'run query',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                outputSchema: { type: 'object', properties: { rows: { type: 'array' } } },
              },
            ],
          },
          updatedAt: now,
        },
        {
          id: 'srv_3',
          name: 'srv-c',
          kind: 'stdio',
          config: { command: 'echo', args: [] },
          updatedAt: now,
        },
      ],
    );

    expect(tools).toEqual([
      {
        serverId: 'srv_1',
        serverName: 'srv-a',
        kind: 'http',
        name: 'mcp__srv-a__query',
        description: 'run query',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { rows: { type: 'array' } } },
        approvalMode: 'allow',
      },
      {
        serverId: 'srv_2',
        serverName: 'srv-b',
        kind: 'generated',
        name: 'mcp__srv-b__alpha',
        description: 'a',
        inputSchema: { type: 'object', properties: {} },
        approvalMode: 'allow',
        toolId: 'tool_a',
        method: 'GET',
        pathTemplate: '/a',
        paramsIn: 'query',
        baseUrl: 'https://api.example.com',
      },
      {
        serverId: 'srv_2',
        serverName: 'srv-b',
        kind: 'generated',
        name: 'mcp__srv-b__zebra',
        description: 'z',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        approvalMode: 'ask',
        toolId: 'tool_z',
        method: 'POST',
        pathTemplate: '/z',
        paramsIn: 'body',
        baseUrl: 'https://api.example.com',
      },
    ]);
  });
});
