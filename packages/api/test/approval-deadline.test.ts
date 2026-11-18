import { afterEach, expect, it, mock } from 'bun:test';
import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { buildGeneratedServer } from '../src/modules/servers/generated.js';
import { stubGlobal, unstubAllGlobals } from './native.js';

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { mcpReq: { signal: AbortSignal } },
) => Promise<CallToolResult>;

/** handler 读取 ctx.mcpReq.signal：测试补一个不会中止的 signal。 */
const ctx = { mcpReq: { signal: new AbortController().signal } };

// MCP 边界 mock：捕获 registerTool 的回调，直接驱动真实的 handler 逻辑。
const mcp = { handlers: new Map<string, ToolHandler>() };

mock.module('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      mcp.handlers.set(name, handler);
    }
  },
  fromJsonSchema: (schema: unknown) => schema,
}));

mock.module('@agentport/core/net-guard', () => ({
  assertSafeUrl: mock(async () => undefined),
  assertServerEndpoint: mock(async () => undefined),
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
  approvalMode: 'ask',
};

const baseInput = {
  name: 'srv',
  baseUrl: 'https://upstream.test',
  headers: {},
  tools: [tool],
  approvals: [],
};

afterEach(() => {
  unstubAllGlobals();
  mock.clearAllMocks();
  mcp.handlers.clear();
});

it('refuses an unapproved call immediately without polling or touching upstream', async () => {
  const fetchSpy = mock(async () => new Response('ok'));
  stubGlobal('fetch', fetchSpy);
  const refreshApprovals = mock(async () => [] as string[]);
  const onApprovalRequired = mock(async () => undefined);
  buildGeneratedServer({ ...baseInput, refreshApprovals, onApprovalRequired });
  const handler = mcp.handlers.get('approve-tool');
  if (!handler) throw new Error('tool was not registered');
  const result = await handler({}, ctx);
  expect(result.isError).toBe(true);
  expect(refreshApprovals).toHaveBeenCalledTimes(1);
  expect(onApprovalRequired).toHaveBeenCalledTimes(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('calls upstream when the refreshed approval is already present', async () => {
  const fetchSpy = mock(async () => new Response('ok'));
  stubGlobal('fetch', fetchSpy);
  buildGeneratedServer({ ...baseInput, refreshApprovals: async () => ['approve-tool'] });
  const handler = mcp.handlers.get('approve-tool');
  if (!handler) throw new Error('tool was not registered');
  const result = await handler({}, ctx);
  expect(result.isError).toBeFalsy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
