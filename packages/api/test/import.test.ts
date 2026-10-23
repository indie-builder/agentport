import type { Agent, Server, Skill } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const GENERATED_BASE_URL = 'https://jsonplaceholder.typicode.com';

interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  warnings: string[];
}

interface PortableTool {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  paramsIn: 'query' | 'body';
  requiresApproval: boolean;
  enabled: boolean;
}

interface ExportedTool extends PortableTool {
  id?: string;
  serverId?: string;
  createdAt?: string;
}

interface ExportedServer {
  name: string;
  kind: string;
  description: string;
  config: Record<string, unknown>;
  secretKeys: string[];
  tools?: ExportedTool[];
}

interface AgentExportFile {
  format: string;
  exportedAt: string;
  agent: Record<string, unknown> & { slug: string; name: string };
  servers: ExportedServer[];
  skills: unknown[];
}

interface ApiToolResponse extends PortableTool {
  id: string;
  serverId: string;
  createdAt: string;
}

function makeTool(overrides: Partial<PortableTool> & { name: string }): PortableTool {
  return Object.assign(
    {
      description: '',
      method: 'GET' as const,
      pathTemplate: `/${overrides.name}`,
      inputSchema: { type: 'object', properties: {} },
      paramsIn: 'query' as const,
      requiresApproval: false,
      enabled: true,
      name: overrides.name,
    },
    overrides,
  );
}

/** 导出/导入只承诺这些字段；id、serverId、createdAt 属于源实例。 */
function portable(tool: PortableTool): PortableTool {
  return {
    name: tool.name,
    description: tool.description,
    method: tool.method,
    pathTemplate: tool.pathTemplate,
    inputSchema: tool.inputSchema,
    paramsIn: tool.paramsIn,
    requiresApproval: tool.requiresApproval,
    enabled: tool.enabled,
  };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function exportFile(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    format: 'agentport/agent@1',
    exportedAt: new Date().toISOString(),
    agent: { slug, name: `Imported ${slug}`, systemPrompt: 'You are imported.' },
    servers: [],
    skills: [],
    ...overrides,
  };
}

describe.skipIf(!ready)('import agents', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdServers: string[] = [];
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, {
      agentSlugs: createdAgents,
      serverNames: createdServers,
      skillSlugs: createdSkills,
    });
    await app.close();
  });

  const auth = () => ({ cookie });
  const importAgent = (payload: object) =>
    inject(app, { method: 'POST', url: '/api/import/agents', headers: auth(), payload });
  const exportAgent = (id: string) =>
    inject(app, { method: 'GET', url: `/api/export/agents/${id}`, headers: auth() });
  const createToolFor = async (serverId: string, tool: PortableTool): Promise<ApiToolResponse> => {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/servers/${serverId}/tools`,
      headers: auth(),
      payload: tool,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<ApiToolResponse>();
    if (tool.enabled) return created;
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${serverId}/tools/${created.id}`,
      headers: auth(),
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    return disabled.json<ApiToolResponse>();
  };
  const listTools = async (serverId: string): Promise<ApiToolResponse[]> => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/servers/${serverId}/tools`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ApiToolResponse[]>();
  };
  const serverByName = async (name: string): Promise<Server | undefined> => {
    const res = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json<Server[]>().find((server) => server.name === name);
  };

  it('imports an agent and creates missing servers and skills', async () => {
    const slug = unique('imp');
    const serverName = unique('imp-srv');
    const skillSlug = unique('imp-skill');
    createdAgents.push(slug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const res = await importAgent(
      exportFile(slug, {
        agent: {
          slug,
          name: `Imported ${slug}`,
          systemPrompt: 'You are imported.',
          description: 'from a file',
        },
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            description: 'local tools',
            config: { command: 'npx', args: ['-y', 'some-mcp'] },
            secretKeys: [],
          },
        ],
        skills: [
          { slug: skillSlug, name: 'Imported Skill', description: 'does things', body: '# steps' },
        ],
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent).toMatchObject({
      slug,
      name: `Imported ${slug}`,
      description: 'from a file',
      role: '通用助手',
      model: 'claude-sonnet-5-5',
      maxTurns: 20,
      serverIds: [expect.any(String)],
      skillIds: [expect.any(String)],
    });
    expect(body.createdServers).toEqual([serverName]);
    expect(body.reusedServers).toEqual([]);
    expect(body.createdSkills).toEqual([skillSlug]);
    expect(body.warnings).toEqual([]);

    const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(agents.json<Agent[]>().some((agent) => agent.id === body.agent.id)).toBe(true);
  });

  it('persists a supported role from an imported agent', async () => {
    const slug = unique('imp-role');
    createdAgents.push(slug);

    const res = await importAgent(
      exportFile(slug, {
        agent: { slug, name: `Imported ${slug}`, role: '数据分析师' },
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.role).toBe('数据分析师');

    const saved = await inject(app, {
      method: 'GET',
      url: `/api/agents/${body.agent.id}`,
      headers: auth(),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<Agent>().role).toBe('数据分析师');
  });

  it('rejects an unsupported historical role from an imported agent', async () => {
    const slug = unique('imp-invalid-role');
    createdAgents.push(slug);

    const res = await importAgent(
      exportFile(slug, {
        agent: { slug, name: `Imported ${slug}`, role: '历史自定义岗位' },
      }),
    );
    const body = expectProblem(res, 'INVALID_INPUT');
    expect(body.path).toBe('/agent/role');
    expect(body.message).toMatch(/角色|岗位|role/i);
  });

  it('reuses an existing server by name', async () => {
    const serverName = unique('imp-reuse');
    const slug = unique('imp-reuse');
    createdServers.push(serverName);
    createdAgents.push(slug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: serverName, kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        servers: [{ name: serverName, kind: 'http', config: { url: 'https://example.com/mcp' } }],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.createdServers).toEqual([]);
    expect(body.agent.serverIds).toEqual([created.json<Server>().id]);
  });

  it('refuses to reuse an existing server with a different kind', async () => {
    const serverName = unique('imp-kind');
    const slug = unique('imp-kind');
    createdServers.push(serverName);
    createdAgents.push(slug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: serverName, kind: 'stdio', command: 'node', args: [] },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        servers: [{ name: serverName, kind: 'http', config: { url: 'https://example.com/mcp' } }],
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an http server pointing at a private address', async () => {
    const res = await importAgent(
      exportFile(unique('imp-ssrf'), {
        servers: [
          { name: unique('imp-ssrf-srv'), kind: 'http', config: { url: 'http://10.0.0.1/mcp' } },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('renames a conflicting slug and explains it in warnings', async () => {
    const slug = unique('imp-dup');
    createdAgents.push(slug, `${slug}-2`);
    const first = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug, name: `Existing ${slug}` },
    });
    expect(first.statusCode).toBe(201);

    const res = await importAgent(exportFile(slug));
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.slug).toBe(`${slug}-2`);
    expect(body.agent.name).toBe(`Imported ${slug}`);
    expect(body.warnings.some((warning) => warning.includes(`${slug}-2`))).toBe(true);
  });

  it('rejects a file with an unsupported format', async () => {
    const res = await importAgent({
      format: 'agentport/agent@2',
      agent: { slug: unique('imp-bad'), name: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a forbidden allowed tool without creating the agent', async () => {
    const slug = unique('imp-tool');
    createdAgents.push(slug);
    const res = await importAgent(
      exportFile(slug, {
        agent: {
          slug,
          name: `Imported ${slug}`,
          allowedTools: ['mcp__ok__*', 'Monitor'],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Monitor');

    const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(agents.json<Agent[]>().some((agent) => agent.slug === slug)).toBe(false);
  });

  it('warns about source sub-agent ids and does not bind them', async () => {
    const slug = unique('imp-sub');
    const localSlug = unique('imp-sub-local');
    createdAgents.push(slug, localSlug);
    const local = (
      await createAgent(app, cookie, { slug: localSlug, track: createdAgents })
    ).json<Agent>();

    const res = await importAgent(
      exportFile(slug, { agent: { slug, name: `Imported ${slug}`, subAgentIds: [local.id] } }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.subAgentIds).toEqual([]);
    expect(body.warnings.some((warning) => warning.includes('子智能体'))).toBe(true);
  });

  it('rejects duplicate server names in one file without partial writes', async () => {
    const slug = unique('imp-dup-srv');
    const serverName = unique('imp-dup-srv-name');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const res = await importAgent(
      exportFile(slug, {
        servers: [
          { name: serverName, kind: 'stdio', config: { command: 'node', args: [] } },
          { name: serverName, kind: 'stdio', config: { command: 'deno', args: [] } },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);

    const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
    expect(agents.json<Agent[]>().some((agent) => agent.slug === slug)).toBe(false);
    expect(await serverByName(serverName)).toBeUndefined();
  });

  it('warns about reused server drift and does not refill existing secrets', async () => {
    const slug = unique('imp-drift');
    const serverName = unique('imp-drift-srv');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: {
        name: serverName,
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer existing' },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        servers: [
          {
            name: serverName,
            kind: 'http',
            config: { url: 'https://example.com/other' },
            secretKeys: ['Authorization'],
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.createdServers).toEqual([]);
    expect(body.warnings.some((warning) => warning.includes('配置与导入文件不同'))).toBe(true);
    // 已存在的 server 不需要重新填密钥，也不能因为导入而被清空。
    expect(body.warnings.some((warning) => warning.includes('Authorization'))).toBe(false);

    const existing = await serverByName(serverName);
    expect(existing?.kind === 'http' ? existing.url : undefined).toBe('https://example.com/mcp');
    expect(existing?.kind === 'http' ? existing.headers : undefined).toEqual({
      Authorization: '••••',
    });
    const row = await app.pool.query<{ secrets_encrypted: string | null }>(
      'select secrets_encrypted from servers where name = $1',
      [serverName],
    );
    expect(row.rows[0]?.secrets_encrypted).not.toBeNull();
  });

  it('never writes secret values and warns about secret keys', async () => {
    const slug = unique('imp-secret');
    const serverName = unique('imp-secret-srv');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const res = await importAgent(
      exportFile(slug, {
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            config: { command: 'node', args: [] },
            secretKeys: ['API_KEY', 'TOKEN'],
          },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('API_KEY');
    expect(body.warnings[0]).toContain('TOKEN');

    // 导出文件里的 secretKeys 只用于提示：数据库里不能出现任何密钥列。
    const row = await app.pool.query<{ secrets_encrypted: string | null }>(
      'select secrets_encrypted from servers where name = $1',
      [serverName],
    );
    expect(row.rows[0]?.secrets_encrypted).toBeNull();

    const servers = await inject(app, { method: 'GET', url: '/api/servers', headers: auth() });
    const imported = servers.json<Server[]>().find((server) => server.name === serverName);
    expect(imported?.kind === 'stdio' ? imported.env : imported?.headers).toEqual({});
  });

  it('creates missing skills but does not duplicate existing ones', async () => {
    const slug = unique('imp-skill-reuse');
    const skillSlug = unique('imp-existing-skill');
    createdAgents.push(slug);
    createdSkills.push(skillSlug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { slug: skillSlug, name: 'Existing', description: 'already here' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importAgent(
      exportFile(slug, {
        skills: [
          { slug: skillSlug, name: 'Existing', description: 'already here' },
          { slug: `${skillSlug}-new`, name: 'New', description: 'fresh' },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<AgentImportResult>();
    createdSkills.push(`${skillSlug}-new`);
    expect(body.createdSkills).toEqual([`${skillSlug}-new`]);
    expect(body.agent.skillIds).toHaveLength(2);

    const skills = await inject(app, { method: 'GET', url: '/api/skills', headers: auth() });
    expect(skills.json<Skill[]>().filter((skill) => skill.slug === skillSlug)).toHaveLength(1);
  });

  it('round-trips generated tools with portable fields and fresh ids', async () => {
    const sourceName = unique('imp-port-src');
    const importedName = unique('imp-port-dst');
    const sourceSlug = unique('imp-port-src');
    const importedSlug = unique('imp-port-dst');
    const secretValue = `Bearer ${unique('imp-port-secret')}`;
    createdServers.push(sourceName, importedName);
    // source 的 slug 由 createAgent 的 track 记录；导入结果落库后再记录实际 slug。
    createdAgents.push(importedSlug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: {
        name: sourceName,
        kind: 'generated',
        baseUrl: GENERATED_BASE_URL,
        headers: { Authorization: secretValue },
      },
    });
    expect(created.statusCode).toBe(201);
    const sourceServer = created.json<Server>();

    const tools: PortableTool[] = [
      makeTool({
        name: 'list-users',
        description: 'list users',
        method: 'GET',
        pathTemplate: '/users',
        paramsIn: 'query',
      }),
      makeTool({
        name: 'create-user',
        description: 'create a user',
        method: 'POST',
        pathTemplate: '/users',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        paramsIn: 'body',
        requiresApproval: true,
      }),
      makeTool({
        name: 'delete-user',
        description: 'disabled legacy tool',
        method: 'DELETE',
        pathTemplate: '/users/{id}',
        enabled: false,
      }),
    ];
    const sourceTools: ApiToolResponse[] = [];
    for (const tool of tools) sourceTools.push(await createToolFor(sourceServer.id, tool));

    const sourceAgent = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        serverIds: [sourceServer.id],
        track: createdAgents,
      })
    ).json<Agent>();

    const exp = await exportAgent(sourceAgent.id);
    expect(exp.statusCode, exp.body).toBe(200);
    const file = exp.json<AgentExportFile>();
    const sourceEntry = file.servers.find((entry) => entry.name === sourceName);
    if (!sourceEntry) throw new Error('export did not include the generated server');
    expect(sourceEntry.kind).toBe('generated');
    const exportedTools = sourceEntry.tools ?? [];
    expect(exportedTools).toHaveLength(3);
    expect(sortByName(exportedTools).map(portable)).toEqual(sortByName(tools).map(portable));

    // 工具条目只带可移植字段：源实例的 id/serverId/createdAt 不能出现在文件里。
    for (const tool of exportedTools) {
      expect(tool).not.toHaveProperty('id');
      expect(tool).not.toHaveProperty('serverId');
      expect(tool).not.toHaveProperty('createdAt');
    }
    for (const sourceTool of sourceTools) expect(exp.body).not.toContain(sourceTool.id);

    // mcpToken 与加密列里的值都不能写入导出文件。
    const tokenRow = await app.pool.query<{ token: string | null }>(
      "select config->>'mcpToken' as token from servers where name = $1",
      [sourceName],
    );
    const sourceToken = tokenRow.rows[0]?.token ?? '';
    expect(sourceToken).not.toBe('');
    expect(sourceEntry.config).not.toHaveProperty('mcpToken');
    expect(sourceEntry.secretKeys).toEqual(['Authorization']);
    expect(exp.body).not.toContain(sourceToken);
    expect(exp.body).not.toContain(secretValue);

    // 改成一个干净的导入目标：agent slug 与 server name 都换新。
    file.agent.slug = importedSlug;
    file.agent.name = `Imported ${importedSlug}`;
    sourceEntry.name = importedName;
    file.agent.serverNames = [importedName];
    // 旧文件可能没有 enabled；省略时按默认开启导入。
    const defaultEnabled = makeTool({ name: 'default-enabled', pathTemplate: '/default' });
    delete (defaultEnabled as Partial<PortableTool>).enabled;
    sourceEntry.tools = [...(sourceEntry.tools ?? []), defaultEnabled];

    const res = await importAgent(file);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.slug).toBe(importedSlug);
    expect(body.agent.name).toBe(`Imported ${importedSlug}`);
    expect(body.agent.id).not.toBe(sourceAgent.id);
    expect(body.createdServers).toEqual([importedName]);
    expect(body.reusedServers).toEqual([]);
    // 密钥只导出键名：导入时提示重新填写，而不是尝试带入旧值。
    expect(body.warnings.some((warning) => warning.includes('Authorization'))).toBe(true);

    const importedServer = await serverByName(importedName);
    if (!importedServer) throw new Error('import did not create the generated server');
    expect(importedServer.id).not.toBe(sourceServer.id);
    expect(body.agent.serverIds).toEqual([importedServer.id]);
    if (importedServer.kind !== 'generated') throw new Error('unexpected imported server kind');
    expect(importedServer.baseUrl).toBe(GENERATED_BASE_URL);
    expect(importedServer.headers).toEqual({});

    const importedTools = await listTools(importedServer.id);
    expect(importedTools).toHaveLength(4);
    expect(sortByName(importedTools).map(portable)).toEqual(
      sortByName([...tools, makeTool({ name: 'default-enabled', pathTemplate: '/default' })]).map(
        portable,
      ),
    );
    expect(sortByName(importedTools).map(portable)).toEqual(
      sortByName([...exportedTools, makeTool(defaultEnabled)]).map(portable),
    );
    const sourceToolIds = new Set(sourceTools.map((tool) => tool.id));
    for (const tool of importedTools) {
      expect(tool.serverId).toBe(importedServer.id);
      expect(sourceToolIds.has(tool.id)).toBe(false);
    }
    const importedByName = new Map(importedTools.map((tool) => [tool.name, tool]));
    expect(importedByName.get('create-user')?.requiresApproval).toBe(true);
    expect(importedByName.get('delete-user')?.enabled).toBe(false);
    expect(importedByName.get('default-enabled')?.enabled).toBe(true);

    // 导入必须生成新的 mcpToken，且响应里不能出现任何 token。
    const importedTokenRow = await app.pool.query<{ token: string | null }>(
      "select config->>'mcpToken' as token from servers where name = $1",
      [importedName],
    );
    const importedToken = importedTokenRow.rows[0]?.token ?? '';
    expect(importedToken).not.toBe('');
    expect(importedToken).not.toBe(sourceToken);
    expect(res.body).not.toContain(importedToken);
    expect(res.body).not.toContain(secretValue);

    // 源 server 与其工具不被导入过程改写。
    expect(sortByName(await listTools(sourceServer.id)).map(portable)).toEqual(
      sortByName(tools).map(portable),
    );
  });

  it('reuses a same-name generated server without merging tools and warns', async () => {
    const serverName = unique('imp-reuse-tools');
    const sourceSlug = unique('imp-reuse-tools-src');
    const importedSlug = unique('imp-reuse-tools-dst');
    createdAgents.push(importedSlug);

    const server = await createServer(app, cookie, { name: serverName, track: createdServers });
    const original = await createToolFor(
      server.id,
      makeTool({ name: 'keep-me', description: 'existing tool', pathTemplate: '/keep' }),
    );
    const sourceAgent = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        serverIds: [server.id],
        track: createdAgents,
      })
    ).json<Agent>();

    const exp = await exportAgent(sourceAgent.id);
    expect(exp.statusCode, exp.body).toBe(200);
    const file = exp.json<AgentExportFile>();
    const entry = file.servers.find((item) => item.name === serverName);
    if (!entry) throw new Error('export did not include the reused server');
    // 同名 server 被复用时，文件里的工具不能被合并进去。
    entry.tools = [...(entry.tools ?? []), makeTool({ name: 'incoming', pathTemplate: '/new' })];
    file.agent.slug = importedSlug;

    const res = await importAgent(file);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.createdServers).toEqual([]);
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.agent.serverIds).toEqual([server.id]);

    const after = await listTools(server.id);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(original.id);
    expect(after.map(portable)).toEqual([portable(original)]);
    expect(after.some((tool) => tool.name === 'incoming')).toBe(false);
  });

  it('rejects malformed, duplicate and non-generated tool entries without partial writes', async () => {
    const cases: Array<{ label: string; invalid: Record<string, unknown> }> = [
      {
        label: 'duplicate tool names',
        invalid: {
          kind: 'generated',
          config: { baseUrl: GENERATED_BASE_URL },
          tools: [makeTool({ name: 'dup-tool' }), makeTool({ name: 'dup-tool' })],
        },
      },
      {
        label: 'non-generated server with tools',
        invalid: {
          kind: 'stdio',
          config: { command: 'node', args: [] },
          tools: [makeTool({ name: 'stdio-tool' })],
        },
      },
      {
        label: 'malformed tool',
        invalid: {
          kind: 'generated',
          config: { baseUrl: GENERATED_BASE_URL },
          tools: [{ name: 'missing-path' }],
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const slug = unique(`imp-bad-${index}`);
      const validName = unique(`imp-bad-valid-${index}`);
      const invalidName = unique(`imp-bad-invalid-${index}`);
      createdAgents.push(slug);
      createdServers.push(validName, invalidName);

      const res = await importAgent(
        exportFile(slug, {
          servers: [
            {
              name: validName,
              kind: 'generated',
              description: '',
              config: { baseUrl: GENERATED_BASE_URL },
              secretKeys: [],
              tools: [makeTool({ name: 'ok-tool' })],
            },
            {
              name: invalidName,
              description: '',
              secretKeys: [],
              ...item.invalid,
            },
          ],
        }),
      );
      expect(res.statusCode, `${item.label}: ${res.body}`).toBe(400);

      const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
      expect(
        agents.json<Agent[]>().some((agent) => agent.slug === slug),
        item.label,
      ).toBe(false);
      // 整个导入是一个事务：前面的合法 server 也不能落库。
      expect(await serverByName(validName), item.label).toBeUndefined();
      expect(await serverByName(invalidName), item.label).toBeUndefined();
    }
  });

  it('requires auth for import and export', async () => {
    const imported = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      payload: exportFile(unique('imp-anon')),
    });
    expect(imported.statusCode).toBe(401);

    const exported = await inject(app, {
      method: 'GET',
      url: '/api/export/agents/agt_missing',
    });
    expect(exported.statusCode).toBe(401);
  });

  it('round-trips v2 rules, output styles and skill files for root and child agents', async () => {
    const sourceSlug = unique('imp-v2-src');
    const childSlug = unique('imp-v2-child');
    const skillSlug = unique('imp-v2-skill');
    const targetSlug = unique('imp-v2-dst');
    const targetChildSlug = unique('imp-v2-dst-child');
    const targetSkillSlug = unique('imp-v2-dst-skill');
    createdAgents.push(sourceSlug, childSlug, targetSlug, targetChildSlug);
    createdSkills.push(skillSlug, targetSkillSlug);
    const fixture = {
      ...exportFile(sourceSlug),
      format: 'agentport/agent@2',
      agent: { slug: sourceSlug, name: 'Portable root', skillSlugs: [] as string[] },
      rules: [{ slug: 'root-rule', content: 'Keep root rules.', globs: 'src/**,test/**' }],
      outputStyles: [
        {
          slug: 'brief',
          description: 'Brief',
          keepCodingInstructions: true,
          body: 'Be brief.',
          isSelected: true,
        },
        {
          slug: 'verbose',
          description: 'Verbose',
          keepCodingInstructions: false,
          body: 'Explain.',
          isSelected: false,
        },
      ],
      subAgents: [
        {
          slug: childSlug,
          name: 'Portable child',
          skillSlugs: [skillSlug],
          rules: [{ slug: 'child-rule', content: 'Keep child rules.', globs: '' }],
          outputStyles: [
            {
              slug: 'child-style',
              description: 'Child',
              keepCodingInstructions: false,
              body: 'Child voice.',
              isSelected: true,
            },
            {
              slug: 'unused',
              description: '',
              keepCodingInstructions: true,
              body: 'Unused voice.',
              isSelected: false,
            },
          ],
        },
      ],
      skills: [
        {
          slug: skillSlug,
          name: 'Portable skill',
          description: 'With resources',
          body: '# Skill steps',
          files: [
            { path: 'references/guide.md', content: '# Guide' },
            { path: 'scripts/run.sh', content: 'true\n' },
          ],
        },
      ],
    };
    const source = await importAgent(fixture);
    expect(source.statusCode, source.body).toBe(201);
    const exported = await exportAgent(source.json<AgentImportResult>().agent.id);
    expect(exported.statusCode, exported.body).toBe(200);
    const file = exported.json<
      typeof fixture & {
        workspace: {
          skills: Array<{ slug: string; files: Array<{ path: string; content: string }> }>;
          rules: Array<{ slug: string; content: string }>;
          outputStyles: Array<{ slug: string; content: string }>;
          selectedOutputStyle: string | null;
          settingsJson: string | null;
        };
      }
    >();
    expect(file.format).toBe('agentport/agent@2');
    expect(file.rules).toEqual(fixture.rules);
    expect(file.outputStyles).toEqual(fixture.outputStyles);
    expect(file.subAgents[0]?.rules).toEqual(fixture.subAgents[0]?.rules);
    expect(file.subAgents[0]?.outputStyles).toEqual(fixture.subAgents[0]?.outputStyles);
    expect(file.skills).toEqual(fixture.skills);
    expect(file.workspace.skills).toContainEqual({
      slug: skillSlug,
      content: expect.any(String),
      files: fixture.skills[0]?.files,
    });
    expect(file.workspace.rules[0]?.content).toContain('Keep root rules.');
    expect(file.workspace.outputStyles.map((style) => style.slug)).toEqual(['brief', 'verbose']);
    expect(file.workspace.selectedOutputStyle).toBe('brief');
    expect(JSON.parse(file.workspace.settingsJson ?? '{}')).toEqual({ outputStyle: 'brief' });

    file.agent.slug = targetSlug;
    const child = file.subAgents[0];
    const exportedSkill = file.skills[0];
    if (!child || !exportedSkill) throw new Error('missing portable child or skill');
    child.slug = targetChildSlug;
    child.skillSlugs = [targetSkillSlug];
    exportedSkill.slug = targetSkillSlug;
    const imported = await importAgent(file);
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    expect(result.agent.slug).toBe(targetSlug);
    expect(result.agent.id).not.toBe(source.json<AgentImportResult>().agent.id);
    expect(result.agent.skillIds).toEqual([]);
    expect(result.createdSkills).toEqual([targetSkillSlug]);
    const reexported = await exportAgent(result.agent.id);
    expect(reexported.statusCode, reexported.body).toBe(200);
    const roundTrip = reexported.json<typeof file>();
    expect(roundTrip.rules).toEqual(file.rules);
    expect(roundTrip.outputStyles).toEqual(file.outputStyles);
    expect(roundTrip.subAgents).toEqual(file.subAgents);
    expect(roundTrip.skills).toEqual(file.skills);
    expect(roundTrip.workspace.skills).toContainEqual({
      slug: targetSkillSlug,
      content: expect.any(String),
      files: fixture.skills[0]?.files,
    });
    expect(roundTrip.workspace.rules).toEqual(file.workspace.rules);
    expect(roundTrip.workspace.outputStyles).toEqual(file.workspace.outputStyles);
    expect(roundTrip.workspace.selectedOutputStyle).toBe('brief');
  });

  it('imports legacy v1 root, child and skill definitions with empty v2 defaults', async () => {
    const slug = unique('imp-v1-root');
    const childSlug = unique('imp-v1-child');
    const skillSlug = unique('imp-v1-skill');
    createdAgents.push(slug, childSlug);
    createdSkills.push(skillSlug);
    const imported = await importAgent(
      exportFile(slug, {
        subAgents: [{ slug: childSlug, name: 'Legacy child', skillSlugs: [skillSlug] }],
        skills: [
          { slug: skillSlug, name: 'Legacy skill', description: 'Legacy', body: '# Legacy' },
        ],
      }),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const exported = await exportAgent(imported.json<AgentImportResult>().agent.id);
    expect(exported.statusCode, exported.body).toBe(200);
    const file = exported.json<{
      format: string;
      rules: unknown[];
      outputStyles: unknown[];
      subAgents: Array<{
        slug: string;
        skillSlugs: string[];
        rules: unknown[];
        outputStyles: unknown[];
      }>;
      skills: Array<{ slug: string; body: string; files: unknown[] }>;
    }>();
    expect(file.format).toBe('agentport/agent@2');
    expect(file.rules).toEqual([]);
    expect(file.outputStyles).toEqual([]);
    expect(file.subAgents).toMatchObject([
      { slug: childSlug, skillSlugs: [skillSlug], rules: [], outputStyles: [] },
    ]);
    expect(file.skills).toMatchObject([{ slug: skillSlug, body: '# Legacy', files: [] }]);
  });

  it('preserves reused skill files with a warning and rejects invalid v2 resources before writes', async () => {
    const sourceSlug = unique('imp-v2-keep-src');
    const targetSlug = unique('imp-v2-keep-dst');
    const skillSlug = unique('imp-v2-keep-skill');
    createdAgents.push(sourceSlug, targetSlug);
    createdSkills.push(skillSlug);
    const skill = {
      slug: skillSlug,
      name: 'Keep skill',
      description: 'Keep resources',
      body: '# Keep body',
      files: [{ path: 'references/keep.md', content: 'Destination content' }],
    };
    const source = await importAgent(
      exportFile(sourceSlug, {
        format: 'agentport/agent@2',
        rules: [],
        outputStyles: [],
        skills: [skill],
      }),
    );
    expect(source.statusCode, source.body).toBe(201);
    const imported = await importAgent(
      exportFile(targetSlug, {
        format: 'agentport/agent@2',
        rules: [],
        outputStyles: [],
        skills: [
          { ...skill, files: [{ path: 'references/incoming.md', content: 'Incoming content' }] },
        ],
      }),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    expect(result.createdSkills).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes(skillSlug))).toBe(true);
    const exported = await exportAgent(result.agent.id);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.json<{ skills: unknown[] }>().skills).toEqual([skill]);

    const selected = { slug: 'first', body: 'Style', isSelected: true };
    const invalid = [
      { outputStyles: [selected, { ...selected, slug: 'second' }] },
      { skills: [{ ...skill, files: [skill.files[0], skill.files[0]] }] },
      { skills: [{ ...skill, files: [{ path: '../escape.md', content: '' }] }] },
      { skills: [{ ...skill, files: [{ path: 'SKILL.md', content: '' }] }] },
    ];
    for (const [index, fields] of invalid.entries()) {
      const slug = unique(`imp-v2-invalid-${index}`);
      const freshSkillSlug = unique(`imp-v2-invalid-skill-${index}`);
      createdAgents.push(slug);
      createdSkills.push(freshSkillSlug);
      const res = await importAgent(
        exportFile(slug, {
          format: 'agentport/agent@2',
          rules: [],
          outputStyles: [],
          ...fields,
          skills: [
            {
              ...skill,
              slug: freshSkillSlug,
              ...(fields.skills?.[0] ? { files: fields.skills[0].files } : {}),
            },
          ],
        }),
      );
      expect(res.statusCode, res.body).toBe(400);
      const agents = await inject(app, { method: 'GET', url: '/api/agents', headers: auth() });
      const skills = await inject(app, { method: 'GET', url: '/api/skills', headers: auth() });
      expect(agents.json<Agent[]>().some((agent) => agent.slug === slug)).toBe(false);
      expect(skills.json<Skill[]>().some((entry) => entry.slug === freshSkillSlug)).toBe(false);
    }
  });
});
