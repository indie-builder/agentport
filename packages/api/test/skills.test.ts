import type { Agent, Skill, SkillWithAgentCount, WorkspaceFiles } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

describe.skipIf(!ready)('skills', () => {
  let app: FastifyInstance;
  let cookie: string;
  const createdAgents: string[] = [];
  const createdSkills: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs: createdAgents, skillSlugs: createdSkills });
    await app.close();
  });

  const auth = () => ({ cookie });

  const createSkill = async (slug: string): Promise<Skill> => {
    createdSkills.push(slug);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { slug, name: `Skill ${slug}`, description: 'agentCount test', body: '' },
    });
    expect(res.statusCode).toBe(201);
    return res.json<Skill>();
  };

  const newAgent = async (skillIds: string[]): Promise<Agent> =>
    (
      await createAgent(app, cookie, {
        slug: unique('count-agent'),
        skillIds,
        track: createdAgents,
      })
    ).json<Agent>();

  it('lists skills with the number of agents using them', async () => {
    const shared = await createSkill(unique('count-shared'));
    const unused = await createSkill(unique('count-unused'));
    await newAgent([shared.id]);
    await newAgent([shared.id]);

    const res = await inject(app, { method: 'GET', url: '/api/skills', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json<SkillWithAgentCount[]>();

    expect(body.find((skill) => skill.id === shared.id)?.agentCount).toBe(2);
    expect(body.find((skill) => skill.id === unused.id)?.agentCount).toBe(0);
  });

  it('downloads the exact SKILL.md the workspace preview renders', async () => {
    const slug = unique('file-skill');
    createdSkills.push(slug);
    const body = '\r\n\r\n## 步骤\r\n第一行：你好，世界 🌏\r\nSecond line\r\n\r\n';
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: {
        slug,
        name: 'Unicode Playbook',
        description: 'Handles "quoted" paths\nand CRLF bodies',
        body,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const skill = created.json<Skill>();

    const res = await inject(app, {
      method: 'GET',
      url: `/api/skills/${skill.id}/file`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="SKILL.md"');

    // 期望值手写：正文只去外层空白，内部 CRLF 与 Unicode 原样保留。
    const expected = [
      '---',
      `name: "${slug}"`,
      'description: "Handles \\"quoted\\" paths\\nand CRLF bodies"',
      '---',
      '',
      '# Unicode Playbook',
      '',
      '## 步骤\r\n第一行：你好，世界 🌏\r\nSecond line',
      '',
    ].join('\n');
    expect(res.body).toBe(expected);

    // 同一技能绑定到智能体后，预览里的内容必须与下载逐字节相同。
    const agent = await newAgent([skill.id]);
    const preview = await inject(app, {
      method: 'GET',
      url: `/api/agents/${agent.id}/files`,
      headers: auth(),
    });
    expect(preview.statusCode).toBe(200);
    const files = preview.json<WorkspaceFiles>();
    const rendered = files.skills.find((entry) => entry.slug === slug);
    expect(rendered?.content).toBe(res.body);
    expect(rendered?.content).toContain('# Unicode Playbook');
    expect(rendered?.content).toContain('第一行：你好，世界 🌏');
    // CLAUDE.md 按 slug + 压平后的描述列出技能。
    expect(files.claudeMd).toContain(`- \`${slug}\`：Handles "quoted" paths and CRLF bodies`);
  });

  it('requires auth and returns 404 for an unknown skill file', async () => {
    const anon = await inject(app, { method: 'GET', url: '/api/skills/skill_missing/file' });
    expectProblem(anon, 'UNAUTHORIZED');

    const missing = await inject(app, {
      method: 'GET',
      url: '/api/skills/skill_missing/file',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ code: string }>().code).toBe('NOT_FOUND');
  });

  type ImportResult = { skill: Skill; warnings: string[] };

  const importSkill = (skillMd: string) =>
    inject(app, {
      method: 'POST',
      url: '/api/skills/import',
      headers: auth(),
      payload: { skillMd },
    });

  const skillMd = (slug: string, extra: string[] = [], h1 = 'Imported Skill') =>
    [
      '---',
      `name: ${slug}`,
      'description: Imported from an official SKILL.md',
      ...extra,
      '---',
      '',
      `# ${h1}`,
      '',
      '## Steps',
      '',
      '1. First step',
    ].join('\n');

  it('imports an official SKILL.md and derives slug, name, description and body', async () => {
    const slug = unique('import-official');
    createdSkills.push(slug);

    const res = await importSkill(skillMd(slug));
    expect(res.statusCode, res.body).toBe(201);
    const { skill, warnings } = res.json<ImportResult>();

    expect(skill).toMatchObject({
      slug,
      name: 'Imported Skill',
      description: 'Imported from an official SKILL.md',
      body: '## Steps\n\n1. First step',
    });
    expect(warnings).toEqual([]);

    const file = await inject(app, {
      method: 'GET',
      url: `/api/skills/${skill.id}/file`,
      headers: auth(),
    });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain('# Imported Skill');
    expect(file.body).toContain('## Steps\n\n1. First step');
  });

  it('defaults the display name to the slug when the markdown has no H1', async () => {
    const slug = unique('import-no-h1');
    createdSkills.push(slug);
    const markdown = [
      '---',
      `name: ${slug}`,
      'description: No heading in this file',
      '---',
      '',
      '## Steps',
      '',
      'Do the thing.',
    ].join('\n');

    const res = await importSkill(markdown);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<ImportResult>().skill).toMatchObject({
      slug,
      name: slug,
      body: '## Steps\n\nDo the thing.',
    });
  });

  it('round-trips an exported SKILL.md under a new slug', async () => {
    const original = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: {
        slug: unique('roundtrip-src'),
        name: 'Roundtrip Playbook',
        description: 'Handles "quoted" paths\nand CRLF bodies',
        body: '## 步骤\r\n第一行：你好，世界 🌏\r\nSecond line',
      },
    });
    expect(original.statusCode, original.body).toBe(201);
    const source = original.json<Skill>();
    createdSkills.push(source.slug);

    const exported = await inject(app, {
      method: 'GET',
      url: `/api/skills/${source.id}/file`,
      headers: auth(),
    });
    expect(exported.statusCode, exported.body).toBe(200);

    const nextSlug = unique('roundtrip-dst');
    createdSkills.push(nextSlug);
    const renamed = exported.body.replace(
      `---\nname: ${JSON.stringify(source.slug)}\n`,
      `---\nname: ${JSON.stringify(nextSlug)}\n`,
    );
    expect(renamed).not.toBe(exported.body);

    const res = await importSkill(renamed);
    expect(res.statusCode, res.body).toBe(201);
    const imported = res.json<ImportResult>().skill;
    expect(imported).toMatchObject({
      slug: nextSlug,
      name: source.name,
      description: source.description,
      body: source.body,
    });

    const downloaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${imported.id}/file`,
      headers: auth(),
    });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe(renamed);
  });

  it('rejects malformed or oversized SKILL.md without inserting anything', async () => {
    const tooBigSlug = unique('import-too-big');
    const cases = [
      '# No frontmatter\n\nJust markdown.',
      '---\nname: Bad Slug\ndescription: invalid slug\n---\n\n# Bad',
      `---\nname: ${unique('import-no-desc')}\n---\n\n# Missing description`,
      // 超过 128 KiB 上限前，内容本身仍是合法 SKILL.md。
      `${skillMd(tooBigSlug)}\n${'x'.repeat(131_072)}`,
    ];
    for (const markdown of cases) {
      const res = await importSkill(markdown);
      expectProblem(res, 'INVALID_INPUT');
    }

    const listed = (await inject(app, { method: 'GET', url: '/api/skills', headers: auth() })).json<
      Skill[]
    >();
    expect(listed.map((skill) => skill.slug)).not.toContain(tooBigSlug);
    expect(listed.map((skill) => skill.slug)).not.toContain('bad-slug');
  });

  it('rejects a duplicate slug and leaves the original untouched', async () => {
    const slug = unique('import-duplicate');
    createdSkills.push(slug);

    const first = await importSkill(skillMd(slug, [], 'Original Name'));
    expect(first.statusCode, first.body).toBe(201);
    const original = first.json<ImportResult>().skill;

    const duplicate = await importSkill(skillMd(slug, [], 'Other Name'));
    expectProblem(duplicate, 'CONFLICT');

    const loaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${original.id}`,
      headers: auth(),
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json<Skill>()).toMatchObject({
      slug,
      name: 'Original Name',
      body: original.body,
    });
  });

  it('requires auth to import', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/skills/import',
      payload: { skillMd: skillMd(unique('import-anon')) },
    });
    expectProblem(res, 'UNAUTHORIZED');
  });

  it('patches and clears descriptive frontmatter fields', async () => {
    const slug = unique('patch-meta');
    createdSkills.push(slug);
    const created = await inject(app, {
      method: 'POST',
      url: '/api/skills',
      headers: auth(),
      payload: { slug, name: 'Patchable', description: 'patchable skill', body: '' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const skill = created.json<Skill>();

    const provenance = {
      license: 'MIT',
      compatibility: 'claude-code',
      metadata: { author: 'skills.sh', version: 2 },
    };
    const patched = await inject(app, {
      method: 'PATCH',
      url: `/api/skills/${skill.id}`,
      headers: auth(),
      payload: provenance,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<Skill>()).toMatchObject(provenance);

    const loaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${skill.id}`,
      headers: auth(),
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json<Skill>()).toMatchObject(provenance);

    // null 表示显式清空：读回来三个键都要消失，而不是变成 null。
    const cleared = await inject(app, {
      method: 'PATCH',
      url: `/api/skills/${skill.id}`,
      headers: auth(),
      payload: { license: null, compatibility: null, metadata: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const reloaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${skill.id}`,
      headers: auth(),
    });
    expect(reloaded.statusCode, reloaded.body).toBe(200);
    for (const res of [cleared, reloaded]) {
      const body = res.json<Skill>();
      expect(body).not.toHaveProperty('license');
      expect(body).not.toHaveProperty('compatibility');
      expect(body).not.toHaveProperty('metadata');
    }
  });

  it('keeps descriptive frontmatter fields through import and API reads', async () => {
    const slug = unique('import-meta');
    createdSkills.push(slug);

    const markdown = skillMd(slug, [
      'license: MIT',
      'compatibility: claude-code',
      'metadata: {"author":"skills.sh","version":2}',
    ]);
    const res = await importSkill(markdown);
    expect(res.statusCode, res.body).toBe(201);
    const expected = {
      slug,
      license: 'MIT',
      compatibility: 'claude-code',
      metadata: { author: 'skills.sh', version: 2 },
    };
    expect(res.json<ImportResult>().skill).toMatchObject(expected);

    const loaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${res.json<ImportResult>().skill.id}`,
      headers: auth(),
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json<Skill>()).toMatchObject(expected);

    // 未写 provenance 时 DB 的 NULL / 空 metadata 不应作为无意义字段出现在 API 里。
    const plainSlug = unique('import-no-meta');
    createdSkills.push(plainSlug);
    const plain = await importSkill(skillMd(plainSlug));
    expect(plain.statusCode, plain.body).toBe(201);
    const plainLoaded = await inject(app, {
      method: 'GET',
      url: `/api/skills/${plain.json<ImportResult>().skill.id}`,
      headers: auth(),
    });
    expect(plainLoaded.statusCode, plainLoaded.body).toBe(200);
    const plainSkill = plainLoaded.json<Skill>();
    expect(plainSkill).not.toHaveProperty('license');
    expect(plainSkill).not.toHaveProperty('compatibility');
    expect(plainSkill).not.toHaveProperty('metadata');
  });
});
