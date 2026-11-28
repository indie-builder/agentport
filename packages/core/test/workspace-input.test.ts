import { describe, expect, it } from 'bun:test';
import { renderWorkspace, unionById } from '../src/workspace.js';
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
    uiFormat: 'markdown',
    effort: null,
    allowedTools: ['Bash'],
    disallowedTools: ['WebFetch'],
    enabled: true,
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

  it('lists Bash in the parent whitelist with or without a custom allow list', () => {
    const withoutCustom = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow({ allowedTools: [] }),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    expect(withoutCustom.agentMd).toContain('tools: ["Bash"');

    const withCustom = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow({ allowedTools: ['mcp__files__*'] }),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    expect(withCustom.agentMd).toContain('tools: ["Bash", "mcp__files__*"]');
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
        subAgents: [agentRow({ slug: 'researcher', description: '查资料' })],
      }),
    );
    expect(files.claudeMd).toContain('后台执行已被运行时禁用');
    expect(files.claudeMd).toContain('| `researcher` | 查资料 | 20 |');
    expect(files.claudeMd.indexOf('## 等待规则')).toBeLessThan(
      files.claudeMd.indexOf('## 可用子智能体'),
    );
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

  it('tells the agent to invoke skills with the native Skill tool', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [
          { slug: 'release-notes', name: 'Release notes', description: '写发布说明', body: '步骤' },
        ],
        subAgents: [],
      }),
    );
    expect(files.claudeMd).toContain('`Skill` 工具');
    expect(files.claudeMd).toContain('`release-notes`');
    expect(files.skills[0]?.content).toContain('步骤');
    const noMcp = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: [],
        skills: [
          { slug: 'release-notes', name: 'Release notes', description: '写发布说明', body: '步骤' },
        ],
        subAgents: [],
      }),
    );
    expect(noMcp.claudeMd).toContain('可用能力只有下方列出的技能');
  });

  it('tells the sub-agent it is being waited on', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'researcher' })],
      }),
    );
    const child = files.subAgents[0]?.content ?? '';
    expect(child).toContain('同步调用');
  });

  it('unions root and child skills into workspace files, deduped by slug', () => {
    const skill = (slug: string) => ({
      slug,
      name: slug,
      description: `${slug} 描述`,
      body: '步骤',
    });
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [skill('root-skill'), skill('shared-skill')],
        subAgents: [
          agentRow({ slug: 'active-child', skills: [skill('shared-skill'), skill('child-skill')] }),
        ],
      }),
    );
    expect(files.skills.map((s) => s.slug)).toEqual(['root-skill', 'shared-skill', 'child-skill']);
    expect(files.claudeMd).toContain('`root-skill`');
    expect(files.claudeMd).toContain('`shared-skill`');
    expect(files.claudeMd).not.toContain('child-skill');
    expect(files.agentMd).not.toContain('child-skill');
    expect(files.subAgents[0]?.content).toContain('skills: ["shared-skill", "child-skill"]');
    expect(files.subAgents[0]?.content).not.toContain('root-skill');
  });

  it('excludes skills of disabled children from workspace files', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [
          agentRow({
            slug: 'disabled-child',
            enabled: false,
            skills: [{ slug: 'off-skill', name: 'Off', description: '停用', body: '步骤' }],
          }),
        ],
      }),
    );
    expect(files.skills).toEqual([]);
    expect(files.subAgents).toEqual([]);
    expect(files.claudeMd).not.toContain('off-skill');
  });

  it('leaves children without skills unchanged', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [agentRow({ slug: 'legacy-child' })],
      }),
    );
    expect(files.subAgents[0]?.content).not.toContain('skills:');
  });

  it('renders settings env that pins foreground execution and one delegation layer', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow(),
        servers: servers('<已配置>'),
        skills: [],
        subAgents: [],
      }),
    );
    expect(JSON.parse(files.settingsJson)).toEqual({
      env: {
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
        CLAUDE_CODE_ENABLE_TASKS: '0',
      },
    });
  });

  it('limits each agent to its own MCP servers and references them by name', () => {
    const files = renderWorkspace(
      toWorkspaceInput({
        agent: agentRow({ serverNames: ['root-srv'], allowedTools: [] }),
        servers: [
          { name: 'root-srv', entry: { command: 'root', args: [], env: {} } },
          { name: 'child-srv', entry: { command: 'child', args: [], env: {} } },
        ],
        skills: [],
        subAgents: [agentRow({ slug: 'researcher', serverNames: ['child-srv'] })],
      }),
    );
    expect(files.agentMd).toContain('mcp__root-srv__*');
    expect(files.agentMd).not.toContain('mcp__child-srv__*');
    expect(files.agentMd).toContain('"mcp__child-srv"');
    // 子级按名字引用根 .mcp.json：inline 配置会在非交互/未信任目录被跳过。
    const child = files.subAgents[0]?.content ?? '';
    expect(child).toContain('mcpServers:\n  - "child-srv"');
    expect(child).not.toContain('mcp__root-srv__*');
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
    expect(files.agentMd).not.toMatch(/disallowedTools: \[[^\]]*"Agent"/);
  });
});

describe('unionById', () => {
  it('dedupes across owner groups and orders the union by id', () => {
    const a = { id: 'srv_a' };
    const b = { id: 'srv_b' };
    expect(unionById([[b], [a, b]])).toEqual([a, b]);
  });
});
