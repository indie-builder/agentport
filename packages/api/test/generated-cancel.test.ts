import type { ApiTool } from '@agentport/shared';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildGeneratedServer } from '../src/features/servers/generated.js';
import { assertSafeUrl } from '../src/features/servers/ssrf.js';

/** 工具 handler 的第二个参数：run 取消时 SDK 通过它传 abort signal。 */
type ToolContext = { mcpReq: { signal: AbortSignal } };
type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;

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

const ssrfMock = vi.mocked(assertSafeUrl);

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

/** 取消类结果：不能再落到旧的超时文案，模型要能区分「人取消了」与「等超时了」。 */
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mcp.handlers.clear();
});

it('cancels the suspended call when the run ends before approval, without touching upstream', async () => {
  vi.useFakeTimers({ now: 0 });
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

  let active = true;
  let approvals: string[] = [];
  const onApprovalRequired = vi.fn(async () => undefined);

  buildGeneratedServer({
    ...baseInput,
    approvals,
    isRunActive: async () => active,
    refreshApprovals: async () => approvals,
    onApprovalRequired,
  });

  const call = callTool(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(onApprovalRequired).toHaveBeenCalledTimes(1);

  // 取消发生在等待窗口内：run 结束，随后即使出现批准记录也不再执行。
  active = false;
  approvals = ['approve-tool'];
  await vi.advanceTimersByTimeAsync(500);

  expectCancelled(await call);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('cancels immediately when the request signal aborts during the wait', async () => {
  vi.useFakeTimers({ now: 0 });
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

  const controller = new AbortController();
  const onApprovalRequired = vi.fn(async () => undefined);
  buildGeneratedServer({
    ...baseInput,
    isRunActive: async () => true,
    refreshApprovals: async () => [],
    onApprovalRequired,
  });

  const call = callTool(controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(500);

  // 截止时刻是 1000ms：500ms 就返回说明是取消，不是超时。
  expectCancelled(await call);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('refuses an already approved tool when the run is no longer active', async () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error('upstream must not be called for an ended run');
  });
  vi.stubGlobal('fetch', fetchSpy);

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
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

  const controller = new AbortController();
  buildGeneratedServer({
    ...baseInput,
    approvals: ['approve-tool'],
    isRunActive: async () => true,
  });

  const call = callTool(controller.signal);
  await vi.waitFor(() => expect(ssrfMock).toHaveBeenCalledTimes(1));
  controller.abort();
  gate.resolve();

  expectCancelled(await call);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each([0, 1000])(
  'does not create an approval after cancellation during a status read (%i ms)',
  async (approvalWaitMs) => {
    const controller = new AbortController();
    const onApprovalRequired = vi.fn(async () => undefined);
    let reads = 0;
    buildGeneratedServer({
      ...baseInput,
      approvalWaitMs,
      isRunActive: async () => {
        reads += 1;
        if (reads === (approvalWaitMs === 0 ? 1 : 2)) controller.abort();
        return true;
      },
      onApprovalRequired,
    });
    expectCancelled(await callTool(controller.signal));
    expect(onApprovalRequired).not.toHaveBeenCalled();
  },
);

it('still calls upstream for an active run with approval', async () => {
  const fetchSpy = vi.fn(async () => new Response('ok'));
  vi.stubGlobal('fetch', fetchSpy);

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
