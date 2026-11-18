import type { SearchResponse } from '@agentport/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../api.js';

export const searchQuery = (q: string, limit: number) => {
  const normalized = q.trim().slice(0, 128);
  return queryOptions<SearchResponse>({
    queryKey: ['search', normalized, limit],
    queryFn: ({ signal }) => api.search({ q: normalized, limit }, signal),
    enabled: normalized.length > 0,
    staleTime: 15_000,
  });
};
