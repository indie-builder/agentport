import type { Agent, Server, Skill, WorkspaceFiles } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface PortableTool {
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  paramsIn: string;
  enabled: boolean;
  requiresApproval: boolean;
}

interface ExportServer {
  name: string;
  kind: string;
  description: string;
  config: Record<string, unknown>;
  secretKeys: string[];
  tools?: Array<PortableTool & { id?: string; serverId?: string }>;
}

interface PortableAgent {
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  enabled: boolean;
  effort?: string;
  maxThinkingTokens?: number;
  serverNames: string[];
  skillSlugs: string[];
  serverIds?: string[];
  skillIds?: string[];
  subAgentIds?: string[];
  id?: string;
  parentId?: string;
}

interface AgentExportFile {
  format: string;
  exportedAt: string;
  agent: PortableAgent;
  subAgents: PortableAgent[];
  servers: ExportServer[];
  skills: Array<{ slug: string; name: string; description: string; body: string }>;
  workspace: WorkspaceFiles;
}

/** 子智能体可移植字段：agentInputSchema 去掉 ID 数组，再补名称引用。 */
const ALLOWED_SUB_AGENT_KEYS = [
  'allowedTools',
  'description',
  'disallowedTools',
  'effort',
  'enabled',
  'maxBudgetUsd',
  'maxThinkingTokens',
  'maxTurns',
  'model',
  'name',
  'permissionMode',
  'serverNames',
  'skillSlugs',
  'slug',
  'systemPrompt',
  'timeoutMs',
];

describe.skipIf(!ready)('subagent export', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const skillSlugs: string[] = [];

  let parent: Agent;
  let firstChild: Agent;
  let disabledChild: Agent;
  let rootServer: Server;
  let childServer: Server;
  let sharedServer: Server;
  let rootSkill: Skill;
  let childSkill: Skill;
  let sharedSkill: Skill;
  let disabledChildSkill: Skill;
  let toolIds: string[] = [];

  const auth = () => ({ cookie });

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);

    const createAgentWith = async (
      slug: string,
      extra: Record<string, unknown>,
    ): Promise<Agent> => {
      agentSlugs.push(slug);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/agents',
        headers: auth(),
        payload: { slug, name: `Agent ${slug}`, ...extra },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Agent>();
    };
    const createSkill = async (slug: string): Promise<Skill> => {
      skillSlugs.push(slug);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/skills',
        headers: auth(),
        payload: { slug, name: `Skill ${slug}`, description: `${slug} description`, body: slug },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<Skill>();
    };
    const createServer = async (payload: Record<string, unknown>): Promise<Server> => {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/servers',
        headers: auth(),
        payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const server = res.json<Server>();
      serverNames.push(server.name);
      return server;
    };
    const createTool = async (
      serverId: string,
      payload: Record<string, unknown>,
    ): Promise<PortableTool & { id: string }> => {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/servers/${serverId}/tools`,
        headers: auth(),
        payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const tool = res.json<PortableTool & { id: string }>();
      const patched = await inject(app, {
        method: 'PATCH',
        url: `/api/servers/${serverId}/tools/${tool.id}`,
        headers: auth(),
        payload: { enabled: false },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      return tool;
    };

    rootServer = await createServer({
      name: unique('exp-root-srv'),
      kind: 'generated',
      baseUrl: 'https://jsonplaceholder.typicode.com',
      headers: { Authorization: 'Bearer root-secret-value' },
    });
    childServer = await createServer({
      name: unique('exp-child-srv'),
      kind: 'http',
      url: 'https://example.com/mcp',
    });
    // 根与子智能体共用的 server：导出里只能出现一次，工具也只带一份。
    sharedServer = await createServer({
      name: unique('exp-shared-srv'),
      kind: 'generated',
      baseUrl: 'https://example.org/api',
    });

    rootSkill = await createSkill(unique('exp-root-skill'));
    childSkill = await createSkill(unique('exp-child-skill'));
    sharedSkill = await createSkill(unique('exp-shared-skill'));
    disabledChildSkill = await createSkill(unique('exp-disabled-skill'));

    const rootTool = await createTool(rootServer.id, {
      name: 'root-tool',
      pathTemplate: '/root',
      requiresApproval: true,
    });
    const sharedTool = await createTool(sharedServer.id, {
      name: 'shared-tool',
      pathTemplate: '/shared',
    });
    toolIds = [rootTool.id, sharedTool.id];

    firstChild = await createAgentWith(unique('exp-child-one'), {
      systemPrompt: 'CHILD-ONE-PROMPT',
      effort: 'low',
      maxThinkingTokens: 2048,
      serverIds: [childServer.id, sharedServer.id],
      skillIds: [childSkill.id],
    });
    disabledChild = await createAgentWith(unique('exp-child-two'), {
      systemPrompt: 'CHILD-TWO-PROMPT',
      enabled: false,
      serverIds: [sharedServer.id],
      skillIds: [disabledChildSkill.id, sharedSkill.id],
    });
    parent = await createAgentWith(unique('exp-parent'), {
      systemPrompt: 'ROOT-PROMPT',
      effort: 'high',
      serverIds: [rootServer.id, sharedServer.id],
      skillIds: [rootSkill.id, sharedSkill.id],
      subAgentIds: [firstChild.id, disabledChild.id],
    });
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, serverNames, skillSlugs });
    await app.close();
  });

  const exportAgent = (id: string, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'GET', url: `/api/export/agents/${id}`, headers });

  it('exports root and children with name references instead of local ids', async () => {
    const res = await exportAgent(parent.id);
    expect(res.statusCode, res.body).toBe(200);
    const file = res.json<AgentExportFile>();

    expect(file.format).toBe('agentport/agent@1');
    // 根智能体只声明自己的绑定；子智能体的资源不进根名称列表。
    expect(file.agent.serverNames).toEqual(
      [rootServer.name, sharedServer.name].sort((a, b) => a.localeCompare(b)),
    );
    expect(file.agent.skillSlugs).toEqual(
      [rootSkill.slug, sharedSkill.slug].sort((a, b) => a.localeCompare(b)),
    );
    expect(file.agent.serverIds).toEqual([]);
    expect(file.agent.skillIds).toEqual([]);
    expect(file.agent.subAgentIds).toEqual([]);
    expect(file.agent).not.toHaveProperty('parentId');
    expect(file.agent).toMatchObject({
      systemPrompt: 'ROOT-PROMPT',
      effort: 'high',
      enabled: true,
    });

    const first = file.subAgents.find((subAgent) => subAgent.slug === firstChild.slug);
    const disabled = file.subAgents.find((subAgent) => subAgent.slug === disabledChild.slug);
    expect(file.subAgents).toHaveLength(2);
    expect(first).toBeDefined();
    expect(disabled).toBeDefined();
    // 子智能体只带可移植配置：没有本机 id、时间戳、父级或资源 ID。
    for (const subAgent of file.subAgents) {
      for (const key of Object.keys(subAgent)) {
        expect(ALLOWED_SUB_AGENT_KEYS, key).toContain(key);
      }
      const forbidden = ['id', 'parentId', 'serverIds', 'skillIds', 'subAgentIds'];
      for (const key of forbidden) expect(subAgent).not.toHaveProperty(key);
    }
    expect(first).toMatchObject({
      systemPrompt: 'CHILD-ONE-PROMPT',
      effort: 'low',
      enabled: true,
      maxThinkingTokens: 2048,
      serverNames: [childServer.name, sharedServer.name].sort((a, b) => a.localeCompare(b)),
      skillSlugs: [childSkill.slug],
    });
    // 停用的子智能体也要导出，且保留停用状态。
    expect(disabled).toMatchObject({
      systemPrompt: 'CHILD-TWO-PROMPT',
      enabled: false,
      serverNames: [sharedServer.name],
      skillSlugs: [disabledChildSkill.slug, sharedSkill.slug].sort((a, b) => a.localeCompare(b)),
    });

    // 顶层资源是根与全部直接子智能体的并集，共用资源只出现一次。
    expect(file.servers.map((server) => server.name).sort()).toEqual(
      [rootServer.name, childServer.name, sharedServer.name].sort((a, b) => a.localeCompare(b)),
    );
    expect(file.skills.map((skill) => skill.slug).sort()).toEqual(
      [rootSkill.slug, childSkill.slug, sharedSkill.slug, disabledChildSkill.slug].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(new Set(file.servers.map((server) => server.name)).size).toBe(file.servers.length);
    expect(new Set(file.skills.map((skill) => skill.slug)).size).toBe(file.skills.length);

    // generated server 的工具保持可移植字段，密钥只留键名。
    const exportedRootServer = file.servers.find((server) => server.name === rootServer.name);
    const exportedSharedServer = file.servers.find((server) => server.name === sharedServer.name);
    expect(exportedSharedServer?.tools?.map((tool) => tool.name)).toEqual(['shared-tool']);
    expect(exportedRootServer?.tools).toEqual([
      {
        name: 'root-tool',
        description: '',
        method: 'GET',
        pathTemplate: '/root',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'query',
        enabled: false,
        requiresApproval: true,
      },
    ]);
    expect(exportedRootServer?.tools?.[0]).not.toHaveProperty('id');
    expect(exportedRootServer?.tools?.[0]).not.toHaveProperty('serverId');
    expect(exportedRootServer?.secretKeys).toEqual(['Authorization']);
    expect(res.body).not.toContain('root-secret-value');

    // 任何源实例 ID 都不能出现在导出文件里。
    const foreignIds = [
      parent.id,
      firstChild.id,
      disabledChild.id,
      rootServer.id,
      childServer.id,
      sharedServer.id,
      rootSkill.id,
      childSkill.id,
      sharedSkill.id,
      disabledChildSkill.id,
      ...toolIds,
    ];
    for (const id of foreignIds) expect(res.body).not.toContain(id);
  });

  it('renders the root workspace with child skills but not child resources', async () => {
    const res = await exportAgent(parent.id);
    expect(res.statusCode, res.body).toBe(200);
    const { workspace } = res.json<AgentExportFile>();

    // 预览只给根智能体自己的 server；子智能体独有或共用的 server 都不扩给父级。
    const mcpServers = JSON.parse(workspace.mcpJson).mcpServers as Record<string, unknown>;
    expect(Object.keys(mcpServers).sort()).toEqual(
      [rootServer.name, sharedServer.name].sort((a, b) => a.localeCompare(b)),
    );
    expect(mcpServers).not.toHaveProperty(childServer.name);
    expect(workspace.claudeMd).not.toContain(childServer.name);
    expect(workspace.claudeMd).toContain(rootSkill.slug);
    expect(workspace.claudeMd).toContain(sharedSkill.slug);
    expect(workspace.claudeMd).not.toContain(childSkill.slug);
    expect(workspace.claudeMd).not.toContain(disabledChildSkill.slug);

    // 子智能体文件带自己的技能声明；停用的子智能体不渲染。
    expect(workspace.subAgents.map((subAgent) => subAgent.slug)).toEqual([firstChild.slug]);
    const childFile = workspace.subAgents[0];
    expect(childFile?.content).toContain(childSkill.slug);
    expect(childFile?.content).toContain('CHILD-ONE-PROMPT');
    expect(childFile?.content).not.toContain('ROOT-PROMPT');
    expect(childFile?.content).not.toContain(disabledChildSkill.slug);
  });

  it('requires auth', async () => {
    expectProblem(await exportAgent(parent.id, {}), 'UNAUTHORIZED');
  });

  it('rejects more than 20 direct children without truncating', async () => {
    const rootSlug = unique('exp-many-children');
    agentSlugs.push(rootSlug);
    const createdRoot = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug: rootSlug, name: `Agent ${rootSlug}` },
    });
    expect(createdRoot.statusCode, createdRoot.body).toBe(201);
    const root = createdRoot.json<Agent>();

    const idPrefix = `agt_${unique('many')}_`;
    const slugPrefix = unique('exp-child-bulk');
    for (let index = 1; index <= 21; index += 1) agentSlugs.push(`${slugPrefix}-${index}`);
    await app.pool.query(
      `insert into agents (id, slug, name, model, system_prompt_md, parent_id)
       select $1 || g, $2 || '-' || g, 'Bulk child ' || g, 'claude-sonnet-5-5', 'bulk', $3
       from generate_series(1, 21) g`,
      [idPrefix, slugPrefix, root.id],
    );

    const res = await exportAgent(root.id);
    expectProblem(res, 'CONFLICT');
    // 明确拒绝，不返回被截断的 20 个。
    expect(res.json()).not.toHaveProperty('subAgents');
  });

  it('rejects more than 100 union resources without truncating', async () => {
    const resourceSlug = unique('exp-many-skills');
    agentSlugs.push(resourceSlug);
    const createdRoot = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: auth(),
      payload: { slug: resourceSlug, name: `Agent ${resourceSlug}` },
    });
    expect(createdRoot.statusCode, createdRoot.body).toBe(201);
    const root = createdRoot.json<Agent>();

    const skillPrefix = unique('exp-bulk-skill');
    for (let index = 1; index <= 101; index += 1) skillSlugs.push(`${skillPrefix}-${index}`);
    await app.pool.query(
      `insert into skills (id, slug, name, description, body)
       select $1 || g, $2 || '-' || g, 'Bulk skill ' || g, 'bulk', ''
       from generate_series(1, 101) g`,
      [`skl_${unique('bulk')}_`, skillPrefix],
    );
    await app.pool.query(
      `insert into agent_skills (agent_id, skill_id)
       select $1, id from skills where slug like $2`,
      [root.id, `${skillPrefix}-%`],
    );

    const res = await exportAgent(root.id);
    expectProblem(res, 'CONFLICT');
    expect(res.json()).not.toHaveProperty('skills');
  });
});
