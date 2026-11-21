import type {
  AgentMemoryAssembly,
  AgentMemoryOverview,
  CreateMemoryReviewInput,
  MemoryChange,
  MemoryFileContent,
  MemoryFileList,
  MemoryPolicy,
  MemoryReview,
  MemoryReviewTarget,
  PersonalMemory,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { agentKeys } from './agents.js';
import { useCursorList } from './shared.js';

export const agentMemoryKeys = {
  list: (...ids: [] | [string]) => ['agent-memory', ...ids] as const,
  file: (...parts: [] | [string] | [string, string]) => ['agent-memory-file', ...parts] as const,
  overview: (id: string) => ['agent-memory', id, 'overview'] as const,
  assembly: (id: string) => ['agent-memory', id, 'assembly'] as const,
};

export const agentMemoryQuery = (id: string) =>
  queryOptions<MemoryFileList>({
    queryKey: agentMemoryKeys.list(id),
    queryFn: () => api.agentMemory(id),
  });

export const agentMemoryOverviewQuery = (id: string) =>
  queryOptions<AgentMemoryOverview>({
    queryKey: agentMemoryKeys.overview(id),
    queryFn: () => api.agentMemoryOverview(id),
  });

export const agentMemoryAssemblyQuery = (id: string) =>
  queryOptions<AgentMemoryAssembly>({
    queryKey: agentMemoryKeys.assembly(id),
    queryFn: () => api.agentMemoryAssembly(id),
  });

export function useUpdateAgentMemoryPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; policy: MemoryPolicy }) =>
      api.updateAgentMemoryPolicy(vars.agentId, vars.policy),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: agentMemoryKeys.overview(vars.agentId) });
      void client.invalidateQueries({ queryKey: agentMemoryKeys.assembly(vars.agentId) });
    },
  });
}

export const agentMemoryFileQuery = (id: string, name: string) =>
  queryOptions<MemoryFileContent>({
    queryKey: agentMemoryKeys.file(id, name),
    queryFn: () => api.agentMemoryFile(id, name),
  });

const personalMemoryQuery = queryOptions<PersonalMemory>({
  queryKey: ['personal-memory'],
  queryFn: () => api.personalMemory(),
  staleTime: 0,
});

export const memoryVersionsQuery = (target: MemoryReviewTarget, enabled = true) =>
  queryOptions<{ items: MemoryChange[]; nextCursor: string | null }>({
    queryKey: ['memory-versions', target],
    queryFn: ({ signal }) => {
      if (target.kind === 'personal') return api.personalMemoryVersions({}, signal);
      if (target.kind === 'agent_memory')
        return api.agentMemoryVersions(target.agentId, target.name, signal);
      return api.agentRuleVersions(target.agentId, target.slug, signal);
    },
    enabled,
    staleTime: 0,
  });

export function usePersonalMemory() {
  return useQuery(personalMemoryQuery);
}

export function usePersonalMemoryVersions() {
  return useQuery(memoryVersionsQuery({ kind: 'personal' }));
}

export function useSavePersonalMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; expectedRevision: number }) =>
      api.writePersonalMemory(input),
    onSuccess: (saved) => {
      client.setQueryData(personalMemoryQuery.queryKey, saved);
      void client.invalidateQueries({ queryKey: personalMemoryQuery.queryKey });
      void client.invalidateQueries({ queryKey: ['memory-versions'] });
    },
  });
}

function invalidateMemoryContent(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: personalMemoryQuery.queryKey });
  void client.invalidateQueries({ queryKey: ['memory-versions'] });
  void client.invalidateQueries({ queryKey: agentMemoryKeys.list() });
  void client.invalidateQueries({ queryKey: agentMemoryKeys.file() });
  void client.invalidateQueries({ queryKey: agentKeys.rulesAll });
}

export function useRollbackMemoryChange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (changeId: string) => api.rollbackMemoryChange(changeId),
    onSuccess: () => {
      invalidateMemoryContent(client);
      invalidateMemoryReviews(client);
    },
  });
}

const memoryReviewKey = (agentId: string | null) => ['memory-reviews', agentId] as const;

function memoryReviewActive(review: MemoryReview): boolean {
  return review.status === 'queued' || review.status === 'running';
}

const MEMORY_REVIEWS_PAGE_SIZE = 50;

export function useMemoryReviews(agentId: string | null) {
  return useCursorList({
    queryKey: memoryReviewKey(agentId),
    queryFn: (cursor, signal) =>
      api.memoryReviews(
        {
          ...(agentId ? { agentId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: MEMORY_REVIEWS_PAGE_SIZE,
        },
        signal,
      ),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some(memoryReviewActive)) ? 3_000 : false,
  });
}

function invalidateMemoryReviews(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: ['memory-reviews'] });
  void client.invalidateQueries({ queryKey: ['memory-review'] });
}

export const memoryReviewQuery = (runId: string) =>
  queryOptions<MemoryReview>({
    queryKey: ['memory-review', runId],
    queryFn: ({ signal }) => api.memoryReview(runId, signal),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data && memoryReviewActive(query.state.data) ? 3_000 : false,
  });

export function useMemoryReview(runId: string | null) {
  return useQuery({
    ...memoryReviewQuery(runId ?? ''),
    enabled: runId !== null,
  });
}

export function useCreateMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { input: CreateMemoryReviewInput; idempotencyKey: string }) =>
      api.createMemoryReview(vars.input, vars.idempotencyKey, 'own'),
    onSuccess: () => invalidateMemoryReviews(client),
  });
}

export function useApplyMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.applyMemoryReview(runId),
    onSuccess: () => {
      invalidateMemoryReviews(client);
      invalidateMemoryContent(client);
    },
  });
}

export function useRejectMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.rejectMemoryReview(runId),
    onSuccess: () => {
      invalidateMemoryReviews(client);
      invalidateMemoryContent(client);
    },
  });
}

export function useCancelMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: () => invalidateMemoryReviews(client),
  });
}
