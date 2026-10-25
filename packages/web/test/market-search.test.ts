import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 市场搜索的请求防抖：连续输入只发最后一次，而不是每个字符都打一次 skills.sh。 */

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useInfiniteQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock('@tanstack/react-query', () => ({
  QueryClient: class {},
  queryOptions: (options: unknown) => options,
  useQuery: mocks.useQuery,
  useInfiniteQuery: mocks.useInfiniteQuery,
  useMutation: mocks.useMutation,
  useQueryClient: mocks.useQueryClient,
}));

vi.mock('../src/lib/api.js', () => ({
  api: { marketSkills: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { useMarketSkills } from '../src/lib/queries.js';

interface MarketOptions {
  queryKey: unknown[];
  enabled: boolean;
}

function options(): MarketOptions {
  return mocks.useQuery.mock.calls.at(-1)?.[0] as MarketOptions;
}

let setQuery: (value: string) => void;

function Probe() {
  const [query, set] = useState('');
  setQuery = set;
  useMarketSkills('all-time', query);
  return null;
}

async function type(value: string): Promise<void> {
  await act(async () => setQuery(value));
}

function keys(): unknown[][] {
  const calls = mocks.useQuery.mock.calls.map((call) => (call[0] as MarketOptions).queryKey);
  // 重渲染会重复调用 hook，只保留真正变化的查询键。
  return calls.filter(
    (key, index) => index === 0 || JSON.stringify(key) !== JSON.stringify(calls[index - 1]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.useQuery.mockReset();
  mocks.useQuery.mockReturnValue({ data: undefined });
});

afterEach(() => vi.useRealTimers());

describe('market search debounce', () => {
  it('sends one request with the final term after rapid typing', async () => {
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    expect(keys()).toEqual([['market-skills', 'all-time', '']]);

    await type('p');
    await type('pd');
    await type('pdf');
    expect(keys()).toEqual([['market-skills', 'all-time', '']]);

    await act(async () => vi.advanceTimersByTime(300));
    expect(keys()).toEqual([
      ['market-skills', 'all-time', ''],
      ['market-skills', 'all-time', 'pdf'],
    ]);
    await act(async () => root.unmount());
  });

  it('keeps the existing minimum length rule on the settled term', async () => {
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Probe)));
    await type('p');
    await act(async () => vi.advanceTimersByTime(300));
    expect(options().enabled).toBe(false);
    await act(async () => root.unmount());
  });
});
