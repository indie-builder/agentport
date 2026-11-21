import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, type RunDetail, type RunStatus } from '../src/lib/api.js';
import { useCancelRun, useRun, useRuns } from '../src/lib/queries.js';

const at = '2026-10-28T00:00:00Z';

function detail(status: RunStatus): RunDetail {
  return {
    run: {
      id: 'r1',
      agentId: 'agent-1',
      agentName: '专家',
      status,
      startedAt: at,
      endedAt: status === 'running' ? null : at,
      latencyMs: 1000,
      turns: 1,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: null,
      conversationId: 'c1',
      initiatedBy: null,
      sessionId: null,
      sandboxId: null,
      runtimeEnvironment: null,
    },
    steps: [],
    conversation: { id: 'c1', agentId: 'agent-1', title: '会话' },
  };
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
let cancel: ReturnType<typeof useCancelRun>;

function Probe() {
  useRun('r1');
  useRuns();
  cancel = useCancelRun();
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  vi.spyOn(api, 'cancelRun').mockResolvedValue(undefined);
  vi.spyOn(api, 'run')
    .mockResolvedValueOnce(detail('running'))
    .mockResolvedValue(detail('succeeded'));
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [] });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

test('取消运行后刷新该运行详情与运行列表', async () => {
  expect(api.run).toHaveBeenCalledTimes(1);
  expect(api.runs).toHaveBeenCalledTimes(1);

  await act(async () => {
    await cancel.mutateAsync('r1');
  });

  expect(api.cancelRun).toHaveBeenCalledWith('r1');
  await vi.waitFor(() => expect(api.run).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(api.runs).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(client.getQueryData<RunDetail>(['run', 'r1'])?.run.status).toBe('succeeded'),
  );
});
