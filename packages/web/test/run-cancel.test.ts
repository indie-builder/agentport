import { beforeEach, expect, test, vi } from 'vitest';

/** useCancelRun 的接线测试：mutation 指向 api.cancelRun，成功后只失效该 run 与列表。 */

const mocks = vi.hoisted(() => {
  const invalidateQueries = vi.fn();
  return {
    invalidateQueries,
    cancelRun: vi.fn(),
    useQuery: vi.fn(),
    useMutation: vi.fn(),
    useInfiniteQuery: vi.fn(),
    useQueryClient: vi.fn(() => ({ invalidateQueries })),
  };
});

vi.mock('@tanstack/react-query', () => ({
  QueryClient: class {},
  queryOptions: (options: unknown) => options,
  useQuery: mocks.useQuery,
  useMutation: mocks.useMutation,
  useInfiniteQuery: mocks.useInfiniteQuery,
  useQueryClient: mocks.useQueryClient,
}));

vi.mock('../src/lib/api.js', () => ({ api: { cancelRun: mocks.cancelRun } }));

import { useCancelRun } from '../src/lib/queries.js';

function useCancelOptions() {
  mocks.useMutation.mockReturnValue({});
  useCancelRun();
  return mocks.useMutation.mock.calls.at(-1)?.[0] as {
    mutationFn: (runId: string) => Promise<void>;
    onSuccess: (data: undefined, runId: string) => void;
  };
}

beforeEach(() => {
  mocks.useMutation.mockReset();
  mocks.cancelRun.mockReset();
  mocks.invalidateQueries.mockReset();
});

test('mutationFn 用 run id 调用 api.cancelRun', async () => {
  const options = useCancelOptions();
  mocks.cancelRun.mockResolvedValue(undefined);
  await options.mutationFn('r1');
  expect(mocks.cancelRun).toHaveBeenCalledWith('r1');
});

test('成功后失效该 run 明细与 runs 列表', () => {
  useCancelOptions().onSuccess(undefined, 'r1');
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['run', 'r1'] });
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['runs'] });
});
