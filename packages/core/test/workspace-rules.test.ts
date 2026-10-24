import { describe, expect, it } from 'vitest';
import { renderRuleMd } from '../src/workspace.js';

describe('renderRuleMd', () => {
  it('keeps a brace-expanded glob as one paths entry', () => {
    const markdown = renderRuleMd({
      slug: 'api',
      content: '# API',
      globs: 'src/**/*.{ts,tsx}',
    });

    expect(markdown).toContain('  - "src/**/*.{ts,tsx}"');
    expect(markdown.match(/^ {2}- /gm)).toHaveLength(1);
  });

  it('splits commas at the top level only', () => {
    const markdown = renderRuleMd({
      slug: 'api',
      content: '# API',
      globs: 'src/**/*.{ts,tsx}, docs/**',
    });

    expect(markdown).toContain('  - "src/**/*.{ts,tsx}"');
    expect(markdown).toContain('  - "docs/**"');
  });

  it('keeps the existing single-glob and no-glob output unchanged', () => {
    expect(renderRuleMd({ slug: 'one', content: '# One', globs: 'src/**/*.ts' })).toBe(
      '---\npaths:\n  - "src/**/*.ts"\n---\n\n# One\n',
    );
    expect(renderRuleMd({ slug: 'all', content: '# All' })).toBe('# All\n');
    expect(renderRuleMd({ slug: 'blank', content: '# Blank', globs: ' , ' })).toBe('# Blank\n');
  });
});
