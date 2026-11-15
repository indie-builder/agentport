import { useInfiniteQuery } from '@tanstack/react-query';
import { type AuditQuery, api } from '../api.js';

const AUDIT_PAGE_SIZE = 100;

export function useAudit(query: Omit<AuditQuery, 'before' | 'cursor' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam, signal }) =>
      api.audit(
        {
          ...query,
          limit: AUDIT_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  });
}
