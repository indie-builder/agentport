import { beforeEach, expect, test, vi } from 'vitest';

/**
 * useRuns 的轮询配置测试：直接调用真实 hook，捕获它交给 useQuery 的配置，
 * 再用真实数据形状求值 refetchInterval，不另写一份判定逻辑。
 */

const rq = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useInfiniteQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock('@tanstack/react-query', () => ({
  QueryClient: class {},
  queryOptions: (options: unknown) => options,
  useQuery: rq.useQuery,
  useMutation: rq.useMutation,
  useInfiniteQuery: rq.useInfiniteQuery,
  useQueryClient: rq.useQueryClient,
}));

vi.mock('../src/lib/api.js', () => ({
  api: {},
  ApiError: class ApiError extends Error {},
}));

import type { RunList, RunQuery, RunStatus } from '../src/lib/api.js';
import { useRuns } from '../src/lib/queries.js';

interface RunsOptions {
  queryKey: unknown[];
  refetchInterval: (query: { state: { data?: RunList } }) => number | false;
}

function capture(): RunsOptions {
  return rq.useQuery.mock.calls.at(-1)?.[0] as RunsOptions;
}

// biome 只允许 hook 在 hook/组件里调用，因此这个测试助手按 hook 命名。
function useDefaultOptions(query: RunQuery = {}): RunsOptions {
  rq.useQuery.mockReturnValue({ data: undefined });
  useRuns(query);
  return capture();
}

function usePollInterval(statuses: RunStatus[]): number | false {
  const data: RunList = {
    items: statuses.map((status, index) => ({
      id: `r${index}`,
      agentId: 'a1',
      agentName: null,
      status,
      startedAt: null,
      endedAt: null,
      costUsd: null,
      turns: null,
      latencyMs: null,
      error: null,
      inputTokens: null,
      outputTokens: null,
    })),
  };
  return useDefaultOptions({ limit: 50 }).refetchInterval({ state: { data } });
}

beforeEach(() => {
  rq.useQuery.mockReset();
});

test('查询键保留过滤条件', () => {
  expect(useDefaultOptions({ agentId: 'a1', status: 'failed', limit: 20 }).queryKey).toEqual([
    'runs',
    'a1',
    'failed',
    20,
  ]);
  expect(useDefaultOptions({ limit: 50 }).queryKey).toEqual(['runs', null, null, 50]);
});

test('有 queued/running 时每 5 秒轮询，全部结束后停止', () => {
  expect(usePollInterval(['queued'])).toBe(5_000);
  expect(usePollInterval(['running'])).toBe(5_000);
  expect(usePollInterval(['succeeded', 'running', 'failed'])).toBe(5_000);
  expect(usePollInterval(['succeeded', 'failed', 'cancelled', 'timeout'])).toBe(false);
  expect(usePollInterval([])).toBe(false);
  expect(useDefaultOptions().refetchInterval({ state: {} })).toBe(false);
});
