import { beforeEach, expect, test, vi } from 'vitest';

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
  queryFn: (context: { pageParam: string | undefined; signal: AbortSignal }) => Promise<AuditList>;
  initialPageParam: string | undefined;
  getNextPageParam: (
    last: AuditList,
    pages: AuditList[],
    pageParam: string | undefined,
  ) => string | undefined;
}

function useQueryOptions(query = {}): AuditOptions {
  mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  useAudit(query);
  return mocks.useInfiniteQuery.mock.calls.at(-1)?.[0] as AuditOptions;
}

function entry(id: string, createdAt = '2026-01-01T00:00:00.000Z'): AuditEntry {
  return {
    id,
    actor: 'admin',
    actorKind: 'user',
    subjectBusinessId: null,
    action: 'agent.create',
    target: null,
    status: 'ok',
    durationMs: null,
    requestId: null,
    inputDigest: null,
    detail: null,
    detailType: null,
    createdAt,
  };
}

function page(entries: AuditEntry[], nextCursor: string | null = null): AuditList {
  return { items: entries, nextCursor };
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
  expect(useQueryOptions().initialPageParam).toBeUndefined();
});

test('首屏用筛选条件请求，不带游标', async () => {
  const query = { target: 'agent:1' };
  mocks.audit.mockResolvedValue(page([entry('e1')]));
  await useQueryOptions(query).queryFn({
    pageParam: undefined,
    signal: new AbortController().signal,
  });
  expect(mocks.audit).toHaveBeenCalledWith({ ...query, limit: 100 }, expect.any(AbortSignal));
});

test('把查询的取消信号交给请求，离开页面时能中止在途分页', async () => {
  const signal = new AbortController().signal;
  mocks.audit.mockResolvedValue(page([entry('e1')]));
  await useQueryOptions().queryFn({ pageParam: undefined, signal });
  expect(mocks.audit).toHaveBeenCalledWith({ limit: 100 }, signal);
});

test('后续页用服务端 nextCursor，不再用时间戳', async () => {
  mocks.audit.mockResolvedValue(page([entry('e2')]));
  await useQueryOptions().queryFn({ pageParam: 'e1', signal: new AbortController().signal });
  expect(mocks.audit).toHaveBeenCalledWith({ limit: 100, cursor: 'e1' }, expect.any(AbortSignal));
});

test('按服务端 nextCursor 翻页，null 表示结束', () => {
  const options = useQueryOptions();
  const full = page(
    Array.from({ length: 100 }, (_, index) => entry(`e${index}`)),
    'e99',
  );
  expect(options.getNextPageParam(full, [full], undefined)).toBe('e99');

  const last = page(Array.from({ length: 100 }, (_, index) => entry(`n${index}`)));
  expect(options.getNextPageParam(last, [full, last], 'e99')).toBeUndefined();
  expect(options.getNextPageParam(page([]), [page([])], undefined)).toBeUndefined();
});
