import { describe, expect, it } from 'vitest';
import { snapshotToSkill } from '../src/features/market/install.js';

const skillMd = `---
name: Find Skills
description: Helps discover and install agent skills.
license: MIT
---

# Find Skills

Search the catalog before recommending a skill.
`;

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
