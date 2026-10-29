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

describe('clarifying questions prompt', () => {
  it('tells the main session to ask before guessing when the mode can prompt', () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const { claudeMd } = renderWorkspace({ agent: { ...agent, permissionMode }, servers: [] });
      expect(claudeMd).toContain('AskUserQuestion');
      expect(claudeMd).toContain('澄清提问');
    }
  });

  it('does not promise questions under dontAsk, which denies them without a prompt', () => {
    const { claudeMd } = renderWorkspace({
      agent: { ...agent, permissionMode: 'dontAsk' },
      servers: [],
    });
    expect(claudeMd).not.toContain('AskUserQuestion');
  });

  it('tells sub-agents they cannot ask the user', () => {
    const { subAgents } = renderWorkspace({
      agent: { ...agent, slug: 'parent' },
      servers: [],
      subAgents: [{ ...agent, slug: 'child', name: 'Child' }],
    });
    expect(subAgents[0]?.content).toContain('不能向用户提问');
  });
});

describe('native todo tracking', () => {
  it('enables TodoWrite instead of the Task tools in the rendered settings env', () => {
    const files = renderWorkspace({ agent, servers: [] });

    expect(JSON.parse(files.settingsJson ?? '{}').env).toMatchObject({
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      CLAUDE_CODE_ENABLE_TASKS: '0',
    });
  });

  it('tells the agent to keep the native list for multi-step work only', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [] });

    expect(claudeMd).toContain('TodoWrite');
    expect(claudeMd).toContain('简单');
  });
});

describe('delivered outputs section', () => {
  it('tells the agent to write deliverables to the outputs mount and overwrite the same path', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [] });

    expect(claudeMd).toContain('/mnt/outputs/');
    expect(claudeMd).toContain('同一路径');
    // 回复里统一叫「会话成果」，指向对话右上角的按钮。
    expect(claudeMd).toContain('会话成果');
    expect(claudeMd).not.toContain('输出文件区');
    // 记忆仍是 Markdown、范围仍是记忆目录：交付目录不是第二份记忆。
    expect(claudeMd).toContain('/mnt/agent-memory/');
    expect(claudeMd).toMatch(/原生记忆[^。]*Markdown/);
  });

  it('keeps sub-agents without file access in their own definition', () => {
    const files = renderWorkspace({
      agent,
      servers: [],
      subAgents: [{ slug: 'child', name: 'Child', model: 'm', systemPrompt: 'p', maxTurns: 3 }],
    });

    expect(files.claudeMd).toContain('/mnt/outputs/');
    expect(files.subAgents[0]?.content).not.toContain('/mnt/outputs/');
  });
});

describe('Bash availability', () => {
  it('describes Bash in the sandbox when no MCP servers are bound', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [] });

    expect(claudeMd).toContain('`Bash`');
    expect(claudeMd).toContain('沙箱容器');
    expect(claudeMd).not.toContain('内置 shell 与网络工具已禁用');
  });

  it('does not reduce non-MCP capabilities to skills and memory', () => {
    const { claudeMd } = renderWorkspace({
      agent,
      servers: [],
      skills: [{ slug: 'deploy', name: 'Deploy', description: 'd', body: 'b' }],
    });

    expect(claudeMd).toContain('`Bash`');
    expect(claudeMd).toContain('沙箱容器');
    expect(claudeMd).toContain('可用能力只有下方列出的技能');
  });

  it('does not promise Bash when it is explicitly denied', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [], toolsDeny: ['Bash'] });

    expect(claudeMd).toContain('`Bash` 已被显式禁用');
    expect(claudeMd).not.toMatch(/仍可使用 `Bash`|沙箱容器内的 `Bash`/);
  });

  it('keeps the non-MCP capability list accurate when Bash is denied', () => {
    const { claudeMd } = renderWorkspace({
      agent,
      servers: [],
      toolsDeny: ['Bash'],
      skills: [{ slug: 'deploy', name: 'Deploy', description: 'd', body: 'b' }],
    });

    expect(claudeMd).toContain('可用能力只有下方列出的技能、原生记忆。');
  });

  it('keeps Bash available under a command-level deny but says it is constrained', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [], toolsDeny: ['Bash(rm:*)'] });

    expect(claudeMd).toContain('`Bash`（默认启用，受命令级禁用规则约束）');
    expect(claudeMd).not.toContain('`Bash` 已被显式禁用');
  });
});

describe('native file access wording', () => {
  it('separates other-path file tools from sub-agent file access', () => {
    const { claudeMd } = renderWorkspace({ agent, servers: [] });

    expect(claudeMd).toContain(
      '其他路径的原生文件工具请求，以及子智能体的原生文件工具请求均被拒绝',
    );
  });
});

describe('parent agent md tool whitelist', () => {
  it('lists Bash by default', () => {
    const { agentMd } = renderWorkspace({ agent, servers: [] });

    expect(agentMd).toContain('tools: ["Bash"]');
  });

  it('keeps Bash alongside a custom allowedTools list', () => {
    const { agentMd } = renderWorkspace({
      agent,
      servers: [],
      toolsAllow: ['mcp__custom__*'],
    });

    expect(agentMd).toContain('tools: ["Bash", "mcp__custom__*"]');
  });

  it('keeps an explicit Bash deny in the rendered frontmatter', () => {
    const { agentMd } = renderWorkspace({ agent, servers: [], toolsDeny: ['Bash'] });

    expect(agentMd).toMatch(/disallowedTools: \[[^\]]*"Bash"/);
  });

  it('lets sub-agents inherit Bash instead of denying it', () => {
    const files = renderWorkspace({
      agent,
      servers: [],
      subAgents: [{ slug: 'child', name: 'Child', model: 'm', systemPrompt: 'p', maxTurns: 3 }],
    });

    const content = files.subAgents[0]?.content ?? '';
    expect(content).not.toContain('tools: [');
    expect(content).not.toContain('"Bash"');
  });

  it('keeps a sub-agent explicit Bash deny in its own frontmatter', () => {
    const files = renderWorkspace({
      agent,
      servers: [],
      subAgents: [
        {
          slug: 'child',
          name: 'Child',
          model: 'm',
          systemPrompt: 'p',
          maxTurns: 3,
          disallowedTools: ['Bash'],
        },
      ],
    });

    expect(files.subAgents[0]?.content).toMatch(/disallowedTools: \[[^\]]*"Bash"/);
  });
});
