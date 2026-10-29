import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  parseChildAgentMd,
  parseClaudeMd,
  parseOutputStyleMd,
  parseRuleMd,
} from '../src/official-files.js';
import {
  renderOutputStyleMd,
  renderRuleMd,
  renderSkillMd,
  renderSubAgentMd,
  renderWorkspace,
} from '../src/workspace.js';

const agent = {
  slug: 'researcher',
  name: '调研员',
  description: '查资料',
  model: 'claude-sonnet-5-5',
  systemPrompt: '你是调研员。\n\n## 步骤\n\n1. 先读。',
  maxTurns: 12,
  permissionMode: 'dontAsk',
  effort: 'high' as const,
  allowedTools: [],
  disallowedTools: [],
  timeoutMs: 90_000,
  skills: [{ slug: 'search', name: '搜索', description: '查资料', body: '' }],
  serverNames: ['web'],
};

function expectInvalid(run: () => unknown, path?: string): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_INPUT');
    if (path !== undefined) expect(appError.path).toBe(path);
    return appError;
  }
  throw new Error('expected an INVALID_INPUT error');
}

describe('official workspace file parsing', () => {
  it('round-trips the rendered child agent file', () => {
    const content = renderSubAgentMd({
      agent,
      servers: [{ name: 'web', entry: { type: 'http', url: 'https://example.com', headers: {} } }],
      skills: agent.skills,
    });
    const parsed = parseChildAgentMd(content, '/child');
    expect(parsed).toEqual({
      slug: 'researcher',
      name: '调研员',
      description: '查资料',
      model: 'claude-sonnet-5-5',
      maxTurns: 12,
      effort: 'high',
      skills: ['search'],
      mcpServers: ['web'],
      disallowedTools: expect.arrayContaining(['Read', 'Agent']),
      systemPrompt: agent.systemPrompt,
    });
    expect(parsed.disallowedTools).not.toContain('Bash');
  });

  it('rejects child files with runtime fields or an invalid model', () => {
    const base = ['---', 'name: kid', 'description: d', 'model: m', '---', '', 'prompt'].join('\n');
    expect(
      expectInvalid(() => parseChildAgentMd(base.replace('model: m', 'model: inherit'), '/x')).path,
    ).toBe('/x/model');
    const withTools = base.replace('model: m', 'model: m\ntools: Bash');
    expect(expectInvalid(() => parseChildAgentMd(withTools, '/x')).message).toContain('tools');
    const empty = ['---', 'name: kid', 'description: d', 'model: m', '---', '   '].join('\n');
    expect(expectInvalid(() => parseChildAgentMd(empty, '/x')).path).toBe('/x');
  });

  it('round-trips rules with and without globs', () => {
    expect(
      parseRuleMd(renderRuleMd({ slug: 'r', content: 'Do it.', globs: '' }), 'r', '/r'),
    ).toEqual({ slug: 'r', content: 'Do it.', globs: '' });
    const withGlobs = renderRuleMd({ slug: 'r', content: 'Do it.', globs: 'src/**,test/**' });
    expect(parseRuleMd(withGlobs, 'r', '/r').globs).toBe('src/**, test/**');
    // 纯 Markdown 规则没有 frontmatter，正文就是全文。
    expect(parseRuleMd('# Rule\n\nKeep it.', 'plain', '/p')).toEqual({
      slug: 'plain',
      content: '# Rule\n\nKeep it.',
      globs: '',
    });
  });

  it('round-trips output styles and rejects a mismatched name', () => {
    const style = {
      slug: 'brief',
      description: 'Brief answers',
      keepCodingInstructions: true,
      body: 'Be brief.',
    };
    expect(parseOutputStyleMd(renderOutputStyleMd(style), 'brief', '/s')).toEqual(style);
    expectInvalid(() => parseOutputStyleMd(renderOutputStyleMd(style), 'other', '/s'), '/s/name');
  });

  it('reads the root CLAUDE.md name and prompt and ignores rendered sections', () => {
    const { claudeMd } = renderWorkspace({
      agent,
      servers: [{ name: 'web', entry: { type: 'http', url: 'https://example.com', headers: {} } }],
      skills: agent.skills,
    });
    expect(parseClaudeMd(claudeMd)).toEqual({
      name: '调研员',
      systemPrompt: agent.systemPrompt,
    });
    expectInvalid(() => parseClaudeMd('没有标题'), '/CLAUDE.md');
  });

  it('reads a CRLF-encoded CLAUDE.md without absorbing the generated OpenUI section', () => {
    // Windows 编辑器 / git autocrlf 会把导出的 CLAUDE.md 存成 CRLF；生成段边界必须同样识别。
    const { claudeMd } = renderWorkspace({
      agent: { ...agent, uiFormat: 'openui' },
      servers: [],
      skills: [],
    });
    expect(claudeMd).toContain('## 生成式 UI');
    expect(parseClaudeMd(claudeMd.replace(/\n/g, '\r\n'))).toEqual({
      name: '调研员',
      systemPrompt: agent.systemPrompt,
    });
  });

  it('keeps skill rendering unchanged for export reuse', () => {
    expect(renderSkillMd({ slug: 's', name: 'S', description: 'd', body: 'step' })).toBe(
      '---\nname: "s"\ndescription: "d"\n---\n\n# S\n\nstep\n',
    );
  });
});
