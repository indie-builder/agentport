import type { Agent, Server } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

interface BundleChild {
  slug: string;
  name?: string;
  systemPrompt?: string;
  serverNames?: string[];
  skillSlugs?: string[];
  allowedTools?: string[];
  permissionMode?: string;
  [key: string]: unknown;
}

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

interface CopyAgent {
  slug: string;
  name: string;
  serverNames?: string[];
  skillSlugs?: string[];
  enabled?: boolean;
  [key: string]: unknown;
}

/** 导出文件的可移植视图：不声明 id，断言时也用不到。 */
interface CopyFile {
  format: string;
  agent: CopyAgent;
  subAgents: CopyAgent[];
  servers: Array<{
    name: string;
    kind: string;
    tools?: PortableTool[];
  }>;
  skills: Array<{ slug: string; name: string; description: string; body: string }>;
}

interface AgentVersionRow {
  version: number;
  snapshot: Agent;
}

describe.skipIf(!ready)('sub-agent bundles', () => {
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
  const importBundle = (payload: object) =>
    inject(app, { method: 'POST', url: '/api/import/agents', headers: auth(), payload });

  const child = (slug: string, overrides: Partial<BundleChild> = {}): BundleChild => ({
    slug,
    name: `Child ${slug}`,
    systemPrompt: `prompt for ${slug}`,
    ...overrides,
  });

  const skill = (slug: string) => ({
    slug,
    name: `Skill ${slug}`,
    description: `skill ${slug}`,
    body: '# steps',
  });

  const server = (name: string, url = 'https://jsonplaceholder.typicode.com') => ({
    name,
    kind: 'generated',
    description: '',
    config: { baseUrl: url },
    secretKeys: [],
  });

  const tool = (name: string) => ({
    name,
    description: '',
    method: 'GET',
    pathTemplate: `/${name}`,
    inputSchema: { type: 'object', properties: {} },
    paramsIn: 'query',
    requiresApproval: false,
    enabled: true,
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
  const versionsOf = async (agentId: string): Promise<AgentVersionRow[]> => {
    const res = await app.pool.query<AgentVersionRow>(
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

    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: {
        slug: parentSlug,
        name: `Parent ${parentSlug}`,
        systemPrompt: 'parent prompt',
        serverNames: [sharedServer],
        skillSlugs: [rootSkill],
      },
      servers: [server(sharedServer), { ...server(firstServer), tools: [tool('list-a')] }],
      skills: [skill(rootSkill), skill(firstSkill), skill(secondSkill)],
      subAgents: [
        child(firstSlug, {
          serverNames: [firstServer],
          skillSlugs: [firstSkill],
          permissionMode: 'plan',
        }),
        child(secondSlug, { skillSlugs: [secondSkill] }),
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
    expect(parent).toBeDefined();
    expect(first?.parent_id).toBe(parent?.id);
    expect(second?.parent_id).toBe(parent?.id);
    expect(first?.id).not.toBe(second?.id);
    expect(body.agent.id).toBe(parent?.id);
    expect(new Set(body.agent.subAgentIds)).toEqual(new Set([first?.id, second?.id]));

    // 共享技能只属于父级；子级只拿到自己的技能和 server。
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
    const parentSnapshot = (await versionsOf(parent?.id ?? ''))[0]?.snapshot;
    expect(new Set(parentSnapshot?.subAgentIds)).toEqual(new Set([first?.id, second?.id]));
    expect((await versionsOf(first?.id ?? ''))[0]?.snapshot.parentId).toBe(parent?.id);

    // 子级的 generated server 工具已落库，且绑定的是子级自己的 server。
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
    const imported = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: parentSlug, skillSlugs: [] },
      skills: [{ ...skill(skillSlug), body: 'incoming instructions' }],
      subAgents: [child(childSlug, { skillSlugs: [skillSlug] })],
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json<ImportResult>().warnings).toEqual([
      `已存在同名技能「${skillSlug}」，其内容与导入文件不同，已保留原配置`,
    ]);
    const stored = await app.pool.query<{ body: string }>(
      'select body from skills where slug = $1',
      [skillSlug],
    );
    expect(stored.rows[0]?.body).toBe('existing instructions');
    expect(await boundSkillSlugs(imported.json<ImportResult>().agent.id)).toEqual([]);
  });

  it('suffixes a child slug that already belongs to another parent, without touching it', async () => {
    const oldParentSlug = unique('bundle-old-parent');
    const oldChildSlug = unique('bundle-old-child');
    const oldParent = (
      await createAgent(app, cookie, { slug: oldParentSlug, track: createdAgents })
    ).json<Agent>();
    const oldChild = (
      await createAgent(app, cookie, {
        slug: oldChildSlug,
        track: createdAgents,
      })
    ).json<Agent>();
    const bind = await inject(app, {
      method: 'PATCH',
      url: `/api/agents/${oldParent.id}`,
      headers: auth(),
      payload: { subAgentIds: [oldChild.id] },
    });
    expect(bind.statusCode, bind.body).toBe(200);

    const parentSlug = unique('bundle-new-parent');
    createdAgents.push(parentSlug, `${oldChildSlug}-2`);
    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
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

    // 原有子智能体与其父级关系保持不变。
    const untouched = await agentRow(oldChildSlug);
    expect(untouched?.id).toBe(oldChild.id);
    expect(untouched?.parent_id).toBe(oldParent.id);
    expect(await versionsOf(oldChild.id)).toHaveLength(1);
    const existing = await inject(app, {
      method: 'GET',
      url: `/api/agents/${oldChild.id}`,
      headers: auth(),
    });
    expect(existing.json<Agent>().systemPrompt).toBe('You are helpful.');
  });

  it('rejects nested, unresolved and forbidden child configs without writing anything', async () => {
    const cases: Array<{ label: string; overrides: Partial<BundleChild> }> = [
      { label: 'nested sub-agents', overrides: { subAgents: [] } },
      { label: 'unknown server reference', overrides: { serverNames: [unique('missing-srv')] } },
      { label: 'unknown skill reference', overrides: { skillSlugs: [unique('missing-skill')] } },
      { label: 'blocked allowed tool', overrides: { allowedTools: ['Monitor'] } },
      { label: 'unsupported permission mode', overrides: { permissionMode: 'auto' } },
      { label: 'parent id supplied', overrides: { parentId: 'agt_whatever' } },
    ];

    for (const [index, item] of cases.entries()) {
      const parentSlug = unique(`bundle-bad-${index}`);
      const childSlug = unique(`bundle-bad-child-${index}`);
      const serverName = unique(`bundle-bad-srv-${index}`);
      createdAgents.push(parentSlug);
      createdServers.push(serverName);

      const res = await importBundle({
        format: 'agentport/agent@1',
        agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
        servers: [server(serverName)],
        subAgents: [child(childSlug, item.overrides)],
      });
      expect(res.statusCode, `${item.label}: ${res.body}`).toBe(400);
      expect(await agentRow(parentSlug), item.label).toBeUndefined();
      const createdChild = await app.pool.query('select id from agents where slug like $1', [
        `${childSlug}%`,
      ]);
      expect(createdChild.rowCount, item.label).toBe(0);
      const createdServer = await app.pool.query('select id from servers where name = $1', [
        serverName,
      ]);
      expect(createdServer.rowCount, item.label).toBe(0);
    }
  });

  it('rejects duplicate skills and duplicate references instead of taking the last one', async () => {
    const parentSlug = unique('bundle-dup-parent');
    const skillSlug = unique('bundle-dup-skill');
    const serverName = unique('bundle-dup-srv');
    createdAgents.push(parentSlug);
    createdServers.push(serverName);
    createdSkills.push(skillSlug);

    const duplicateSkill = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
      skills: [skill(skillSlug), { ...skill(skillSlug), name: 'other' }],
    });
    expect(duplicateSkill.statusCode, duplicateSkill.body).toBe(400);

    const duplicateRef = await importBundle({
      format: 'agentport/agent@1',
      agent: {
        slug: parentSlug,
        name: `Parent ${parentSlug}`,
        serverNames: [serverName, serverName],
      },
      servers: [server(serverName)],
      skills: [{ ...skill(skillSlug), body: 'kept' }],
    });
    expect(duplicateRef.statusCode, duplicateRef.body).toBe(400);

    expect(await agentRow(parentSlug)).toBeUndefined();
    const createdSkill = await app.pool.query('select body from skills where slug = $1', [
      skillSlug,
    ]);
    expect(createdSkill.rowCount).toBe(0);

    // 子智能体 slug 不能与父级重复，同级之间也不能重复。
    const twin = unique('bundle-dup-child');
    const childCases: BundleChild[][] = [[child(parentSlug)], [child(twin), child(twin)]];
    for (const children of childCases) {
      const duplicateChild = await importBundle({
        format: 'agentport/agent@1',
        agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
        subAgents: children,
      });
      expect(duplicateChild.statusCode, duplicateChild.body).toBe(400);
    }
    expect(await agentRow(parentSlug)).toBeUndefined();
  });

  it('warns about legacy foreign sub-agent ids without binding them', async () => {
    const localSlug = unique('bundle-legacy-local');
    const parentSlug = unique('bundle-legacy-parent');
    const local = (
      await createAgent(app, cookie, { slug: localSlug, track: createdAgents })
    ).json<Agent>();
    createdAgents.push(parentSlug);

    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}`, subAgentIds: [local.id] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<ImportResult>();
    expect(body.agent.subAgentIds).toEqual([]);
    expect(body.createdSubAgents).toEqual([]);
    expect(body.warnings.some((warning) => warning.includes('子智能体'))).toBe(true);
    expect((await agentRow(localSlug))?.parent_id).toBeNull();
  });

  it('does not warn about legacy ids when the bundle carries real sub-agents', async () => {
    const parentSlug = unique('bundle-nowarn-parent');
    const childSlug = unique('bundle-nowarn-child');
    createdAgents.push(parentSlug, childSlug);

    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}`, subAgentIds: [] },
      subAgents: [child(childSlug)],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<ImportResult>().warnings).toEqual([]);
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

    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
      servers: [
        server(freshName),
        { name: existingName, kind: 'http', config: { url: 'https://example.com/mcp' } },
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

  it('imports an exported agent as a fresh parent with no sub-agent warnings', async () => {
    const server = {
      name: unique('bundle-export-srv'),
      kind: 'generated' as const,
      baseUrl: 'https://jsonplaceholder.typicode.com',
    };
    createdServers.push(server.name);
    const createdServer = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: auth(),
      payload: server,
    });
    expect(createdServer.statusCode, createdServer.body).toBe(201);
    const serverRow = createdServer.json<Server>();

    const sourceSlug = unique('bundle-export-src');
    const source = (
      await createAgent(app, cookie, {
        slug: sourceSlug,
        serverIds: [serverRow.id],
        track: createdAgents,
      })
    ).json<Agent>();

    const exp = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${source.id}`,
      headers: auth(),
    });
    expect(exp.statusCode, exp.body).toBe(200);
    const file = exp.json<Record<string, unknown>>();
    const importedSlug = unique('bundle-export-dst');
    createdAgents.push(importedSlug);
    (file.agent as Record<string, unknown>).slug = importedSlug;
    (file.agent as Record<string, unknown>).name = `Imported ${importedSlug}`;

    const res = await importBundle(file);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<ImportResult>();
    expect(body.agent.slug).toBe(importedSlug);
    expect(body.agent.id).not.toBe(source.id);
    expect(body.reusedServers).toEqual([server.name]);
    expect(body.createdSubAgents).toEqual([]);
    expect(body.warnings).toEqual([]);
    expect(await boundServerNames(body.agent.id)).toEqual([server.name]);
  });

  it('records the import in the audit log without raw prompts', async () => {
    const parentSlug = unique('bundle-audit');
    const prompt = `secret-prompt-${parentSlug}`;
    createdAgents.push(parentSlug);

    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}`, systemPrompt: prompt },
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

  it('rejects more than 20 sub-agents per bundle', async () => {
    const parentSlug = unique('bundle-many');
    createdAgents.push(parentSlug);
    const res = await importBundle({
      format: 'agentport/agent@1',
      agent: { slug: parentSlug, name: `Parent ${parentSlug}` },
      subAgents: Array.from({ length: 21 }, (_, index) =>
        child(`${parentSlug}-${index.toString(36)}`),
      ),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(await agentRow(parentSlug)).toBeUndefined();
  });

  it('re-imports an exported tree as a new parent with fresh child ids and exact bindings', async () => {
    const rootSlug = unique('bundle-copy-root');
    const activeSlug = unique('bundle-copy-active');
    const disabledSlug = unique('bundle-copy-disabled');
    const sharedServer = unique('bundle-copy-srv-shared');
    const rootServer = unique('bundle-copy-srv-root');
    const childServer = unique('bundle-copy-srv-child');
    const rootSkill = unique('bundle-copy-skill-root');
    const sharedSkill = unique('bundle-copy-skill-shared');
    const activeSkill = unique('bundle-copy-skill-active');
    const disabledSkill = unique('bundle-copy-skill-disabled');
    createdAgents.push(rootSlug, activeSlug, disabledSlug);
    createdServers.push(sharedServer, rootServer, childServer);
    createdSkills.push(rootSkill, sharedSkill, activeSkill, disabledSkill);

    // 源 bundle 直接写成导出格式：根 + 一个启用的子 + 一个停用的子。
    const source = await importBundle({
      format: 'agentport/agent@1',
      agent: {
        slug: rootSlug,
        name: `Parent ${rootSlug}`,
        systemPrompt: 'root prompt',
        serverNames: [sharedServer, rootServer],
        skillSlugs: [rootSkill, sharedSkill],
        permissionMode: 'plan',
      },
      servers: [
        server(sharedServer),
        {
          ...server(rootServer),
          tools: [
            {
              ...tool('root-tool'),
              pathTemplate: '/root-tool',
              enabled: false,
              requiresApproval: true,
            },
          ],
        },
        {
          ...server(childServer),
          tools: [
            {
              ...tool('child-tool'),
              method: 'POST',
              pathTemplate: '/child-tool',
              paramsIn: 'body',
              enabled: true,
              requiresApproval: true,
            },
          ],
        },
      ],
      skills: [skill(rootSkill), skill(sharedSkill), skill(activeSkill), skill(disabledSkill)],
      subAgents: [
        child(activeSlug, {
          serverNames: [childServer, sharedServer],
          skillSlugs: [activeSkill, sharedSkill],
        }),
        child(disabledSlug, { enabled: false, skillSlugs: [disabledSkill] }),
      ],
    });
    expect(source.statusCode, source.body).toBe(201);
    const seeded = source.json<ImportResult>();
    const sourceRoot = await agentRow(rootSlug);
    const sourceActive = await agentRow(activeSlug);
    const sourceDisabled = await agentRow(disabledSlug);
    expect(seeded.createdSubAgents).toEqual([activeSlug, disabledSlug]);
    expect(sourceRoot?.parent_id).toBeNull();
    expect(sourceActive?.parent_id).toBe(sourceRoot?.id);
    expect(sourceDisabled?.parent_id).toBe(sourceRoot?.id);

    const exp = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${seeded.agent.id}`,
      headers: auth(),
    });
    expect(exp.statusCode, exp.body).toBe(200);
    const file = exp.json<CopyFile>();
    const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));

    // 根只声明自己的资源；子资源只出现在子定义里。
    expect(sorted(file.agent.serverNames ?? [])).toEqual(sorted([rootServer, sharedServer]));
    expect(sorted(file.agent.skillSlugs ?? [])).toEqual(sorted([rootSkill, sharedSkill]));
    expect(file.agent.skillSlugs).not.toContain(activeSkill);
    expect(file.agent.skillSlugs).not.toContain(disabledSkill);
    // 顶层资源是根与全部子资源的并集。
    expect(sorted(file.servers.map((entry) => entry.name))).toEqual(
      sorted([sharedServer, rootServer, childServer]),
    );
    expect(sorted(file.skills.map((entry) => entry.slug))).toEqual(
      sorted([rootSkill, sharedSkill, activeSkill, disabledSkill]),
    );
    const exportedChildren = new Map(file.subAgents.map((entry) => [entry.slug, entry]));
    expect(sorted([...exportedChildren.keys()])).toEqual(sorted([activeSlug, disabledSlug]));
    expect(exportedChildren.get(activeSlug)).toMatchObject({
      enabled: true,
      skillSlugs: sorted([activeSkill, sharedSkill]),
    });
    expect(sorted(exportedChildren.get(activeSlug)?.serverNames ?? [])).toEqual(
      sorted([childServer, sharedServer]),
    );
    expect(exportedChildren.get(disabledSlug)).toMatchObject({
      enabled: false,
      serverNames: [],
      skillSlugs: [disabledSkill],
    });

    // 工具只带可移植字段，启停与审批标记原样保留。
    const exportedServers = new Map(file.servers.map((entry) => [entry.name, entry]));
    expect(exportedServers.get(rootServer)?.tools).toEqual([
      {
        name: 'root-tool',
        description: '',
        method: 'GET',
        pathTemplate: '/root-tool',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'query',
        enabled: false,
        requiresApproval: true,
      },
    ]);
    expect(exportedServers.get(childServer)?.tools).toEqual([
      {
        name: 'child-tool',
        description: '',
        method: 'POST',
        pathTemplate: '/child-tool',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'body',
        enabled: true,
        requiresApproval: true,
      },
    ]);

    const sourceServerIds = (
      await app.pool.query<{ id: string }>('select id from servers where name = any($1::text[])', [
        [sharedServer, rootServer, childServer],
      ])
    ).rows.map((row) => row.id);
    const sourceToolIds = (
      await app.pool.query<{ id: string }>(
        'select id from api_tools where server_id = any($1::text[])',
        [sourceServerIds],
      )
    ).rows.map((row) => row.id);
    expect(sourceServerIds).toHaveLength(3);
    expect(sourceToolIds).toHaveLength(2);
    const sourceIds = [
      seeded.agent.id,
      sourceActive?.id ?? '',
      sourceDisabled?.id ?? '',
      ...sourceServerIds,
      ...sourceToolIds,
    ];
    for (const id of sourceIds) expect(exp.body).not.toContain(id);

    // 第二份：只改根 slug/name，资源全部改名以强制新 ID，引用同步镜像。
    const fresh = {
      root: unique('bundle-copy2-root'),
      servers: {
        shared: unique('bundle-copy2-srv-shared'),
        root: unique('bundle-copy2-srv-root'),
        child: unique('bundle-copy2-srv-child'),
      },
      skills: {
        root: unique('bundle-copy2-skill-root'),
        shared: unique('bundle-copy2-skill-shared'),
        active: unique('bundle-copy2-skill-active'),
        disabled: unique('bundle-copy2-skill-disabled'),
      },
    };
    const serverRename = new Map([
      [sharedServer, fresh.servers.shared],
      [rootServer, fresh.servers.root],
      [childServer, fresh.servers.child],
    ]);
    const skillRename = new Map([
      [rootSkill, fresh.skills.root],
      [sharedSkill, fresh.skills.shared],
      [activeSkill, fresh.skills.active],
      [disabledSkill, fresh.skills.disabled],
    ]);
    const copy = structuredClone(file);
    copy.agent.slug = fresh.root;
    copy.agent.name = `Imported ${fresh.root}`;
    const mirror = (entry: CopyAgent) => {
      entry.serverNames = (entry.serverNames ?? []).map((name) => serverRename.get(name) ?? name);
      entry.skillSlugs = (entry.skillSlugs ?? []).map((slug) => skillRename.get(slug) ?? slug);
    };
    mirror(copy.agent);
    for (const entry of copy.subAgents) mirror(entry);
    for (const entry of copy.servers) entry.name = serverRename.get(entry.name) ?? entry.name;
    for (const entry of copy.skills) entry.slug = skillRename.get(entry.slug) ?? entry.slug;
    copy.servers.sort((a, b) => a.name.localeCompare(b.name));
    copy.skills.sort((a, b) => a.slug.localeCompare(b.slug));

    const second = await importBundle(copy);
    expect(second.statusCode, second.body).toBe(201);
    const imported = second.json<ImportResult>();
    createdAgents.push(imported.agent.slug, ...imported.createdSubAgents);
    createdServers.push(...imported.createdServers);
    createdSkills.push(...imported.createdSkills);

    expect(imported.agent.slug).toBe(fresh.root);
    expect(sorted(imported.createdSubAgents)).toEqual(
      sorted([`${activeSlug}-2`, `${disabledSlug}-2`]),
    );
    expect(imported.createdServers).toEqual(copy.servers.map((entry) => entry.name));
    expect(imported.createdSkills).toEqual(copy.skills.map((entry) => entry.slug));
    expect(imported.warnings.some((warning) => warning.includes(`${activeSlug}-2`))).toBe(true);

    const newRoot = await agentRow(fresh.root);
    const newActive = await agentRow(`${activeSlug}-2`);
    const newDisabled = await agentRow(`${disabledSlug}-2`);
    expect(newRoot?.id).toBe(imported.agent.id);
    expect(newRoot?.id).not.toBe(sourceRoot?.id);
    expect(newRoot?.parent_id).toBeNull();
    expect(newActive?.parent_id).toBe(newRoot?.id);
    expect(newDisabled?.parent_id).toBe(newRoot?.id);
    for (const child of [newActive, newDisabled]) {
      expect(sourceIds).not.toContain(child?.id);
    }

    // 源树不动：子智能体仍挂在原父级，行与版本都没被改写。
    expect((await agentRow(activeSlug))?.id).toBe(sourceActive?.id);
    expect((await agentRow(activeSlug))?.parent_id).toBe(sourceRoot?.id);
    expect((await agentRow(disabledSlug))?.parent_id).toBe(sourceRoot?.id);
    expect(await versionsOf(sourceActive?.id ?? '')).toHaveLength(1);

    // 导入结果按名称重建绑定，根只拿自己的资源。
    const newServerRows = await app.pool.query<{ id: string; name: string }>(
      'select id, name from servers where name = any($1::text[])',
      [[fresh.servers.shared, fresh.servers.root, fresh.servers.child]],
    );
    const newServerId = new Map(newServerRows.rows.map((row) => [row.name, row.id]));
    const newSkillRows = await app.pool.query<{ id: string; slug: string }>(
      'select id, slug from skills where slug = any($1::text[])',
      [[fresh.skills.root, fresh.skills.shared, fresh.skills.active, fresh.skills.disabled]],
    );
    const newSkillId = new Map(newSkillRows.rows.map((row) => [row.slug, row.id]));
    expect(newServerId.size).toBe(3);
    expect(newSkillId.size).toBe(4);

    expect(new Set(imported.agent.serverIds)).toEqual(
      new Set([newServerId.get(fresh.servers.root), newServerId.get(fresh.servers.shared)]),
    );
    expect(new Set(imported.agent.skillIds)).toEqual(
      new Set([newSkillId.get(fresh.skills.root), newSkillId.get(fresh.skills.shared)]),
    );
    expect(sorted(await boundServerNames(newRoot?.id ?? ''))).toEqual(
      sorted([fresh.servers.root, fresh.servers.shared]),
    );
    expect(sorted(await boundSkillSlugs(newRoot?.id ?? ''))).toEqual(
      sorted([fresh.skills.root, fresh.skills.shared]),
    );
    expect(sorted(await boundServerNames(newActive?.id ?? ''))).toEqual(
      sorted([fresh.servers.child, fresh.servers.shared]),
    );
    expect(sorted(await boundSkillSlugs(newActive?.id ?? ''))).toEqual(
      sorted([fresh.skills.active, fresh.skills.shared]),
    );
    expect(await boundServerNames(newDisabled?.id ?? '')).toEqual([]);
    expect(await boundSkillSlugs(newDisabled?.id ?? '')).toEqual([fresh.skills.disabled]);
    const disabledRow = await app.pool.query<{ enabled: boolean }>(
      'select enabled from agents where id = $1',
      [newDisabled?.id],
    );
    expect(disabledRow.rows[0]?.enabled).toBe(false);

    // 工具用新 ID 重建，绑定到各自的 server，可移植字段与标记不变。
    const newTools = await app.pool.query<{
      id: string;
      serverId: string;
      name: string;
      method: string;
      pathTemplate: string;
      inputSchema: Record<string, unknown>;
      paramsIn: string;
      enabled: boolean;
      requiresApproval: boolean;
    }>(
      `select id, server_id as "serverId", name, method, path_template as "pathTemplate",
              input_schema as "inputSchema", params_in as "paramsIn", enabled,
              requires_approval as "requiresApproval"
       from api_tools where server_id = any($1::text[]) order by name`,
      [[newServerId.get(fresh.servers.root), newServerId.get(fresh.servers.child)]],
    );
    expect(newTools.rows.map(({ id: _id, serverId: _serverId, ...portable }) => portable)).toEqual([
      {
        name: 'child-tool',
        method: 'POST',
        pathTemplate: '/child-tool',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'body',
        enabled: true,
        requiresApproval: true,
      },
      {
        name: 'root-tool',
        method: 'GET',
        pathTemplate: '/root-tool',
        inputSchema: { type: 'object', properties: {} },
        paramsIn: 'query',
        enabled: false,
        requiresApproval: true,
      },
    ]);
    expect(newTools.rows).toHaveLength(2);
    expect(newTools.rows.find((entry) => entry.name === 'root-tool')?.serverId).toBe(
      newServerId.get(fresh.servers.root),
    );
    expect(newTools.rows.find((entry) => entry.name === 'child-tool')?.serverId).toBe(
      newServerId.get(fresh.servers.child),
    );
    for (const entry of newTools.rows) expect(sourceToolIds).not.toContain(entry.id);

    // 根版本快照记录最终的子智能体 ID。
    const newRootVersions = await versionsOf(newRoot?.id ?? '');
    expect(newRootVersions).toHaveLength(1);
    expect(newRootVersions[0]?.version).toBe(1);
    expect(new Set(newRootVersions[0]?.snapshot.subAgentIds)).toEqual(
      new Set([newActive?.id, newDisabled?.id]),
    );
  });
});
