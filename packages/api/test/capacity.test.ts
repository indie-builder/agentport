import { afterEach, expect, it, mock } from 'bun:test';
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

mock.module('@agentport/core/net-guard', () => ({
  assertSafeUrl: mock(async () => undefined),
  assertServerEndpoint: mock(async () => undefined),
}));

const approvalTool: ApiTool = {
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

const plainTool: ApiTool = {
  ...approvalTool,
  id: 'tool_2',
  name: 'plain-tool',
  pathTemplate: '/plain',
  approvalMode: 'allow',
};

const evaluation = (tool: ApiTool, approved: boolean) => ({
  effectiveMode: tool.approvalMode,
  baseline: tool.approvalMode,
  approved,
  decisionHash: 'test-decision',
  matchedRuleIds: [],
});

const baseInput = {
  name: 'srv',
  baseUrl: 'https://upstream.test',
  headers: {},
  tools: [approvalTool, plainTool],
  privateHostAllowlist: '',
};

function handler(name: string): ToolHandler {
  const found = mcp.handlers.get(name);
  if (!found) throw new Error(`${name} was not registered`);
  return found;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  unstubAllGlobals();
  mcp.handlers.clear();
});

it('keeps the execution pool free when unapproved calls are refused', async () => {
  const fetchSpy = mock(async () => new Response('ok'));
  stubGlobal('fetch', fetchSpy);

  const onApprovalRequired = mock(async () => undefined);
  buildGeneratedServer({
    ...baseInput,
    isRunActive: async () => true,
    evaluateApproval: async (tool) => evaluation(tool, false),
    onApprovalRequired,
  });

  const signal = new AbortController().signal;
  const waiting = Array.from({ length: 4 }, () =>
    handler('approve-tool')({}, { mcpReq: { signal } }),
  );
  await waitForAssertion(() => expect(onApprovalRequired).toHaveBeenCalledTimes(4));

  const plain = await handler('plain-tool')({}, { mcpReq: { signal } });
  expect(plain.isError).toBeFalsy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  const fifth = await handler('approve-tool')({}, { mcpReq: { signal } });
  expect(fifth.isError).toBe(true);
  expect(JSON.stringify(fifth.content)).toContain('需要批准');
  expect(onApprovalRequired).toHaveBeenCalledTimes(5);
  expect(onApprovalRequired).toHaveBeenLastCalledWith(
    'approve-tool',
    expect.any(Object),
    expect.any(Object),
  );

  const results = await Promise.all(waiting);
  for (const result of results) expect(result.isError).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('never calls upstream for a call cancelled while queued for the execution pool', async () => {
  const slots = Array.from({ length: 4 }, () => deferred<Response>());
  const fetchSpy = mock(() => slots[fetchSpy.mock.calls.length - 1]?.promise ?? Promise.reject());
  stubGlobal('fetch', fetchSpy);

  buildGeneratedServer({ ...baseInput, isRunActive: async () => true });

  const controller = new AbortController();
  const activeCalls = Array.from({ length: 4 }, () =>
    handler('plain-tool')({}, { mcpReq: { signal: new AbortController().signal } }),
  );
  await waitForAssertion(() => expect(fetchSpy).toHaveBeenCalledTimes(4));

  const queued = handler('plain-tool')({}, { mcpReq: { signal: controller.signal } });
  controller.abort();
  slots[0]?.resolve(new Response('ok'));

  const result = await queued;
  for (const slot of slots.slice(1)) slot.resolve(new Response('ok'));
  await Promise.all(activeCalls);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/取消|结束/);
  expect(fetchSpy).toHaveBeenCalledTimes(4);
});
