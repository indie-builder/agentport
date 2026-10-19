import type {
  Agent,
  AgentInput,
  ApiTool,
  ApiToolInput,
  Server,
  ServerInput,
  ServerTestResult,
  Skill,
  SkillInput,
} from '@agentport/shared';
import {
  QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AgentFiles,
  api,
  type ConversationDetail,
  type ConversationList,
  type Me,
  type Overview,
} from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

export const meQuery = queryOptions<Me>({
  queryKey: ['me'],
  queryFn: api.me,
  staleTime: 30_000,
});

export const serversQuery = queryOptions<Server[]>({
  queryKey: ['servers'],
  queryFn: api.servers,
});

export const agentsQuery = queryOptions<Agent[]>({
  queryKey: ['agents'],
  queryFn: api.agents,
});

export const skillsQuery = queryOptions<Skill[]>({
  queryKey: ['skills'],
  queryFn: api.skills,
});

export const overviewQuery = queryOptions<Overview | null>({
  queryKey: ['overview'],
  queryFn: api.overview,
  staleTime: 15_000,
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

export function useOverview() {
  return useQuery(overviewQuery);
}

export function useTools(serverId: string | null) {
  return useQuery({
    queryKey: ['tools', serverId],
    queryFn: () => api.tools(serverId ?? ''),
    enabled: serverId !== null,
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

export function useConversations(agentId: string | null) {
  return useQuery<ConversationList>({
    queryKey: ['conversations', agentId],
    queryFn: () => api.conversations(agentId ?? undefined),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

export function useConversation(conversationId: string | null) {
  return useQuery<ConversationDetail>({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId ?? ''),
    enabled: conversationId !== null,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (key: string) => client.invalidateQueries({ queryKey: [key] });
}

export function useUpdateServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<ServerInput> }) =>
      api.updateServer(vars.id, vars.input),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: ['servers'] });
      const previous = client.getQueryData<Server[]>(['servers']);
      client.setQueryData<Server[]>(['servers'], (old) =>
        old?.map((server) => (server.id === id ? ({ ...server, ...input } as Server) : server)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(['servers'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useCreateServer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ServerInput) => api.createServer(input),
    onSuccess: () => {
      invalidate('servers');
      invalidate('overview');
    },
  });
}

export function useDeleteServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: ['servers'] });
      const previous = client.getQueryData<Server[]>(['servers']);
      client.setQueryData<Server[]>(['servers'], (old) =>
        old?.filter((server) => server.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) client.setQueryData(['servers'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['servers'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useTestServer() {
  return useMutation({ mutationFn: (id: string): Promise<ServerTestResult> => api.testServer(id) });
}

export function useCreateTool(serverId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ApiToolInput) => api.createTool(serverId, input),
    onSuccess: () => invalidate('tools'),
  });
}

export function useDeleteTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (toolId: string) => api.deleteTool(serverId, toolId),
    onMutate: async (toolId) => {
      await client.cancelQueries({ queryKey: ['tools', serverId] });
      const previous = client.getQueryData<ApiTool[]>(['tools', serverId]);
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.filter((tool) => tool.id !== toolId),
      );
      return { previous };
    },
    onError: (_error, _toolId, context) => {
      if (context?.previous) client.setQueryData(['tools', serverId], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
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

export function useUpdateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<AgentInput> }) =>
      api.updateAgent(vars.id, vars.input),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: ['agents'] });
      const previous = client.getQueryData<Agent[]>(['agents']);
      client.setQueryData<Agent[]>(['agents'], (old) =>
        old?.map((agent) => (agent.id === id ? ({ ...agent, ...input } as Agent) : agent)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(['agents'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
    },
  });
}

export function useDeleteAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: ['agents'] });
      const previous = client.getQueryData<Agent[]>(['agents']);
      client.setQueryData<Agent[]>(['agents'], (old) => old?.filter((agent) => agent.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) client.setQueryData(['agents'], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useSkills() {
  return useQuery(skillsQuery);
}

export function useCreateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SkillInput) => api.createSkill(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<SkillInput> }) =>
      api.updateSkill(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useDeleteSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
