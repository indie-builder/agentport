import { describe, expect, it } from 'vitest';
import { openuiSystemPrompt } from '../src/openui-prompt.js';
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
    uiFormat: 'markdown',
    effort: null,
    allowedTools: [],
    disallowedTools: [],
    enabled: true,
    timeoutMs: 600_000,
    ...overrides,
  };
}

function claudeMd(
  overrides: Partial<WorkspaceAgentRow> = {},
  openuiTools?: Parameters<typeof toWorkspaceInput>[0]['openuiTools'],
): string {
  return renderWorkspace(
    toWorkspaceInput({
      agent: agentRow(overrides),
      servers: [],
      skills: [],
      subAgents: [],
      ...(openuiTools === undefined ? {} : { openuiTools }),
    }),
  ).claudeMd;
}

const tool = {
  name: 'mcp__billing__get-invoice',
  description: 'Fetch one invoice',
  inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
};

describe('uiFormat', () => {
  it('appends the OpenUI prompt section when uiFormat is openui', () => {
    const md = claudeMd({ uiFormat: 'openui' });
    expect(md).toContain('## 生成式 UI');
    expect(md).toContain('Card(');
    expect(md).toContain('openui-lang');
  });

  it('omits the OpenUI section for markdown or missing uiFormat', () => {
    expect(claudeMd()).not.toContain('## 生成式 UI');
    expect(claudeMd({ uiFormat: undefined })).not.toContain('## 生成式 UI');
  });

  it('lists the caller-supplied tool catalog in CLAUDE.md', () => {
    const md = claudeMd({ uiFormat: 'openui' }, [tool]);
    expect(md).toContain('mcp__billing__get-invoice');
    // markdown 路径即便传了目录也不该出现工具段。
    expect(claudeMd({ uiFormat: 'markdown' }, [tool])).not.toContain('mcp__billing__get-invoice');
  });
});

describe('openuiSystemPrompt', () => {
  it('generates the prompt from the committed official spec', () => {
    const prompt = openuiSystemPrompt();
    // 签名来自官方 LibrarySpec，不是手写；抽查几个易漂的组件。
    expect(prompt).toContain(
      'Text(variant?: "text" | "number", value: string, subtext?: string, subtextVariant?: "text" | "number" | "metric", size?: "xs" | "sm" | "md" | "lg")',
    );
    expect(prompt).toContain('Form(name: string, buttons: Buttons, fields?: FormControl[])');
    expect(prompt).toContain('Input(name: string, placeholder?: string');
    expect(prompt).toContain('value?: $binding<string>');
    expect(prompt).toContain('CheckBoxGroup(name: string, items: CheckBoxItem[]');
    expect(prompt).toContain('Record<string, boolean>');
    expect(prompt).toContain('EntityList(rows?:');
    // 12 个分组标题都在提示词里。
    for (const group of ['Content', 'Tables', 'Charts (2D)', 'Forms', 'Cards']) {
      expect(prompt).toContain(group);
    }
  });

  it('works without a tool catalog and is stable across calls', () => {
    expect(openuiSystemPrompt([])).toBe(openuiSystemPrompt());
  });

  it('lists the tool catalog so the model can call it', () => {
    const prompt = openuiSystemPrompt([tool]);
    expect(prompt).toContain('mcp__billing__get-invoice');
    expect(prompt).toContain('Query(');
    expect(prompt).toContain('Mutation(');
  });

  it('caches per catalog: a different catalog yields a different prompt', () => {
    const first = openuiSystemPrompt([tool]);
    expect(openuiSystemPrompt([tool])).toBe(first);
    const second = openuiSystemPrompt([{ ...tool, description: 'other' }]);
    expect(second).not.toBe(first);
    expect(second).toContain('other');
  });
});
