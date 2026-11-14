import type { Agent, AgentInput, AgentOptions, AgentPatch } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AgentAccess,
  type AgentFiles,
  type AgentMemberList,
  type AgentSummary,
  type AgentVersionDetail,
  type AgentVersionSummary,
  api,
} from '../api.js';
import { useInvalidate } from './shared.js';

export const agentsQuery = queryOptions<AgentSummary[]>({
  queryKey: ['agents'],
  queryFn: api.agents,
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

export const agentAccessQuery = (id: string | null) =>
  queryOptions<AgentAccess>({
    queryKey: ['agent-access', id],
    queryFn: () => api.agentAccess(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

export const agentMembersQuery = (id: string | null) =>
  queryOptions<AgentMemberList>({
    queryKey: ['agent-members', id],
    queryFn: () => api.agentMembers(id ?? ''),
    enabled: id !== null,
    staleTime: 0,
  });

export const agentOptionsQuery = queryOptions<AgentOptions>({
  queryKey: ['agent-options'],
  queryFn: api.agentOptions,
  staleTime: 60_000,
});

/** 绑定选择器摘要；只有具备 agents.bindings.manage 的调用方才发请求。 */
export function useAgentOptions(enabled = true) {
  return useQuery({ ...agentOptionsQuery, enabled });
}

export function useAgents() {
  return useQuery(agentsQuery);
}

export function useExperts() {
  return useQuery({
    ...agentsQuery,
    select: (agents: AgentSummary[]) => agents.filter((agent) => !agent.isDefault),
  });
}

/** 列表摘要：只用于选择器和卡片，不包含配置正文。 */
export function useAgentSummary(id: string | null) {
  return useQuery({
    ...agentsQuery,
    select: (agents: AgentSummary[]) => agents.find((agent) => agent.id === id) ?? null,
  });
}

/** 完整配置：调用前必须已有 agents.config.read；禁用的查询不会发请求。 */
export function useAgentDetail(id: string | null, enabled = true) {
  return useQuery({ ...agentDetailQuery(id ?? '', enabled && id !== null) });
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
    onSuccess: (_member, vars) => {
      void client.invalidateQueries({ queryKey: ['agent-members', vars.agentId] });
      void client.invalidateQueries({ queryKey: ['agents'] });
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
      void client.invalidateQueries({ queryKey: ['agents'] });
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
      void client.invalidateQueries({ queryKey: ['agents'] });
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

export function useRollbackAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; version: number }) => api.rollbackAgent(vars.id, vars.version),
    onSuccess: (agent, { id }) => {
      client.setQueryData(['agent-detail', id], agent);
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-versions', id] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', id] });
    },
  });
}

export function useCreateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AgentInput) => api.createAgent(input),
    onSuccess: () => {
      invalidate('agents');
      invalidate('overview');
    },
  });
}

export function useDuplicateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; slug: string; name: string }) =>
      api.duplicateAgent(vars.id, { slug: vars.slug, name: vars.name }),
    onSuccess: (agent) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
      client.setQueryData(['agents'], (prev: Agent[] | undefined) =>
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
      await client.cancelQueries({ queryKey: ['agents'] });
      const previous = client.getQueryData<Agent[]>(['agents']);
      client.setQueryData<Agent[]>(['agents'], (old) =>
        old?.map((agent) => {
          if (agent.id !== id) return agent;
          // PATCH 的 null 表示「清空」；本地缓存里缺省仍是 undefined。
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
      if (context?.previous) client.setQueryData(['agents'], context.previous);
    },
    onSettled: (_data, _error, vars) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
      void client.invalidateQueries({ queryKey: ['agent-detail', vars.id] });
    },
  });
}

export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    // 删除成功才移除缓存：失败时要保留详情与草稿，等用户重试或取消。
    onSuccess: (_data, id) => {
      client.setQueryData<Agent[]>(['agents'], (old) => old?.filter((agent) => agent.id !== id));
      client.removeQueries({ queryKey: ['agent-detail', id], exact: true });
      client.removeQueries({ queryKey: ['agent-access', id], exact: true });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
