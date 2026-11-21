import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { buildGeneratedServer } from '../src/modules/servers/generated.js';
import { stubGlobal, unstubAllGlobals, waitForAssertion } from './native.js';

type ToolContext = { mcpReq: { signal: AbortSignal } };
type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;

const mcp = { handlers: new Map<string, ToolHandler>() };

mock.module('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      mcp.handlers.set(name, handler);
    }
  },
  fromJsonSchema: (schema: unknown) => schema,
}));

const ssrfMock = mock(async () => undefined);

mock.module('@agentport/core/net-guard', () => ({
  assertSafeUrl: ssrfMock,
  assertServerEndpoint: ssrfMock,
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

function expectCancelled(result: CallToolResult): void {
  const text = JSON.stringify(result.content);
  expect(result.isError).toBe(true);
  expect(text).toMatch(/cancel|取消|结束/i);
  expect(text).not.toContain('已等待');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

async function callTool(signal: AbortSignal): Promise<CallToolResult> {
  const handler = mcp.handlers.get('approve-tool');
  if (!handler) throw new Error('tool was not registered');
  return handler({}, { mcpReq: { signal } });
}

beforeEach(() => {
  ssrfMock.mockReset();
  ssrfMock.mockResolvedValue(undefined);
});

afterEach(() => {
  unstubAllGlobals();
  mcp.handlers.clear();
});

it('refuses an already approved tool when the run is no longer active', async () => {
  const fetchSpy = mock(async () => {
    throw new Error('upstream must not be called for an ended run');
  });
  stubGlobal('fetch', fetchSpy);

  buildGeneratedServer({
    ...baseInput,
    approvals: ['approve-tool'],
    isRunActive: async () => false,
  });

  expectCancelled(await callTool(new AbortController().signal));
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('checks cancellation after the DNS gate and before fetch', async () => {
  const gate = deferred();
  ssrfMock.mockImplementation(() => gate.promise);
  const fetchSpy = mock(async () => new Response('ok'));
  stubGlobal('fetch', fetchSpy);

  const controller = new AbortController();
  buildGeneratedServer({
    ...baseInput,
    approvals: ['approve-tool'],
    isRunActive: async () => true,
  });

  const call = callTool(controller.signal);
  await waitForAssertion(() => expect(ssrfMock).toHaveBeenCalledTimes(1));
  controller.abort();
  gate.resolve();

  expectCancelled(await call);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each([1, 2])(
  'does not create an approval after cancellation during status read %i',
  async (cancelAt) => {
    const controller = new AbortController();
    const onApprovalRequired = mock(async () => undefined);
    let reads = 0;
    buildGeneratedServer({
      ...baseInput,
      isRunActive: async () => {
        reads += 1;
        if (reads === cancelAt) controller.abort();
        return true;
      },
      onApprovalRequired,
    });
    expectCancelled(await callTool(controller.signal));
    expect(onApprovalRequired).not.toHaveBeenCalled();
  },
);

it('still calls upstream for an active run with approval', async () => {
  const fetchSpy = mock(async () => new Response('ok'));
  stubGlobal('fetch', fetchSpy);

  buildGeneratedServer({
    ...baseInput,
    approvals: ['approve-tool'],
    isRunActive: async () => true,
  });

  const result = await callTool(new AbortController().signal);
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
