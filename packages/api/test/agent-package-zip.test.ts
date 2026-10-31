import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseChildAgentMd, parseClaudeMd } from '@agentport/core';
import type { Agent, Server, Skill } from '@agentport/shared';
import { AGENT_PACKAGE_MAX_BYTES, AGENT_PACKAGE_SIDECAR } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  createServer,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  testConfig,
  unique,
} from './helpers.js';
import {
  packageFiles,
  packageZip,
  packageZipStored,
  rawZip,
  sidecarOf,
  unzipPackage,
} from './package-fixtures.js';

const ready = await infraReady;

const GENERATED_BASE_URL = 'https://jsonplaceholder.typicode.com';

interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
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

interface ApiToolResponse extends PortableTool {
  id: string;
  serverId: string;
  createdAt: string;
}

function makeTool(overrides: Partial<PortableTool> & { name: string }): PortableTool {
  return {
    description: '',
    method: 'GET',
    pathTemplate: `/${overrides.name}`,
    inputSchema: { type: 'object', properties: {} },
    paramsIn: 'query',
    requiresApproval: false,
    enabled: true,
    ...overrides,
  };
}

function portable(tool: PortableTool): PortableTool {
  const {
    name,
    description,
    method,
    pathTemplate,
    inputSchema,
    paramsIn,
    enabled,
    requiresApproval,
  } = tool;
  return {
    name,
    description,
    method,
    pathTemplate,
    inputSchema,
    paramsIn,
    enabled,
    requiresApproval,
  };
}

const sortByName = <T extends { name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

describe.skipIf(!ready)('agent package (official .claude directory ZIP)', () => {
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

  const exportAgent = (id: string) => injectZip(app, 'GET', `/api/export/agents/${id}`, cookie);
  const exportFiles = async (id: string): Promise<Map<string, string>> => {
    const res = await exportAgent(id);
    expect(res.statusCode, res.body).toBe(200);
    return unzipPackage(res.rawPayload);
  };
  const importZip = (zip: Buffer, query = '') =>
    injectZip(app, 'POST', `/api/import/agents${query}`, cookie, zip);
  const listAgents = async (): Promise<Agent[]> => {
    const res = await inject(app, { method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Agent[]>();
  };
  const serverByName = async (name: string): Promise<Server | undefined> => {
    const res = await inject(app, { method: 'GET', url: '/api/servers', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json<Server[]>().find((server) => server.name === name);
  };
  const createToolFor = async (serverId: string, tool: PortableTool): Promise<ApiToolResponse> => {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/servers/${serverId}/tools`,
      headers: { cookie },
      payload: tool,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<ApiToolResponse>();
    if (tool.enabled) return created;
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/servers/${serverId}/tools/${created.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    return disabled.json<ApiToolResponse>();
  };
  const listTools = async (serverId: string): Promise<ApiToolResponse[]> => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/servers/${serverId}/tools`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ApiToolResponse[]>();
  };
  const createSkillWithResources = async (
    skillSlug: string,
    name: string,
    description: string,
    resources: Array<{ path: string; content: string }>,
  ): Promise<Skill> => {
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: { slug: skillSlug, name, description },
    });
    expect(created.statusCode, created.body).toBe(201);
    const skill = created.json<Skill>();
    for (const resource of resources) {
      const written = await inject(app, {
        method: 'PUT',
        url: `/api/skills/${skill.id}/files/${resource.path}`,
        headers: { cookie },
        payload: { content: resource.content },
      });
      expect(written.statusCode, written.body).toBe(200);
    }
    return skill;
  };
  const skillResources = async (
    skillId: string,
  ): Promise<Array<{ path: string; content: string }>> => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/skills/${skillId}/files`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Array<{ path: string; content: string }>>();
  };

  it('exports a ZIP whose only definition is official .claude files', async () => {
    const slug = unique('pkg-zip');
    const skillSlug = unique('pkg-zip-skill');
    createdAgents.push(slug);
    createdSkills.push(skillSlug);

    const skill = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: {
        slug: skillSlug,
        name: '包技能',
        description: '包含 "引号"',
        body: '# 步骤\n\n第一行 "x"\n第二行',
      },
    });
    expect(skill.statusCode, skill.body).toBe(201);
    const created = await createAgent(app, cookie, { slug, track: createdAgents });
    const agentId = created.json<{ id: string }>().id;
    const prompt = '你是助手。\n包含 "引号"、\\反斜杠 与 🚀\n第二行';
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: { cookie },
      payload: { systemPrompt: prompt, skillIds: [skill.json<{ id: string }>().id] },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const res = await exportAgent(agentId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/zip/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${slug}.zip"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.byteLength).toBeLessThanOrEqual(AGENT_PACKAGE_MAX_BYTES);

    const files = unzipPackage(res.rawPayload);
    // 正文只在官方文件里；侧车不带 prompt / 技能正文。
    expect(files.get('CLAUDE.md')).toContain(prompt);
    expect(files.get(`.claude/skills/${skillSlug}/SKILL.md`)).toContain('# 步骤');
    const sidecarText = files.get(AGENT_PACKAGE_SIDECAR) ?? '';
    expect(sidecarText).not.toContain(prompt);
    expect(sidecarText).not.toContain('# 步骤');
    expect(sidecarOf(files).agent).toMatchObject({ slug, name: `Agent ${slug}` });

    const reimport = await importZip(res.rawPayload);
    expect(reimport.statusCode, reimport.body).toBe(201);
    const result = reimport.json<AgentImportResult>();
    createdAgents.push(result.agent.slug);
    expect(result.agent.slug).toBe(`${slug}-2`);
    expect(result.agent.systemPrompt).toBe(prompt);
    expect(result.warnings.some((warning) => warning.includes(`导入为 "${slug}-2"`))).toBe(true);
  });

  it('writes imported skill provenance into the exported SKILL.md', async () => {
    const slug = unique('pkg-provenance');
    const skillSlug = unique('pkg-provenance-skill');
    createdAgents.push(slug);
    createdSkills.push(skillSlug);

    const markdown = [
      '---',
      `name: ${skillSlug}`,
      'description: Provenance skill',
      'license: MIT',
      'compatibility: claude-code',
      'metadata: {"author":"skills.sh","version":2}',
      '---',
      '',
      '# Provenance',
      '',
      'Steps.',
    ].join('\n');
    const imported = await inject(app, {
      method: 'POST',
      url: '/api/skills/import',
      headers: { cookie },
      payload: { skillMd: markdown },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const skill = imported.json<{ skill: Skill }>().skill;
    expect(skill).toMatchObject({
      license: 'MIT',
      compatibility: 'claude-code',
      metadata: { author: 'skills.sh', version: 2 },
    });

    const created = await createAgent(app, cookie, {
      slug,
      skillIds: [skill.id],
      track: createdAgents,
    });
    const files = await exportFiles(created.json<{ id: string }>().id);
    const skillMd = files.get(`.claude/skills/${skillSlug}/SKILL.md`) ?? '';
    expect(skillMd).toContain('license: "MIT"');
    expect(skillMd).toContain('compatibility: "claude-code"');
    expect(skillMd).toContain('metadata: {"author":"skills.sh","version":2}');
  });

  it('rejects an export whose ZIP exceeds 1 MiB instead of truncating it', async () => {
    const slug = unique('pkg-big');
    const skillSlug = unique('pkg-big-skill');
    createdAgents.push(slug);
    createdSkills.push(skillSlug);
    const created = await createAgent(app, cookie, { slug, track: createdAgents });
    // 随机内容不可压缩：官方文件合起来真实超过 1 MiB，才能验证导出端拒绝而不是截断。
    // 单个请求仍低于 1 MiB 的 JSON 上限，所以只能由导出端拦截。
    const skill = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: {
        slug: skillSlug,
        name: 'Big skill',
        description: 'big',
        body: randomBytes(500_000).toString('base64'),
      },
    });
    expect(skill.statusCode, skill.body).toBe(201);
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${created.json<{ id: string }>().id}`,
      headers: { cookie },
      payload: {
        systemPrompt: randomBytes(600_000).toString('base64'),
        skillIds: [skill.json<{ id: string }>().id],
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const res = await exportAgent(created.json<{ id: string }>().id);
    const problem = expectProblem(res, 'CONFLICT');
    expect(problem.message).toContain('1 MiB');
  });

  it('imports an official directory, creating missing servers and skills', async () => {
    const slug = unique('imp');
    const serverName = unique('imp-srv');
    const skillSlug = unique('imp-skill');
    createdAgents.push(slug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const res = await importZip(
      packageZip({
        agent: {
          slug,
          name: `Imported ${slug}`,
          description: 'from a file',
          systemPrompt: 'You are imported.',
          serverNames: [serverName],
          skillSlugs: [skillSlug],
        },
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            description: 'local tools',
            secretKeys: [],
            command: 'npx',
            args: ['-y', 'some-mcp'],
          },
        ],
        skills: [
          { slug: skillSlug, name: 'Imported Skill', description: 'does things', body: '# steps' },
        ],
      }),
    );

    expect(res.statusCode, res.body).toBe(201);
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
    expect((await listAgents()).some((agent) => agent.id === body.agent.id)).toBe(true);
  });

  it('keeps a supported role and rejects an unsupported one', async () => {
    const slug = unique('imp-role');
    const badSlug = unique('imp-bad-role');
    createdAgents.push(slug);

    const ok = await importZip(packageZip({ agent: { slug, name: slug, role: '数据分析师' } }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<AgentImportResult>().agent.role).toBe('数据分析师');

    const bad = await importZip(
      packageZip({
        agent: {
          slug: badSlug,
          name: badSlug,
          // 绕过类型：构造历史岗位值，导入必须拒绝。
          role: '历史自定义岗位' as '通用助手',
        },
      }),
    );
    const problem = expectProblem(bad, 'INVALID_INPUT');
    expect(problem.message).toMatch(/角色|岗位|role/i);
  });

  it('reuses an existing server by name and refuses a different kind', async () => {
    const serverName = unique('imp-reuse');
    const slug = unique('imp-reuse');
    const kindSlug = unique('imp-kind');
    const kindName = unique('imp-kind');
    createdServers.push(serverName, kindName);
    createdAgents.push(slug, kindSlug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: serverName, kind: 'http', url: 'https://example.com/mcp' },
    });
    expect(created.statusCode).toBe(201);

    const reused = await importZip(
      packageZip({
        agent: { slug, name: slug, serverNames: [serverName] },
        servers: [
          { name: serverName, kind: 'http', url: 'https://example.com/mcp', secretKeys: [] },
        ],
      }),
    );
    expect(reused.statusCode, reused.body).toBe(201);
    const body = reused.json<AgentImportResult>();
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.createdServers).toEqual([]);
    expect(body.agent.serverIds).toEqual([created.json<Server>().id]);

    const stdio = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: kindName, kind: 'stdio', command: 'node', args: [] },
    });
    expect(stdio.statusCode).toBe(201);
    const conflict = await importZip(
      packageZip({
        agent: { slug: kindSlug, name: kindSlug, serverNames: [kindName] },
        servers: [{ name: kindName, kind: 'http', url: 'https://example.com/mcp', secretKeys: [] }],
      }),
    );
    expect(conflict.statusCode).toBe(400);
  });

  it('rejects a server pointing at a private address without partial writes', async () => {
    const res = await importZip(
      packageZip({
        agent: { slug: unique('imp-ssrf'), name: 'ssrf' },
        servers: [
          {
            name: unique('imp-ssrf-srv'),
            kind: 'http',
            url: 'http://10.0.0.1/mcp',
            secretKeys: [],
          },
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
      headers: { cookie },
      payload: { slug, name: `Existing ${slug}` },
    });
    expect(first.statusCode).toBe(201);

    const res = await importZip(packageZip({ agent: { slug, name: `Imported ${slug}` } }));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.slug).toBe(`${slug}-2`);
    expect(body.agent.name).toBe(`Imported ${slug}`);
    expect(body.warnings.some((warning) => warning.includes(`${slug}-2`))).toBe(true);
  });

  it('rejects forbidden allowed tools without creating anything', async () => {
    const slug = unique('imp-tool');
    createdAgents.push(slug);
    const res = await importZip(
      packageZip({ agent: { slug, name: slug, allowedTools: ['mcp__ok__*', 'Monitor'] } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Monitor');
    expect((await listAgents()).some((agent) => agent.slug === slug)).toBe(false);
  });

  it('accepts Bash and Bash(...) and keeps an explicit deny through import', async () => {
    const slug = unique('imp-bash');
    createdAgents.push(slug);
    const res = await importZip(
      packageZip({
        agent: {
          slug,
          name: slug,
          allowedTools: ['Bash', 'Bash(git:*)'],
          disallowedTools: ['Bash(rm:*)'],
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json<AgentImportResult>();
    createdAgents.push(agent.slug);
    expect(agent.allowedTools).toEqual(['Bash', 'Bash(git:*)']);
    expect(agent.disallowedTools).toEqual(['Bash(rm:*)']);
  });

  it('rejects a legacy JSON package', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { cookie, 'content-type': 'application/zip' },
      payload: Buffer.from(
        JSON.stringify({ format: 'agentport/agent@1', agent: { slug: 'x', name: 'X' } }),
      ),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unsafe archives: absolute, .., backslash, duplicates, symlinks and bombs', async () => {
    const cases: Array<{ label: string; zip: Buffer }> = [
      { label: 'absolute path', zip: rawZip([{ name: '/etc/CLAUDE.md', content: 'x' }]) },
      {
        label: 'parent traversal',
        zip: rawZip([{ name: 'CLAUDE.md' }, { name: '../escape.md', content: 'x' }]),
      },
      {
        label: 'backslash',
        zip: rawZip([{ name: 'CLAUDE.md' }, { name: 'a\\b.md', content: 'x' }]),
      },
      {
        label: 'symlink',
        zip: rawZip([
          { name: 'CLAUDE.md' },
          { name: 'link.md', content: '/etc/passwd', mode: 0o120777 },
        ]),
      },
      {
        label: 'unknown capability path',
        zip: rawZip([{ name: 'CLAUDE.md' }, { name: '.claude/hooks/x.sh', content: 'rm -rf /' }]),
      },
    ];
    for (const { label, zip } of cases) {
      const res = await importZip(zip);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }

    // 声明解压后超大：不真正解压就拒绝。
    const bomb = rawZip([{ name: 'CLAUDE.md' }]);
    const original = bomb.indexOf('CLAUDE.md');
    // 把中央目录里的原始大小改成 0x00ffffff，模拟 zip bomb 声明。
    const central = bomb.lastIndexOf('PK\x01\x02');
    bomb.writeUInt32LE(0x00ffffff, central + 24);
    expect(original).toBeGreaterThan(0);
    expectProblem(await importZip(bomb), 'INVALID_INPUT');
  });

  it('accepts a package without sidecar using the query slug', async () => {
    const slug = unique('imp-nosidecar');
    createdAgents.push(slug);
    const files = packageFiles({
      agent: { slug: 'ignored', name: 'Plain official dir', systemPrompt: 'Plain prompt.' },
      omitSidecar: true,
    });
    // 侧车缺失时连接器绑定无法推断：带 .mcp.json 条目的目录必须明确拒绝。
    const withMcp = {
      ...files,
      '.mcp.json': JSON.stringify({
        mcpServers: { legacy: { type: 'http', url: 'https://x.test' } },
      }),
    };
    expectProblem(
      await importZip(
        rawZip(Object.entries(withMcp).map(([name, content]) => ({ name, content }))),
        `?slug=${slug}`,
      ),
      'INVALID_INPUT',
    );
    const zip = rawZip(Object.entries(files).map(([name, content]) => ({ name, content })));

    const missing = await importZip(zip);
    expect(missing.statusCode).toBe(400);

    const res = await importZip(zip, `?slug=${slug}&name=Plain`);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent).toMatchObject({ slug, name: 'Plain', systemPrompt: 'Plain prompt.' });
  });

  it('round-trips generated tools, bindings and secret keys', async () => {
    const sourceName = unique('pkg-gen-src');
    const importedName = unique('pkg-gen-dst');
    const sourceSlug = unique('pkg-gen-src');
    const importedSlug = unique('pkg-gen-dst');
    const secretValue = `Bearer ${unique('pkg-gen-secret')}`;
    createdServers.push(sourceName, importedName);
    createdAgents.push(importedSlug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: sourceName,
        kind: 'generated',
        baseUrl: GENERATED_BASE_URL,
        headers: { Authorization: secretValue },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const sourceServer = created.json<Server>();

    const tools: PortableTool[] = [
      makeTool({ name: 'list-users', description: 'list users' }),
      makeTool({
        name: 'create-user',
        method: 'POST',
        pathTemplate: '/users',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        paramsIn: 'body',
        requiresApproval: true,
      }),
      makeTool({
        name: 'delete-user',
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

    const files = await exportFiles(sourceAgent.id);
    const exported = sidecarOf(files);
    const sourceEntry = exported.servers.find((entry) => entry.name === sourceName);
    if (sourceEntry?.kind !== 'generated') {
      throw new Error('export did not include the generated server');
    }
    expect(sortByName(sourceEntry.tools ?? []).map(portable)).toEqual(
      sortByName(tools).map(portable),
    );

    // mcpToken 与加密列里的值都不能写入导出包。
    const tokenRow = await app.pool.query<{ token: string | null }>(
      "select config->>'mcpToken' as token from servers where name = $1",
      [sourceName],
    );
    const sourceToken = tokenRow.rows[0]?.token ?? '';
    expect(sourceToken).not.toBe('');
    expect(sourceEntry).not.toHaveProperty('mcpToken');
    expect(sourceEntry.secretKeys).toEqual(['Authorization']);
    const rawFiles = [...files.values()].join('\n');
    expect(rawFiles).not.toContain(sourceToken);
    expect(rawFiles).not.toContain(secretValue);

    // 目标实例换新名字，工具定义仍在包里。
    sourceEntry.name = importedName;
    exported.agent.slug = importedSlug;
    exported.agent.name = `Imported ${importedSlug}`;
    exported.agent.serverNames = [importedName];
    const zip = rawZip(
      [...files].map(([name, content]) => ({
        name,
        content:
          name === AGENT_PACKAGE_SIDECAR ? `${JSON.stringify(exported, null, 2)}\n` : content,
      })),
    );

    const res = await importZip(zip);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.agent.slug).toBe(importedSlug);
    expect(body.agent.id).not.toBe(sourceAgent.id);
    expect(body.createdServers).toEqual([importedName]);
    expect(body.warnings.some((warning) => warning.includes('Authorization'))).toBe(true);

    const importedServer = await serverByName(importedName);
    if (importedServer?.kind !== 'generated') {
      throw new Error('import did not create the generated server');
    }
    expect(importedServer.id).not.toBe(sourceServer.id);
    expect(body.agent.serverIds).toEqual([importedServer.id]);
    expect(importedServer.baseUrl).toBe(GENERATED_BASE_URL);
    expect(importedServer.headers).toEqual({});

    const importedTools = await listTools(importedServer.id);
    expect(sortByName(importedTools).map(portable)).toEqual(sortByName(tools).map(portable));
    const sourceToolIds = new Set(sourceTools.map((tool) => tool.id));
    for (const tool of importedTools) {
      expect(tool.serverId).toBe(importedServer.id);
      expect(sourceToolIds.has(tool.id)).toBe(false);
    }

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
    expect(sortByName(await listTools(sourceServer.id)).map(portable)).toEqual(
      sortByName(tools).map(portable),
    );
  });

  it('warns about drift on a reused server and keeps its secrets', async () => {
    const slug = unique('imp-drift');
    const serverName = unique('imp-drift-srv');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: serverName,
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer existing' },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, serverNames: [serverName] },
        servers: [
          {
            name: serverName,
            kind: 'http',
            url: 'https://example.com/other',
            secretKeys: ['Authorization'],
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.warnings.some((warning) => warning.includes('配置与导入包不同'))).toBe(true);
    expect(body.warnings.some((warning) => warning.includes('Authorization'))).toBe(false);

    const existing = await serverByName(serverName);
    expect(existing?.kind === 'http' ? existing.url : undefined).toBe('https://example.com/mcp');
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

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, serverNames: [serverName] },
        servers: [
          {
            name: serverName,
            kind: 'stdio',
            command: 'node',
            secretKeys: ['API_KEY', 'TOKEN'],
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('API_KEY');
    expect(body.warnings[0]).toContain('TOKEN');

    const row = await app.pool.query<{ secrets_encrypted: string | null }>(
      'select secrets_encrypted from servers where name = $1',
      [serverName],
    );
    expect(row.rows[0]?.secrets_encrypted).toBeNull();
    const servers = await inject(app, { method: 'GET', url: '/api/servers', headers: { cookie } });
    const imported = servers.json<Server[]>().find((server) => server.name === serverName);
    expect(imported?.kind === 'stdio' ? imported.env : imported?.headers).toEqual({});
  });

  it('reuses skills, preserving content and warning about drift', async () => {
    const slug = unique('imp-skill-reuse');
    const skillSlug = unique('imp-existing-skill');
    const targetSlug = unique('imp-skill-target');
    createdAgents.push(slug, targetSlug);
    createdSkills.push(skillSlug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: { slug: skillSlug, name: 'Existing', description: 'already here' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, skillSlugs: [skillSlug] },
        skills: [{ slug: skillSlug, name: 'Existing', description: 'already here', body: '# new' }],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.createdSkills).toEqual([]);
    expect(body.agent.skillIds).toHaveLength(1);
    expect(body.warnings.some((warning) => warning.includes(skillSlug))).toBe(true);
    const skills = await inject(app, { method: 'GET', url: '/api/skills', headers: { cookie } });
    expect(skills.json<Skill[]>().filter((skill) => skill.slug === skillSlug)).toHaveLength(1);
    expect(skills.json<Skill[]>().find((skill) => skill.slug === skillSlug)?.body).toBe('');
  });

  it('warns when a reused skill differs only in provenance and keeps the original', async () => {
    const slug = unique('imp-skill-prov');
    const again = unique('imp-skill-prov');
    const skillSlug = unique('imp-skill-prov-existing');
    createdAgents.push(slug, again);
    createdSkills.push(skillSlug);

    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: { cookie },
      payload: {
        slug: skillSlug,
        name: 'Existing',
        description: 'already here',
        license: 'MIT',
        compatibility: 'claude-code',
        metadata: { author: 'existing', version: 1 },
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const markdown = (provenance: string[]) =>
      [
        '---',
        `name: ${skillSlug}`,
        'description: already here',
        ...provenance,
        '---',
        '',
        '# Existing',
      ].join('\n');
    const importWith = (agentSlug: string, provenance: string[]) =>
      importZip(
        packageZip({
          agent: { slug: agentSlug, name: agentSlug, skillSlugs: [skillSlug] },
          skills: [{ slug: skillSlug, name: 'Existing', description: 'already here', body: '' }],
          extraFiles: {
            [`.claude/skills/${skillSlug}/SKILL.md`]: markdown(provenance),
          },
        }),
      );

    // 同值不同键序（JSONB 会重排键）不算来源漂移。
    const same = await importWith(slug, [
      'license: MIT',
      'compatibility: claude-code',
      'metadata: {"version":1,"author":"existing"}',
    ]);
    expect(same.statusCode, same.body).toBe(201);
    expect(same.json<AgentImportResult>().warnings.some((w) => w.includes('来源信息'))).toBe(false);

    const drift = await importWith(again, [
      'license: Apache-2.0',
      'compatibility: other-host',
      'metadata: {"author":"incoming","version":2}',
    ]);
    expect(drift.statusCode, drift.body).toBe(201);
    const body = drift.json<AgentImportResult>();
    expect(body.createdSkills).toEqual([]);
    // 只有来源字段不同：内容警告不出现，来源警告出现。
    expect(body.warnings.some((w) => w.includes('内容与导入包不同'))).toBe(false);
    expect(body.warnings.some((w) => w.includes('来源信息与导入包不同'))).toBe(true);

    const skills = await inject(app, { method: 'GET', url: '/api/skills', headers: { cookie } });
    expect(skills.statusCode, skills.body).toBe(200);
    expect(skills.json<Skill[]>().find((skill) => skill.slug === skillSlug)).toMatchObject({
      license: 'MIT',
      compatibility: 'claude-code',
      metadata: { author: 'existing', version: 1 },
    });
  });

  it('keeps resource files isolated when reused skills share a path', async () => {
    const slug = unique('imp-skill-isolated');
    const firstSlug = unique('imp-skill-isolated-a');
    const secondSlug = unique('imp-skill-isolated-b');
    createdAgents.push(slug);
    createdSkills.push(firstSlug, secondSlug);
    const first = await createSkillWithResources(firstSlug, 'First', 'shared path', [
      { path: 'notes.md', content: 'first-original' },
    ]);
    const second = await createSkillWithResources(secondSlug, 'Second', 'shared path', [
      { path: 'notes.md', content: 'second-original' },
    ]);

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, skillSlugs: [firstSlug, secondSlug] },
        skills: [
          {
            slug: firstSlug,
            name: 'First',
            description: 'shared path',
            body: '',
            files: [{ path: 'notes.md', content: 'first-original' }],
          },
          {
            // 与 first 的原文件相同：若两个技能共用/交换已有文件桶，警告集合会偏离预期。
            slug: secondSlug,
            name: 'Second',
            description: 'shared path',
            body: '',
            files: [{ path: 'notes.md', content: 'first-original' }],
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.createdSkills).toEqual([]);
    expect(body.warnings.filter((warning) => warning.includes('资源文件与导入包不同'))).toEqual([
      `已存在同名技能「${secondSlug}」，其资源文件与导入包不同，已保留原文件`,
    ]);
    expect(await skillResources(first.id)).toMatchObject([
      { path: 'notes.md', content: 'first-original' },
    ]);
    expect(await skillResources(second.id)).toMatchObject([
      { path: 'notes.md', content: 'second-original' },
    ]);
  });

  it('warns about missing, extra and changed resources in package skill order', async () => {
    const slug = unique('imp-skill-drift-kinds');
    const zeroSlug = unique('imp-drift-a-missing');
    const extraSlug = unique('imp-drift-b-extra');
    const changedSlug = unique('imp-drift-c-changed');
    createdAgents.push(slug);
    createdSkills.push(zeroSlug, extraSlug, changedSlug);
    const zero = await createSkillWithResources(zeroSlug, 'Zero', 'no resources', []);
    const extra = await createSkillWithResources(extraSlug, 'Extra', 'extra resource', [
      { path: 'notes.md', content: 'same' },
      { path: 'only-existing.md', content: 'old-only' },
    ]);
    const changed = await createSkillWithResources(changedSlug, 'Changed', 'changed resource', [
      { path: 'notes.md', content: 'old' },
    ]);

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, skillSlugs: [zeroSlug, extraSlug, changedSlug] },
        skills: [
          {
            slug: zeroSlug,
            name: 'Zero',
            description: 'no resources',
            body: '',
            files: [{ path: 'package-only.md', content: 'package-only' }],
          },
          {
            slug: extraSlug,
            name: 'Extra',
            description: 'extra resource',
            body: '',
            files: [{ path: 'notes.md', content: 'same' }],
          },
          {
            slug: changedSlug,
            name: 'Changed',
            description: 'changed resource',
            body: '',
            files: [{ path: 'notes.md', content: 'new' }],
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.createdSkills).toEqual([]);
    expect(body.warnings.filter((warning) => warning.includes('资源文件与导入包不同'))).toEqual([
      `已存在同名技能「${zeroSlug}」，其资源文件与导入包不同，已保留原文件`,
      `已存在同名技能「${extraSlug}」，其资源文件与导入包不同，已保留原文件`,
      `已存在同名技能「${changedSlug}」，其资源文件与导入包不同，已保留原文件`,
    ]);
    expect(await skillResources(zero.id)).toEqual([]);
    expect(await skillResources(extra.id)).toMatchObject([
      { path: 'notes.md', content: 'same' },
      { path: 'only-existing.md', content: 'old-only' },
    ]);
    expect(await skillResources(changed.id)).toMatchObject([{ path: 'notes.md', content: 'old' }]);
  });

  it('rejects duplicate server names without partial writes', async () => {
    const slug = unique('imp-dup-srv');
    const serverName = unique('imp-dup-srv-name');
    createdAgents.push(slug);
    createdServers.push(serverName);

    const res = await importZip(
      packageZip({
        agent: { slug, name: slug, serverNames: [serverName] },
        servers: [
          { name: serverName, kind: 'stdio', command: 'node', secretKeys: [] },
          { name: serverName, kind: 'stdio', command: 'deno', secretKeys: [] },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect((await listAgents()).some((agent) => agent.slug === slug)).toBe(false);
    expect(await serverByName(serverName)).toBeUndefined();
  });

  it('requires auth for import and export', async () => {
    const imported = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: { 'content-type': 'application/zip' },
      payload: packageZip({ agent: { slug: unique('imp-anon'), name: 'anon' } }),
    });
    expect(imported.statusCode).toBe(401);

    const exported = await inject(app, { method: 'GET', url: '/api/export/agents/agt_missing' });
    expect(exported.statusCode).toBe(401);
  });

  it('round-trips root and child rules, output styles and skill resources', async () => {
    const sourceSlug = unique('pkg-tree-src');
    const childSlug = unique('pkg-tree-child');
    const skillSlug = unique('pkg-tree-skill');
    const targetSlug = unique('pkg-tree-dst');
    createdAgents.push(sourceSlug, childSlug, targetSlug);
    createdSkills.push(skillSlug);

    const spec = {
      agent: {
        slug: sourceSlug,
        name: 'Portable root',
        systemPrompt: 'Root prompt.',
        skillSlugs: [skillSlug],
        effort: 'high' as const,
        uiFormat: 'openui' as const,
      },
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
          systemPrompt: 'CHILD-PROMPT',
          skills: [skillSlug],
          rules: [{ slug: 'child-rule', content: 'Keep child rules.', globs: '' }],
          outputStyles: [
            {
              slug: 'child-style',
              description: 'Child',
              keepCodingInstructions: false,
              body: 'Child voice.',
              isSelected: true,
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
    const source = await importZip(packageZip(spec));
    expect(source.statusCode, source.body).toBe(201);
    const sourceResult = source.json<AgentImportResult>();

    // 学习内容属于运行期产物；包只携带定义，不复制记忆正文。
    const memoryDir = join(testConfig().WORKSPACES_DIR, childSlug, 'agent-memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, 'MEMORY.md'), 'LEARNED-SECRET-CONTENT');

    const files = await exportFiles(sourceResult.agent.id);
    const exportedChildMd = files.get(`.claude/agents/${childSlug}.md`) ?? '';
    expect(exportedChildMd).toContain('CHILD-PROMPT');
    expect(exportedChildMd).toContain('memory: project');
    expect([...files.keys()].some((path) => path.includes('agent-memory'))).toBe(false);
    expect([...files.values()].join('\n')).not.toContain('LEARNED-SECRET-CONTENT');
    await rm(join(testConfig().WORKSPACES_DIR, childSlug), { recursive: true, force: true });

    expect(files.get('.claude/rules/root-rule.md')).toContain('Keep root rules.');
    expect(files.get('.claude/output-styles/brief.md')).toContain('Be brief.');
    expect(JSON.parse(files.get('.claude/settings.json') ?? '{}')).toEqual({
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' },
      outputStyle: 'brief',
    });
    expect(files.get(`.claude/skills/${skillSlug}/references/guide.md`)).toBe('# Guide');
    expect(files.get(`.claude/skills/${skillSlug}/scripts/run.sh`)).toBe('true\n');
    expect(files.get(`.claude/agents/${childSlug}.md`)).toContain('CHILD-PROMPT');
    const exported = sidecarOf(files);
    expect(exported.agent).toMatchObject({
      effort: 'high',
      uiFormat: 'openui',
    });
    expect(exported.subAgents[0]).toMatchObject({
      slug: childSlug,
      rules: [{ slug: 'child-rule', content: 'Keep child rules.', globs: '' }],
      outputStyles: [
        {
          slug: 'child-style',
          description: 'Child',
          keepCodingInstructions: false,
          body: 'Child voice.',
          isSelected: true,
        },
      ],
    });

    // 目标实例：改根 slug，导出包里的子定义随根一起迁移。
    const copy = new Map(files);
    exported.agent.slug = targetSlug;
    exported.agent.name = 'Imported root';
    copy.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(exported, null, 2)}\n`);
    const imported = await importZip(
      rawZip([...copy].map(([name, content]) => ({ name, content }))),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    expect(result.agent.slug).toBe(targetSlug);
    expect(result.createdSubAgents).toEqual([`${childSlug}-2`]);
    expect(result.agent.skillIds).toHaveLength(1);
    expect(result.createdSkills).toEqual([]);

    const roundTrip = await exportFiles(result.agent.id);
    const roundTripChildMd = roundTrip.get(`.claude/agents/${childSlug}-2.md`) ?? '';
    expect(roundTripChildMd).toContain('CHILD-PROMPT');
    expect(roundTripChildMd).toContain('memory: project');
    expect([...roundTrip.values()].join('\n')).not.toContain('LEARNED-SECRET-CONTENT');
    expect(roundTrip.get('.claude/rules/root-rule.md')).toBe(
      files.get('.claude/rules/root-rule.md'),
    );
    expect(roundTrip.get('.claude/output-styles/brief.md')).toBe(
      files.get('.claude/output-styles/brief.md'),
    );
    // 导入忽略 env，导出端按自己的必需项重新生成，往返后内容一致。
    expect(roundTrip.get('.claude/settings.json')).toBe(files.get('.claude/settings.json'));
    expect(roundTrip.get(`.claude/skills/${skillSlug}/references/guide.md`)).toBe('# Guide');
    const roundTripSidecar = sidecarOf(roundTrip);
    expect(roundTripSidecar.subAgents[0]?.rules).toEqual(exported.subAgents[0]?.rules);
    expect(roundTripSidecar.agent).toMatchObject({
      effort: 'high',
      uiFormat: 'openui',
    });
  });

  it('rejects user/local memory scopes in package child definitions', async () => {
    for (const scope of ['user', 'local']) {
      const slug = unique(`pkg-memory-${scope}`);
      const childSlug = unique(`pkg-memory-child-${scope}`);
      const files = packageFiles({
        agent: { slug, name: slug },
        subAgents: [{ slug: childSlug }],
      });
      const childPath = `.claude/agents/${childSlug}.md`;
      files[childPath] = (files[childPath] ?? '').replace('memory: project', `memory: ${scope}`);

      const res = await importZip(
        rawZip(Object.entries(files).map(([name, content]) => ({ name, content }))),
      );
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('round-trips OpenUI packages without polluting the prompt or duplicating the section', async () => {
    const sourceSlug = unique('pkg-openui-src');
    const targetSlug = unique('pkg-openui-dst');
    createdAgents.push(sourceSlug, targetSlug);

    const sourceAgent = (
      await createAgent(app, cookie, { slug: sourceSlug, track: createdAgents })
    ).json<Agent>();
    const prompt = '你是看板助手。\n\n## 规则\n\n1. 先查再答。';
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${sourceAgent.id}`,
      headers: { cookie },
      payload: { systemPrompt: prompt, uiFormat: 'openui' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const files = await exportFiles(sourceAgent.id);
    const exportedClaude = files.get('CLAUDE.md') ?? '';
    // 生成段只出现一次，并由专属标记包住；普通标题不再是边界。
    expect(exportedClaude.split('## 生成式 UI')).toHaveLength(2);
    expect(exportedClaude.split('## 工具使用')).toHaveLength(2);
    expect(exportedClaude).toContain(prompt);

    const copy = new Map(files);
    const exported = sidecarOf(copy);
    exported.agent.slug = targetSlug;
    exported.agent.name = `Imported ${targetSlug}`;
    copy.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(exported, null, 2)}\n`);
    const imported = await importZip(
      rawZip([...copy].map(([name, content]) => ({ name, content }))),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    createdAgents.push(result.agent.slug);
    // 生成段属于渲染产物，不能回流成用户 systemPrompt。
    expect(result.agent.uiFormat).toBe('openui');
    expect(result.agent.systemPrompt).toBe(prompt);
    expect(result.agent.systemPrompt).not.toContain('## 生成式 UI');
    expect(result.agent.systemPrompt).not.toContain('## 工具使用');

    const reexported = await exportFiles(result.agent.id);
    expect(reexported.get('CLAUDE.md')?.split('## 生成式 UI')).toHaveLength(2);
    expect(sidecarOf(reexported).agent.uiFormat).toBe('openui');
  });

  it('round-trips root and child prompts containing boundary lookalikes', async () => {
    const START = '<!-- agentport:generated:start -->';
    const END = '<!-- agentport:generated:end -->';
    const note = '你是被父智能体同步调用的：直接执行任务并返回最终文本。';
    const rootPrompt = [
      '你是看板助手。',
      '',
      '## 工具使用',
      '',
      '用户自己的同名标题。',
      '',
      START,
      '完整标记示例。',
      END,
      '',
      note,
      '',
      '## 工具使用',
      '',
      '重复标题也属于正文。',
    ].join('\n');
    const childPrompt = [
      '子智能体正文。',
      '',
      '## 工具使用',
      '',
      note,
      '',
      START,
      '示例',
      END,
    ].join('\n');

    const sourceSlug = unique('pkg-prompt-src');
    const childSlug = unique('pkg-prompt-child');
    const targetSlug = unique('pkg-prompt-dst');
    createdAgents.push(sourceSlug, childSlug, targetSlug);

    const childAgent = (
      await createAgent(app, cookie, { slug: childSlug, track: createdAgents })
    ).json<Agent>();
    const childPatched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${childAgent.id}`,
      headers: { cookie },
      payload: { systemPrompt: childPrompt, timeoutMs: 123_000 },
    });
    expect(childPatched.statusCode, childPatched.body).toBe(200);

    const sourceAgent = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        track: createdAgents,
        subAgentIds: [childAgent.id],
      })
    ).json<Agent>();
    const rootPatched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${sourceAgent.id}`,
      headers: { cookie },
      payload: { systemPrompt: rootPrompt, timeoutMs: 456_000 },
    });
    expect(rootPatched.statusCode, rootPatched.body).toBe(200);

    const files = await exportFiles(sourceAgent.id);
    const exportedClaude = files.get('CLAUDE.md') ?? '';
    expect(parseClaudeMd(exportedClaude).systemPrompt).toBe(rootPrompt);
    expect(exportedClaude.trimEnd().endsWith(END)).toBe(true);
    const exportedChildMd = files.get(`.claude/agents/${childSlug}.md`) ?? '';
    expect(parseChildAgentMd(exportedChildMd, `/child/${childSlug}`).systemPrompt).toBe(
      childPrompt,
    );

    // 只改根 slug；子级同名冲突会改名，所以不逐字比较整份文件，而是核对正文与生成段次数。
    const copy = new Map(files);
    const exported = sidecarOf(copy);
    exported.agent.slug = targetSlug;
    copy.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(exported, null, 2)}\n`);
    const imported = await importZip(
      rawZip([...copy].map(([name, content]) => ({ name, content }))),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    createdAgents.push(...result.createdSubAgents);
    expect(result.agent.systemPrompt).toBe(rootPrompt);
    // 独立运行超时是实体配置：父子不同值经包往返仍各自保留。
    expect(result.agent.timeoutMs).toBe(456_000);

    const importedChildSlug = result.createdSubAgents[0] ?? '';
    // 列表只返回摘要，正文要按实体 id 读取。
    const childRow = await app.pool.query<{ id: string }>('select id from agents where slug = $1', [
      importedChildSlug,
    ]);
    const importedChildId = childRow.rows[0]?.id ?? '';
    const importedChildGet = await inject(app, {
      method: 'GET',
      url: `/api/agents/${importedChildId}`,
      headers: { cookie },
    });
    expect(importedChildGet.statusCode, importedChildGet.body).toBe(200);
    expect(importedChildGet.json<Agent>().systemPrompt).toBe(childPrompt);
    expect(importedChildGet.json<Agent>().timeoutMs).toBe(123_000);

    const reexported = await exportFiles(result.agent.id);
    const reexportedClaude = reexported.get('CLAUDE.md') ?? '';
    // 没有回流、没有重复生成段：正文仍是原提示，生成段仍只追加一次。
    expect(reexportedClaude).not.toBe('');
    expect(reexportedClaude.split(START)).toHaveLength(3);
    expect(reexportedClaude.split(END)).toHaveLength(3);
    expect(reexportedClaude.split('## 任务清单')).toHaveLength(2);
    expect(reexportedClaude.trimEnd().endsWith(END)).toBe(true);
    const reexportedChildMd = reexported.get(`.claude/agents/${importedChildSlug}.md`) ?? '';
    expect(reexportedChildMd.split(START)).toHaveLength(3);
    expect(reexportedChildMd.split(END)).toHaveLength(3);
    expect(parseChildAgentMd(reexportedChildMd, `/child/${importedChildSlug}`).systemPrompt).toBe(
      childPrompt,
    );
  });

  it('keeps uiFormat through clone and version rollback', async () => {
    const slug = unique('pkg-openui-ver');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<Agent>();
    const toOpenUi = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie },
      payload: { uiFormat: 'openui' },
    });
    expect(toOpenUi.statusCode, toOpenUi.body).toBe(200);

    // 当前版本是 openui；回滚到仍为 markdown 的 v1 必须显式变回 markdown。
    const back = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: { cookie },
      payload: { version: 1 },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<Agent>().uiFormat).toBe('markdown');

    const again = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: { cookie },
      payload: { uiFormat: 'openui' },
    });
    expect(again.statusCode, again.body).toBe(200);

    const copySlug = unique('pkg-openui-copy');
    createdAgents.push(copySlug);
    const copy = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/duplicate`,
      headers: { cookie },
      payload: { slug: copySlug, name: 'Cloned OpenUI agent' },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json<Agent>().uiFormat).toBe('openui');

    // 回到 openui 版本（v2 = 第一次 PATCH 后），回滚后导出仍是生成式 UI。
    const restored = await inject(app, {
      method: 'POST',
      url: `/api/agents/${agent.id}/rollback`,
      headers: { cookie },
      payload: { version: 2 },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<Agent>().uiFormat).toBe('openui');
    expect((await exportFiles(agent.id)).get('CLAUDE.md')).toContain('## 生成式 UI');
  });

  it('rebinds the OpenUI tool catalog on import and previews the imported names', async () => {
    const sourceSlug = unique('pkg-openui-rebind-src');
    const importedSlug = unique('pkg-openui-rebind-dst');
    const sourceName = unique('pkg-openui-rebind-srv');
    const importedName = unique('pkg-openui-rebind-srv');
    const toolName = unique('openui-rebind-tool');
    createdAgents.push(sourceSlug, importedSlug);
    createdServers.push(sourceName, importedName);

    const sourceServer = await createServer(app, cookie, {
      name: sourceName,
      track: createdServers,
    });
    const tool = await createToolFor(sourceServer.id, makeTool({ name: toolName }));
    const sourceAgent = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        serverIds: [sourceServer.id],
        track: createdAgents,
      })
    ).json<Agent>();
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${sourceAgent.id}`,
      headers: { cookie },
      payload: { uiFormat: 'openui' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const files = await exportFiles(sourceAgent.id);
    const exported = sidecarOf(files);
    exported.agent.slug = importedSlug;
    exported.agent.name = `Imported ${importedSlug}`;
    exported.agent.serverNames = [importedName];
    const entry = exported.servers.find((server) => server.name === sourceName);
    if (entry === undefined) throw new Error('export did not include the bound server');
    entry.name = importedName;
    const imported = await importZip(
      rawZip(
        [...files].map(([name, content]) => ({
          name,
          content:
            name === AGENT_PACKAGE_SIDECAR ? `${JSON.stringify(exported, null, 2)}\n` : content,
        })),
      ),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    createdAgents.push(result.agent.slug);

    // 预览与运行时同源：换绑后的 server 名与工具名必须出现在新智能体的提示词里。
    const preview = await inject(app, {
      method: 'GET',
      url: `/api/agents/${result.agent.id}/files`,
      headers: { cookie },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const claudeMd = preview.json<{ claudeMd: string }>().claudeMd;
    expect(claudeMd).toContain(`mcp__${importedName}__${tool.name}`);
    expect(claudeMd).not.toContain(`mcp__${sourceName}__`);
    expect(claudeMd.split('## 生成式 UI')).toHaveLength(2);
  });

  it('imports a CRLF-encoded export without leaking the generated OpenUI section', async () => {
    const sourceSlug = unique('pkg-openui-crlf');
    const targetSlug = unique('pkg-openui-crlf-dst');
    createdAgents.push(sourceSlug, targetSlug);

    const sourceAgent = (
      await createAgent(app, cookie, { slug: sourceSlug, track: createdAgents })
    ).json<Agent>();
    const prompt = '你是报表助手。\n\n## 步骤\n\n1. 汇总。';
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${sourceAgent.id}`,
      headers: { cookie },
      payload: { systemPrompt: prompt, uiFormat: 'openui' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    // Windows 编辑器 / git autocrlf 会把导出的目录存成 CRLF；这是真实的文件格式，不是私人变体。
    const files = new Map(
      [...(await exportFiles(sourceAgent.id))].map(([name, content]) => [
        name,
        content.replace(/\n/g, '\r\n'),
      ]),
    );
    const exported = sidecarOf(files);
    exported.agent.slug = targetSlug;
    exported.agent.name = `Imported ${targetSlug}`;
    files.set(AGENT_PACKAGE_SIDECAR, `${JSON.stringify(exported, null, 2)}\r\n`);
    const imported = await importZip(
      rawZip([...files].map(([name, content]) => ({ name, content }))),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<AgentImportResult>();
    createdAgents.push(result.agent.slug);
    expect(result.agent.uiFormat).toBe('openui');
    expect(result.agent.systemPrompt).toBe(prompt);
  });

  it('rejects invalid skill resource paths and unknown frontmatter before writes', async () => {
    const cases: Array<{ label: string; files: Record<string, string> }> = [
      {
        label: 'unsafe resource path',
        files: { '.claude/skills/x/references/../../escape.md': 'x' },
      },
      {
        label: 'resource owns SKILL.md',
        files: { '.claude/skills/x/skill.md': 'x' },
      },
      {
        label: 'unknown skill frontmatter',
        files: {
          '.claude/skills/x/SKILL.md':
            '---\nname: x\ndescription: d\nallowed-tools: Bash\n---\n\n# x',
        },
      },
      {
        label: 'two selected output styles',
        files: {
          '.claude/output-styles/a.md': '---\nname: a\n---\n\nA',
          '.claude/output-styles/b.md': '---\nname: b\n---\n\nB',
          '.claude/settings.json': '{"outputStyle":"a","permissions":{}}',
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const slug = unique(`pkg-invalid-${index}`);
      createdAgents.push(slug);
      const spec = packageFiles({
        agent: { slug, name: slug, skillSlugs: ['x'] },
        skills: [{ slug: 'x', name: 'X', description: 'd', body: 'body' }],
        extraFiles: item.files,
      });
      const res = await importZip(
        rawZip(Object.entries(spec).map(([name, content]) => ({ name, content }))),
      );
      expect(res.statusCode, `${item.label}: ${res.body}`).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
      expect((await listAgents()).some((agent) => agent.slug === slug)).toBe(false);
    }
  });

  it('rejects more than 20 children and more than 100 resources on export', async () => {
    const rootSlug = unique('pkg-many-children');
    createdAgents.push(rootSlug);
    const createdRoot = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { slug: rootSlug, name: `Agent ${rootSlug}` },
    });
    expect(createdRoot.statusCode, createdRoot.body).toBe(201);
    const root = createdRoot.json<Agent>();

    const idPrefix = `agt_${unique('many')}_`;
    const slugPrefix = unique('pkg-child-bulk');
    for (let index = 1; index <= 21; index += 1) createdAgents.push(`${slugPrefix}-${index}`);
    await app.pool.query(
      `insert into agents (id, slug, name, model, system_prompt_md, parent_id, created_by, owner_business_id)
       select $1 || g, $2 || '-' || g, 'Bulk child ' || g, 'claude-sonnet-5-5', 'bulk', $3, 'bootstrap-admin', 'bootstrap-admin'
       from generate_series(1, 21) g`,
      [idPrefix, slugPrefix, root.id],
    );
    expectProblem(await exportAgent(root.id), 'CONFLICT');

    const resourceSlug = unique('pkg-many-skills');
    createdAgents.push(resourceSlug);
    const root2 = (
      await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: { cookie },
        payload: { slug: resourceSlug, name: `Agent ${resourceSlug}` },
      })
    ).json<Agent>();
    const skillPrefix = unique('pkg-bulk-skill');
    for (let index = 1; index <= 101; index += 1) createdSkills.push(`${skillPrefix}-${index}`);
    await app.pool.query(
      `insert into skills (id, slug, name, description, body)
       select $1 || g, $2 || '-' || g, 'Bulk skill ' || g, 'bulk', ''
       from generate_series(1, 101) g`,
      [`skl_${unique('bulk')}_`, skillPrefix],
    );
    await app.pool.query(
      `insert into agent_skills (agent_id, skill_id)
       select $1, id from skills where slug like $2`,
      [root2.id, `${skillPrefix}-%`],
    );
    expectProblem(await exportAgent(root2.id), 'CONFLICT');
  });

  it('rejects stored resource path collisions on export', async () => {
    const collisionCases: Array<{ label: string; paths: string[] }> = [
      ...['skill.md', 'SkIlL.mD', 'skill.md/child.md'].map((path) => ({
        label: `reserved ${path}`,
        paths: [path],
      })),
      { label: 'case-folded duplicate', paths: ['references/A.md', 'references/a.md'] },
      { label: 'ancestor first', paths: ['refs/A', 'refs/a/child.md'] },
      { label: 'descendant first', paths: ['refs/a/child.md', 'refs/A'] },
      // ZIP 编码本身拒绝空段/./..：这些坏路径在编码阶段就会失败，schema 在同一入口给出相同的 INVALID_INPUT。
      { label: 'empty segment', paths: ['a//b.md'] },
      { label: 'dot segment', paths: ['./refs/a.md'] },
      { label: 'parent segment', paths: ['refs/../a.md'] },
      // 空格在 ZIP 中合法，只有单路径 schema 拒绝：导出必须与导入/CRUD 用同一套规则。
      { label: 'non-canonical characters', paths: ['references/a b.md'] },
    ];
    for (const [index, item] of collisionCases.entries()) {
      const slug = unique(`pkg-collision-${index}`);
      const skillSlug = unique(`pkg-collision-skill-${index}`);
      createdAgents.push(slug);
      createdSkills.push(skillSlug);
      const imported = await importZip(
        packageZip({
          agent: { slug, name: slug, skillSlugs: [skillSlug] },
          skills: [{ slug: skillSlug, name: 'Collision', description: 'd', body: '# x' }],
        }),
      );
      expect(imported.statusCode, imported.body).toBe(201);
      const skill = await app.pool.query<{ id: string }>('select id from skills where slug = $1', [
        skillSlug,
      ]);
      await app.pool.query('delete from skill_files where skill_id = $1', [skill.rows[0]?.id]);
      for (const path of item.paths) {
        await app.pool.query(
          'insert into skill_files (id, skill_id, path, content) values ($1, $2, $3, $4)',
          [unique('collision-file'), skill.rows[0]?.id, path, 'Conflicting resource.'],
        );
      }
      const exported = await exportAgent(imported.json<AgentImportResult>().agent.id);
      expectProblem(exported, 'INVALID_INPUT');
    }
  });

  it('rejects definition limits on export and import', async () => {
    const slug = unique('pkg-limits');
    createdAgents.push(slug);
    const root = (
      await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: { cookie },
        payload: { slug, name: slug },
      })
    ).json<Agent>();
    const insertRules = async (count: number) => {
      await app.pool.query('delete from agent_rules where agent_id = $1', [root.id]);
      await app.pool.query(
        `insert into agent_rules (id, agent_id, slug, content, globs)
         select $1 || g, $2, 'rule-' || g, '', '' from generate_series(1, $3) g`,
        [`rule_${unique('bulk')}_`, root.id, count],
      );
    };
    await insertRules(51);
    expectProblem(await exportAgent(root.id), 'CONFLICT');
    await insertRules(50);
    expect((await exportAgent(root.id)).statusCode).toBe(200);

    // 导入端同一套上限：51 条规则直接拒绝，且不落库。
    const importSlug = unique('pkg-limits-import');
    createdAgents.push(importSlug);
    const res = await importZip(
      packageZip({
        agent: { slug: importSlug, name: importSlug },
        rules: Array.from({ length: 51 }, (_, index) => ({
          slug: `rule-${index}`,
          content: '',
          globs: '',
        })),
      }),
    );
    expectProblem(res, 'INVALID_INPUT');
    expect((await listAgents()).some((agent) => agent.slug === importSlug)).toBe(false);
  });

  it('reuses a same-name generated server without merging tools and warns', async () => {
    const serverName = unique('imp-reuse-tools');
    const sourceSlug = unique('imp-reuse-tools-src');
    const importedSlug = unique('imp-reuse-tools-dst');
    createdAgents.push(sourceSlug, importedSlug);

    const server = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: serverName, kind: 'generated', baseUrl: GENERATED_BASE_URL },
    });
    expect(server.statusCode, server.body).toBe(201);
    createdServers.push(serverName);
    const original = await createToolFor(
      server.json<Server>().id,
      makeTool({ name: 'keep-me', description: 'existing tool', pathTemplate: '/keep' }),
    );
    const sourceAgent = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        serverIds: [server.json<Server>().id],
        track: createdAgents,
      })
    ).json<Agent>();

    const files = await exportFiles(sourceAgent.id);
    const sidecar = sidecarOf(files);
    const entry = sidecar.servers.find((item) => item.name === serverName);
    if (entry?.kind !== 'generated') throw new Error('export missing generated server');
    // 同名 server 被复用时，包里的工具不能被合并进去。
    entry.tools = [...(entry.tools ?? []), makeTool({ name: 'incoming', pathTemplate: '/new' })];
    sidecar.agent.slug = importedSlug;
    const res = await importZip(
      rawZip(
        [...files].map(([name, content]) => ({
          name,
          content:
            name === AGENT_PACKAGE_SIDECAR ? `${JSON.stringify(sidecar, null, 2)}\n` : content,
        })),
      ),
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<AgentImportResult>();
    expect(body.createdServers).toEqual([]);
    expect(body.reusedServers).toEqual([serverName]);
    expect(body.warnings.some((warning) => warning.includes('工具'))).toBe(true);
    expect(body.agent.serverIds).toEqual([server.json<Server>().id]);

    const after = await listTools(server.json<Server>().id);
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe(original.name);
    expect(after.some((tool) => tool.name === 'incoming')).toBe(false);
  });

  it('rejects malformed tool definitions without partial writes', async () => {
    const cases: Array<{ label: string; server: Record<string, unknown> }> = [
      {
        label: 'duplicate tool names',
        server: {
          name: unique('imp-bad-tool-dup'),
          kind: 'generated',
          baseUrl: GENERATED_BASE_URL,
          tools: [makeTool({ name: 'dup-tool' }), makeTool({ name: 'dup-tool' })],
        },
      },
      {
        label: 'non-generated server with tools',
        server: {
          name: unique('imp-bad-tool-stdio'),
          kind: 'stdio',
          command: 'node',
          args: [],
          tools: [makeTool({ name: 'stdio-tool' })],
        },
      },
      {
        label: 'malformed tool',
        server: {
          name: unique('imp-bad-tool-shape'),
          kind: 'generated',
          baseUrl: GENERATED_BASE_URL,
          tools: [{ name: 'missing-path' }],
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const slug = unique(`imp-bad-${index}`);
      createdAgents.push(slug);
      const serverName = String(item.server.name);
      createdServers.push(serverName);
      const files = packageFiles({
        agent: { slug, name: slug, serverNames: [serverName] },
      });
      const sidecar = sidecarOf(new Map(Object.entries(files)));
      const res = await importZip(
        rawZip([
          ...Object.entries(files).map(([name, content]) => ({ name, content })),
          {
            name: AGENT_PACKAGE_SIDECAR,
            content: `${JSON.stringify({ ...sidecar, servers: [item.server] }, null, 2)}\n`,
          },
        ]),
      );
      expect(res.statusCode, `${item.label}: ${res.body}`).toBe(400);
      expect(
        (await listAgents()).some((agent) => agent.slug === slug),
        item.label,
      ).toBe(false);
      expect(await serverByName(serverName), item.label).toBeUndefined();
    }
  });

  it('accepts a package at the byte limit and rejects one byte more', async () => {
    const exactSlug = unique('pkg-exact');
    const skillSlug = unique('pkg-exact-skill');
    createdAgents.push(exactSlug);
    createdSkills.push(skillSlug);
    const resource = (length: number) => ({
      path: 'references/big.txt',
      content: 'x'.repeat(length),
    });
    const build = (length: number) =>
      packageZipStored({
        agent: { slug: exactSlug, name: 'Exact', skillSlugs: [skillSlug] },
        skills: [
          {
            slug: skillSlug,
            name: 'Exact skill',
            description: 'd',
            body: 'x',
            files: [resource(length)],
          },
        ],
      });
    // 不压缩打包时包体随内容线性增长；先量一次，再补齐到精确上限。
    const probe = build(100_000);
    const exact = build(100_000 + AGENT_PACKAGE_MAX_BYTES - probe.byteLength);
    expect(exact.byteLength).toBe(AGENT_PACKAGE_MAX_BYTES);

    const accepted = await importZip(exact);
    expect(accepted.statusCode, accepted.body).toBe(201);
    createdAgents.push(accepted.json<AgentImportResult>().agent.slug);

    expectProblem(await importZip(Buffer.concat([exact, Buffer.alloc(1, 0)])), 'PAYLOAD_TOO_LARGE');
  });

  it('rejects an import body over the ZIP limit', async () => {
    const oversized = Buffer.alloc(AGENT_PACKAGE_MAX_BYTES + 1, 0x50);
    expectProblem(await importZip(oversized), 'PAYLOAD_TOO_LARGE');
  });

  it('exports the portable TodoWrite env even without a selected output style', async () => {
    const slug = unique('pkg-settings-env');
    createdAgents.push(slug);
    const agent = (await createAgent(app, cookie, { slug, track: createdAgents })).json<Agent>();

    const files = await exportFiles(agent.id);
    const settings = files.get('.claude/settings.json') ?? '';
    expect(JSON.parse(settings)).toEqual({
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' },
    });
    // 沙盒专有的后台任务与委派深度限制不随定义包迁移。
    expect(settings).not.toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    expect(settings).not.toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH');
  });

  it('redacts the per-server secret mask from an exported .mcp.json', async () => {
    const slug = unique('pkg-mask');
    const serverName = unique('pkg-mask-srv');
    createdAgents.push(slug);
    createdServers.push(serverName);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: serverName,
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer super-secret' },
      },
    });
    expect(created.statusCode).toBe(201);
    const agent = (
      await createAgent(app, cookie, {
        slug,
        serverIds: [created.json<Server>().id],
        track: createdAgents,
      })
    ).json<Agent>();
    const files = await exportFiles(agent.id);
    const raw = [...files.values()].join('\n');
    expect(raw).not.toContain('super-secret');
    expect(files.get('.mcp.json')).toContain(serverName);
    expect(JSON.parse(files.get('.mcp.json') ?? '{}')).toEqual({
      mcpServers: { [serverName]: { type: 'http', url: 'https://example.com/mcp', headers: {} } },
    });
    expect(files.get(AGENT_PACKAGE_SIDECAR)).toContain('Authorization');
  });
});
