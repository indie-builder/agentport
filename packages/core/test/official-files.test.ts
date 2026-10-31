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
      disallowedTools: expect.arrayContaining(['Agent']),
      systemPrompt: agent.systemPrompt,
    });
    expect(content).toContain('memory: project');
    expect(parsed.disallowedTools).not.toContain('Bash');
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(parsed.disallowedTools).not.toContain(tool);
    }
  });

  it('accepts only project memory in child files', () => {
    const base = ['---', 'name: kid', 'description: d', 'model: m', '---', '', 'prompt'].join('\n');
    const withMemory = (value: string) => base.replace('model: m', `model: m\nmemory: ${value}`);
    expect(parseChildAgentMd(withMemory('project'), '/x').slug).toBe('kid');
    for (const scope of ['user', 'local']) {
      const error = expectInvalid(() => parseChildAgentMd(withMemory(scope), '/x'), '/x/memory');
      expect(error.message).toContain('project');
      // 拒绝原因是未纳入平台挂载与导出契约，而不是目录位于工作区之外。
      expect(error.message).toContain('挂载与导出契约');
    }
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

describe('generated suffix round-trips user prose verbatim', () => {
  const START = '<!-- agentport:generated:start -->';
  const END = '<!-- agentport:generated:end -->';
  const DELEGATION_NOTE = '你是被父智能体同步调用的：直接执行任务并返回最终文本。';
  const prompts = {
    heading: '你是助手。\n\n## 工具使用\n\n用户自己的同名标题，必须保留。',
    repeatedHeading: '第一段\n\n## 工具使用\n\n第二段\n\n## 工具使用\n\n第三段',
    delegationNote: `正文。\n\n${DELEGATION_NOTE}\n\n后续正文。`,
    loneStart: `正文。\n\n${START}\n\n后面还有正文。`,
    loneEnd: `正文。\n\n${END}\n\n后面还有正文。`,
    completeExample: `正文。\n\n${START}\n示例内容\n${END}`,
    multipleExamples: `${START}\n甲\n${END}\n\n中间正文\n\n${START}\n乙\n${END}`,
  };

  it('round-trips the root CLAUDE.md prompt without using heading or prose as a boundary', () => {
    for (const prompt of Object.values(prompts)) {
      const { claudeMd } = renderWorkspace({
        agent: { ...agent, systemPrompt: prompt },
        servers: [],
      });
      expect(parseClaudeMd(claudeMd).systemPrompt).toBe(prompt);
    }
  });

  it('round-trips the child definition prompt without using the delegation note as a boundary', () => {
    for (const prompt of Object.values(prompts)) {
      const content = renderSubAgentMd({
        agent: { ...agent, systemPrompt: prompt },
        servers: [
          { name: 'web', entry: { type: 'http', url: 'https://example.com', headers: {} } },
        ],
      });
      expect(parseChildAgentMd(content, '/child').systemPrompt).toBe(prompt);
    }
  });

  it('normalizes BOM and CRLF before reading the generated suffix', () => {
    const prompt = prompts.completeExample;
    const { claudeMd } = renderWorkspace({
      agent: { ...agent, systemPrompt: prompt },
      servers: [],
    });
    const bomCrlf = `﻿${claudeMd.replace(/\n/g, '\r\n')}`;
    expect(parseClaudeMd(bomCrlf).systemPrompt).toBe(prompt);

    const child = renderSubAgentMd({ agent: { ...agent, systemPrompt: prompt }, servers: [] });
    expect(parseChildAgentMd(`﻿${child.replace(/\n/g, '\r\n')}`, '/child').systemPrompt).toBe(
      prompt,
    );
  });

  it('keeps OpenUI tool descriptions from masquerading as generated boundaries', () => {
    // 工具描述是外来多行文本，可能恰好含独占边界行；读取端只认渲染器自己的终端后缀。
    for (const description of [
      `工具说明\n${START}\n后续说明`,
      `工具说明\n${END}\n后续说明`,
      `工具说明\n${START}\n示例内容\n${END}\n后续说明`,
    ]) {
      const { claudeMd } = renderWorkspace({
        agent: { ...agent, uiFormat: 'openui' },
        servers: [],
        openuiTools: [
          {
            name: 'search',
            description,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
      expect(claudeMd).toContain('## 生成式 UI');
      expect(parseClaudeMd(claudeMd).systemPrompt).toBe(agent.systemPrompt);
      const lines = claudeMd.split('\n').map((line) => line.trim());
      expect(lines.filter((line) => line === START)).toHaveLength(1);
      expect(lines.filter((line) => line === END)).toHaveLength(1);
    }
  });

  it('accepts a rendered child definition whose user prompt is empty', () => {
    const content = renderSubAgentMd({ agent: { ...agent, systemPrompt: '' }, servers: [] });
    expect(parseChildAgentMd(content, '/child').systemPrompt).toBe('');
  });

  it('keeps hand-written files without a generated suffix as the whole instruction', () => {
    expect(parseClaudeMd('# 手写\n\n## 工具使用\n\n用户全文。').systemPrompt).toBe(
      '## 工具使用\n\n用户全文。',
    );
    const child = [
      '---',
      'name: kid',
      'description: d',
      'model: m',
      '---',
      '',
      '# Kid',
      '',
      DELEGATION_NOTE,
      '',
      '用户全文。',
    ].join('\n');
    expect(parseChildAgentMd(child, '/child').systemPrompt).toBe(
      `${DELEGATION_NOTE}\n\n用户全文。`,
    );
  });
});
