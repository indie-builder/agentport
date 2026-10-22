import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, expect, it, vi } from 'vitest';
import { buildGeneratedServer } from '../src/features/servers/generated.js';

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { mcpReq: { signal: AbortSignal } },
) => Promise<CallToolResult>;

/** handler 读取 ctx.mcpReq.signal：测试补一个不会中止的 signal。 */
const ctx = { mcpReq: { signal: new AbortController().signal } };

// MCP 边界 mock：捕获 registerTool 的回调，直接驱动真实的 handler 逻辑。
const mcp = vi.hoisted(() => ({ handlers: new Map<string, ToolHandler>() }));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      mcp.handlers.set(name, handler);
    }
  },
  fromJsonSchema: (schema: unknown) => schema,
}));

vi.mock('../src/features/servers/ssrf.js', () => ({
  assertSafeUrl: vi.fn(async () => undefined),
}));

const tool: ApiTool = {
  id: 'tool_1',
  serverId: 'srv_1',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  name: 'approve-tool',
  description: 'needs approval',
  method: 'GET',
  pathTemplate: '/hello',
  inputSchema: { type: 'object', properties: {} },
  paramsIn: 'query',
  requiresApproval: true,
};

const baseInput = {
  name: 'srv',
  baseUrl: 'https://upstream.test',
  headers: {},
  tools: [tool],
  approvals: [],
  approvalWaitMs: 1000,
};

function deferred(): { promise: Promise<string[]>; resolve: (value: string[]) => void } {
  let resolve!: (value: string[]) => void;
  const promise = new Promise<string[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mcp.handlers.clear();
});

it('times out instead of calling upstream when approval lands after the deadline', async () => {
  vi.useFakeTimers({ now: 0 });
  const fetchSpy = vi.fn(async () => {
    throw new Error('upstream must not be called after the deadline');
  });
  vi.stubGlobal('fetch', fetchSpy);

  const later = deferred();
  let calls = 0;
  const refreshApprovals = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? [] : later.promise;
  });

  buildGeneratedServer({ ...baseInput, refreshApprovals });
  const handler = mcp.handlers.get('approve-tool');
  if (!handler) throw new Error('tool was not registered');

  const call = handler({}, ctx);
  await vi.advanceTimersByTimeAsync(500); // second lookup already in flight
  await vi.advanceTimersByTimeAsync(600); // past the 1000ms deadline
  later.resolve(['approve-tool']);

  const result = await call;
  expect(result.isError).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('calls upstream when approval arrives before the deadline', async () => {
  vi.useFakeTimers({ now: 0 });
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

  let calls = 0;
  const refreshApprovals = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? [] : ['approve-tool'];
  });

  buildGeneratedServer({ ...baseInput, refreshApprovals });
  const handler = mcp.handlers.get('approve-tool');
  if (!handler) throw new Error('tool was not registered');

  const call = handler({}, ctx);
  await vi.advanceTimersByTimeAsync(500);

  const result = await call;
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
