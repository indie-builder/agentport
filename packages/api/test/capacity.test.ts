import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, expect, it, vi } from 'vitest';
import { buildGeneratedServer } from '../src/features/servers/generated.js';

type ToolContext = { mcpReq: { signal: AbortSignal } };
type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;

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
  requiresApproval: true,
};

const plainTool: ApiTool = {
  ...approvalTool,
  id: 'tool_2',
  name: 'plain-tool',
  pathTemplate: '/plain',
  requiresApproval: false,
};

const baseInput = {
  name: 'srv',
  baseUrl: 'https://upstream.test',
  headers: {},
  tools: [approvalTool, plainTool],
  approvals: [],
  approvalWaitMs: 1000,
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mcp.handlers.clear();
});

it('keeps the execution pool free while calls wait for approval', async () => {
  vi.useFakeTimers({ now: 0 });
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

  const onApprovalRequired = vi.fn(async () => undefined);
  buildGeneratedServer({
    ...baseInput,
    isRunActive: async () => true,
    refreshApprovals: async () => [],
    onApprovalRequired,
  });

  const signal = new AbortController().signal;
  // 四次挂起已经占满等待名额，但仍不能占执行池。
  const waiting = Array.from({ length: 4 }, () =>
    handler('approve-tool')({}, { mcpReq: { signal } }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(onApprovalRequired).toHaveBeenCalledTimes(4);

  // 已批准的工具在四次等待期间照样能打上游。
  const plain = await handler('plain-tool')({}, { mcpReq: { signal } });
  expect(plain.isError).toBeFalsy();
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  // 第五次请求没有等待名额：立即拒绝，不挂起、不重试。
  const fifth = await handler('approve-tool')({}, { mcpReq: { signal } });
  expect(fifth.isError).toBe(true);
  expect(JSON.stringify(fifth.content)).toContain('需要批准');
  expect(onApprovalRequired).toHaveBeenCalledTimes(5);
  expect(onApprovalRequired).toHaveBeenLastCalledWith('approve-tool', null);

  await vi.advanceTimersByTimeAsync(1000);
  const results = await Promise.all(waiting);
  for (const result of results) expect(result.isError).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('releases the wait slot when a suspended call ends', async () => {
  vi.useFakeTimers({ now: 0 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok')),
  );

  const onApprovalRequired = vi.fn(async () => undefined);
  buildGeneratedServer({
    ...baseInput,
    isRunActive: async () => true,
    refreshApprovals: async () => [],
    onApprovalRequired,
  });

  const signal = new AbortController().signal;
  const waiting = Array.from({ length: 4 }, () =>
    handler('approve-tool')({}, { mcpReq: { signal } }),
  );
  await vi.advanceTimersByTimeAsync(0);

  const rejected = await handler('approve-tool')({}, { mcpReq: { signal } });
  expect(rejected.isError).toBe(true);

  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all(waiting);

  // 名额已归还：下一次调用重新进入挂起，而不是继续走立即拒绝。
  const call = handler('approve-tool')({}, { mcpReq: { signal } });
  await vi.advanceTimersByTimeAsync(0);
  expect(onApprovalRequired).toHaveBeenLastCalledWith('approve-tool', expect.any(Date));
  await vi.advanceTimersByTimeAsync(1000);
  await call;
});

it('never calls upstream for a call cancelled while queued for the execution pool', async () => {
  const slots = Array.from({ length: 4 }, () => deferred<Response>());
  const fetchSpy = vi.fn(() => slots[fetchSpy.mock.calls.length - 1]?.promise ?? Promise.reject());
  vi.stubGlobal('fetch', fetchSpy);

  buildGeneratedServer({ ...baseInput, approvals: ['plain-tool'], isRunActive: async () => true });

  const controller = new AbortController();
  const activeCalls = Array.from({ length: 4 }, () =>
    handler('plain-tool')({}, { mcpReq: { signal: new AbortController().signal } }),
  );
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));

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
