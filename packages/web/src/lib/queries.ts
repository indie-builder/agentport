import type { AgentInput, ApiToolInput, ServerInput } from '@agentport/shared';
import {
  QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type AgentFiles, api, type Me } from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export const meQuery = queryOptions<Me>({
  queryKey: ['me'],
  queryFn: api.me,
  staleTime: 30_000,
});

export const serversQuery = queryOptions({
  queryKey: ['servers'],
  queryFn: api.servers,
});

export const agentsQuery = queryOptions({
  queryKey: ['agents'],
  queryFn: api.agents,
});

export function useMe() {
  return useQuery(meQuery);
}

export function useServers() {
  return useQuery(serversQuery);
}

export function useAgents() {
  return useQuery(agentsQuery);
}

export function useTools(serverId: string | null) {
  return useQuery({
    queryKey: ['tools', serverId],
    queryFn: () => api.tools(serverId ?? ''),
    enabled: serverId !== null,
  });
}

export function useAgentFiles(agentId: string | null) {
  return useQuery<AgentFiles>({
    queryKey: ['agent-files', agentId],
    queryFn: () => api.agentFiles(agentId ?? ''),
    enabled: agentId !== null,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (key: string) => client.invalidateQueries({ queryKey: [key] });
}

export function useCreateServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ServerInput) => api.createServer(input),
    onSuccess: () => invalidate('servers'),
  });
}

export function useDeleteServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onSuccess: () => invalidate('servers'),
  });
}

export function useTestServer() {
  return useMutation({ mutationFn: (id: string) => api.testServer(id) });
}

export function useCreateTool(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ApiToolInput) => api.createTool(serverId, input),
    onSuccess: () => invalidate('tools'),
  });
}

export function useDeleteTool(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (toolId: string) => api.deleteTool(serverId, toolId),
    onSuccess: () => invalidate('tools'),
  });
}

export function useCreateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AgentInput) => api.createAgent(input),
    onSuccess: () => invalidate('agents'),
  });
}

export function useUpdateAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<AgentInput> }) =>
      api.updateAgent(vars.id, vars.input),
    onSuccess: () => invalidate('agents'),
  });
}

export function useDeleteAgent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => invalidate('agents'),
  });
}
