import type {
  Agent,
  AgentBudgetStatus,
  AgentInput,
  AgentOptions,
  AgentPatch,
  CursorPage,
} from '@agentport/shared';
import {
  type InfiniteData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AgentAccess,
  type AgentFiles,
  type AgentListParams,
  type AgentMemberList,
  type AgentSummary,
  type AgentVersionDetail,
  type AgentVersionSummary,
  api,
} from '../api.js';
import { OVERVIEW_QUERY_KEY } from './overview.js';
import { runKeys } from './runs.js';
import { useCursorList, useInvalidate } from './shared.js';

export const AGENTS_QUERY_KEY = ['agents'] as const;
export const AGENT_OPTIONS_QUERY_KEY = ['agent-options'] as const;

export const agentKeys = {
  all: AGENTS_QUERY_KEY,
  browse: [...AGENTS_QUERY_KEY, 'list'] as const,
  options: AGENT_OPTIONS_QUERY_KEY,
  tags: ['agent-tags'] as const,
  detail: (id: string) => ['agent-detail', id] as const,
  stats: (agentId: string, days: number) => ['agent-stats', agentId, days] as const,
  budget: (agentId: string) => ['agent-budget', agentId] as const,
  access: (id: string | null) => ['agent-access', id] as const,
  members: (id: string | null) => ['agent-members', id] as const,
  files: (agentId: string | null) => ['agent-files', agentId] as const,
  filesAll: ['agent-files'] as const,
  versions: (agentId: string | null) => ['agent-versions', agentId] as const,
  version: (agentId: string, version: number) => ['agent-version', agentId, version] as const,
  rules: (id: string) => ['agent-rules', id] as const,
  rulesAll: ['agent-rules'] as const,
  outputStyles: (id: string) => ['agent-output-styles', id] as const,
  workflows: (id: string) => ['agent-workflows', id] as const,
  hooks: (id: string) => ['agent-hooks', id] as const,
};

type AgentPages = InfiniteData<CursorPage<AgentSummary>, string | undefined>;
type AgentReference = Awaited<ReturnType<typeof api.agentReference>>;

export const agentsQuery = queryOptions({
  queryKey: agentKeys.all,
  queryFn: ({ signal }) => api.agentReference(signal),
});

const agentTagsQuery = queryOptions<{ items: string[] }>({
  queryKey: agentKeys.tags,
  queryFn: () => api.agentTags(),
});

export const agentDetailQuery = (id: string, enabled = true) =>
  queryOptions<Agent>({
    queryKey: agentKeys.detail(id),
    queryFn: ({ signal }) => api.agent(id, signal),
    enabled,
    staleTime: 0,
  });

export const agentStatsQuery = (agentId: string, days: number) =>
  queryOptions({
    queryKey: agentKeys.stats(agentId, days),
    queryFn: () => api.agentStats(agentId, days),
    staleTime: 60_000,
  });

const agentBudgetQuery = (agentId: string, enabled = true) =>
  queryOptions<AgentBudgetStatus>({
    queryKey: agentKeys.budget(agentId),
    queryFn: () => api.agentBudget(agentId),
    enabled,
    staleTime: 30_000,
  });

const agentAccessQuery = (id: string | null) =>
  queryOptions<AgentAccess>({
    queryKey: agentKeys.access(id),
    queryFn: () => api.agentAccess(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

const agentMembersQuery = (id: string | null) =>
  queryOptions<AgentMemberList>({
    queryKey: agentKeys.members(id),
    queryFn: () => api.agentMembers(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

const agentOptionsQuery = queryOptions<AgentOptions>({
  queryKey: agentKeys.options,
  queryFn: api.agentOptions,
  staleTime: 60_000,
});

export function useAgentOptions(enabled = true) {
  return useQuery({ ...agentOptionsQuery, enabled });
}

export function useAgents() {
  return useQuery({ ...agentsQuery, select: (page) => page.items });
}

export function useAgentsTruncated() {
  return useQuery({ ...agentsQuery, select: (page) => page.truncated });
}

export function useAgentsBrowse(filters: Omit<AgentListParams, 'cursor' | 'limit'>) {
  return useCursorList({
    queryKey: [...agentKeys.browse, filters],
    queryFn: (cursor, signal) => api.agents({ ...filters, cursor }, signal),
    select: ({ pages }) => pages.flatMap(({ items }) => items.filter((agent) => !agent.isDefault)),
  });
}

export function useExperts() {
  return useQuery({
    ...agentsQuery,
    select: (page) => page.items.filter((agent) => !agent.isDefault),
  });
}

export function useAgentTags() {
  return useQuery(agentTagsQuery);
}

export function useSetAgentFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; favorite: boolean }) =>
      api.setAgentFavorite(vars.id, vars.favorite),
    onSuccess: (_result, vars) => {
      const update = (agent: AgentSummary) =>
        agent.id === vars.id ? { ...agent, isFavorite: vars.favorite } : agent;
      client.setQueryData(
        agentsQuery.queryKey,
        (old) => old && { ...old, items: old.items.map(update) },
      );
      client.setQueriesData<AgentPages>(
        { queryKey: agentKeys.browse },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({ ...page, items: page.items.map(update) })),
          },
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.tags });
    },
  });
}

function invalidateAgentLifecycle(client: QueryClient, id: string): void {
  void client.invalidateQueries({ queryKey: agentKeys.all });
  void client.invalidateQueries({ queryKey: agentKeys.tags });
  void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
  void client.invalidateQueries({ queryKey: agentKeys.detail(id) });
  void client.invalidateQueries({ queryKey: agentKeys.access(id) });
}

export function useArchiveAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveAgent(id),
    onSuccess: (_agent, id) => invalidateAgentLifecycle(client, id),
  });
}

export function useRestoreAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreAgent(id),
    onSuccess: (_agent, id) => invalidateAgentLifecycle(client, id),
  });
}

export function useAgentSummary(id: string | null) {
  return useQuery({
    ...agentsQuery,
    select: (page) => page.items.find((agent) => agent.id === id) ?? null,
  });
}

export function useAgentDetail(id: string | null, enabled = true) {
  return useQuery({ ...agentDetailQuery(id ?? '', enabled && id !== null) });
}

export function useAgentBudget(id: string | null, enabled = true) {
  return useQuery(agentBudgetQuery(id ?? '', enabled && id !== null));
}

export function useAgentAccess(id: string | null) {
  return useQuery(agentAccessQuery(id));
}

export function useAgentMembers(id: string | null) {
  return useQuery(agentMembersQuery(id));
}

export function useSetAgentMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      agentId: string;
      businessId: string;
      canUse: boolean;
      canMaintain: boolean;
    }) =>
      api.setAgentMember(vars.agentId, vars.businessId, {
        canUse: vars.canUse,
        canMaintain: vars.canMaintain,
      }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: agentKeys.members(vars.agentId) });
      const prev = client.getQueryData<AgentMemberList>(agentKeys.members(vars.agentId));
      if (prev) {
        client.setQueryData<AgentMemberList>(agentKeys.members(vars.agentId), (old) =>
          old
            ? {
                ...old,
                members: old.members.map((m) =>
                  m.businessId === vars.businessId
                    ? { ...m, canUse: vars.canUse, canMaintain: vars.canMaintain }
                    : m,
                ),
              }
            : old,
        );
      }
      return { prev };
    },
    onError: (_error, vars, ctx) => {
      if (ctx?.prev !== undefined) {
        client.setQueryData<AgentMemberList>(agentKeys.members(vars.agentId), ctx.prev);
      }
      void client.invalidateQueries({ queryKey: agentKeys.members(vars.agentId) });
    },
    onSuccess: (_member, vars) => {
      void client.invalidateQueries({ queryKey: agentKeys.members(vars.agentId) });
      void client.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useDeleteAgentMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; businessId: string }) =>
      api.deleteAgentMember(vars.agentId, vars.businessId),
    onSuccess: (_ok, vars) => {
      void client.invalidateQueries({ queryKey: agentKeys.members(vars.agentId) });
      void client.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}

export function useTransferAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; ownerBusinessId: string }) =>
      api.transferAgent(vars.agentId, vars.ownerBusinessId),
    onSuccess: (agent) => {
      client.setQueryData(agentKeys.detail(agent.id), agent);
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.access(agent.id) });
    },
  });
}

export function useAgentFiles(agentId: string | null, enabled = true) {
  return useQuery<AgentFiles>({
    queryKey: agentKeys.files(agentId),
    queryFn: () => api.agentFiles(agentId ?? ''),
    enabled: agentId !== null && enabled,
    staleTime: 0,
  });
}

export function useAgentVersions(agentId: string | null, enabled = true) {
  return useQuery<AgentVersionSummary[]>({
    queryKey: agentKeys.versions(agentId),
    queryFn: () => api.agentVersions(agentId ?? ''),
    enabled: agentId !== null && enabled,
    staleTime: 0,
  });
}

export function useAgentVersion(agentId: string, version: number, enabled: boolean) {
  return useQuery<AgentVersionDetail>({
    queryKey: agentKeys.version(agentId, version),
    queryFn: () => api.agentVersion(agentId, version),
    enabled,
  });
}

export function useRollbackAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; version: number }) => api.rollbackAgent(vars.id, vars.version),
    onSuccess: (result, { id }) => {
      if (result.kind === 'detail') client.setQueryData(agentKeys.detail(id), result.agent);
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.versions(id) });
      void client.invalidateQueries({ queryKey: agentKeys.filesAll });
      void client.invalidateQueries({ queryKey: agentKeys.detail(id) });
      void client.invalidateQueries({ queryKey: agentKeys.budget(id) });
    },
  });
}

export function usePublishAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; note?: string }) => api.publishAgent(vars.id, vars.note),
    onSuccess: (result) => {
      if (result.kind === 'detail')
        client.setQueryData(agentKeys.detail(result.agent.id), result.agent);
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.detail(result.agent.id) });
      void client.invalidateQueries({ queryKey: agentKeys.versions(result.agent.id) });
    },
  });
}

export function useOfflineAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.offlineAgent(id),
    onSuccess: (result) => {
      if (result.kind === 'detail')
        client.setQueryData(agentKeys.detail(result.agent.id), result.agent);
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.detail(result.agent.id) });
      void client.invalidateQueries({ queryKey: agentKeys.versions(result.agent.id) });
    },
  });
}

export function useTrialAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; prompt: string }) => api.trialAgent(vars.id, vars.prompt),
    onSuccess: () => void client.invalidateQueries({ queryKey: runKeys.all }),
  });
}

export function useCreateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AgentInput) => api.createAgent(input),
    onSuccess: () => {
      invalidate(agentKeys.all[0]);
      invalidate(agentKeys.tags[0]);
      invalidate(OVERVIEW_QUERY_KEY[0]);
    },
  });
}

export function useDuplicateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; slug: string; name: string }) =>
      api.duplicateAgent(vars.id, { slug: vars.slug, name: vars.name }),
    onSuccess: (agent) => {
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
      client.setQueryData(agentKeys.all, (prev: AgentReference | undefined) =>
        prev ? { ...prev, items: [...prev.items, agent] } : prev,
      );
    },
  });
}

export function useUpdateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: AgentPatch; expectedUpdatedAt?: string }) =>
      api.updateAgent(vars.id, vars.input, vars.expectedUpdatedAt),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: agentKeys.all });
      const previous = client.getQueryData<AgentReference>(agentKeys.all);
      client.setQueryData<AgentReference>(
        agentKeys.all,
        (old) =>
          old && {
            ...old,
            items: old.items.map((agent) => {
              if (agent.id !== id) return agent;
              const next = { ...agent, ...input };
              return {
                ...next,
                effort: next.effort ?? undefined,
              };
            }),
          },
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(agentKeys.all, context.previous);
    },
    onSettled: (_data, _error, vars) => {
      void client.invalidateQueries({ queryKey: agentKeys.all });
      void client.invalidateQueries({ queryKey: agentKeys.tags });
      void client.invalidateQueries({ queryKey: agentKeys.filesAll });
      void client.invalidateQueries({ queryKey: agentKeys.detail(vars.id) });
      void client.invalidateQueries({ queryKey: agentKeys.budget(vars.id) });
    },
  });
}

export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: (_data, id) => {
      client.setQueryData<AgentReference>(
        agentKeys.all,
        (old) => old && { ...old, items: old.items.filter((agent) => agent.id !== id) },
      );
      client.removeQueries({ queryKey: agentKeys.detail(id), exact: true });
      client.removeQueries({ queryKey: agentKeys.access(id), exact: true });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: agentKeys.all });
    },
  });
}
