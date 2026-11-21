import type {
  Agent,
  AgentBudgetStatus,
  AgentInput,
  AgentOptions,
  AgentPatch,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useInvalidate } from './shared.js';

const listAgents = api.agents;

export const AGENTS_QUERY_KEY = ['agents'] as const;
export const AGENT_OPTIONS_QUERY_KEY = ['agent-options'] as const;

export const agentsQuery = queryOptions<AgentSummary[]>({
  queryKey: AGENTS_QUERY_KEY,
  queryFn: () => listAgents(),
});

const agentsListQuery = (options: AgentListParams) =>
  queryOptions<AgentSummary[]>({
    queryKey: [...AGENTS_QUERY_KEY, 'list', options],
    queryFn: () => api.agents(options),
  });

const agentTagsQuery = queryOptions<{ items: string[] }>({
  queryKey: ['agent-tags'],
  queryFn: () => api.agentTags(),
});

export const agentDetailQuery = (id: string, enabled = true) =>
  queryOptions<Agent>({
    queryKey: ['agent-detail', id],
    queryFn: ({ signal }) => api.agent(id, signal),
    enabled,
    staleTime: 0,
  });

export const agentStatsQuery = (agentId: string, days: number) =>
  queryOptions({
    queryKey: ['agent-stats', agentId, days],
    queryFn: () => api.agentStats(agentId, days),
    staleTime: 60_000,
  });

const agentBudgetQuery = (agentId: string, enabled = true) =>
  queryOptions<AgentBudgetStatus>({
    queryKey: ['agent-budget', agentId],
    queryFn: () => api.agentBudget(agentId),
    enabled,
    staleTime: 30_000,
  });

const agentAccessQuery = (id: string | null) =>
  queryOptions<AgentAccess>({
    queryKey: ['agent-access', id],
    queryFn: () => api.agentAccess(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

const agentMembersQuery = (id: string | null) =>
  queryOptions<AgentMemberList>({
    queryKey: ['agent-members', id],
    queryFn: () => api.agentMembers(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

const agentOptionsQuery = queryOptions<AgentOptions>({
  queryKey: AGENT_OPTIONS_QUERY_KEY,
  queryFn: api.agentOptions,
  staleTime: 60_000,
});

export function useAgentOptions(enabled = true) {
  return useQuery({ ...agentOptionsQuery, enabled });
}

export function useAgents() {
  return useQuery(agentsQuery);
}

function isDefaultList(options: AgentListParams): boolean {
  return (
    (options.status ?? 'active') === 'active' &&
    options.q === undefined &&
    options.tag === undefined &&
    options.favorite === undefined &&
    options.sort === undefined
  );
}

export function useExperts(options?: AgentListParams) {
  const resolved = options ?? {};
  return useQuery({
    ...(isDefaultList(resolved) ? agentsQuery : agentsListQuery(resolved)),
    select: (agents: AgentSummary[]) => agents.filter((agent) => !agent.isDefault),
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
      client.setQueriesData<AgentSummary[]>({ queryKey: AGENTS_QUERY_KEY }, (old) =>
        old?.map((agent) =>
          agent.id === vars.id ? { ...agent, isFavorite: vars.favorite } : agent,
        ),
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-tags'] });
    },
  });
}

export function useArchiveAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.archiveAgent(id),
    onSuccess: (_agent, id) => {
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-tags'] });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-detail', id] });
      void client.invalidateQueries({ queryKey: ['agent-access', id] });
    },
  });
}

export function useRestoreAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreAgent(id),
    onSuccess: (_agent, id) => {
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-tags'] });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-detail', id] });
      void client.invalidateQueries({ queryKey: ['agent-access', id] });
    },
  });
}

export function useAgentSummary(id: string | null) {
  return useQuery({
    ...agentsQuery,
    select: (agents: AgentSummary[]) => agents.find((agent) => agent.id === id) ?? null,
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
      await client.cancelQueries({ queryKey: ['agent-members', vars.agentId] });
      const prev = client.getQueryData<AgentMemberList>(['agent-members', vars.agentId]);
      if (prev) {
        client.setQueryData<AgentMemberList>(['agent-members', vars.agentId], (old) =>
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
        client.setQueryData<AgentMemberList>(['agent-members', vars.agentId], ctx.prev);
      }
      void client.invalidateQueries({ queryKey: ['agent-members', vars.agentId] });
    },
    onSuccess: (_member, vars) => {
      void client.invalidateQueries({ queryKey: ['agent-members', vars.agentId] });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}

export function useDeleteAgentMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; businessId: string }) =>
      api.deleteAgentMember(vars.agentId, vars.businessId),
    onSuccess: (_ok, vars) => {
      void client.invalidateQueries({ queryKey: ['agent-members', vars.agentId] });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}

export function useTransferAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; ownerBusinessId: string }) =>
      api.transferAgent(vars.agentId, vars.ownerBusinessId),
    onSuccess: (agent) => {
      client.setQueryData(['agent-detail', agent.id], agent);
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-access', agent.id] });
    },
  });
}

export function useAgentFiles(agentId: string | null, enabled = true) {
  return useQuery<AgentFiles>({
    queryKey: ['agent-files', agentId],
    queryFn: () => api.agentFiles(agentId ?? ''),
    enabled: agentId !== null && enabled,
    staleTime: 0,
  });
}

export function useAgentVersions(agentId: string | null, enabled = true) {
  return useQuery<AgentVersionSummary[]>({
    queryKey: ['agent-versions', agentId],
    queryFn: () => api.agentVersions(agentId ?? ''),
    enabled: agentId !== null && enabled,
    staleTime: 0,
  });
}

export function useAgentVersion(agentId: string, version: number, enabled: boolean) {
  return useQuery<AgentVersionDetail>({
    queryKey: ['agent-version', agentId, version],
    queryFn: () => api.agentVersion(agentId, version),
    enabled,
  });
}

export function isAgentDetail(agent: Agent | AgentSummary): agent is Agent {
  return 'systemPrompt' in agent;
}

export function useRollbackAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; version: number }) => api.rollbackAgent(vars.id, vars.version),
    onSuccess: (agent, { id }) => {
      if (isAgentDetail(agent)) client.setQueryData(['agent-detail', id], agent);
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-versions', id] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', id] });
      void client.invalidateQueries({ queryKey: ['agent-budget', id] });
    },
  });
}

export function usePublishAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; note?: string }) => api.publishAgent(vars.id, vars.note),
    onSuccess: (agent) => {
      if (isAgentDetail(agent)) client.setQueryData(['agent-detail', agent.id], agent);
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-detail', agent.id] });
      void client.invalidateQueries({ queryKey: ['agent-versions', agent.id] });
    },
  });
}

export function useOfflineAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.offlineAgent(id),
    onSuccess: (agent) => {
      if (isAgentDetail(agent)) client.setQueryData(['agent-detail', agent.id], agent);
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-detail', agent.id] });
      void client.invalidateQueries({ queryKey: ['agent-versions', agent.id] });
    },
  });
}

export function useTrialAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; prompt: string }) => api.trialAgent(vars.id, vars.prompt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runs'] }),
  });
}

export function useCreateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AgentInput) => api.createAgent(input),
    onSuccess: () => {
      invalidate(AGENTS_QUERY_KEY[0]);
      invalidate('agent-tags');
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
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
      client.setQueryData(AGENTS_QUERY_KEY, (prev: Agent[] | undefined) =>
        prev ? [...prev, agent] : prev,
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
      await client.cancelQueries({ queryKey: AGENTS_QUERY_KEY });
      const previous = client.getQueryData<Agent[]>(AGENTS_QUERY_KEY);
      client.setQueryData<Agent[]>(AGENTS_QUERY_KEY, (old) =>
        old?.map((agent) => {
          if (agent.id !== id) return agent;
          const next = { ...agent, ...input };
          return {
            ...next,
            effort: next.effort ?? undefined,
          };
        }),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(AGENTS_QUERY_KEY, context.previous);
    },
    onSettled: (_data, _error, vars) => {
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: ['agent-tags'] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', vars.id] });
      void client.invalidateQueries({ queryKey: ['agent-budget', vars.id] });
    },
  });
}

export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: (_data, id) => {
      client.setQueryData<Agent[]>(AGENTS_QUERY_KEY, (old) =>
        old?.filter((agent) => agent.id !== id),
      );
      client.removeQueries({ queryKey: ['agent-detail', id], exact: true });
      client.removeQueries({ queryKey: ['agent-access', id], exact: true });
      void client.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}
