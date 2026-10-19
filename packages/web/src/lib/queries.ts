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
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type AgentFiles,
  type AgentVersionDetail,
  type AgentVersionSummary,
  type ApprovalRequestList,
  type AuditQuery,
  api,
  type ConversationDetail,
  type ConversationList,
  type EvalCase,
  type EvalCaseInput,
  type EvalRun,
  type EvalRunDetail,
  type HealthMetrics,
  type Me,
  type Overview,
  type RunDetail,
  type RunList,
  type RunQuery,
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

export const healthMetricsQuery = queryOptions<HealthMetrics | null>({
  queryKey: ['health-metrics'],
  queryFn: api.healthMetrics,
  refetchInterval: 30_000,
  staleTime: 0,
});

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
    onSuccess: (_agent, { id }) => {
      void client.invalidateQueries({ queryKey: ['agents'] });
      void client.invalidateQueries({ queryKey: ['agent-versions', id] });
      void client.invalidateQueries({ queryKey: ['agent-files'] });
    },
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

export function useRuns(query: RunQuery = {}) {
  return useQuery<RunList>({
    queryKey: ['runs', query.agentId ?? null, query.status ?? null, query.limit ?? 50],
    queryFn: () => api.runs(query),
    staleTime: 5_000,
  });
}

export function useRun(runId: string) {
  return useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => api.run(runId),
    // 运行中要能看到新落库的步骤。
    refetchInterval: (query) =>
      query.state.data?.run.status === 'running' || query.state.data?.run.status === 'queued'
        ? 2_000
        : false,
  });
}

/** 审批请求由 MCP 端点在工具被拒时写入；运行期间轮询，结束后停。 */
export function useRunApprovals(runId: string | null) {
  return useQuery<ApprovalRequestList>({
    queryKey: ['run-approvals', runId],
    queryFn: () => api.runApprovals(runId ?? ''),
    enabled: runId !== null,
    refetchInterval: 2_000,
  });
}

const AUDIT_PAGE_SIZE = 100;
export function useAudit(query: Omit<AuditQuery, 'before' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam }) =>
      api.audit({
        ...query,
        limit: AUDIT_PAGE_SIZE,
        ...(pageParam === null ? {} : { before: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last, _pages, before) => {
      if (last.items.length < AUDIT_PAGE_SIZE) return undefined;
      const next = last.items.at(-1)?.createdAt ?? null;
      return next === before ? undefined : next;
    },
    staleTime: 0,
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return (key: string) => client.invalidateQueries({ queryKey: [key] });
}

export function useUpdateServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<ServerInput>; expectedUpdatedAt?: string }) =>
      api.updateServer(vars.id, vars.input, vars.expectedUpdatedAt),
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

export function useSetToolEnabled(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { toolId: string; enabled?: boolean; requiresApproval?: boolean }) =>
      api.updateTool(serverId, vars.toolId, {
        ...(vars.enabled === undefined ? {} : { enabled: vars.enabled }),
        ...(vars.requiresApproval === undefined ? {} : { requiresApproval: vars.requiresApproval }),
      }),
    onSuccess: (tool) => {
      client.setQueryData<ApiTool[]>(['tools', serverId], (old) =>
        old?.map((item) => (item.id === tool.id ? tool : item)),
      );
      void client.invalidateQueries({ queryKey: ['tools', serverId] });
    },
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
    mutationFn: (vars: { id: string; input: Partial<AgentInput>; expectedUpdatedAt?: string }) =>
      api.updateAgent(vars.id, vars.input, vars.expectedUpdatedAt),
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

export function useEvalCases(agentId: string | null) {
  return useQuery<EvalCase[]>({
    queryKey: ['eval-cases', agentId],
    queryFn: () => api.evalCases(agentId ?? undefined),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

export function useCreateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseInput) => api.createEvalCase(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

export function useUpdateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<Omit<EvalCaseInput, 'agentId'>> }) =>
      api.updateEvalCase(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

export function useDeleteEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEvalCase(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

export function useEvalRuns(agentId: string | null) {
  return useQuery<EvalRun[]>({
    queryKey: ['eval-runs', agentId],
    queryFn: () => api.evalRuns(agentId ?? undefined),
    enabled: agentId !== null,
    // 跑批在后台进行，列表里有 running 时轮询。
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'running') ? 3_000 : false,
  });
}

export function useStartEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.startEvalRun(agentId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-runs'] }),
  });
}

export function useEvalRun(id: string | null) {
  return useQuery<EvalRunDetail>({
    queryKey: ['eval-run', id],
    queryFn: () => api.evalRun(id ?? ''),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.evalRun.status === 'running' ? 2_000 : false),
  });
}
