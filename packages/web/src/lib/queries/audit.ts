import { useInfiniteQuery } from '@tanstack/react-query';
import { type AuditQuery, api } from '../api.js';

const AUDIT_PAGE_SIZE = 100;

export function useAudit(query: Omit<AuditQuery, 'before' | 'beforeId' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam, signal }) =>
      api.audit(
        {
          ...query,
          limit: AUDIT_PAGE_SIZE,
          ...(pageParam === null ? {} : { beforeId: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last, _pages, beforeId) => {
      if (last.items.length < AUDIT_PAGE_SIZE) return undefined;
      const next = last.items.at(-1)?.id;
      return next === undefined || next === beforeId ? undefined : next;
    },
    staleTime: 0,
  });
}
