import { describe, expect, it } from 'vitest';
import { renderWorkspace } from '../src/workspace.js';
import { toWorkspaceInput, type WorkspaceAgentRow } from '../src/workspace-input.js';

function agentRow(overrides: Partial<WorkspaceAgentRow> = {}): WorkspaceAgentRow {
  return {
    slug: 'lead',
    name: 'Lead',
    description: 'Lead agent',
    model: 'claude-sonnet-4-5',
    systemPromptMd: '# Lead\n\nYou are the lead.',
    maxTurns: 20,
    permissionMode: 'dontAsk',
    effort: null,
    allowedTools: ['Bash'],
    disallowedTools: ['WebFetch'],
    enabled: true,
    timeoutMs: 600_000,
    ...overrides,
  };
}

const servers = (secret: string) => [
  {
    name: 'files',
    entry: { command: 'npx', args: ['-y', 'files-mcp'], env: { API_KEY: secret } },
  },
];

describe('toWorkspaceInput', () => {
  it('renders the same agent md in preview and runtime mode', () => {
    const preview = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    const runtime = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('sk-real-secret'),
        skills: [],
        subAgents: [],
      }),
    );

    // 密钥只影响 .mcp.json，不能影响 agent md / CLAUDE.md。
    expect(runtime.agentMd).toBe(preview.agentMd);
    expect(runtime.claudeMd).toBe(preview.claudeMd);
    expect(preview.mcpJson).not.toContain('sk-real-secret');
    expect(runtime.mcpJson).toContain('sk-real-secret');
  });

  it('passes allowed/disallowed tools through to the agent md', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    expect(files.agentMd).toContain('tools: ["Bash"]');
    expect(files.agentMd).toContain('"WebFetch"');
  });

  it('only renders enabled sub-agents', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [
          agentRow({ slug: 'active-child' }),
          agentRow({ slug: 'disabled-child', enabled: false }),
        ],
      }),
    );
    expect(files.subAgents.map((sub) => sub.slug)).toEqual(['active-child']);
    expect(files.claudeMd).not.toContain('disabled-child');
  });

  it('omits tools from sub-agent files so MCP tools resolve at spawn time', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'active-child' })],
      }),
    );
    // SDK 会把子智能体的 tools 当名字解析，此时 MCP 工具未注册 → 直接拒绝派生。
    expect(files.subAgents[0]?.content).not.toContain('tools: [');
    expect(files.agentMd).toContain('tools: [');
  });

  it('states the synchronous wait contract for the parent', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow({ slug: 'lead' }),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'researcher', description: '查资料', timeoutMs: 120_000 })],
      }),
    );
    // Agent 默认后台运行；平台要求等待，MD 必须写明。
    expect(files.claudeMd).toContain('run_in_background: false');
    expect(files.claudeMd).toContain('| `researcher` | 查资料 | 120s |');
    // 章节顺序：规则在前，清单在后，否则「读上面的规则」是错的。
    expect(files.claudeMd.indexOf('## 等待规则')).toBeLessThan(
      files.claudeMd.indexOf('## 可用子智能体'),
    );
    // 没有子智能体时不应出现等待章节。
    const noSub = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    expect(noSub.claudeMd).not.toContain('等待规则');
  });

  it('tells the sub-agent it is being waited on', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'researcher', timeoutMs: 120_000 })],
      }),
    );
    const child = files.subAgents[0]?.content ?? '';
    expect(child).toContain('同步调用');
    expect(child).toContain('最多等你 120 秒');
  });

  it('always disallows Agent/TaskStop in sub-agent files, even if the DB value omits them', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'active-child', disallowedTools: [] })],
      }),
    );
    const content = files.subAgents[0]?.content ?? '';
    expect(content).toContain('disallowedTools: [');
    expect(content).toMatch(/disallowedTools: \[[^\]]*"Agent"/);
    expect(content).toMatch(/disallowedTools: \[[^\]]*"TaskStop"/);
    // 主智能体有子智能体时仍可委派。
    expect(files.agentMd).not.toMatch(/disallowedTools: \[[^\]]*"Agent"/);
  });
});
