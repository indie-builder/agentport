import type {
  AgentHookFile,
  AgentHooks,
  AgentWorkflow,
  OutputStyle,
  Rule,
} from '@agentport/shared';
import { type QueryClient, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export const agentRulesQuery = (id: string) =>
  queryOptions<Rule[]>({
    queryKey: ['agent-rules', id],
    queryFn: () => api.agentRules(id),
  });

export const agentOutputStylesQuery = (id: string) =>
  queryOptions<OutputStyle[]>({
    queryKey: ['agent-output-styles', id],
    queryFn: () => api.agentOutputStyles(id),
  });

export const agentWorkflowsQuery = (id: string) =>
  queryOptions<AgentWorkflow[]>({
    queryKey: ['agent-workflows', id],
    queryFn: () => api.agentWorkflows(id),
  });

function invalidateAgentWorkflows(client: QueryClient, agentId: string): void {
  void client.invalidateQueries({ queryKey: agentWorkflowsQuery(agentId).queryKey });
  void client.invalidateQueries({ queryKey: ['agent-files', agentId] });
}

export function useCreateAgentWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; slug: string; content: string }) =>
      api.createAgentWorkflow(vars.agentId, { slug: vars.slug, content: vars.content }),
    onSuccess: (_workflow, vars) => invalidateAgentWorkflows(client, vars.agentId),
  });
}

export function useUpdateAgentWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      agentId: string;
      workflowId: string;
      content: string;
      expectedUpdatedAt?: string;
    }) =>
      api.updateAgentWorkflow(vars.agentId, vars.workflowId, {
        content: vars.content,
        ...(vars.expectedUpdatedAt === undefined
          ? {}
          : { expectedUpdatedAt: vars.expectedUpdatedAt }),
      }),
    onSuccess: (_workflow, vars) => invalidateAgentWorkflows(client, vars.agentId),
  });
}

export function useDeleteAgentWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; workflowId: string }) =>
      api.deleteAgentWorkflow(vars.agentId, vars.workflowId),
    onSuccess: (_data, vars) => invalidateAgentWorkflows(client, vars.agentId),
  });
}

export const agentHooksQuery = (id: string) =>
  queryOptions<AgentHooks>({
    queryKey: ['agent-hooks', id],
    queryFn: () => api.agentHooks(id),
  });

function invalidateAgentHooks(client: QueryClient, agentId: string): void {
  void client.invalidateQueries({ queryKey: agentHooksQuery(agentId).queryKey });
  void client.invalidateQueries({ queryKey: ['agent-files', agentId] });
}

export function useWriteAgentHooksSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      agentId: string;
      enabled: boolean;
      config: Record<string, unknown> | null;
    }) =>
      api.writeAgentHooksSettings(vars.agentId, {
        enabled: vars.enabled,
        config: vars.config,
      }),
    onSuccess: (_data, vars) => invalidateAgentHooks(client, vars.agentId),
  });
}

export function useWriteAgentHookFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      agentId: string;
      path: string;
      content: string;
      executable: boolean;
    }): Promise<AgentHookFile> => api.writeAgentHookFile(vars.agentId, vars),
    onSuccess: (_data, vars) => invalidateAgentHooks(client, vars.agentId),
  });
}

export function useDeleteAgentHookFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; path: string }) =>
      api.deleteAgentHookFile(vars.agentId, vars.path),
    onSuccess: (_data, vars) => invalidateAgentHooks(client, vars.agentId),
  });
}
