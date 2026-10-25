import type { Agent } from '@agentport/shared';
import { AGENT_PACKAGE_SIDECAR } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  injectZip,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';
import type { AgentSpec, ChildSpec, PackageSpec, SkillSpec } from './package-fixtures.js';
import { packageFiles, packageZip, rawZip, sidecarOf, unzipPackage } from './package-fixtures.js';

const ready = await infraReady;

interface ImportResult {
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
  method: string;
  pathTemplate: string;
  inputSchema: Record<string, unknown>;
  paramsIn: string;
  enabled: boolean;
  requiresApproval: boolean;
}

describe.skipIf(!ready)('sub-agent packages (official files)', () => {
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
  const importPackage = (spec: PackageSpec) =>
    injectZip(app, 'POST', '/api/import/agents', cookie, packageZip(spec));
  const exportFiles = async (id: string) => {
    const res = await injectZip(app, 'GET', `/api/export/agents/${id}`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return unzipPackage(res.rawPayload);
  };

  const child = (slug: string, overrides: Partial<ChildSpec> = {}): ChildSpec => ({
    slug,
    name: `Child ${slug}`,
    systemPrompt: `prompt for ${slug}`,
    ...overrides,
  });
  const skill = (slug: string): SkillSpec => ({
    slug,
    name: `Skill ${slug}`,
    description: `skill ${slug}`,
    body: '# steps',
  });
  const agent = (slug: string, overrides: Partial<AgentSpec> = {}): AgentSpec => ({
    slug,
    name: `Parent ${slug}`,
    systemPrompt: 'parent prompt',
    ...overrides,
  });

  const agentRow = async (
    slug: string,
  ): Promise<{ id: string; parent_id: string | null } | undefined> => {
    const res = await app.pool.query<{ id: string; parent_id: string | null }>(
      'select id, parent_id from agents where slug = $1',
      [slug],
    );
    return res.rows[0];
  };
  const versionsOf = async (agentId: string) => {
    const res = await app.pool.query<{ version: number; snapshot: Agent }>(
      'select version, snapshot from agent_versions where agent_id = $1 order by version',
      [agentId],
    );
    return res.rows;
  };
  const boundSkillSlugs = async (agentId: string): Promise<string[]> => {
    const res = await app.pool.query<{ slug: string }>(
      'select s.slug from agent_skills a join skills s on s.id = a.skill_id where a.agent_id = $1 order by s.slug',
      [agentId],
    );
    return res.rows.map((row) => row.slug);
  };
  const boundServerNames = async (agentId: string): Promise<string[]> => {
    const res = await app.pool.query<{ name: string }>(
      'select s.name from agent_servers a join servers s on s.id = a.server_id where a.agent_id = $1 order by s.name',
      [agentId],
    );
    return res.rows.map((row) => row.name);
  };
  const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));

  it('creates a parent and two fresh children with exact bindings', async () => {
    const parentSlug = unique('bundle-parent');
    const firstSlug = unique('bundle-child-a');
    const secondSlug = unique('bundle-child-b');
    const sharedServer = unique('bundle-srv-shared');
    const firstServer = unique('bundle-srv-a');
    const rootSkill = unique('bundle-skill-root');
    const firstSkill = unique('bundle-skill-a');
    const secondSkill = unique('bundle-skill-b');
    createdAgents.push(parentSlug, firstSlug, secondSlug);
    createdServers.push(sharedServer, firstServer);
    createdSkills.push(rootSkill, firstSkill, secondSkill);

    const res = await importPackage({
      agent: agent(parentSlug, {
        serverNames: [sharedServer],
        skillSlugs: [rootSkill],
      }),
      servers: [
        {
          name: sharedServer,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
        },
        {
          name: firstServer,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
          tools: [
            {
              name: 'list-a',
              description: '',
              method: 'GET',
              pathTemplate: '/list-a',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'query',
              requiresApproval: false,
              enabled: true,
            },
          ],
        },
      ],
      skills: [skill(rootSkill), skill(firstSkill), skill(secondSkill)],
      subAgents: [
        child(firstSlug, {
          serverNames: [firstServer],
          skills: [firstSkill],
          permissionMode: 'plan',
        }),
        child(secondSlug, { skills: [secondSkill] }),
      ],
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<ImportResult>();
    expect(body.createdSubAgents).toEqual([firstSlug, secondSlug]);
    expect(body.agent.subAgentIds).toHaveLength(2);
    expect(body.warnings).toEqual([]);

    const parent = await agentRow(parentSlug);
    const first = await agentRow(firstSlug);
    const second = await agentRow(secondSlug);
    expect(first?.parent_id).toBe(parent?.id);
    expect(second?.parent_id).toBe(parent?.id);
    expect(body.agent.id).toBe(parent?.id);

    expect(await boundSkillSlugs(parent?.id ?? '')).toEqual([rootSkill]);
    expect(await boundSkillSlugs(first?.id ?? '')).toEqual([firstSkill]);
    expect(await boundSkillSlugs(second?.id ?? '')).toEqual([secondSkill]);
    expect(await boundServerNames(parent?.id ?? '')).toEqual([sharedServer]);
    expect(await boundServerNames(first?.id ?? '')).toEqual([firstServer]);
    expect(await boundServerNames(second?.id ?? '')).toEqual([]);

    // 每个 agent 恰好一条 v1；父级快照包含最终的子智能体 id。
    for (const row of [parent, first, second]) {
      const versions = await versionsOf(row?.id ?? '');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(1);
    }
    expect((await versionsOf(first?.id ?? ''))[0]?.snapshot.parentId).toBe(parent?.id);
    expect((await versionsOf(parent?.id ?? ''))[0]?.snapshot.subAgentIds).toHaveLength(2);

    const tools = await app.pool.query<{ server_id: string; name: string }>(
      'select server_id, name from api_tools where name = $1',
      ['list-a'],
    );
    expect(tools.rows).toHaveLength(1);
    expect(tools.rows[0]?.server_id).toBe(
      (
        await app.pool.query<{ id: string }>('select id from servers where name = $1', [
          firstServer,
        ])
      ).rows[0]?.id,
    );
  });

  it('warns when a reused skill differs and preserves the existing body', async () => {
    const skillSlug = unique('bundle-skill-drift');
    const parentSlug = unique('bundle-skill-drift-parent');
    const childSlug = unique('bundle-skill-drift-child');
    createdSkills.push(skillSlug);
    createdAgents.push(parentSlug, childSlug);
    const seeded = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { ...skill(skillSlug), body: 'existing instructions' },
    });
    expect(seeded.statusCode).toBe(201);

    const res = await importPackage({
      agent: agent(parentSlug),
      skills: [{ ...skill(skillSlug), body: 'incoming instructions' }],
      subAgents: [child(childSlug, { skills: [skillSlug] })],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<ImportResult>().warnings).toEqual([
      `已存在同名技能「${skillSlug}」，其内容与导入包不同，已保留原配置`,
    ]);
    const stored = await app.pool.query<{ body: string }>(
      'select body from skills where slug = $1',
      [skillSlug],
    );
    expect(stored.rows[0]?.body).toBe('existing instructions');
    expect(await boundSkillSlugs(res.json<ImportResult>().agent.id)).toEqual([]);
  });

  it('suffixes a child slug that already belongs to another parent, without touching it', async () => {
    const oldParentSlug = unique('bundle-old-parent');
    const oldChildSlug = unique('bundle-old-child');
    const oldParent = (
      await createAgent(app, cookie, { slug: oldParentSlug, track: createdAgents })
    ).json<Agent>();
    const oldChild = (
      await createAgent(app, cookie, { slug: oldChildSlug, track: createdAgents })
    ).json<Agent>();
    const bound = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${oldParent.id}`,
      headers: auth(),
      payload: { subAgentIds: [oldChild.id] },
    });
    expect(bound.statusCode, bound.body).toBe(200);

    const parentSlug = unique('bundle-new-parent');
    createdAgents.push(parentSlug, `${oldChildSlug}-2`);
    const res = await importPackage({
      agent: agent(parentSlug),
      subAgents: [child(oldChildSlug, { systemPrompt: 'imported copy' })],
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<ImportResult>();
    expect(body.createdSubAgents).toEqual([`${oldChildSlug}-2`]);
    expect(body.warnings.some((warning) => warning.includes(`${oldChildSlug}-2`))).toBe(true);

    const newParent = await agentRow(parentSlug);
    const newChild = await agentRow(`${oldChildSlug}-2`);
    expect(newChild?.parent_id).toBe(newParent?.id);
    expect(newChild?.id).not.toBe(oldChild.id);
    const untouched = await agentRow(oldChildSlug);
    expect(untouched?.id).toBe(oldChild.id);
    expect(untouched?.parent_id).toBe(oldParent.id);
    expect(await versionsOf(oldChild.id)).toHaveLength(1);
  });

  it('rejects unresolvable references, forbidden tools and unknown fields', async () => {
    const cases: Array<{ label: string; spec: PackageSpec }> = [
      {
        label: 'unknown server reference',
        spec: {
          agent: agent(unique('bundle-bad-srv'), { serverNames: [unique('missing-srv')] }),
        },
      },
      {
        label: 'unknown skill reference',
        spec: {
          agent: agent(unique('bundle-bad-skill'), { skillSlugs: [unique('missing-skill')] }),
        },
      },
      {
        label: 'blocked allowed tool',
        spec: { agent: agent(unique('bundle-bad-tool'), { allowedTools: ['Monitor'] }) },
      },
      {
        label: 'unsupported permission mode',
        spec: {
          agent: {
            ...agent(unique('bundle-bad-mode')),
            // 绕过类型：auto 依赖分类器，平台不开放。
            permissionMode: 'auto' as 'dontAsk',
          },
        },
      },
      {
        label: 'child referencing a missing server',
        spec: (() => {
          const rootSlug = unique('bundle-bad-child-srv');
          const childSlug = unique('bundle-bad-child');
          const files = packageFiles({
            agent: agent(rootSlug),
            subAgents: [child(childSlug)],
          });
          // 子级绑定只能来自官方 mcpServers；引用包内没有的名字必须拒绝。
          const path = `.claude/agents/${childSlug}.md`;
          const md = (files[path] ?? '').replace(
            /^---\n/,
            `---\nmcpServers: ["${unique('nope')}"]\n`,
          );
          return {
            agent: agent(rootSlug),
            subAgents: [child(childSlug)],
            extraFiles: { [path]: md },
          } satisfies PackageSpec;
        })(),
      },
    ];
    for (const { label, spec } of cases) {
      const res = await importPackage(spec);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
      expect((await agentRow(spec.agent.slug))?.id, label).toBeUndefined();
    }

    // 侧车未知字段一律拒绝：旧格式的 ID 字段不能悄悄被忽略。
    const slug = unique('bundle-unknown');
    const files = packageFiles({ agent: agent(slug) });
    const sidecar = sidecarOf(new Map(Object.entries(files)));
    const tampered = rawZip(
      Object.entries({
        ...files,
        [AGENT_PACKAGE_SIDECAR]: `${JSON.stringify({ ...sidecar, format: 'agentport/agent@2' })}\n`,
      }).map(([name, content]) => ({ name, content })),
    );
    expectProblem(
      await injectZip(app, 'POST', '/api/import/agents', cookie, tampered),
      'INVALID_INPUT',
    );
    expect(await agentRow(slug)).toBeUndefined();
  });

  it('rejects duplicate names, duplicate refs and duplicate child files', async () => {
    const parentSlug = unique('bundle-dup-parent');
    const skillSlug = unique('bundle-dup-skill');
    const serverName = unique('bundle-dup-srv');
    createdAgents.push(parentSlug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const duplicateServer = await importPackage({
      agent: agent(parentSlug, { serverNames: [serverName] }),
      servers: [
        { name: serverName, kind: 'stdio', command: 'node', secretKeys: [] },
        { name: serverName, kind: 'stdio', command: 'deno', secretKeys: [] },
      ],
    });
    expectProblem(duplicateServer, 'INVALID_INPUT');

    const duplicateRef = await importPackage({
      agent: agent(parentSlug, { serverNames: [serverName, serverName] }),
      servers: [{ name: serverName, kind: 'stdio', command: 'node', secretKeys: [] }],
      skills: [{ ...skill(skillSlug), body: 'kept' }],
    });
    expectProblem(duplicateRef, 'INVALID_INPUT');

    // ZIP 内同名条目：底层归档校验直接拒绝，不落任何行。
    const childSlug = unique('bundle-dup-child');
    const files = packageFiles({ agent: agent(parentSlug), subAgents: [child(childSlug)] });
    const raw = rawZip([
      ...Object.entries(files).map(([name, content]) => ({ name, content })),
      { name: `.claude/agents/${childSlug}.md`, content: 'duplicate' },
    ]);
    expectProblem(await injectZip(app, 'POST', '/api/import/agents', cookie, raw), 'INVALID_INPUT');

    expect(await agentRow(parentSlug)).toBeUndefined();
    const createdSkill = await app.pool.query('select body from skills where slug = $1', [
      skillSlug,
    ]);
    expect(createdSkill.rowCount).toBe(0);
    expect(await agentRow(childSlug)).toBeUndefined();
  });

  it('rolls back every row when a reused server has a conflicting kind', async () => {
    const existingName = unique('bundle-conflict-existing');
    const freshName = unique('bundle-conflict-fresh');
    const parentSlug = unique('bundle-conflict-parent');
    const childSlug = unique('bundle-conflict-child');
    createdServers.push(existingName);
    createdAgents.push(parentSlug);
    const existing = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: { name: existingName, kind: 'stdio', command: 'node', args: [] },
    });
    expect(existing.statusCode, existing.body).toBe(201);

    const res = await importPackage({
      agent: agent(parentSlug),
      servers: [
        {
          name: freshName,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
        },
        { name: existingName, kind: 'http', url: 'https://example.com/mcp', secretKeys: [] },
      ],
      subAgents: [child(childSlug)],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(existingName);

    expect(await agentRow(parentSlug)).toBeUndefined();
    const fresh = await app.pool.query('select id from servers where name = $1', [freshName]);
    expect(fresh.rowCount).toBe(0);
    expect(await agentRow(childSlug)).toBeUndefined();
  });

  it('re-imports an exported package as a new parent with fresh child ids', async () => {
    const rootSlug = unique('bundle-export-root');
    const childSlug = unique('bundle-export-child');
    const serverName = unique('bundle-export-srv');
    const skillSlug = unique('bundle-export-skill');
    createdAgents.push(rootSlug, childSlug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const source = await importPackage({
      agent: agent(rootSlug, { serverNames: [serverName], skillSlugs: [skillSlug] }),
      servers: [
        {
          name: serverName,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
          tools: [
            {
              name: 'root-tool',
              description: '',
              method: 'GET',
              pathTemplate: '/root-tool',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'query',
              requiresApproval: true,
              enabled: false,
            },
          ],
        },
      ],
      skills: [skill(skillSlug)],
      subAgents: [child(childSlug, { skills: [skillSlug], enabled: false })],
    });
    expect(source.statusCode, source.body).toBe(201);
    const seeded = source.json<ImportResult>();
    const sourceRoot = await agentRow(rootSlug);
    const sourceChild = await agentRow(childSlug);

    const files = await exportFiles(seeded.agent.id);
    // 停用的子定义仍写成官方文件；状态在侧车里。
    expect(files.get(`.claude/agents/${childSlug}.md`)).toContain(`prompt for ${childSlug}`);
    const sidecar = sidecarOf(files);
    expect(sidecar.subAgents[0]).toMatchObject({ slug: childSlug, enabled: false });
    expect(sidecar.servers[0]).toMatchObject({
      name: serverName,
      kind: 'generated',
      tools: [
        {
          name: 'root-tool',
          description: '',
          method: 'GET',
          pathTemplate: '/root-tool',
          inputSchema: { type: 'object', properties: {} },
          paramsIn: 'query',
          requiresApproval: true,
          enabled: false,
        },
      ],
    });
    expect(sidecar.agent).toMatchObject({
      slug: rootSlug,
      serverNames: [serverName],
      skillSlugs: [skillSlug],
    });

    // 不改名导入：全部加后缀，源树不动。
    const copy = await injectZip(
      app,
      'POST',
      '/api/import/agents',
      cookie,
      rawZip([...files].map(([name, content]) => ({ name, content }))),
    );
    expect(copy.statusCode, copy.body).toBe(201);
    const imported = copy.json<ImportResult>();
    createdAgents.push(imported.agent.slug, ...imported.createdSubAgents);
    createdServers.push(...imported.createdServers);
    createdSkills.push(...imported.createdSkills);
    expect(imported.agent.slug).toBe(`${rootSlug}-2`);
    expect(imported.createdSubAgents).toEqual([`${childSlug}-2`]);
    // 同名资源复用，不重复创建。
    expect(imported.createdServers).toEqual([]);
    expect(imported.createdSkills).toEqual([]);

    const newRoot = await agentRow(`${rootSlug}-2`);
    const newChild = await agentRow(`${childSlug}-2`);
    expect(newRoot?.id).toBe(imported.agent.id);
    expect(newRoot?.id).not.toBe(sourceRoot?.id);
    expect(newRoot?.parent_id).toBeNull();
    expect(newChild?.parent_id).toBe(newRoot?.id);
    expect(newChild?.id).not.toBe(sourceChild?.id);

    const disabled = await app.pool.query<{ enabled: boolean }>(
      'select enabled from agents where id = $1',
      [newChild?.id],
    );
    expect(disabled.rows[0]?.enabled).toBe(false);

    expect(sorted(await boundServerNames(newRoot?.id ?? ''))).toEqual([serverName]);
    expect(sorted(await boundSkillSlugs(newRoot?.id ?? ''))).toEqual([skillSlug]);
    expect(sorted(await boundSkillSlugs(newChild?.id ?? ''))).toEqual([skillSlug]);

    // 源树与版本都不被改写。
    expect((await agentRow(rootSlug))?.id).toBe(sourceRoot?.id);
    expect((await agentRow(childSlug))?.parent_id).toBe(sourceRoot?.id);
    expect(await versionsOf(sourceChild?.id ?? '')).toHaveLength(1);
    expect((await versionsOf(newRoot?.id ?? ''))[0]?.snapshot.subAgentIds).toEqual([newChild?.id]);
  });

  it('records the import in the audit log without raw prompts', async () => {
    const parentSlug = unique('bundle-audit');
    const prompt = `secret-prompt-${parentSlug}`;
    createdAgents.push(parentSlug);

    const res = await importPackage({
      agent: agent(parentSlug, { systemPrompt: prompt }),
      subAgents: [child(`${parentSlug}-kid`, { systemPrompt: `${prompt}-kid` })],
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<ImportResult>();
    createdAgents.push(`${parentSlug}-kid`);

    const audit = await app.pool.query<{ input_digest: string | null }>(
      "select input_digest from audit_log where action = 'agent.imported' and target = $1",
      [body.agent.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.input_digest).not.toContain(prompt);
    expect(audit.rows[0]?.input_digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects more than 20 sub-agents per package', async () => {
    const parentSlug = unique('bundle-many');
    createdAgents.push(parentSlug);
    const res = await importPackage({
      agent: agent(parentSlug),
      subAgents: Array.from({ length: 21 }, (_, index) =>
        child(`${parentSlug}-${index.toString(36)}`),
      ),
    });
    expectProblem(res, 'INVALID_INPUT');
    expect(await agentRow(parentSlug)).toBeUndefined();
    // 只有真正新建的子定义才需要清理。
    for (let index = 0; index < 21; index += 1) {
      expect(await agentRow(`${parentSlug}-${index.toString(36)}`)).toBeUndefined();
    }
  });

  it('preserves child-only generated tools and bindings in the exported tree', async () => {
    const rootSlug = unique('bundle-tree-root');
    const childSlug = unique('bundle-tree-child');
    const childServer = unique('bundle-tree-srv-child');
    const sharedServer = unique('bundle-tree-srv-shared');
    createdAgents.push(rootSlug, childSlug);
    createdServers.push(childServer, sharedServer);

    const imported = await importPackage({
      agent: agent(rootSlug, { serverNames: [sharedServer] }),
      servers: [
        {
          name: sharedServer,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
        },
        {
          name: childServer,
          kind: 'generated',
          baseUrl: 'https://jsonplaceholder.typicode.com',
          secretKeys: [],
          tools: [
            {
              name: 'child-tool',
              description: '',
              method: 'POST',
              pathTemplate: '/child-tool',
              inputSchema: { type: 'object', properties: {} },
              paramsIn: 'body',
              requiresApproval: true,
              enabled: true,
            },
          ],
        },
      ],
      subAgents: [child(childSlug, { serverNames: [childServer, sharedServer] })],
    });
    expect(imported.statusCode, imported.body).toBe(201);

    const files = await exportFiles(imported.json<ImportResult>().agent.id);
    const sidecar = sidecarOf(files);
    expect(sorted(sidecar.agent.serverNames)).toEqual([sharedServer]);
    // 子级绑定只写在官方 md 的 mcpServers；侧车不重复。
    const childMd = files.get(`.claude/agents/${childSlug}.md`) ?? '';
    const mcpList = /mcpServers:\n((?: {2}- .*\n)*)/.exec(childMd)?.[1] ?? '';
    expect(
      sorted(
        mcpList
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^ {2}- "?|"$/g, '')),
      ),
    ).toEqual(sorted([childServer, sharedServer]));
    const exportedChildTools = sidecar.servers.find((entry) => entry.name === childServer);
    expect(exportedChildTools?.kind === 'generated' ? exportedChildTools.tools : undefined).toEqual(
      [
        {
          name: 'child-tool',
          description: '',
          method: 'POST',
          pathTemplate: '/child-tool',
          inputSchema: { type: 'object', properties: {} },
          paramsIn: 'body',
          requiresApproval: true,
          enabled: true,
        },
      ] satisfies PortableTool[],
    );
    // .mcp.json 与运行时一致：父 + 子绑定的并集，子定义按名字引用自己的条目。
    const mcp = JSON.parse(files.get('.mcp.json') ?? '{}') as {
      mcpServers: Record<string, unknown>;
    };
    // 与运行时同源：.mcp.json 是父 + 子绑定的并集，CLAUDE.md 的工具清单同源于此；
    // 子定义靠官方 mcpServers 名字只引用自己那几条。
    expect(Object.keys(mcp.mcpServers).sort()).toEqual([childServer, sharedServer].sort());
  });
});
