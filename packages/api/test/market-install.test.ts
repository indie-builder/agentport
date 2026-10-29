import { repo } from '@agentport/db';
import { describe, expect, it, vi } from 'vitest';
import { snapshotToSkill } from '../src/features/market/install.js';
import {
  cleanup,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

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

describe('snapshotToSkill', () => {
  it('uses the market slug and keeps support files', () => {
    const result = snapshotToSkill('find-skills', [
      { path: 'SKILL.md', contents: skillMd },
      { path: 'references/api.md', contents: '# API' },
    ]);

    expect(result.skill.slug).toBe('find-skills');
    expect(result.skill.name).toBe('Find Skills');
    expect(result.skill.description).toBe('Helps discover and install agent skills.');
    expect(result.skill.body).toContain('Search the catalog');
    expect(result.files).toEqual([{ path: 'references/api.md', content: '# API' }]);
    expect(result.warnings).toEqual([]);
  });

  it('skips unsafe paths, binary content, and bad entries', () => {
    const result = snapshotToSkill('find-skills', [
      { path: 'SKILL.md', contents: skillMd },
      { path: '../escape.md', contents: 'x' },
      { path: 'image.png', contents: '\0binary' },
      'not-an-entry',
    ]);

    expect(result.files).toEqual([]);
    expect(result.warnings).toHaveLength(3);
  });

  it('warns and skips non-canonical paths and reserved definition names', () => {
    const paths = ['a//b.md', './refs/a.md', 'skill.md', 'SKILL.md/child.md'];
    const result = snapshotToSkill('find-skills', [
      { path: 'SKILL.md', contents: skillMd },
      ...paths.map((path) => ({ path, contents: 'skip' })),
      { path: 'references/nested/api.md', contents: 'keep' },
    ]);
    expect(result.files).toEqual([{ path: 'references/nested/api.md', content: 'keep' }]);
    expect(result.warnings).toEqual(paths.map((path) => `跳过路径不合法的文件 ${path}`));
  });

  it('rejects snapshots without SKILL.md', () => {
    expect(() => snapshotToSkill('find-skills', [])).toThrow('缺少 SKILL.md');
  });

  it('rejects invalid slug segments', () => {
    expect(() => snapshotToSkill('../evil', [])).toThrow('目录名不合法');
  });
});

describe.skipIf(!ready)('market install persistence', () => {
  it.each([
    ['refs', 'refs/child.md'],
    ['refs/child.md', 'refs'],
    ['refs/a.md', 'REFS/A.md'],
    ['refs/a.md', 'refs/a.md'],
  ])(
    'rejects a conflicting market installation before persisting %s / %s',
    async (first, second) => {
      const app = await startApp();
      const slug = unique('market-conflict');
      try {
        const cookie = await loginCookie(app);
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(
            Response.json({
              files: [
                { path: 'SKILL.md', contents: skillMd },
                { path: first, contents: 'first' },
                { path: second, contents: 'second' },
              ],
            }),
          ),
        );
        const result = await inject(app, {
          method: 'POST',
          url: '/api/market/skills/install',
          headers: { cookie },
          payload: { id: `acme/skills/${slug}` },
        });
        expectProblem(result, 'INVALID_INPUT');
        expect(await repo.skills.getSkillBySourceId(app.db, `acme/skills/${slug}`)).toBeNull();
        expect((await repo.skills.listSkills(app.db)).some((row) => row.slug === slug)).toBe(false);
      } finally {
        vi.unstubAllGlobals();
        await cleanup(app, { skillSlugs: [slug] });
        await app.close();
      }
    },
  );

  it.each([
    [
      { path: 'refs', content: 'file' },
      { path: 'refs/child.md', content: 'child' },
    ],
    [
      { path: 'refs/a.md', content: 'one' },
      { path: 'REFS/A.md', content: 'two' },
    ],
  ])('rejects a non-projectable batch without creating the skill: %j', async (...files) => {
    const app = await startApp();
    const slug = unique('market-batch');
    try {
      const { skill } = snapshotToSkill(slug, [{ path: 'SKILL.md', contents: skillMd }]);
      await expect(repo.skills.createSkillWithFiles(app.db, skill, files)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect((await repo.skills.listSkills(app.db)).some((row) => row.slug === slug)).toBe(false);
    } finally {
      await cleanup(app, { skillSlugs: [slug] });
      await app.close();
    }
  });

  it('writes provenance and legal nested resources to the installed skill', async () => {
    const app = await startApp();
    const slug = unique('market-provenance');
    try {
      const snapshot = snapshotToSkill(slug, [
        { path: 'SKILL.md', contents: skillMd },
        { path: 'references/nested/api.md', contents: '# API' },
        { path: 'scripts/run.sh', contents: 'exit 0' },
      ]);
      const created = await repo.skills.createSkillWithFiles(
        app.db,
        snapshot.skill,
        snapshot.files,
      );
      const persisted = await repo.skills.getSkill(app.db, created.id);
      if (!persisted) throw new Error('installed skill not found');

      expect(persisted.license).toBe('MIT');
      expect(persisted.compatibility).toBe('Requires Node 20+');
      expect(persisted.metadata).toEqual(metadata);
      expect(
        (await repo.skillFiles.listSkillFiles(app.db, created.id)).map(({ path, content }) => ({
          path,
          content,
        })),
      ).toEqual(snapshot.files);
      expect(repo.skills.toSkillDefinition(persisted)).toMatchObject({
        license: 'MIT',
        compatibility: 'Requires Node 20+',
        metadata,
      });
    } finally {
      await cleanup(app, { skillSlugs: [slug] });
      await app.close();
    }
  });
});
