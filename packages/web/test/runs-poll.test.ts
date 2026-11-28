import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type RunList, type RunQuery, type RunStatus } from '../src/lib/api.js';
import { useRuns } from '../src/lib/queries.js';

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

function runPage(statuses: RunStatus[]): RunList {
  return {
    items: statuses.map((status, index) => ({
      id: `r${index}`,
      agentId: 'a1',
      agentName: null,
      status,
      trigger: 'chat',
      startedAt: null,
      endedAt: null,
      costUsd: null,
      turns: null,
      latencyMs: null,
      error: null,
      inputTokens: null,
      outputTokens: null,
    })),
    nextCursor: null,
  };
}

function runsReads(): number {
  return vi.mocked(api.runs).mock.calls.length;
}

function Probe({ query = {} }: { query?: RunQuery }) {
  useRuns(query);
  return null;
}

async function mount(query: RunQuery = {}) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe, { query })));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.spyOn(api, 'runs').mockResolvedValue(runPage([]));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useRuns polling and filtering', () => {
  it('forwards filters to api.runs and separates cache entries by filter', async () => {
    await mount({ agentId: 'a1', status: 'failed', limit: 20 });
    expect(api.runs).toHaveBeenLastCalledWith(
      { agentId: 'a1', status: 'failed', limit: 20 },
      expect.any(AbortSignal),
    );
    expect(client.getQueryData(['runs', 'a1', 'failed', null, null, 20])).toBeDefined();

    await mount({ limit: 50 });
    expect(api.runs).toHaveBeenLastCalledWith({ limit: 50 }, expect.any(AbortSignal));
    expect(client.getQueryData(['runs', null, null, null, null, 50])).toBeDefined();
    expect(runsReads()).toBe(2);
  });

  it('polls every 5 seconds while queued or running and stops once all runs finish', async () => {
    vi.mocked(api.runs)
      .mockResolvedValueOnce(runPage(['queued']))
      .mockResolvedValueOnce(runPage(['running']))
      .mockResolvedValueOnce(runPage(['succeeded', 'running', 'failed']))
      .mockResolvedValue(runPage(['succeeded', 'failed', 'cancelled', 'timeout']));

    await mount({ limit: 50 });
    expect(runsReads()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(runsReads()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(runsReads()).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(runsReads()).toBe(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(runsReads()).toBe(4);
  });

  it('does not poll when the list is empty or unavailable', async () => {
    vi.mocked(api.runs).mockResolvedValue(runPage([]));
    await mount({ limit: 50 });
    expect(runsReads()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(runsReads()).toBe(1);

    vi.mocked(api.runs).mockRejectedValueOnce(new Error('offline'));
    await mount({ agentId: 'a2', limit: 50 });
    expect(runsReads()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(runsReads()).toBe(2);
  });
});
