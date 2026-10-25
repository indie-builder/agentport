import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { renderWorkspace } from '../../core/src/workspace.js';

// 外部 I/O 只有 SDK 与 stdin/stdout；runner 的 schema、选项组装和事件编码全走真实代码。
const io = vi.hoisted(() => ({
  line: '',
  options: undefined as Record<string, unknown> | undefined,
  forkCalls: [] as Array<{ sessionId: string; upToMessageId?: string }>,
  /** 挂载目录里实际存在的 session（含 fork 产物）。 */
  sessions: new Set<string>(),
  /** init 消息里报告已加载的插件；undefined 表示按任务里的 path 全部加载。 */
  initPlugins: undefined as Array<{ name: string; path: string }> | undefined,
  pluginErrors: undefined as Array<{ plugin: string; type: string; message: string }> | undefined,
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield io.line;
    },
  }),
}));

// transcript 目录用真实文件系统语义太重；这里只回答「会话是否存在」。
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async () => ['workspace'],
    stat: async (path: string) => {
      const match = /([^/]+)\.jsonl$/.exec(path);
      if (match && io.sessions.has(match[1] ?? '')) return { isFile: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: async (sessionId: string, options: { upToMessageId?: string }) => {
    io.forkCalls.push({
      sessionId,
      ...(options.upToMessageId ? { upToMessageId: options.upToMessageId } : {}),
    });
    io.sessions.add('forked-session');
    return { sessionId: 'forked-session' };
  },
  query: ({ options }: { options: Record<string, unknown> }) => {
    io.options = options;
    const loaded =
      io.initPlugins ??
      ((options.plugins as Array<{ path: string }> | undefined) ?? []).map((plugin) => ({
        name: plugin.path.split('/').pop() ?? plugin.path,
        path: plugin.path,
      }));
    return (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        mcp_servers: [],
        plugins: loaded,
        ...(io.pluginErrors === undefined ? {} : { plugin_errors: io.pluginErrors }),
      };
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: '33333333-4444-4555-8666-777777777777',
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

const USER_UUID = '11111111-2222-4333-8444-555555555555';

interface Event {
  type: string;
  text?: string;
  status?: string;
  sessionId?: string;
  uuids?: Array<{ from: string; to: string }>;
  sdkUuid?: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function run(
  task: Record<string, unknown>,
  init: {
    plugins?: Array<{ name: string; path: string }>;
    pluginErrors?: Array<{ plugin: string; type: string; message: string }>;
  } = {},
): Promise<{ events: Event[] }> {
  io.line = JSON.stringify({
    prompt: 'hi',
    model: 'test-model',
    maxTurns: 2,
    maxBudgetUsd: 1,
    userMessageUuid: USER_UUID,
    ...task,
  });
  io.forkCalls = [];
  io.options = undefined;
  io.sessions = new Set(['existing-session', 'source-session']);
  io.initPlugins = init.plugins;
  io.pluginErrors = init.pluginErrors;
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
      expect.objectContaining({
        type: 'assistant_text',
        text: 'hello',
        sdkUuid: '33333333-4444-4555-8666-777777777777',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run_finished',
        status: 'succeeded',
        sessionId: 'session-1',
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
    expect(matchers?.[0]?.hooks).toHaveLength(2);
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

  it('sets the sandbox runtime env on the SDK process', async () => {
    await run({});
    expect(io.options?.env).toMatchObject({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    });
  });

  it('does not resume an empty conversation', async () => {
    await run({});
    expect(io.options).not.toHaveProperty('resume');
    expect(io.forkCalls).toEqual([]);
  });

  it('resumes the stored session for a follow-up turn', async () => {
    await run({ resumeSessionId: 'existing-session' });
    expect(io.options?.resume).toBe('existing-session');
    expect(io.forkCalls).toEqual([]);
  });

  it('forks at the saved message before resuming a branch', async () => {
    io.forkCalls = [];
    const { events } = await run({
      resumeSessionId: 'source-session',
      forkFromMessageUuid: '22222222-3333-4444-8555-666666666666',
    });

    expect(io.forkCalls).toEqual([
      { sessionId: 'source-session', upToMessageId: '22222222-3333-4444-8555-666666666666' },
    ]);
    expect(io.options?.resume).toBe('forked-session');
    // uuid 映射由宿主从 transcript 的 forkedFrom 计算，事件只带新会话 id。
    expect(events).toContainEqual({
      type: 'session_forked',
      sessionId: 'forked-session',
    });
  });

  it('fails as infra instead of falling back to text when the transcript is missing', async () => {
    const { events } = await run({ resumeSessionId: 'missing-session' });
    expect(events).toEqual([
      {
        type: 'run_finished',
        status: 'failed',
        error: expect.stringContaining('missing from the mounted transcript directory'),
        failureKind: 'infra',
      },
    ]);
    expect(io.options).toBeUndefined();
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

  it('does not auto-approve child-only MCP servers for the parent', async () => {
    await run({
      mcpServers: ['root-mcp'],
      subAgents: [{ slug: 'researcher', servers: ['child-mcp'], skills: [] }],
    });
    const options = io.options as Options;
    expect(options.allowedTools).toContain('mcp__root-mcp__*');
    expect(options.allowedTools).not.toContain('mcp__child-mcp__*');
    // 会话级 deny 会连带移除子智能体自己的工具（子级继承会话权限），
    // 父级误调用交给 PreToolUse 边界 hook 拒绝。
    expect(options.disallowedTools).not.toContain('mcp__child-mcp');
  });

  it('defaults to no skills when the task omits them', async () => {
    await run({});
    expect(io.options?.skills).toEqual([]);
  });

  it('omits the plugins option entirely when no plugin is bound', async () => {
    await run({});
    expect(io.options).not.toHaveProperty('plugins');
    expect(io.options?.allowedTools).not.toEqual(
      expect.arrayContaining([expect.stringContaining('mcp__plugin_')]),
    );
  });

  it('loads bound plugins and namespaces their skills and MCP tools', async () => {
    await run({
      skills: ['demo-skill'],
      plugins: [
        {
          path: '/workspace/.claude/plugins/demo',
          runtimeName: 'demo.plugin',
          skills: ['review'],
          mcpServers: ['fs.main'],
          hasAgents: false,
        },
      ],
    });
    const options = io.options as Options;

    expect(options.plugins).toEqual([{ type: 'local', path: '/workspace/.claude/plugins/demo' }]);
    expect(options.skills).toEqual(['demo-skill', 'demo.plugin:review']);
    // 插件 server 的 scoped 名非 [A-Za-z0-9_-] 字符替换成 _。
    expect(options.allowedTools).toContain('mcp__plugin_demo_plugin_fs_main__*');
    // 有插件子智能体时才放行 Agent。
    expect(options.allowedTools).not.toContain('Agent');
    expect(options.disallowedTools).toContain('Agent');
  });

  it('allows Agent when a plugin ships its own sub-agents', async () => {
    await run({
      subAgents: [{ slug: 'child', servers: [], skills: [] }],
      plugins: [
        {
          path: '/workspace/.claude/plugins/demo',
          runtimeName: 'demo',
          skills: [],
          mcpServers: [],
          hasAgents: true,
        },
      ],
    });
    const options = io.options as Options;
    expect(options.allowedTools).toContain('Agent');
    expect(options.disallowedTools).not.toContain('Agent');
  });

  it('fails as infra when bound plugins never load', async () => {
    const { events } = await run(
      {
        plugins: [
          {
            path: '/workspace/.claude/plugins/demo',
            runtimeName: 'demo',
            skills: [],
            mcpServers: [],
            hasAgents: false,
          },
        ],
      },
      { plugins: [] },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run_finished',
        status: 'failed',
        failureKind: 'infra',
      }),
    );
  });

  it('reports plugin load errors without failing the run', async () => {
    const { events } = await run(
      {
        plugins: [
          {
            path: '/workspace/.claude/plugins/demo',
            runtimeName: 'demo',
            skills: [],
            mcpServers: [],
            hasAgents: false,
          },
        ],
      },
      {
        pluginErrors: [
          { plugin: 'inline[0]', type: 'path-not-found', message: 'Path not found: /x' },
        ],
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Path not found: /x'),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run_finished', status: 'succeeded' }),
    );
  });

  it('rejects a task without a user message uuid', async () => {
    await expect(run({ userMessageUuid: 'not-a-uuid' })).rejects.toThrow();
  });
});
