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
});
