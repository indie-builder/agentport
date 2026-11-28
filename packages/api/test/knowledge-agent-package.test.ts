import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDb, newId, repo, schema } from '@agentport/db';
import { AGENT_PACKAGE_SIDECAR, knowledgeTokenEnv } from '@agentport/shared';
import {
  buildAgentPackage,
  importAgentPackage,
  parseAgentPackage,
} from '../src/modules/agents/package.js';
import { BOOTSTRAP_ADMIN_BUSINESS_ID } from '../src/modules/auth/types.js';

const realLookup = Bun.dns.lookup;
Bun.dns.lookup = async (host, options) =>
  host === 'pace.example.com'
    ? [{ address: '8.8.8.8', family: 4, ttl: 0 }]
    : realLookup(host, options);

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const handle = createDb(
  process.env.DATABASE_URL ??
    'postgres://pace_knowledge:pace_knowledge_local@127.0.0.1:55432/pace_knowledge',
);
const createdAgents: string[] = [];
const suffix = newId('knowledgeBase').slice(-10);
const agentSlug = `kpkg-${suffix}`;
const knowledgeServerName = `kb-${suffix}`;
let agentId = '';
let serverId = '';
let baseId = '';

beforeAll(async () => {
  baseId = newId('knowledgeBase');
  const [server] = await handle.db
    .insert(schema.servers)
    .values({
      id: newId('server'),
      name: knowledgeServerName,
      kind: 'knowledge',
      config: { knowledgeBaseId: baseId },
    })
    .returning();
  if (!server) throw new Error('knowledge server insert returned no row');
  serverId = server.id;
  const [agent] = await handle.db
    .insert(schema.agents)
    .values({
      id: newId('agent'),
      slug: agentSlug,
      name: 'Knowledge expert',
      model: 'test',
      systemPromptMd: 'Use the knowledge base.',
      createdBy: BOOTSTRAP_ADMIN_BUSINESS_ID,
      ownerBusinessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
    })
    .returning();
  if (!agent) throw new Error('agent insert returned no row');
  agentId = agent.id;
  createdAgents.push(agent.id);
  await handle.db.insert(schema.agentServers).values({ agentId: agent.id, serverId });
});

afterAll(async () => {
  Bun.dns.lookup = realLookup;
  await handle.client.unsafe('delete from agent_servers where server_id = $1', [serverId]);
  await handle.client.unsafe('delete from agents where id = any($1::text[])', [
    handle.client.array(createdAgents, 'TEXT'),
  ]);
  await handle.client.unsafe('delete from servers where id = $1', [serverId]);
  await handle.client.close();
});

async function exportedPackage() {
  const row = await repo.agents.getAgent(handle.db, agentId);
  if (!row) throw new Error('missing agent row');
  return buildAgentPackage(handle.db, KEY, 'https://pace.example.com', row);
}

describe('knowledge binding in the agent package', () => {
  it('exports an official http entry with a dedicated credential variable', async () => {
    const pkg = await exportedPackage();
    const mcp = JSON.parse(pkg.files['.mcp.json'] ?? '{}') as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const tokenEnv = knowledgeTokenEnv(knowledgeServerName);
    expect(mcp.mcpServers[knowledgeServerName]).toEqual({
      type: 'http',
      url: `https://pace.example.com/mcp/${serverId}`,
      headers: { Authorization: `Bearer \${${tokenEnv}}` },
    });

    const sidecar = JSON.parse(pkg.files[AGENT_PACKAGE_SIDECAR] ?? '{}') as {
      servers: unknown[];
    };
    expect(sidecar.servers).toContainEqual({
      name: knowledgeServerName,
      description: '',
      kind: 'http',
      url: `https://pace.example.com/mcp/${serverId}`,
      secretKeys: [tokenEnv],
    });
    const all = Object.values(pkg.files).join('\n');
    expect(all).not.toContain('"kind": "knowledge"');
    expect(all).not.toContain('mcpToken');
  });

  it('round-trips the exported package back into the same knowledge binding', async () => {
    const pkg = await exportedPackage();
    const parsed = parseAgentPackage(new Map(Object.entries(pkg.files)), {});
    const result = await importAgentPackage(handle.db, parsed, {
      nodeEnv: 'development',
      selfUrl: 'https://pace.example.com',
      businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
    });
    createdAgents.push(result.agent.id);
    expect(result.reusedServers).toEqual([knowledgeServerName]);
    expect(result.createdServers).toEqual([]);
    expect(result.warnings.join('\n')).toContain('知识库连接');
    expect(result.agent.serverIds).toEqual([serverId]);
  });

  it('still runs SSRF checks for a knowledge-marked entry pointing elsewhere', async () => {
    const pkg = await exportedPackage();
    const sidecar = JSON.parse(pkg.files[AGENT_PACKAGE_SIDECAR] ?? '{}') as {
      servers: Array<{ name: string; url?: string }>;
    };
    for (const server of sidecar.servers) {
      if (server.name === knowledgeServerName) server.url = 'http://10.0.0.5:3000/mcp/srv_other';
    }
    const files = new Map(Object.entries(pkg.files));
    files.set(AGENT_PACKAGE_SIDECAR, JSON.stringify(sidecar));
    const parsed = parseAgentPackage(files, {});
    await expect(
      importAgentPackage(handle.db, parsed, {
        nodeEnv: 'production',
        selfUrl: 'https://pace.example.com',
        businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
      }),
    ).rejects.toThrow('该地址解析到内网');
  });

  it('accepts its own loopback MCP endpoint when the base really exists', async () => {
    const selfUrl = 'http://127.0.0.1:3000';
    const row = await repo.agents.getAgent(handle.db, agentId);
    if (!row) throw new Error('missing agent row');
    const pkg = await buildAgentPackage(handle.db, KEY, selfUrl, row);
    const parsed = parseAgentPackage(new Map(Object.entries(pkg.files)), {});
    const result = await importAgentPackage(handle.db, parsed, {
      nodeEnv: 'production',
      selfUrl,
      businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
    });
    createdAgents.push(result.agent.id);
    expect(result.reusedServers).toEqual([knowledgeServerName]);
    expect(result.agent.serverIds).toEqual([serverId]);
  });

  it('warns and keeps the binding when imported into an instance without that base', async () => {
    const pkg = await exportedPackage();
    const renamed = `kb2-${suffix}`;
    const sidecar = JSON.parse(pkg.files[AGENT_PACKAGE_SIDECAR] ?? '{}') as {
      agent: { slug: string; serverNames: string[] };
      servers: Array<{ name: string; secretKeys: string[] }>;
      subAgents: unknown[];
    };
    sidecar.agent.slug = `${agentSlug}-copy`;
    sidecar.agent.serverNames = sidecar.agent.serverNames.map((name) =>
      name === knowledgeServerName ? renamed : name,
    );
    for (const server of sidecar.servers) {
      if (server.name !== knowledgeServerName) continue;
      server.name = renamed;
      server.secretKeys = [knowledgeTokenEnv(renamed)];
    }
    const mcp = JSON.parse(pkg.files['.mcp.json'] ?? '{}') as {
      mcpServers: Record<string, unknown>;
    };
    mcp.mcpServers[renamed] = mcp.mcpServers[knowledgeServerName];
    delete mcp.mcpServers[knowledgeServerName];
    const files = new Map(Object.entries(pkg.files));
    files.set(AGENT_PACKAGE_SIDECAR, JSON.stringify(sidecar));
    files.set('.mcp.json', JSON.stringify(mcp));

    const parsed = parseAgentPackage(files, {});
    const result = await importAgentPackage(handle.db, parsed, {
      nodeEnv: 'development',
      selfUrl: 'https://pace.example.com',
      businessId: BOOTSTRAP_ADMIN_BUSINESS_ID,
    });
    createdAgents.push(result.agent.id);
    try {
      expect(result.createdServers).toEqual([renamed]);
      expect(result.warnings.join('\n')).toContain('知识库连接');
      expect(result.agent.serverIds).toHaveLength(1);
      const rows = await handle.client.unsafe<{ kind: string }[]>(
        'select kind from servers where name = $1',
        [renamed],
      );
      expect(rows[0]?.kind).toBe('http');
    } finally {
      await handle.client.unsafe('delete from servers where name = $1', [renamed]);
    }
  });
});
