import { describe, expect, it, vi } from 'vitest';

/**
 * probe 的 schema、目录裁剪与 close 语义全走真实代码，只 mock MCP 传输边界：
 * 不 spawn 子进程，只断言 stdin 任务、stdio env 与结果行。
 */
const io = vi.hoisted(() => {
  const noop = () => undefined;
  return {
    line: '',
    tools: [] as unknown[],
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] as unknown[] })),
    close: vi.fn(async () => undefined),
    transportOptions: undefined as Record<string, unknown> | undefined,
    stderrText: '',
    stderr: undefined as { setEncoding: () => void; on: typeof noop } | undefined,
  };
});

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = io.connect;
    listTools = io.listTools;
    getServerVersion = () => ({ name: 'fixture-mcp', version: '1.2.3' });
    close = io.close;
  },
}));

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class {
    stderr = {
      setEncoding: () => undefined,
      on: () => undefined,
    };
    constructor(options: Record<string, unknown>) {
      io.transportOptions = options;
    }
    close = vi.fn(async () => undefined);
  },
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield io.line;
    },
  }),
}));

interface Result {
  ok: boolean;
  tools: Array<Record<string, unknown>>;
  serverInfo?: { name: string; version: string };
  error?: string;
}

async function run(task: string): Promise<Result[]> {
  io.line = task;
  io.connect.mockClear();
  io.close.mockClear();
  io.listTools.mockReset();
  io.listTools.mockImplementation(async () => ({ tools: io.tools }));
  vi.resetModules();
  const results: Result[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    results.push(JSON.parse(String(chunk)));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await import('../src/probe.js');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return results;
}

const task = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'x' },
    ...extra,
  });

describe('sandbox probe entrypoint', () => {
  it('connects with only the task env and returns the trimmed catalog', async () => {
    io.tools = [
      {
        name: 'echo',
        description: 'echo back',
        inputSchema: { type: 'object' },
        icons: [{ src: 'https://example.test/i.png' }],
        _meta: { token: 'fixture-token' },
      },
    ];

    const results = await run(task());

    expect(results).toEqual([
      {
        ok: true,
        serverInfo: { name: 'fixture-mcp', version: '1.2.3' },
        tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }],
      },
    ]);
    expect(io.transportOptions).toEqual({
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'x' },
      stderr: 'pipe',
    });
    expect(io.connect).toHaveBeenCalledTimes(1);
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid task without connecting', async () => {
    const results = await run(JSON.stringify({ kind: 'http', command: 'node' }));

    expect(results).toEqual([{ ok: false, tools: [], error: '试连任务格式无效' }]);
    expect(io.connect).not.toHaveBeenCalled();
  });

  it('turns a connect failure into a single failure line and still closes', async () => {
    io.connect.mockRejectedValueOnce(new Error('spawn npx ENOENT'));

    const results = await run(task());

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, tools: [], error: 'spawn npx ENOENT' });
    expect(io.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a tool catalog over the limit instead of truncating', async () => {
    io.tools = Array.from({ length: 1001 }, (_, i) => ({ name: `tool-${i}` }));

    const results = await run(task());

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('上限 1000');
    expect(io.close).toHaveBeenCalledTimes(1);
  });
});
