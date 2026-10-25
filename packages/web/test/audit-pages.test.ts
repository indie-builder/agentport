import { beforeEach, expect, test, vi } from 'vitest';

/**
 * useAudit 的分页配置测试：直接调用真实 hook，捕获它交给 useInfiniteQuery 的配置，
 * 再用真实数据形状求值 queryFn / getNextPageParam，不另写一份判定逻辑。
 */

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useInfiniteQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  audit: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  QueryClient: class {},
  queryOptions: (options: unknown) => options,
  useQuery: mocks.useQuery,
  useMutation: mocks.useMutation,
  useInfiniteQuery: mocks.useInfiniteQuery,
  useQueryClient: mocks.useQueryClient,
}));

vi.mock('../src/lib/api.js', () => ({
  api: { audit: mocks.audit },
  ApiError: class ApiError extends Error {},
}));

import type { AuditEntry, AuditList } from '../src/lib/api.js';
import { useAudit } from '../src/lib/queries.js';

interface AuditOptions {
  queryKey: unknown[];
  queryFn: (context: { pageParam: string | null; signal: AbortSignal }) => Promise<AuditList>;
  initialPageParam: string | null;
  getNextPageParam: (
    last: AuditList,
    pages: AuditList[],
    pageParam: string | null,
  ) => string | undefined;
}

// biome 只允许 hook 在 hook/组件里调用，因此测试助手按 hook 命名。
function useQueryOptions(query = {}): AuditOptions {
  mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  useAudit(query);
  return mocks.useInfiniteQuery.mock.calls.at(-1)?.[0] as AuditOptions;
}

function entry(id: string, createdAt = '2026-01-01T00:00:00.000Z'): AuditEntry {
  return {
    id,
    actor: 'admin',
    action: 'agent.create',
    target: null,
    status: 'ok',
    durationMs: null,
    requestId: null,
    inputDigest: null,
    createdAt,
  };
}

function page(entries: AuditEntry[]): AuditList {
  return { items: entries };
}

beforeEach(() => {
  mocks.useInfiniteQuery.mockReset();
  mocks.audit.mockReset();
});

test('查询键保留过滤条件，分页游标不进入键', () => {
  expect(useQueryOptions({ action: 'agent.', status: 'ok' }).queryKey).toEqual([
    'audit',
    { action: 'agent.', status: 'ok' },
  ]);
  expect(useQueryOptions().initialPageParam).toBeNull();
});

test('首屏用筛选条件请求，不带游标', async () => {
  const query = { target: 'agent:1' };
  mocks.audit.mockResolvedValue(page([entry('e1')]));
  await useQueryOptions(query).queryFn({ pageParam: null, signal: new AbortController().signal });
  expect(mocks.audit).toHaveBeenCalledWith({ ...query, limit: 100 }, expect.any(AbortSignal));
});

test('把查询的取消信号交给请求，离开页面时能中止在途分页', async () => {
  const signal = new AbortController().signal;
  mocks.audit.mockResolvedValue(page([entry('e1')]));
  await useQueryOptions().queryFn({ pageParam: null, signal });
  expect(mocks.audit).toHaveBeenCalledWith({ limit: 100 }, signal);
});

test('后续页用 id 游标，不再用时间戳', async () => {
  mocks.audit.mockResolvedValue(page([entry('e2')]));
  await useQueryOptions().queryFn({ pageParam: 'e1', signal: new AbortController().signal });
  expect(mocks.audit).toHaveBeenCalledWith({ limit: 100, beforeId: 'e1' }, expect.any(AbortSignal));
});

test('满页时即使时间戳相同也继续按 id 翻页', () => {
  const options = useQueryOptions();
  const full = page(Array.from({ length: 100 }, (_, index) => entry(`e${index}`)));
  expect(options.getNextPageParam(full, [full], null)).toBe('e99');
  // 上一页与下一页的边界时间戳相同，旧的时间戳游标会在这里停住。
  const next = page(Array.from({ length: 100 }, (_, index) => entry(`n${index}`)));
  expect(options.getNextPageParam(next, [full, next], 'e99')).toBe('n99');
});

test('不满一页视为结束', () => {
  const options = useQueryOptions();
  const short = page(Array.from({ length: 99 }, (_, index) => entry(`e${index}`)));
  expect(options.getNextPageParam(short, [short], null)).toBeUndefined();
  expect(options.getNextPageParam(page([]), [page([])], null)).toBeUndefined();
});

test('游标重复时停止，避免重复页死循环', () => {
  const options = useQueryOptions();
  const full = page(Array.from({ length: 100 }, (_, index) => entry(`e${index}`)));
  expect(options.getNextPageParam(full, [full], 'e99')).toBeUndefined();
});
