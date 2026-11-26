import type { CursorPage } from '@agentport/shared';
import {
  type InfiniteData,
  type Query,
  QueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { useEffect } from 'react';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

export function useCursorList<
  TPage extends CursorPage<unknown>,
  TData = InfiniteData<TPage, string | undefined>,
>(options: {
  queryKey: readonly unknown[];
  queryFn: (cursor: string | undefined, signal: AbortSignal) => Promise<TPage>;
  enabled?: boolean | undefined;
  staleTime?: number | undefined;
  refetchInterval?:
    | number
    | false
    | ((
        query: Query<TPage, Error, InfiniteData<TPage, string | undefined>>,
      ) => number | false | undefined)
    | undefined;
  refetchIntervalInBackground?: boolean | undefined;
  select?: ((data: InfiniteData<TPage, string | undefined>) => TData) | undefined;
}) {
  return useInfiniteQuery({
    queryKey: options.queryKey,
    queryFn: ({ pageParam, signal }) => options.queryFn(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
    ...(options.refetchIntervalInBackground === undefined
      ? {}
      : { refetchIntervalInBackground: options.refetchIntervalInBackground }),
    ...(options.select === undefined ? {} : { select: options.select }),
  });
}

export function useDrainPages(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}
