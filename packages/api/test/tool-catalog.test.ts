import type { Server } from '@agentport/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * testConnection 的目录上限走真实 Effect 流程，只 mock MCP transport 边界：
 * stdio 传输不 spawn 进程，Client 不建连接，断言失败/成功与 close 语义。
 */
const mocks = vi.hoisted(() => ({
  tools: [] as unknown[],
  connect: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({ tools: [] as unknown[] })),
  getServerVersion: vi.fn(() => ({ name: 'fixture-mcp', version: '1.2.3' })),
  close: vi.fn(async () => undefined),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return {
    ...actual,
    Client: class {
      connect = mocks.connect;
      listTools = mocks.listTools;
      getServerVersion = mocks.getServerVersion;
      close = mocks.close;
    },
  };
});

vi.mock('@modelcontextprotocol/client/stdio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>();
  return {
    ...actual,
    StdioClientTransport: class {
      stderr = undefined;
    },
  };
});

const { testConnection } = await import('../src/features/servers/test-connection.js');

const server: Server = {
  id: 'srv-fixture',
  name: 'fixture',
  description: '',
  kind: 'stdio',
  command: 'node',
  // stdio 传输已被 mock；这里只需满足试连的参数白名单（解释器要一个相对脚本路径）。
  args: ['server.js'],
  env: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mocks.tools = [];
  mocks.connect.mockClear();
  mocks.listTools.mockReset();
  mocks.listTools.mockImplementation(async () => ({ tools: mocks.tools }));
  mocks.getServerVersion.mockClear();
  mocks.close.mockClear();
});

describe('testConnection tool catalog limits', () => {
  it('rejects more than 1000 tools and still closes the client once', async () => {
    mocks.tools = Array.from({ length: 1001 }, (_, i) => ({ name: `tool-${i}` }));

    const result = await testConnection(server);

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('上限 1000');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a catalog over 1MiB by UTF-8 byte length without echoing it', async () => {
    mocks.tools = [{ name: 'huge', description: '界'.repeat(400_000) }];
    expect(Buffer.byteLength(JSON.stringify(mocks.tools))).toBeGreaterThan(1_048_576);

    const result = await testConnection(server);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('1048576');
    expect(result.error).toContain('字节上限');
    expect(result.error?.length).toBeLessThan(1000);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly 1000 tools but maps only the four contract fields', async () => {
    const inputSchema = {
      type: 'object',
      properties: { id: { type: 'integer' } },
    };
    mocks.tools = Array.from({ length: 1000 }, (_, i) => ({
      name: `tool-${i}`,
      title: `Tool ${i}`,
      description: `description ${i}`,
      inputSchema,
      icons: [{ src: 'https://example.test/icon.png' }],
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
      _meta: { token: 'fixture-token' },
    }));

    const result = await testConnection(server);

    expect(result.ok).toBe(true);
    expect(result.serverInfo).toEqual({ name: 'fixture-mcp', version: '1.2.3' });
    expect(result.tools).toHaveLength(1000);
    for (const tool of result.tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name', 'title']);
      expect(tool.inputSchema).toEqual(inputSchema);
    }
    expect(JSON.stringify(result)).not.toContain('fixture-token');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
