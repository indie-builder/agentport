import type { Agent, Server, Skill, WorkspaceFiles } from '@agentport/shared';
import { AGENT_PACKAGE_SIDECAR } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import { sidecarOf, unzipPackage } from './package-fixtures.js';

const ready = await infraReady;

/** 子定义的官方字段在 md，其余平台字段在侧车；这里只断言可移植部分。 */
const ALLOWED_SIDECAR_CHILD_KEYS = [
  'allowedTools',
  'disallowedTools',
  'enabled',
  'maxBudgetUsd',
  'maxThinkingTokens',
  'outputStyles',
  'permissionMode',
  'rules',
  'serverNames',
  'slug',
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
  let disabledServer: Server;
  let sharedServer: Server;
  let rootSkill: Skill;
  let childSkill: Skill;
  let sharedSkill: Skill;
  let disabledChildSkill: Skill;
  let toolIds: string[] = [];

  const auth = () => ({ cookie });
  const byIdOrder = (items: Array<{ id: string; name: string }>) =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((item) => item.name);

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
    ): Promise<{ id: string }> => {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/servers/${serverId}/tools`,
        headers: auth(),
        payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const tool = res.json<{ id: string }>();
      const patched = await inject(app, {
        method: 'PATCH',
        url: `/api/servers/${serverId}/tools/${tool.id}`,
        headers: auth(),
        payload: { enabled: false },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      return tool;
    };

    // 先建子级 server、后建父级 server：按分组顺序会得到 [父, …, 子]，
    // 统一投影必须按 server id 得到 [子, 父, …]。
    childServer = await createServer({
      name: unique('exp-child-srv'),
      kind: 'http',
      url: 'https://example.com/mcp',
    });
    rootServer = await createServer({
      name: unique('exp-root-srv'),
      kind: 'generated',
      baseUrl: 'https://jsonplaceholder.typicode.com',
      headers: { Authorization: 'Bearer root-secret-value' },
    });
    // 固定 id 顺序（子 a < 父 b），否则 uuidv7 同毫秒的随机位会让顺序断言偶然通过。
    const fixedServerId = (suffix: string) => `srv_${suffix.padStart(26, '0')}`;
    await app.pool.query('update servers set id = $1 where id = $2', [
      fixedServerId('a'),
      childServer.id,
    ]);
    await app.pool.query('update servers set id = $1 where id = $2', [
      fixedServerId('b'),
      rootServer.id,
    ]);
    childServer = { ...childServer, id: fixedServerId('a') };
    rootServer = { ...rootServer, id: fixedServerId('b') };
    // 只属于停用子级的 server：预览（运行时）不加载，导出仍携带其定义。
    disabledServer = await createServer({
      name: unique('exp-disabled-srv'),
      kind: 'http',
      url: 'https://example.net/mcp',
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
      serverIds: [sharedServer.id, disabledServer.id],
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

  const exportPackage = (id: string, headers: Record<string, string> = auth()) =>
    injectZip(app, 'GET', `/api/export/agents/${id}`, headers.cookie ?? '');

  it('exports root and children as official files with name references', async () => {
    const res = await exportPackage(parent.id);
    expect(res.statusCode, res.body).toBe(200);
    const files = unzipPackage(res.rawPayload);
    const sidecar = sidecarOf(files);

    expect(sidecar.agent.serverNames).toEqual([rootServer.name, sharedServer.name]);
    expect(sidecar.agent.skillSlugs).toEqual([rootSkill.slug, sharedSkill.slug]);
    expect(sidecar.agent).toMatchObject({
      slug: parent.slug,
      name: parent.name,
      effort: 'high',
      enabled: true,
    });
    expect(sidecar.agent.serverIds).toBeUndefined();

    const childFiles = [...files.keys()].filter((path) => path.startsWith('.claude/agents/'));
    expect(childFiles.sort()).toEqual(
      [firstChild.slug, disabledChild.slug].map((slug) => `.claude/agents/${slug}.md`).sort(),
    );
    const firstMd = files.get(`.claude/agents/${firstChild.slug}.md`) ?? '';
    // 官方文件承载提示词与技能预加载，不重复平台绑定字段。
    expect(firstMd).toContain('CHILD-ONE-PROMPT');
    expect(firstMd).toContain(childSkill.slug);
    expect(firstMd).toContain('effort: "low"');

    expect(sidecar.subAgents).toHaveLength(2);
    for (const child of sidecar.subAgents) {
      for (const key of Object.keys(child)) {
        expect(ALLOWED_SIDECAR_CHILD_KEYS, key).toContain(key);
      }
    }
    const first = sidecar.subAgents.find((entry) => entry.slug === firstChild.slug);
    const disabled = sidecar.subAgents.find((entry) => entry.slug === disabledChild.slug);
    expect(first).toMatchObject({ enabled: true, maxThinkingTokens: 2048 });
    expect(disabled).toMatchObject({ enabled: false });
    // 子级 MCP 绑定只写在官方 frontmatter 的 mcpServers（名字引用根 .mcp.json）。
    const disabledMd = files.get(`.claude/agents/${disabledChild.slug}.md`) ?? '';
    const mcpList = /mcpServers:\n((?: {2}- .*\n)*)/.exec(disabledMd)?.[1] ?? '';
    expect(mcpList).toContain(sharedServer.name);
    expect(mcpList).toContain(disabledServer.name);
    expect(mcpList).not.toContain(childServer.name);

    // 顶层资源是根与全部直接子智能体的并集，共用资源只出现一次，且按 server id 排序。
    expect(sidecar.servers.map((server) => server.name)).toEqual(
      byIdOrder([childServer, rootServer, disabledServer, sharedServer]),
    );
    expect(new Set(sidecar.servers.map((server) => server.name)).size).toBe(sidecar.servers.length);
    const skillFiles = [...files.keys()].filter((path) => path.endsWith('/SKILL.md'));
    expect(skillFiles.sort()).toEqual(
      [rootSkill.slug, childSkill.slug, sharedSkill.slug, disabledChildSkill.slug]
        .map((slug) => `.claude/skills/${slug}/SKILL.md`)
        .sort(),
    );

    // generated server 的工具保持可移植字段，密钥只留键名。
    const exportedRootServer = sidecar.servers.find((server) => server.name === rootServer.name);
    const exportedSharedServer = sidecar.servers.find(
      (server) => server.name === sharedServer.name,
    );
    expect(
      exportedSharedServer?.kind === 'generated'
        ? exportedSharedServer.tools?.map((tool) => tool.name)
        : undefined,
    ).toEqual(['shared-tool']);
    expect(exportedRootServer?.kind === 'generated' ? exportedRootServer.tools : undefined).toEqual(
      [
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
      ],
    );
    expect(exportedRootServer?.secretKeys).toEqual(['Authorization']);

    // agent/skill/tool 的源实例 ID 不能出现在包里；generated 的 .mcp.json 必须指向
    // 平台自己的 /mcp/<serverId> 端点（不是上游 baseUrl），导入时按新 id 重建。
    const raw = [...files.values()].join('\n');
    const foreignIds = [
      parent.id,
      firstChild.id,
      disabledChild.id,
      rootSkill.id,
      childSkill.id,
      sharedSkill.id,
      disabledChildSkill.id,
      ...toolIds,
    ];
    for (const id of foreignIds) expect(raw).not.toContain(id);
    const mcp = JSON.parse(files.get('.mcp.json') ?? '{}') as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(mcp.mcpServers[rootServer.name]?.url).toBe(`http://127.0.0.1:3000/mcp/${rootServer.id}`);
    expect(mcp.mcpServers[rootServer.name]?.url).not.toContain('jsonplaceholder.typicode.com');
    // 导出包含停用子级的 server（有意差异），顺序同样按 id。
    expect(Object.keys(mcp.mcpServers)).toEqual(
      byIdOrder([childServer, rootServer, disabledServer, sharedServer]),
    );
    expect(raw).not.toContain('root-secret-value');
    expect(files.get(AGENT_PACKAGE_SIDECAR)).toBeDefined();
  });

  it('renders the root workspace with enabled child resources but not disabled child resources', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/agents/${parent.id}/files`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const workspace = res.json<WorkspaceFiles>();

    // 与 worker 落盘一致：.mcp.json 是父 + 启用子级的并集，停用子级的 server 不进入运行时；
    // 顺序与导出/运行共用同一 id 排序，子级先建时也不能把父级排到前面。
    const mcpServers = JSON.parse(workspace.mcpJson).mcpServers as Record<string, unknown>;
    expect(Object.keys(mcpServers)).toEqual(byIdOrder([childServer, rootServer, sharedServer]));
    expect(mcpServers).not.toHaveProperty(disabledServer.name);
    // CLAUDE.md 列出工作区里所有可用条目；子级条目只归子级，父级在 agentMd 里显式禁用。
    expect(workspace.claudeMd).toContain(childServer.name);
    expect(workspace.claudeMd).not.toContain(disabledServer.name);
    expect(workspace.claudeMd).toContain(rootSkill.slug);
    expect(workspace.claudeMd).toContain(sharedSkill.slug);
    expect(workspace.claudeMd).not.toContain(childSkill.slug);
    expect(workspace.agentMd).toContain(`"mcp__${childServer.name}"`);
    expect(workspace.agentMd).not.toContain(`"mcp__${childServer.name}__*"`);

    // 停用的子智能体不渲染到运行时工作区；导出仍保留其定义。
    expect(workspace.subAgents.map((subAgent) => subAgent.slug)).toEqual([firstChild.slug]);
    const childFile = workspace.subAgents[0];
    expect(childFile?.content).toContain(childSkill.slug);
    expect(childFile?.content).toContain('CHILD-ONE-PROMPT');
    expect(childFile?.content).not.toContain('ROOT-PROMPT');
    // 子定义按名字引用根 .mcp.json 里自己的条目。
    const childMcp = /mcpServers:\n((?: {2}- .*\n)*)/.exec(childFile?.content ?? '')?.[1] ?? '';
    expect(childMcp).toContain(childServer.name);
    expect(childMcp).toContain(sharedServer.name);
    expect(childMcp).not.toContain(rootServer.name);
    expect(childMcp).not.toContain(disabledServer.name);
  });

  it('requires auth', async () => {
    expectProblem(await exportPackage(parent.id, {}), 'UNAUTHORIZED');
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

    // 明确拒绝，不返回被截断的 ZIP。
    const res = await exportPackage(root.id);
    expectProblem(res, 'CONFLICT');
    expect(res.rawPayload.byteLength).toBeLessThan(1_000);
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

    expectProblem(await exportPackage(root.id), 'CONFLICT');
  });
});
