import { describe, expect, it } from 'vitest';
import { parseMarkdownFrontmatter } from '../src/markdown-frontmatter.js';
import { renderRuleMd, renderWorkspace } from '../src/workspace.js';

const agent = {
  slug: 'a',
  name: 'A',
  model: 'm',
  systemPrompt: 'p',
  maxTurns: 5,
};

function rulePaths(globs: string): string[] {
  const rendered = renderRuleMd({ slug: 'rule', content: 'body', globs });
  if (!rendered.startsWith('---\n')) return [];
  return parseMarkdownFrontmatter(rendered, 'rule', '/rule').fields.get('paths') as string[];
}

describe('renderRuleMd globs', () => {
  it('keeps brace alternation in one pattern', () => {
    expect(rulePaths('src/**/*.{ts,tsx}')).toEqual(['src/**/*.{ts,tsx}']);
  });

  it('splits top-level commas', () => {
    expect(rulePaths('a.ts,b.ts')).toEqual(['a.ts', 'b.ts']);
  });

  it('splits mixed globs only at the top level', () => {
    expect(rulePaths('src/**/*.{ts,tsx},scripts/*.mjs')).toEqual([
      'src/**/*.{ts,tsx}',
      'scripts/*.mjs',
    ]);
  });

  it('does not split on an escaped comma', () => {
    expect(rulePaths('src/file\\,name.ts,test/**')).toEqual(['src/file\\,name.ts', 'test/**']);
  });

  it('does not split on a comma inside a bracket character set', () => {
    expect(rulePaths('src/[a,b].ts,test/**')).toEqual(['src/[a,b].ts', 'test/**']);
  });

  it('drops empty entries', () => {
    expect(rulePaths('')).toEqual([]);
    expect(rulePaths(' , , ')).toEqual([]);
  });
});

describe('renderClaudeMd skill access rules', () => {
  it('allows reading skill references without banning the skills directory', () => {
    const { claudeMd } = renderWorkspace({
      agent,
      servers: [],
      skills: [{ slug: 'deploy', name: 'Deploy', description: 'd', body: 'b' }],
    });

    expect(claudeMd).toContain('.claude/skills/<slug>/references/');
    expect(claudeMd).not.toContain('不要用 `Read` 打开 `.claude/skills/`');
  });
});
