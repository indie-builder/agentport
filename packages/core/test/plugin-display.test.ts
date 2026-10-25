import { describe, expect, it } from 'vitest';
import { readPluginMarkdown } from '../src/plugin-display.js';

describe('readPluginMarkdown', () => {
  it('reads string name and description and keeps the body verbatim', () => {
    const markdown = [
      '---',
      'name: demo',
      'description: >',
      '  first line',
      '  second line',
      'allowed-tools: Read',
      '---',
      '',
      '# Demo',
      '',
      'Body text.',
    ].join('\n');

    expect(readPluginMarkdown(markdown, 'fallback')).toEqual({
      name: 'demo',
      description: 'first line second line',
      body: '\n# Demo\n\nBody text.',
    });
  });

  it('accepts multi-line quoted descriptions and CRLF files', () => {
    const markdown = '---\r\nname: crlf\r\ndescription: "line one\\nline two"\r\n---\r\n正文\r\n';

    expect(readPluginMarkdown(markdown, 'fallback')).toEqual({
      name: 'crlf',
      description: 'line one\nline two',
      body: '正文\r\n',
    });
  });

  it('strips a BOM and ignores unknown non-string fields', () => {
    const markdown = '﻿---\nname:\ndescription: 42\nversion: 1.0\n---\nBody';

    expect(readPluginMarkdown(markdown, 'fallback')).toEqual({
      name: 'fallback',
      description: '',
      body: 'Body',
    });
  });

  it('returns the original text when there is no frontmatter', () => {
    const markdown = '\n# Readme\n\nNo frontmatter here.';

    expect(readPluginMarkdown(markdown, 'README.md')).toEqual({
      name: 'README.md',
      description: '',
      body: markdown,
    });
  });

  it('falls back to the full raw text and reports unclosed frontmatter', () => {
    const markdown = '---\nname: broken\n\n# Body';
    const parsed = readPluginMarkdown(markdown, 'broken');

    expect(parsed.body).toBe(markdown);
    expect(parsed.name).toBe('broken');
    expect(parsed.issue).toMatch(/闭合/);
  });

  it('falls back to the full raw text and reports invalid YAML', () => {
    const markdown = '---\nname: [unclosed\n---\nBody';
    const parsed = readPluginMarkdown(markdown, 'broken');

    expect(parsed.body).toBe(markdown);
    expect(parsed.name).toBe('broken');
    expect(parsed.issue).toMatch(/YAML/);
  });

  it('falls back to the full raw text when the frontmatter is not a mapping', () => {
    const markdown = '---\n- name\n---\nBody';
    const parsed = readPluginMarkdown(markdown, 'broken');

    expect(parsed.body).toBe(markdown);
    expect(parsed.issue).toMatch(/映射/);
  });
});
