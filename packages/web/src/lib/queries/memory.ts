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
import { useCursorList } from './client.js';

export const agentMemoryKeys = {
  list: (...ids: [] | [string]) => ['agent-memory', ...ids] as const,
  file: (...parts: [] | [string] | [string, string]) => ['agent-memory-file', ...parts] as const,
  overview: (id: string) => ['agent-memory', id, 'overview'] as const,
  assembly: (id: string) => ['agent-memory', id, 'assembly'] as const,
};

export const memoryKeys = {
  personal: ['personal-memory'] as const,
  versions: (target: MemoryReviewTarget) => ['memory-versions', target] as const,
  versionsAll: ['memory-versions'] as const,
  reviews: (agentId: string | null) => ['memory-reviews', agentId] as const,
  reviewsAll: ['memory-reviews'] as const,
  review: (runId: string) => ['memory-review', runId] as const,
  reviewAll: ['memory-review'] as const,
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
  queryKey: memoryKeys.personal,
  queryFn: () => api.personalMemory(),
  staleTime: 0,
});

export const memoryVersionsQuery = (target: MemoryReviewTarget, enabled = true) =>
  queryOptions<{ items: MemoryChange[]; nextCursor: string | null }>({
    queryKey: memoryKeys.versions(target),
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
      void client.invalidateQueries({ queryKey: memoryKeys.versionsAll });
    },
  });
}

function invalidateMemoryContent(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: personalMemoryQuery.queryKey });
  void client.invalidateQueries({ queryKey: memoryKeys.versionsAll });
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

function memoryReviewActive(review: MemoryReview): boolean {
  return review.status === 'queued' || review.status === 'running';
}

const MEMORY_REVIEWS_PAGE_SIZE = 50;

export function useMemoryReviews(agentId: string | null) {
  return useCursorList({
    queryKey: memoryKeys.reviews(agentId),
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
  void client.invalidateQueries({ queryKey: memoryKeys.reviewsAll });
  void client.invalidateQueries({ queryKey: memoryKeys.reviewAll });
}

export const memoryReviewQuery = (runId: string) =>
  queryOptions<MemoryReview>({
    queryKey: memoryKeys.review(runId),
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

function invalidateAgentMemoryQueries(
  client: ReturnType<typeof useQueryClient>,
  agentId: string,
): void {
  void client.invalidateQueries({ queryKey: agentMemoryKeys.list(agentId) });
  void client.invalidateQueries({ queryKey: agentMemoryKeys.file(agentId) });
  void client.invalidateQueries({ queryKey: memoryKeys.versionsAll });
  void client.invalidateQueries({ queryKey: memoryKeys.reviewsAll });
}

export function useWriteAgentMemoryFile(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; content: string }) =>
      api.writeAgentMemoryFile(agentId, vars.name, vars.content),
    onSuccess: (file) => {
      client.setQueryData(agentMemoryFileQuery(agentId, file.name).queryKey, file);
      invalidateAgentMemoryQueries(client, agentId);
    },
  });
}

export function useDeleteAgentMemoryFile(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fileName: string) => api.deleteAgentMemoryFile(agentId, fileName),
    onSuccess: (_data, fileName) => {
      client.removeQueries({ queryKey: agentMemoryKeys.file(agentId, fileName) });
      invalidateAgentMemoryQueries(client, agentId);
    },
  });
}

export function useWriteAgentRule(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; content: string; globs: string }) =>
      api.writeAgentRule(agentId, vars.slug, { content: vars.content, globs: vars.globs }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.rules(agentId) });
    },
  });
}

export function useDeleteAgentRule(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.deleteAgentRule(agentId, slug),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.rules(agentId) });
    },
  });
}

export function useWriteAgentOutputStyle(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      slug: string;
      description: string;
      keepCodingInstructions: boolean;
      body: string;
    }) =>
      api.writeAgentOutputStyle(agentId, vars.slug, {
        description: vars.description,
        keepCodingInstructions: vars.keepCodingInstructions,
        body: vars.body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.outputStyles(agentId) });
    },
  });
}

export function useUnselectAgentOutputStyle(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.unselectAgentOutputStyle(agentId, slug),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.outputStyles(agentId) });
    },
  });
}

export function useDeleteAgentOutputStyle(agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.deleteAgentOutputStyle(agentId, slug),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: agentKeys.outputStyles(agentId) });
    },
  });
}
