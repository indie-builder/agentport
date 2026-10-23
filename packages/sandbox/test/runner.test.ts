import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { renderWorkspace } from '../../core/src/workspace.js';

// 外部 I/O 只有 SDK 与 stdin/stdout；runner 的 schema、选项组装和事件编码全走真实代码。
const io = vi.hoisted(() => ({
  line: '',
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield io.line;
    },
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    io.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', mcp_servers: [] };
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'hello' }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: 'session-1',
        modelUsage: { model: { inputTokens: 3, outputTokens: 4 } },
      };
    })();
  },
}));

interface Event {
  type: string;
  text?: string;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function run(task: Record<string, unknown>): Promise<{ events: Event[] }> {
  io.line = JSON.stringify({ prompt: 'hi', ...task });
  vi.resetModules();
  const events: Event[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    events.push(JSON.parse(String(chunk)));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await import('../src/runner.js');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return { events };
}

describe('runner task wiring', () => {
  it('passes the requested skills to the SDK without a Skill wildcard', async () => {
    const { events } = await run({ skills: ['demo-skill'] });

    expect(io.options?.skills).toEqual(['demo-skill']);
    expect(io.options?.allowedTools).not.toContain('Skill');
    expect(io.options?.disallowedTools).toContain('Bash');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'assistant_text', text: 'hello' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run_finished',
        status: 'succeeded',
        inputTokens: 3,
        outputTokens: 4,
      }),
    );
  });

  it('keeps memory tools available under dontAsk and enforces a hook on every request', async () => {
    await run({ extraAllowedTools: ['Read', 'Write', 'Edit'] });
    const options = io.options as Options;
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settings).toMatchObject({
      autoMemoryEnabled: true,
      autoMemoryDirectory: '/mnt/agent-memory',
    });
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(['Read(//mnt/agent-memory/**)', 'Edit(//mnt/agent-memory/**)']),
    );
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(options.allowedTools).not.toContain(tool);
      expect(options.disallowedTools).not.toContain(tool);
    }
    const matchers = options.hooks?.PreToolUse;
    expect(matchers).toHaveLength(1);
    expect(matchers?.[0]?.matcher).toBeUndefined();
    const hook = matchers?.[0]?.hooks[0];
    expect(hook).toBeTypeOf('function');
    const result = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/transcript',
        cwd: '/workspace',
        tool_name: 'Read',
        tool_use_id: 't',
        tool_input: { file_path: '/workspace/.mcp.json' },
      },
      't',
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('keeps file tools denied in generated child frontmatter', () => {
    const child = { slug: 'child', name: 'Child', model: 'm', systemPrompt: 'p', maxTurns: 5 };
    const files = renderWorkspace({
      agent: { ...child, slug: 'parent' },
      servers: [],
      subAgents: [child],
    });
    const content = files.subAgents[0]?.content ?? '';
    for (const tool of ['Read', 'Write', 'Edit']) {
      expect(content).toMatch(new RegExp(`disallowedTools: \\[[^\\]]*"${tool}"`));
    }
  });

  it('defaults to no skills when the task omits them', async () => {
    await run({});
    expect(io.options?.skills).toEqual([]);
  });

  it('rejects a skill name that is not a slug', async () => {
    await expect(run({ skills: ['Not A Slug'] })).rejects.toThrow();
  });
});
