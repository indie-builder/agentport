import type { Server } from '@agentport/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * testConnection 的目录上限走真实 Effect 流程，只 mock MCP client 边界：
 * 不建连接，断言失败/成功与 close 语义。stdio 已移到沙盒，这里用 http。
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
    StreamableHTTPClientTransport: class {},
  };
});

// SSRF 边界单独有测试；本套件只关心目录上限与 close 语义，
// 用真实 DNS 会让离线/沙箱环境里的固定域名解析失败，掩盖真正的断言。
vi.mock('../src/features/servers/ssrf.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/servers/ssrf.js')>()),
  assertSafeUrl: vi.fn(async () => undefined),
}));

const { testConnection } = await import('../src/features/servers/test-connection.js');

const server: Server = {
  id: 'srv-fixture',
  name: 'fixture',
  description: '',
  kind: 'http',
  url: 'https://example.test/mcp',
  headers: {},
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
  it('never spawns stdio servers in the API process', async () => {
    const result = await testConnection({
      ...server,
      kind: 'stdio',
      command: 'node',
      args: [],
      env: {},
    } as Server);

    expect(result).toMatchObject({ ok: false, tools: [] });
    expect(result.error).toContain('沙盒');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

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

  it('redacts bearer and assignment secrets in the result and warn log', async () => {
    mocks.connect.mockRejectedValueOnce(
      new Error(
        'connect failed: Authorization: Bearer abcdefghijklmnop, MCP_TOKEN=superSecretValue123',
      ),
    );
    const logger = { warn: vi.fn() };

    const result = await testConnection(server, 'production', undefined, logger);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Bearer abcd***');
    expect(result.error).toContain('MCP_TOKEN=supe***');
    expect(result.error).not.toContain('abcdefghijklmnop');
    expect(result.error).not.toContain('superSecretValue123');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0];
    expect(message).toBe('mcp server test failed');
    expect(fields.error).toBe(result.error);
    expect(JSON.stringify(fields)).not.toContain('superSecretValue123');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('redacts a multi-megabyte bearer token without RangeError', async () => {
    mocks.connect.mockRejectedValueOnce(new Error(`Bearer ${'x'.repeat(7_000_000)}`));
    const logger = { warn: vi.fn() };

    const result = await testConnection(server, 'production', undefined, logger);

    expect(result.error).toBe('Bearer xxxx***');
    expect(logger.warn.mock.calls[0][0].error).toBe('Bearer xxxx***');
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
