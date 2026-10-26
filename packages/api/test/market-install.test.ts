import { repo } from '@agentport/db';
import { describe, expect, it } from 'vitest';
import { snapshotToSkill } from '../src/features/market/install.js';
import { cleanup, infraReady, startApp, unique } from './helpers.js';

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

  it('rejects snapshots without SKILL.md', () => {
    expect(() => snapshotToSkill('find-skills', [])).toThrow('缺少 SKILL.md');
  });

  it('rejects invalid slug segments', () => {
    expect(() => snapshotToSkill('../evil', [])).toThrow('目录名不合法');
  });
});

describe.skipIf(!ready)('market install persistence', () => {
  it('writes license, compatibility and metadata to the installed skill', async () => {
    const app = await startApp();
    const slug = unique('market-provenance');
    try {
      const snapshot = snapshotToSkill(slug, [{ path: 'SKILL.md', contents: skillMd }]);
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
