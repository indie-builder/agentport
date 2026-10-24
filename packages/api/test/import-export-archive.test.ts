import { buildWorkspaceArchive, parseWorkspaceArchive } from '@agentport/core';
import type { Agent, Server, Skill } from '@agentport/shared';
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
const SECRET = 'ARCHIVE-SECRET-VALUE';

interface ArchiveImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}

interface ExportedAgentPackage {
  format: string;
  agent: Record<string, unknown> & { slug: string; name: string };
  rules: Array<{ slug: string; content: string; globs: string }>;
  outputStyles: Array<Record<string, unknown> & { slug: string; isSelected: boolean }>;
  subAgents: Array<Record<string, unknown> & { slug: string }>;
  skills: Array<Record<string, unknown> & { slug: string }>;
  servers: Array<Record<string, unknown> & { name: string }>;
}

/** 同长度替换 zip 条目名：只改头部的文件名，不触碰内容、CRC 或偏移。 */
function renameArchiveEntry(archive: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const data = Buffer.from(archive);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let count = 0;
  let index = data.indexOf(needle);
  while (index !== -1) {
    replacement.copy(data, index);
    count += 1;
    index = data.indexOf(needle, index + replacement.length);
  }
  expect(count).toBeGreaterThan(0);
  return data;
}

describe.skipIf(!ready)('agent archive export/import', () => {
  let app: FastifyInstance;
  let cookie: string;
  let root: Agent;
  let child: Agent;
  let disabledChild: Agent;
  let server: Server;
  let rootSkill: Skill;
  let childSkill: Skill;

  const agentSlugs: string[] = [];
  const serverNames: string[] = [];
  const skillSlugs: string[] = [];

  const ROOT_PROMPT = 'ROOT-PROMPT-ARCHIVE-MARKER';
  const CHILD_PROMPT = 'CHILD-PROMPT-ARCHIVE-MARKER';
  const DISABLED_CHILD_PROMPT = 'DISABLED-CHILD-ARCHIVE-MARKER';
  const rootSlug = unique('arch-root');
  const childSlug = unique('arch-child');
  const disabledChildSlug = unique('arch-disabled');

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
    agentSlugs.push(rootSlug, childSlug, disabledChildSlug);

    const serverRes = await inject(app, {
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: unique('arch-srv'),
        kind: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: `Bearer ${SECRET}` },
      },
    });
    expect(serverRes.statusCode, serverRes.body).toBe(201);
    server = serverRes.json<Server>();
    serverNames.push(server.name);

    const createSkill = async (payload: Record<string, unknown>): Promise<Skill> => {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/skills',
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const skill = res.json<Skill>();
      skillSlugs.push(skill.slug);
      return skill;
    };

    rootSkill = await createSkill({
      slug: unique('arch-skill'),
      name: '部署技能',
      description: '发布到生产环境',
      body: '按步骤执行。',
      license: 'MIT',
      compatibility: '>=1',
      metadata: { owner: 'team' },
    });
    childSkill = await createSkill({
      slug: unique('arch-child-skill'),
      name: '子技能',
      description: '子智能体专用',
      body: '子步骤。',
    });
    const fileRes = await inject(app, {
      method: 'PUT',
      url: `/api/skills/${rootSkill.id}/files/references/guide.md`,
      headers: { cookie },
      payload: { content: '# 指引\n\n资源内容。' },
    });
    expect(fileRes.statusCode, fileRes.body).toBe(200);

    const childRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: childSlug,
        name: '子执行者',
        description: '负责执行具体任务',
        systemPrompt: CHILD_PROMPT,
        model: 'claude-haiku-4-5',
        permissionMode: 'plan',
        maxTurns: 7,
        effort: 'low',
        // 父子共同绑定 rootSkill，用于验证根绑定不会被扣掉。
        skillIds: [childSkill.id, rootSkill.id],
      },
    });
    expect(childRes.statusCode, childRes.body).toBe(201);
    child = childRes.json<Agent>();

    const disabledChildRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: disabledChildSlug,
        name: '停用执行者',
        description: '停用状态不应被归档丢掉',
        systemPrompt: DISABLED_CHILD_PROMPT,
        model: 'claude-haiku-4-5',
        enabled: false,
      },
    });
    expect(disabledChildRes.statusCode, disabledChildRes.body).toBe(201);
    disabledChild = disabledChildRes.json<Agent>();
    expect(disabledChild.enabled).toBe(false);

    const rootRes = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: rootSlug,
        name: '归档助手',
        description: '归档往返测试',
        systemPrompt: ROOT_PROMPT,
        model: 'claude-opus-4-1',
        permissionMode: 'plan',
        maxTurns: 12,
        maxBudgetUsd: 0.1,
        timeoutMs: 90_000,
        effort: 'high',
        allowedTools: [`mcp__${server.name}__*`],
        disallowedTools: ['WebFetch'],
        serverIds: [server.id],
        skillIds: [rootSkill.id],
        subAgentIds: [child.id, disabledChild.id],
      },
    });
    expect(rootRes.statusCode, rootRes.body).toBe(201);
    root = rootRes.json<Agent>();

    const ruleRes = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${root.id}/rules/api-rules`,
      headers: { cookie },
      payload: { content: '# API 规则\n\n永远先读测试。', globs: 'src/**/*.ts' },
    });
    expect(ruleRes.statusCode, ruleRes.body).toBe(200);

    const styleRes = await inject(app, {
      method: 'PUT',
      url: `/api/agents/${root.id}/output-styles/review`,
      headers: { cookie },
      payload: {
        description: '代码评审',
        keepCodingInstructions: true,
        body: '严格评审。',
      },
    });
    expect(styleRes.statusCode, styleRes.body).toBe(200);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, serverNames, skillSlugs });
    await app.close();
  });

  const auth = () => ({ cookie });
  const exportArchive = (id: string, headers: Record<string, string> = auth()) =>
    inject(app, { method: 'GET', url: `/api/export/agents/${id}/archive`, headers });
  const importArchive = (
    filename: string,
    dataBase64: string,
    headers: Record<string, string> = auth(),
  ) =>
    inject(app, {
      method: 'POST',
      url: '/api/import/agents/archive',
      headers,
      payload: { filename, dataBase64 },
    });

  it('round-trips the definition through export → import → export', async () => {
    const exported = await exportArchive(root.id);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('application/zip');
    expect(exported.headers['content-disposition']).toBe(`attachment; filename="${rootSlug}.zip"`);
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.rawPayload.subarray(0, 2).toString()).toBe('PK');
    // .mcp.json 用空 env/headers 渲染，明文凭据不能进入归档。
    expect(exported.rawPayload.includes(Buffer.from(SECRET))).toBe(false);

    const importSlug = `${rootSlug}-copy`;
    agentSlugs.push(importSlug);
    const imported = await importArchive(
      `${importSlug}.zip`,
      exported.rawPayload.toString('base64'),
    );
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<ArchiveImportResult>();
    agentSlugs.push(...result.createdSubAgents);

    expect(result.agent).toMatchObject({
      slug: importSlug,
      name: '归档助手',
      systemPrompt: ROOT_PROMPT,
      model: 'claude-opus-4-1',
      permissionMode: 'plan',
      allowedTools: [`mcp__${server.name}__*`],
      disallowedTools: ['WebFetch'],
      effort: 'high',
      // 无官方归宿的限额取平台默认值，并在 warnings 说明。
      maxTurns: 20,
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
    });
    expect(result.agent.serverIds).toHaveLength(1);
    // 归档不记录根绑定归属：父子共享的技能必须保留在根级。
    expect(result.agent.skillIds).toEqual(expect.arrayContaining([rootSkill.id, childSkill.id]));
    expect(result.reusedServers).toEqual([server.name]);
    expect(result.createdServers).toEqual([]);
    expect(result.createdSkills).toEqual([]);
    expect(result.createdSubAgents).toHaveLength(2);
    const importedDisabledSlug = result.createdSubAgents.find((slug) =>
      slug.startsWith(disabledChildSlug),
    );
    expect(importedDisabledSlug).toBeDefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('maxTurns / maxBudgetUsd / timeoutMs'),
        expect.stringContaining('启停状态'),
      ]),
    );
    // 官方文件没有启停字段：停用子智能体导入后按默认启用。
    const disabledRows = await app.pool.query('select enabled from agents where slug = $1', [
      importedDisabledSlug,
    ]);
    expect(disabledRows.rows[0]?.enabled).toBe(true);

    const reexported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${result.agent.id}`,
      headers: auth(),
    });
    expect(reexported.statusCode, reexported.body).toBe(200);
    const pkg = reexported.json<ExportedAgentPackage>();

    expect(pkg.agent).toMatchObject({
      systemPrompt: ROOT_PROMPT,
      model: 'claude-opus-4-1',
      permissionMode: 'plan',
      allowedTools: [`mcp__${server.name}__*`],
      disallowedTools: ['WebFetch'],
      effort: 'high',
      maxTurns: 20,
      maxBudgetUsd: 2,
      timeoutMs: 600_000,
    });
    expect(pkg.rules).toEqual([
      { slug: 'api-rules', content: '# API 规则\n\n永远先读测试。', globs: 'src/**/*.ts' },
    ]);
    expect(pkg.outputStyles).toEqual([
      {
        slug: 'review',
        description: '代码评审',
        keepCodingInstructions: true,
        body: '严格评审。',
        isSelected: true,
      },
    ]);

    const rootSkillOut = pkg.skills.find((skill) => skill.slug === rootSkill.slug);
    expect(rootSkillOut).toMatchObject({
      name: '部署技能',
      license: 'MIT',
      compatibility: '>=1',
      metadata: { owner: 'team' },
    });
    expect(rootSkillOut?.files).toEqual([
      { path: 'references/guide.md', content: '# 指引\n\n资源内容。' },
    ]);
    expect(pkg.skills.map((skill) => skill.slug)).toContain(childSkill.slug);

    // 导入时子智能体 slug 会因重名加后缀，用提示词定位。
    const childOut = pkg.subAgents.find((entry) =>
      String(entry.systemPrompt).includes(CHILD_PROMPT),
    );
    expect(childOut).toMatchObject({
      model: 'claude-haiku-4-5',
      permissionMode: 'plan',
      maxTurns: 7,
      effort: 'low',
      skillSlugs: expect.arrayContaining([childSkill.slug, rootSkill.slug]),
    });
    expect(
      pkg.subAgents.some((entry) => String(entry.systemPrompt).includes(DISABLED_CHILD_PROMPT)),
    ).toBe(true);
  });

  it('writes root tools, effort and limits into official files', async () => {
    const exported = await exportArchive(root.id);
    expect(exported.statusCode, exported.body).toBe(200);
    const parsed = parseWorkspaceArchive(new Uint8Array(exported.rawPayload));
    expect(parsed.settings).toMatchObject({
      model: 'claude-opus-4-1',
      effortLevel: 'high',
      permissions: {
        defaultMode: 'plan',
        allow: [`mcp__${server.name}__*`],
        deny: ['WebFetch'],
      },
    });
    // 无官方归宿的限额不写私有键。
    const settingsText = JSON.stringify(parsed.settings);
    expect(settingsText).not.toContain('maxTurns');
    expect(settingsText).not.toContain('maxBudgetUsd');
    expect(settingsText).not.toContain('timeoutMs');

    // 停用子智能体仍必须出现在归档里。
    expect(parsed.subAgents.map((entry) => entry.slug)).toContain(disabledChildSlug);
    const disabledOut = parsed.subAgents.find((entry) => entry.slug === disabledChildSlug);
    expect(disabledOut?.systemPrompt).toContain(DISABLED_CHILD_PROMPT);
  });

  it('keeps mappable settings permissions and warns about the rest', async () => {
    const archive = buildWorkspaceArchive({
      files: {
        mcpJson: '{"mcpServers":{}}\n',
        claudeMd: '',
        agentMd: '',
        skills: [],
        subAgents: [],
        rules: [],
        outputStyles: [],
        selectedOutputStyle: null,
        settingsJson: JSON.stringify({
          model: 'claude-opus-4-1',
          permissions: {
            allow: ['mcp__x__y', 'Bash(npm:*)', 'Bash'],
            deny: ['Read(/etc/**)'],
          },
        }),
      },
      agent: { name: '权限归档', systemPrompt: '按权限执行。' },
    });
    const slug = unique('arch-permissions');
    agentSlugs.push(slug);
    const imported = await importArchive(`${slug}.zip`, Buffer.from(archive).toString('base64'));
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<ArchiveImportResult>();
    expect(result.agent.allowedTools).toEqual(['mcp__x__y']);
    expect(result.agent.disallowedTools).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        // 官方 allow 是自动批准；平台映射成工具白名单，语义差异必须提示。
        expect.stringContaining('自动批准'),
        expect.stringContaining('运行时固定禁用'),
        expect.stringContaining('Bash(npm:*)'),
        expect.stringContaining('Read(/etc/**)'),
        expect.stringContaining('Bash'),
      ]),
    );
  });

  it('rejects an archive that would exceed the unpacked limits', async () => {
    const heavyBody = '汉'.repeat(200_000);
    const skillIds: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      const slug = unique(`arch-heavy-${index}`);
      const res = await inject(app, {
        method: 'POST',
        url: '/api/skills',
        headers: { cookie },
        payload: { slug, name: `重技能 ${index}`, description: '超限导出测试', body: heavyBody },
      });
      expect(res.statusCode, res.body).toBe(201);
      const skill = res.json<Skill>();
      skillSlugs.push(skill.slug);
      skillIds.push(skill.id);
    }
    const heavyAgentSlug = unique('arch-heavy-agent');
    agentSlugs.push(heavyAgentSlug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: {
        slug: heavyAgentSlug,
        name: '超限助手',
        systemPrompt: '内容很多。',
        skillIds,
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const exported = await exportArchive(created.json<Agent>().id);
    const problem = expectProblem(exported, 'CONFLICT');
    expect(problem.message).toContain('解压后');
    expect(problem.message).toContain('8388608');
  });

  it('rejects malformed archives with the unified envelope and writes nothing', async () => {
    const cases = [
      { slug: unique('arch-bad-b64'), filename: '', data: '!!!not-base64!!!' },
      { slug: unique('arch-oversize'), filename: '', data: 'A'.repeat(1_500_001) },
      {
        slug: unique('arch-not-zip'),
        filename: '',
        data: Buffer.from('plain text, not a zip').toString('base64'),
      },
    ];
    for (const entry of cases) {
      const filename = entry.filename || `${entry.slug}.zip`;
      const res = await importArchive(filename, entry.data);
      expectProblem(res, 'INVALID_INPUT');
      const rows = await app.pool.query('select 1 from agents where slug = $1', [entry.slug]);
      expect(rows.rowCount).toBe(0);
    }

    const exported = await exportArchive(root.id);
    expect(exported.statusCode).toBe(200);
    const traversalSlug = unique('arch-traversal');
    const traversal = renameArchiveEntry(exported.rawPayload, '.mcp.json', '../x.json');
    expectProblem(
      await importArchive(`${traversalSlug}.zip`, traversal.toString('base64')),
      'INVALID_INPUT',
    );
    const rows = await app.pool.query('select 1 from agents where slug = $1', [traversalSlug]);
    expect(rows.rowCount).toBe(0);
  });

  it('requires auth', async () => {
    expectProblem(await exportArchive(root.id, {}), 'UNAUTHORIZED');
    expectProblem(
      await importArchive('x.zip', Buffer.from('x').toString('base64'), {}),
      'UNAUTHORIZED',
    );
  });

  it('keeps the JSON package import/export unchanged', async () => {
    const exported = await inject(app, {
      method: 'GET',
      url: `/api/export/agents/${root.id}`,
      headers: auth(),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const pkg = exported.json<ExportedAgentPackage & Record<string, unknown>>();
    expect(pkg.format).toBe('agentport/agent@2');

    const jsonSlug = `${rootSlug}-json`;
    agentSlugs.push(jsonSlug);
    pkg.agent.slug = jsonSlug;
    const imported = await inject(app, {
      method: 'POST',
      url: '/api/import/agents',
      headers: auth(),
      payload: pkg,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<ArchiveImportResult>();
    agentSlugs.push(...result.createdSubAgents);
    expect(result.agent).toMatchObject({
      slug: jsonSlug,
      systemPrompt: ROOT_PROMPT,
      model: 'claude-opus-4-1',
      permissionMode: 'plan',
    });
  });
});
