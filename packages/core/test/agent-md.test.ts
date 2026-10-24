import { describe, expect, it } from 'vitest';
import { parseAgentMd } from '../src/agent-md.js';
import { AppError } from '../src/errors.js';
import { renderWorkspace } from '../src/workspace.js';

const WARNING = '已按官方智能体字段导入；MCP Server 与子智能体需在平台重新绑定。';

const defaults = {
  name: 'release-helper',
  role: '通用助手',
  description: 'Helps cut releases',
  model: 'claude-sonnet-5-5',
  serverIds: [],
  skillIds: [],
  subAgentIds: [],
  allowedTools: [],
  disallowedTools: [],
  permissionMode: 'dontAsk',
  maxTurns: 20,
  maxBudgetUsd: 2,
  timeoutMs: 600_000,
  enabled: true,
};

function invalidWith(content: string): AppError {
  try {
    parseAgentMd(content);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_INPUT');
    expect(appError.path).toBeTruthy();
    return appError;
  }
  throw new Error('expected parseAgentMd to throw');
}

describe('parseAgentMd', () => {
  it('parses an agent file, keeps the whole body and fills safe defaults', () => {
    const markdown = [
      '---',
      'name: release-helper',
      'description: Helps cut releases',
      '---',
      '',
      '# Release Helper',
      '',
      '## Steps',
      '',
      '1. Collect merged PRs',
    ].join('\n');

    expect(parseAgentMd(markdown)).toEqual({
      agent: {
        ...defaults,
        slug: 'release-helper',
        systemPrompt: '# Release Helper\n\n## Steps\n\n1. Collect merged PRs',
      },
      warnings: [WARNING],
    });
  });

  it('strips a BOM and accepts CRLF without touching inner line endings', () => {
    const markdown =
      '﻿---\r\nname: crlf-agent\r\ndescription: unicode 你好\r\n---\r\n\r\n# 标题\r\n\r\n第一行\r\nSecond line\r\n';

    const { agent } = parseAgentMd(markdown);
    expect(agent.slug).toBe('crlf-agent');
    expect(agent.name).toBe('crlf-agent');
    expect(agent.description).toBe('unicode 你好');
    expect(agent.systemPrompt).toBe('# 标题\r\n\r\n第一行\r\nSecond line');
  });

  it('reads model, effort and maxTurns from the frontmatter', () => {
    const markdown = [
      '---',
      'name: tuned',
      'description: Tuned agent',
      'model: opus',
      'effort: high',
      'maxTurns: 7',
      '---',
      '',
      'Do the work.',
    ].join('\n');

    const { agent } = parseAgentMd(markdown);
    expect(agent.model).toBe('opus');
    expect(agent.effort).toBe('high');
    expect(agent.maxTurns).toBe(7);
  });

  it('rejects the inherit alias because the stored root agent has no parent', () => {
    const content = [
      '---',
      'name: inherited',
      'description: d',
      'model: inherit',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(content).path).toBe('/model');
  });

  it('rejects a non-string model', () => {
    const content = [
      '---',
      'name: numeric-model',
      'description: d',
      'model: 3',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(content).path).toBe('/model');
  });

  it('rejects missing required fields', () => {
    expect(invalidWith('---\nname: no-description\n---\n\nx').path).toBe('/description');
    expect(invalidWith('---\ndescription: no name\n---\n\nx').path).toBe('/name');
  });

  it('rejects a blank description and an empty body', () => {
    expect(invalidWith('---\nname: blank\ndescription: "  "\n---\n\nx').path).toBe('/description');
    expect(invalidWith('---\nname: empty-body\ndescription: d\n---\n').path).toBe('/body');
  });

  it('rejects a name that is not a slug', () => {
    const content = ['---', 'name: Bad Slug', 'description: d', '---', '', 'x'].join('\n');
    expect(invalidWith(content).path).toBe('/name');
  });

  it('rejects malformed YAML structures', () => {
    expect(invalidWith('# No frontmatter\n\nJust markdown.').message).toMatch(/---/);
    expect(invalidWith('---\nname: open\ndescription: d\n').message).toMatch(/闭合/);
    expect(invalidWith('---\n- name\n- description\n---\n\nx').message).toMatch(/映射/);

    const duplicate = ['---', 'name: dup', 'description: a', 'description: b', '---', '', 'x'].join(
      '\n',
    );
    expect(invalidWith(duplicate).message).toMatch(/unique/i);

    const anchors = [
      '---',
      'name: anchored',
      'description: &shared text',
      'model: *shared',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(anchors).message).toMatch(/锚点|别名/);

    const multiDoc = [
      '---',
      'name: multi-doc',
      'description: first',
      '...',
      'extra: second',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(multiDoc).message).toMatch(/multiple documents/i);

    const nonStringKey = ['---', '1: value', 'name: keyed', 'description: d', '---', '', 'x'].join(
      '\n',
    );
    expect(invalidWith(nonStringKey).message).toMatch(/字符串/);
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

  it('accepts the official runtime fields its own exporter writes', () => {
    const content = [
      '---',
      'name: exported-child',
      'description: d',
      'model: opus',
      'tools: mcp__docs__*, ListAgents',
      'disallowedTools:',
      '  - Bash',
      '  - WebFetch',
      'permissionMode: plan',
      'skills: ["release-notes"]',
      'effort: high',
      'maxTurns: 9',
      '---',
      '',
      'x',
    ].join('\n');

    const { agent, warnings } = parseAgentMd(content);
    expect(agent.allowedTools).toEqual(['mcp__docs__*', 'ListAgents']);
    expect(agent.disallowedTools).toEqual(['Bash', 'WebFetch']);
    expect(agent.permissionMode).toBe('plan');
    expect(agent.effort).toBe('high');
    expect(agent.maxTurns).toBe(9);
    expect(warnings.join('\n')).toMatch(/skills/);
  });

  it('round-trips a subagent file rendered by the exporter', () => {
    const files = renderWorkspace({
      agent: {
        slug: 'lead',
        name: 'Lead',
        model: 'claude-sonnet-4-5',
        systemPrompt: 'Lead the work.',
        maxTurns: 20,
      },
      servers: [],
      subAgents: [
        {
          slug: 'researcher',
          name: 'Researcher',
          description: '查资料',
          model: 'opus',
          systemPrompt: '# Researcher\n\nFind sources.',
          maxTurns: 9,
          permissionMode: 'plan',
          effort: 'high',
          skills: [{ slug: 'release-notes', name: 'Release Notes', description: 'd', body: 'b' }],
        },
      ],
    });

    const { agent, warnings } = parseAgentMd(files.subAgents[0]?.content ?? '');
    expect(agent.slug).toBe('researcher');
    expect(agent.model).toBe('opus');
    expect(agent.maxTurns).toBe(9);
    expect(agent.permissionMode).toBe('plan');
    expect(agent.effort).toBe('high');
    // 子文件按官方约定省略 tools：派生时继承父会话工具集。
    expect(agent.allowedTools).toEqual([]);
    expect(agent.disallowedTools).toContain('Bash');
    expect(warnings.join('\n')).toMatch(/skills/);
  });

  it('rejects unknown fields and invalid permission modes', () => {
    const content = [
      '---',
      'name: with-unknown',
      'description: tries to add behavior',
      'hooks: {}',
      'memory: user',
      '---',
      '',
      'x',
    ].join('\n');

    const error = invalidWith(content);
    for (const key of ['hooks', 'memory']) expect(error.message).toContain(key);
    expect(error.message).not.toContain('permissionMode');

    const mode = [
      '---',
      'name: bad-mode',
      'description: d',
      'permissionMode: nope',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(mode).path).toBe('/permissionMode');
  });

  it('rejects the auto permission mode and runtime-blocked tools, like the API does', () => {
    const auto = [
      '---',
      'name: auto-mode',
      'description: d',
      'permissionMode: auto',
      '---',
      '',
      'x',
    ].join('\n');
    const modeError = invalidWith(auto);
    expect(modeError.path).toBe('/permissionMode');
    expect(modeError.message).toContain('auto');

    const tool = [
      '---',
      'name: blocked-tool',
      'description: d',
      'tools: ListAgents, Monitor',
      '---',
      '',
      'x',
    ].join('\n');
    const toolError = invalidWith(tool);
    expect(toolError.path).toBe('/allowedTools');
    expect(toolError.message).toContain('Monitor');
  });

  it('rejects invalid maxTurns and effort values', () => {
    const turns = ['---', 'name: turns', 'description: d', 'maxTurns: ten', '---', '', 'x'].join(
      '\n',
    );
    expect(invalidWith(turns).path).toBe('/maxTurns');

    const effort = [
      '---',
      'name: effort',
      'description: d',
      'effort: extreme',
      '---',
      '',
      'x',
    ].join('\n');
    expect(invalidWith(effort).path).toBe('/effort');
  });
});
