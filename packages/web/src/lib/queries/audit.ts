import { type AuditQuery, api } from '../api.js';
import { useCursorList } from './shared.js';

const AUDIT_PAGE_SIZE = 100;

export function useAudit(query: Omit<AuditQuery, 'before' | 'cursor' | 'limit'>) {
  return useCursorList({
    queryKey: ['audit', query],
    queryFn: (cursor, signal) =>
      api.audit(
        {
          ...query,
          limit: AUDIT_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    staleTime: 0,
  });
}
