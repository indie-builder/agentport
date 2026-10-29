import { describe, expect, it } from 'vitest';
import { findSkillResourcePathConflict, skillFileInputSchema } from '../src/agent.js';

describe('skill resource paths', () => {
  it.each([
    'SKILL.md',
    'skill.MD',
    'Skill.md/child.md',
    'a//b.md',
    './refs/a.md',
    'refs/./a.md',
    'refs/../a.md',
    '/refs/a.md',
    'refs/',
    'refs\\a.md',
  ])('rejects non-canonical or reserved path %s', (path) => {
    expect(skillFileInputSchema.safeParse({ path, content: '' }).success).toBe(false);
  });

  it.each([
    'references/nested/SKILL.md',
    'scripts/run.sh',
    '.config/settings.json',
    'refs/.../a.md',
  ])('keeps legal nested resource %s unchanged', (path) => {
    expect(skillFileInputSchema.parse({ path, content: 'text' })).toEqual({
      path,
      content: 'text',
    });
  });

  it.each([
    ['refs', 'refs/child.md'],
    ['refs/child.md', 'refs'],
    ['refs/a.md', 'REFS/A.md'],
    ['refs/a.md', 'refs/a.md'],
    ['Refs', 'refs/child.md'],
    ['SKILL.md', 'skill.md'],
  ])('reports conflict between %s and %s without mutating the collection', (first, second) => {
    const paths = Object.freeze([first, second]);
    const result = findSkillResourcePathConflict(paths);
    expect(result).toEqual(
      first === 'SKILL.md'
        ? { path: first, conflictingPath: 'SKILL.md' }
        : { path: second, conflictingPath: first },
    );
    expect(paths).toEqual([first, second]);
  });

  it('accepts sibling and nested resources without treating name prefixes as directories', () => {
    expect(
      findSkillResourcePathConflict([
        'refs/a.md',
        'refs/b.md',
        'refs/nested/c.md',
        'refs-extra',
        'references/SKILL.md',
      ]),
    ).toBeUndefined();
    expect(findSkillResourcePathConflict([])).toBeUndefined();
  });

  it('leaves single-path syntax validation to the entry schema', () => {
    expect(findSkillResourcePathConflict(['a//b.md'])).toBeUndefined();
    expect(skillFileInputSchema.safeParse({ path: 'a//b.md' }).success).toBe(false);
  });
});
