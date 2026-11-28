import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { repo } from '@agentport/db';
import type { Skill } from '@agentport/shared';
import {
  cleanup,
  expectProblem,
  infraReady,
  loginCookie,
  request,
  startApp,
  type TestApp,
  unique,
} from './helpers.js';
import { stubGlobal, unstubAllGlobals } from './native.js';

const skillMd = `---
name: Find Skills
description: Helps discover and install agent skills.
license: MIT
compatibility: Requires Node 20+
metadata:
  author: acme
  tags:
    - catalog
    - search
  limits:
    maxFiles: 12
---

# Find Skills

Search the catalog before recommending a skill.
`;

const metadata = {
  author: 'acme',
  tags: ['catalog', 'search'],
  limits: { maxFiles: 12 },
};

const ready = await infraReady;

describe.skipIf(!ready)('market skill install', () => {
  let app: TestApp;
  let cookie: string;
  const skillSlugs: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterEach(() => {
    unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanup(app, { skillSlugs });
    await app.close();
  });

  const stubSnapshot = (files: unknown[]) => {
    stubGlobal('fetch', mock().mockResolvedValue(Response.json({ files })));
  };

  const install = (id: string) =>
    request(app, {
      method: 'POST',
      url: '/api/market/skills/install',
      headers: { cookie },
      payload: { id },
    });

  it('uses the market slug, writes provenance and keeps legal nested resources', async () => {
    const slug = unique('find-skills');
    skillSlugs.push(slug);
    stubSnapshot([
      { path: 'SKILL.md', contents: skillMd },
      { path: 'references/nested/api.md', contents: '# API' },
      { path: 'scripts/run.sh', contents: 'exit 0' },
    ]);

    const res = await install(`acme/skills/${slug}`);
    expect(res.statusCode, res.body).toBe(201);
    const { skill, warnings } = res.json<{ skill: Skill; warnings: string[] }>();

    expect(skill.slug).toBe(slug);
    expect(skill.name).toBe('Find Skills');
    expect(skill.description).toBe('Helps discover and install agent skills.');
    expect(skill.body).toContain('Search the catalog');
    expect(skill.license).toBe('MIT');
    expect(skill.compatibility).toBe('Requires Node 20+');
    expect(skill.metadata).toEqual(metadata);
    expect(warnings).toEqual([]);

    const persisted = await repo.skills.getSkill(app.db, skill.id);
    if (!persisted) throw new Error('installed skill not found');
    expect(repo.skills.toSkillDefinition(persisted)).toMatchObject({
      license: 'MIT',
      compatibility: 'Requires Node 20+',
      metadata,
    });
    expect(
      (await repo.skillFiles.listSkillFiles(app.db, skill.id)).map(({ path, content }) => ({
        path,
        content,
      })),
    ).toEqual([
      { path: 'references/nested/api.md', content: '# API' },
      { path: 'scripts/run.sh', content: 'exit 0' },
    ]);
  });

  it('skips unsafe paths, binary content, and bad entries', async () => {
    const slug = unique('market-unsafe');
    skillSlugs.push(slug);
    stubSnapshot([
      { path: 'SKILL.md', contents: skillMd },
      { path: '../escape.md', contents: 'x' },
      { path: 'image.png', contents: '\0binary' },
      'not-an-entry',
    ]);

    const res = await install(`acme/skills/${slug}`);
    expect(res.statusCode, res.body).toBe(201);
    const { skill, warnings } = res.json<{ skill: Skill; warnings: string[] }>();
    expect(warnings).toHaveLength(3);
    expect(await repo.skillFiles.listSkillFiles(app.db, skill.id)).toEqual([]);
  });

  it('warns and skips non-canonical paths and reserved definition names', async () => {
    const slug = unique('market-canonical');
    skillSlugs.push(slug);
    const paths = ['a//b.md', './refs/a.md', 'skill.md', 'SKILL.md/child.md'];
    stubSnapshot([
      { path: 'SKILL.md', contents: skillMd },
      ...paths.map((path) => ({ path, contents: 'skip' })),
      { path: 'references/nested/api.md', contents: 'keep' },
    ]);

    const res = await install(`acme/skills/${slug}`);
    expect(res.statusCode, res.body).toBe(201);
    const { skill, warnings } = res.json<{ skill: Skill; warnings: string[] }>();
    expect(warnings).toEqual(paths.map((path) => `跳过路径不合法的文件 ${path}`));
    expect(
      (await repo.skillFiles.listSkillFiles(app.db, skill.id)).map(({ path, content }) => ({
        path,
        content,
      })),
    ).toEqual([{ path: 'references/nested/api.md', content: 'keep' }]);
  });

  it('rejects snapshots without SKILL.md', async () => {
    const slug = unique('market-no-skillmd');
    skillSlugs.push(slug);
    stubSnapshot([]);

    const res = await install(`acme/skills/${slug}`);
    const problem = expectProblem(res, 'INVALID_INPUT');
    expect(problem.message).toContain('缺少 SKILL.md');
  });

  it('rejects invalid slug segments', async () => {
    expectProblem(await install('../evil'), 'INVALID_INPUT');

    stubSnapshot([{ path: 'SKILL.md', contents: skillMd }]);
    const problem = expectProblem(await install('acme/skills/Invalid.Slug'), 'INVALID_INPUT');
    expect(problem.message).toContain('目录名不合法');
  });

  it.each([
    ['refs', 'refs/child.md'],
    ['refs/child.md', 'refs'],
    ['refs/a.md', 'REFS/A.md'],
    ['refs/a.md', 'refs/a.md'],
  ])(
    'rejects a conflicting market installation before persisting %s / %s',
    async (first, second) => {
      const slug = unique('market-conflict');
      skillSlugs.push(slug);
      stubSnapshot([
        { path: 'SKILL.md', contents: skillMd },
        { path: first, contents: 'first' },
        { path: second, contents: 'second' },
      ]);
      const result = await install(`acme/skills/${slug}`);
      expectProblem(result, 'INVALID_INPUT');
      expect(await repo.skills.getSkillBySourceId(app.db, `acme/skills/${slug}`)).toBeNull();
      expect(
        (await repo.skills.listSkills(app.db, { limit: 100 })).items.some(
          (row) => row.slug === slug,
        ),
      ).toBe(false);
    },
  );
});
