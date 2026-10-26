import { createDb, newId, schema } from '@agentport/db';
import * as agentRepo from '@agentport/db/repo/agents.js';
import * as serverRepo from '@agentport/db/repo/servers.js';
import { AGENT_PACKAGE_SIDECAR, knowledgeTokenEnv } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAgentPackage,
  importAgentPackage,
  parseAgentPackage,
} from '../src/features/agent-package.js';
import { getServer, listServers, toApiServer } from '../src/features/servers/repo.js';

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
    })
    .returning();
  if (!agent) throw new Error('agent insert returned no row');
  agentId = agent.id;
  createdAgents.push(agent.id);
  await handle.db.insert(schema.agentServers).values({ agentId: agent.id, serverId });
});

afterAll(async () => {
  await handle.pool.query('delete from agent_servers where server_id = $1', [serverId]);
  await handle.pool.query('delete from agents where id = any($1::text[])', [createdAgents]);
  await handle.pool.query('delete from servers where id = $1', [serverId]);
  await handle.pool.end();
});

async function exportedPackage() {
  const row = await agentRepo.getAgent(handle.db, agentId);
  if (!row) throw new Error('missing agent row');
  return buildAgentPackage(handle.db, KEY, 'https://pace.example.com', row);
}

describe('knowledge server read shape', () => {
  it('reads knowledge rows as the knowledge kind instead of falling through', async () => {
    const row = await serverRepo.getServer(handle.db, serverId);
    if (!row) throw new Error('missing knowledge server row');
    const server = await getServer(handle.db, serverId, KEY);
    expect(server).toMatchObject({
      id: serverId,
      kind: 'knowledge',
      config: { knowledgeBaseId: baseId },
    });
    expect(toApiServer(row, KEY)).toMatchObject({
      kind: 'knowledge',
      config: { knowledgeBaseId: baseId },
    });
    // 知识连接没有长期 token，读形状里也不能出现。
    expect(JSON.stringify(server)).not.toContain('mcpToken');
  });

  it('drops knowledge servers from the generic list', async () => {
    const list = await listServers(handle.db, KEY);
    expect(list.some((server) => server.id === serverId)).toBe(false);
  });
});

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
    // 内部 kind、mcpToken 与任何 run token 都不进包。
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
      // 自称知识库但指向内网：只有库自己的 /mcp/:id 才免检。
      if (server.name === knowledgeServerName) server.url = 'http://10.0.0.5:3000/mcp/srv_other';
    }
    const files = new Map(Object.entries(pkg.files));
    files.set(AGENT_PACKAGE_SIDECAR, JSON.stringify(sidecar));
    const parsed = parseAgentPackage(files, {});
    await expect(
      importAgentPackage(handle.db, parsed, {
        nodeEnv: 'production',
        selfUrl: 'https://pace.example.com',
      }),
    ).rejects.toThrow('该地址解析到内网');
  });

  it('accepts its own loopback MCP endpoint when the base really exists', async () => {
    const selfUrl = 'http://127.0.0.1:3000';
    const row = await agentRepo.getAgent(handle.db, agentId);
    if (!row) throw new Error('missing agent row');
    const pkg = await buildAgentPackage(handle.db, KEY, selfUrl, row);
    const parsed = parseAgentPackage(new Map(Object.entries(pkg.files)), {});
    // 生产环境不放行 loopback；只有「已存在的库 + 完全吻合的地址」这一条通道。
    const result = await importAgentPackage(handle.db, parsed, {
      nodeEnv: 'production',
      selfUrl,
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
    });
    createdAgents.push(result.agent.id);
    try {
      expect(result.createdServers).toEqual([renamed]);
      // 缺凭据必须给出可读 warning，而不是静默漏掉绑定。
      expect(result.warnings.join('\n')).toContain('知识库连接');
      expect(result.agent.serverIds).toHaveLength(1);
      const { rows } = await handle.pool.query<{ kind: string }>(
        'select kind from servers where name = $1',
        [renamed],
      );
      expect(rows[0]?.kind).toBe('http');
    } finally {
      await handle.pool.query('delete from servers where name = $1', [renamed]);
    }
  });
});
