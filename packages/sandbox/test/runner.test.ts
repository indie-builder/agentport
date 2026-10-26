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
  /** 自定义 SDK 消息序列；为 null 时用默认的单文本块回合。 */
  messages: null as unknown[] | null,
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
      if (io.messages !== null) {
        yield* io.messages as AsyncIterable<unknown>;
        return;
      }
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
  blockIndex?: number;
  kind?: string;
  parentToolUseId?: string;
  truncated?: boolean;
}

async function run(
  task: Record<string, unknown>,
  messages?: unknown[],
  init: {
    plugins?: Array<{ name: string; path: string }>;
    pluginErrors?: Array<{ plugin: string; type: string; message: string }>;
  } = {},
): Promise<{ events: Event[]; stderr: string }> {
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
  io.messages = messages ?? null;
  io.sessions = new Set(['existing-session', 'source-session']);
  io.initPlugins = init.plugins;
  io.pluginErrors = init.pluginErrors;
  vi.resetModules();
  const events: Event[] = [];
  let stderr = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    events.push(JSON.parse(String(chunk)));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    await import('../src/runner.js');
  } finally {
    stdout.mockRestore();
    stderrSpy.mockRestore();
  }
  return { events, stderr };
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

  it('leaves outputStyle to the project settings the SDK loads natively', async () => {
    await run({});
    expect(io.options?.settingSources).toEqual(['project']);
    expect(io.options?.settings).not.toHaveProperty('outputStyle');
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
      undefined,
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
      undefined,
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

describe('assistant block streaming', () => {
  const SDK_UUID = '33333333-4444-4555-8666-777777777777';
  const init = [{ type: 'system', subtype: 'init', mcp_servers: [] }];
  const result = [
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0,
      num_turns: 1,
      session_id: 'session-1',
      modelUsage: {},
    },
  ];
  /** 真实顺序：每个非空内容块先发流事件，完整 assistant 消息在该块 stop 之前到达。 */
  function stream(event: unknown, parentToolUseId: string | null = null): unknown {
    return {
      type: 'stream_event',
      event,
      parent_tool_use_id: parentToolUseId,
      uuid: SDK_UUID,
      session_id: 'session-1',
    };
  }
  const completed = (text: string, parentToolUseId: string | null = null): unknown => ({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    uuid: SDK_UUID,
    message: { content: [{ type: 'text', text }] },
  });
  /** 工具块只能来自完整消息，同样在本块 stop 之前到达。 */
  const completedTool = (parentToolUseId: string | null = null): unknown => ({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    uuid: SDK_UUID,
    message: {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'x' } }],
    },
  });

  /** 一轮助手消息：文本块 + 工具块 + 文本块，完整消息在各自 stop 之前到达。 */
  function turn(parentToolUseId: string | null = null): unknown[] {
    const stream = (event: unknown): unknown => ({
      type: 'stream_event',
      event,
      parent_tool_use_id: parentToolUseId,
      uuid: SDK_UUID,
      session_id: 'session-1',
    });
    return [
      ...init,
      stream({ type: 'message_start', message: {} }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'first ' },
      }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'part' },
      }),
      completed('first part', parentToolUseId),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
      }),
      completedTool(parentToolUseId),
      stream({ type: 'content_block_stop', index: 1 }),
      stream({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'second' },
      }),
      completed('second', parentToolUseId),
      stream({ type: 'content_block_stop', index: 2 }),
      stream({ type: 'message_stop' }),
      ...result,
    ];
  }

  it('emits start/delta/stop per content block and keeps one completed text per block', async () => {
    const { events } = await run({}, turn());
    const streamed = events.filter((event) => event.type !== 'run_finished');

    expect(streamed.map((event) => event.type)).toEqual([
      'assistant_block_start',
      'text_delta',
      'text_delta',
      'assistant_text',
      'assistant_block_stop',
      'assistant_block_start',
      'tool_start',
      'tool_input',
      'assistant_block_stop',
      'assistant_block_start',
      'text_delta',
      'assistant_text',
      'assistant_block_stop',
    ]);
    expect(streamed.filter((event) => event.type === 'assistant_block_start')).toEqual([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text', sdkUuid: SDK_UUID },
      { type: 'assistant_block_start', blockIndex: 1, kind: 'tool_use', sdkUuid: SDK_UUID },
      { type: 'assistant_block_start', blockIndex: 2, kind: 'text', sdkUuid: SDK_UUID },
    ]);
    expect(streamed.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'first ', blockIndex: 0, sdkUuid: SDK_UUID },
      { type: 'text_delta', text: 'part', blockIndex: 0, sdkUuid: SDK_UUID },
      { type: 'text_delta', text: 'second', blockIndex: 2, sdkUuid: SDK_UUID },
    ]);
    // 落库用整块文本：只有文本块产生 assistant_text，各自带自己的 blockIndex。
    expect(streamed.filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: 'first part', blockIndex: 0, sdkUuid: SDK_UUID },
      { type: 'assistant_text', text: 'second', blockIndex: 2, sdkUuid: SDK_UUID },
    ]);
  });

  it('keeps sub-agent attribution on every streamed block', async () => {
    const { events } = await run({}, turn('toolu_parent'));
    for (const event of events.filter(
      (event) => event.type === 'text_delta' || event.type === 'assistant_block_start',
    )) {
      expect(event.parentToolUseId).toBe('toolu_parent');
    }
    expect(events.filter((event) => event.type === 'assistant_text')).toContainEqual(
      expect.objectContaining({ text: 'second', parentToolUseId: 'toolu_parent' }),
    );
  });

  it('maps a completed block to the streaming block index, not its position in the message', async () => {
    // 真实顺序（docs streaming-output）：thinking 是 index 0，文本是 index 1；
    // 完整 assistant 消息只含当前块，按消息内位置重编会把文本错报成 0。
    const thinking = { type: 'thinking', thinking: 'plan' };
    const { events } = await run({}, [
      ...init,
      stream({ type: 'message_start', message: {} }),
      stream({ type: 'content_block_start', index: 0, content_block: thinking }),
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      }),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
        message: { content: [thinking] },
      },
      stream({ type: 'content_block_stop', index: 0 }),
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' },
      }),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'bbbbbbbb-2222-4222-8222-222222222222',
        message: { content: [{ type: 'text', text: 'answer' }] },
      },
      stream({ type: 'content_block_stop', index: 1 }),
      stream({ type: 'message_stop' }),
      ...result,
    ]);

    const text = events.filter((event) => event.type === 'assistant_text');
    expect(text).toEqual([
      {
        type: 'assistant_text',
        text: 'answer',
        blockIndex: 1,
        sdkUuid: 'bbbbbbbb-2222-4222-8222-222222222222',
      },
    ]);
    // 完整消息先于该块的 stop 到达，delta 与完整块共享同一个真实 index。
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'answer', blockIndex: 1, sdkUuid: SDK_UUID },
    ]);
  });

  it('forwards every complete single-block message in order, then the terminal result', async () => {
    const { events } = await run({}, [
      ...init,
      stream({ type: 'message_start', message: {} }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      completed('first'),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({ type: 'message_stop' }),
      stream({ type: 'message_start', message: {} }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      completed('second'),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({ type: 'message_stop' }),
      ...result,
    ]);

    const streamed = events.filter((event) => event.type !== 'run_finished');
    expect(streamed.map((event) => event.type)).toEqual([
      'assistant_block_start',
      'assistant_text',
      'assistant_block_stop',
      'assistant_block_start',
      'assistant_text',
      'assistant_block_stop',
    ]);
    expect(streamed.filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: 'first', blockIndex: 0, sdkUuid: SDK_UUID },
      { type: 'assistant_text', text: 'second', blockIndex: 0, sdkUuid: SDK_UUID },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'succeeded' });
  });

  it('marks an over-limit block as truncated instead of silently cutting it', async () => {
    const huge = 'x'.repeat(2048);
    const { events, stderr } = await run({ maxFieldBytes: 1024 }, [
      ...init,
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: SDK_UUID,
        message: { content: [{ type: 'text', text: huge }] },
      },
      ...result,
    ]);
    const text = events.find((event) => event.type === 'assistant_text');
    expect(text?.truncated).toBe(true);
    expect(text?.text).toBe('x'.repeat(1024));
    expect(stderr).toContain('truncated');
  });
});
