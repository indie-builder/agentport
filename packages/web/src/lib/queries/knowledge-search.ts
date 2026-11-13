import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  type KnowledgeRetrievalEvaluationInput,
  type KnowledgeSearchOptions,
  type KnowledgeSearchResponse,
} from '../api.js';
import { knowledgeKeys } from './shared.js';

export function useKnowledgeSearch(baseId: string, options: KnowledgeSearchOptions) {
  const term = options.q.trim();
  return useQuery<KnowledgeSearchResponse>({
    queryKey: knowledgeKeys.search(baseId, { ...options, q: term }),
    queryFn: ({ signal }) => api.knowledgeSearch(baseId, { ...options, q: term }, signal),
    enabled: term.length > 0,
    staleTime: 10_000,
  });
}

export function useEvaluateKnowledgeRetrieval(baseId: string) {
  return useMutation({
    mutationFn: (input: KnowledgeRetrievalEvaluationInput) =>
      api.evaluateKnowledgeRetrieval(baseId, input),
  });
}
