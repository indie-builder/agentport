import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { parseSkillMd } from '../src/skill-md.js';
import { renderSkillMd } from '../src/workspace.js';

function invalidWith(content: string): AppError {
  try {
    parseSkillMd(content);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_INPUT');
    expect(appError.path).toBeTruthy();
    return appError;
  }
  throw new Error('expected parseSkillMd to throw');
}

describe('parseSkillMd', () => {
  it('parses an official SKILL.md and uses the first H1 as display name', () => {
    const markdown = [
      '---',
      'name: release-notes',
      'description: Write release notes from merged pull requests',
      '---',
      '',
      '# Release Notes',
      '',
      '## Steps',
      '',
      '1. Collect merged PRs',
    ].join('\n');

    expect(parseSkillMd(markdown)).toEqual({
      skill: {
        slug: 'release-notes',
        name: 'Release Notes',
        description: 'Write release notes from merged pull requests',
        body: '## Steps\n\n1. Collect merged PRs',
      },
      warnings: [],
    });
  });

  it('falls back to the slug and keeps the body when there is no H1', () => {
    const markdown = [
      '---',
      'name: no-heading',
      'description: No heading here',
      '---',
      '',
      '## Steps',
      '',
      'Do the thing.',
    ].join('\n');

    expect(parseSkillMd(markdown).skill).toEqual({
      slug: 'no-heading',
      name: 'no-heading',
      description: 'No heading here',
      body: '## Steps\n\nDo the thing.',
    });
  });

  it('round-trips what renderSkillMd writes', () => {
    const skill = {
      slug: 'roundtrip',
      name: 'Roundtrip Playbook',
      description: 'Handles "quoted" paths\nand CRLF bodies',
      body: '## 步骤\r\n第一行：你好，世界 🌏\r\nSecond line',
    };

    expect(parseSkillMd(renderSkillMd(skill))).toEqual({ skill, warnings: [] });
  });

  it('strips a BOM and accepts CRLF delimiters without touching body line endings', () => {
    const markdown =
      '﻿---\r\nname: crlf-skill\r\ndescription: unicode 你好\r\n---\r\n\r\n# 标题\r\n\r\n第一行\r\nSecond line\r\n';

    expect(parseSkillMd(markdown).skill).toEqual({
      slug: 'crlf-skill',
      name: '标题',
      description: 'unicode 你好',
      body: '第一行\r\nSecond line',
    });
  });

  it('decodes newlines inside a quoted YAML scalar', () => {
    const markdown = [
      '---',
      'name: quoted',
      'description: "line one\\nline two"',
      '---',
      '',
      '# Quoted',
    ].join('\n');

    expect(parseSkillMd(markdown).skill.description).toBe('line one\nline two');
  });

  it('keeps license, compatibility and metadata through a round trip', () => {
    const markdown = [
      '---',
      'name: described',
      'description: Has provenance metadata',
      'license: MIT',
      'compatibility: claude-code',
      'metadata:',
      '  version: 1',
      '  owners: [docs, release]',
      '  nested:',
      '    team: platform',
      '---',
      '',
      '# Described',
    ].join('\n');

    const { skill, warnings } = parseSkillMd(markdown);
    expect(warnings).toEqual([]);
    expect(skill).toEqual({
      slug: 'described',
      name: 'Described',
      description: 'Has provenance metadata',
      body: '',
      license: 'MIT',
      compatibility: 'claude-code',
      metadata: { version: 1, owners: ['docs', 'release'], nested: { team: 'platform' } },
    });
    expect(parseSkillMd(renderSkillMd(skill))).toEqual({ skill, warnings: [] });
  });

  it('rejects metadata that is not a YAML map', () => {
    const markdown = [
      '---',
      'name: bad-metadata',
      'description: d',
      'metadata: just-a-string',
      '---',
      '',
      '# X',
    ].join('\n');
    expect(invalidWith(markdown).path).toBe('/metadata');
  });

  it('rejects files without a frontmatter header', () => {
    expect(invalidWith('# No frontmatter\n\nJust markdown.').message).toMatch(/---/);
  });

  it('rejects a frontmatter that is not a mapping', () => {
    invalidWith('---\n- name\n- description\n---\n\n# List');
  });

  it('rejects names that are not slugs', () => {
    expect(invalidWith('---\nname: Bad Slug\ndescription: d\n---\n\n# X').path).toBe('/name');
  });

  it('rejects a missing description', () => {
    expect(invalidWith('---\nname: no-description\n---\n\n# X').path).toBe('/description');
  });

  it('rejects duplicate keys', () => {
    const content = [
      '---',
      'name: duplicate',
      'description: first',
      'description: second',
      '---',
      '',
      '# X',
    ].join('\n');
    expect(invalidWith(content).message).toMatch(/unique/i);
  });

  it('rejects anchors and aliases', () => {
    const content = [
      '---',
      'name: anchored',
      'description: &shared shared text',
      'license: *shared',
      '---',
      '',
      '# X',
    ].join('\n');
    expect(invalidWith(content).message).toMatch(/锚点|别名/);
  });

  it('rejects multiple YAML documents in the frontmatter', () => {
    const content = [
      '---',
      'name: multi-doc',
      'description: first',
      '...',
      'extra: second',
      '---',
      '',
      '# X',
    ].join('\n');
    expect(invalidWith(content).message).toMatch(/multiple documents/i);
  });

  it('rejects content over 128 KiB of UTF-8', () => {
    const content = [
      '---',
      'name: too-big',
      'description: big',
      '---',
      '',
      '# Big',
      '',
      'x'.repeat(131_072),
    ].join('\n');
    expect(invalidWith(content).message).toMatch(/上限/);
  });

  it('rejects behavioral fields and lists their keys', () => {
    const content = [
      '---',
      'name: with-tools',
      'description: tries to add behavior',
      'allowed-tools: Read',
      'hooks: {}',
      'runtime: node',
      '---',
      '',
      '# X',
    ].join('\n');

    const error = invalidWith(content);
    expect(error.message).toMatch(/allowed-tools/);
    expect(error.message).toMatch(/hooks/);
    expect(error.message).toMatch(/runtime/);
  });
});
