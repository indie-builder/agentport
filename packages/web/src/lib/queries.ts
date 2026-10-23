import type {
  Agent,
  AgentInput,
  AgentPatch,
  ApiTool,
  ApiToolInput,
  ChatRequest,
  EvalDataset,
  Server,
  ServerInput,
  ServerTestResult,
  SkillInput,
  SkillWithAgentCount,
} from '@agentport/shared';
import {
  QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  type AgentFiles,
  type AgentVersionDetail,
  type AgentVersionSummary,
  ApiError,
  type ApprovalRequestList,
  type AuditQuery,
  api,
  type ConversationDetail,
  type ConversationList,
  type EvalCase,
  type EvalCaseInput,
  type EvalComparison,
  type EvalRun,
  type EvalRunDetail,
  type HealthLive,
  type HealthMetrics,
  type HealthProbe,
  type HealthReady,
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

export const skillsQuery = queryOptions<SkillWithAgentCount[]>({
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

/** 单个专家从列表缓存里取；配置页用它，slug 不存在时返回 null。 */
export function useAgent(id: string) {
  const query = useAgents();
  return { ...query, data: (query.data ?? []).find((agent) => agent.id === id) ?? null };
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

export const healthLiveQuery = queryOptions<HealthProbe<HealthLive>>({
  queryKey: ['health-live'],
  queryFn: api.healthLive,
  refetchInterval: 10_000,
  staleTime: 0,
});

export const healthReadyQuery = queryOptions<HealthProbe<HealthReady>>({
  queryKey: ['health-ready'],
  queryFn: api.healthReady,
  refetchInterval: 10_000,
  staleTime: 0,
});

export const toolsQuery = (serverId: string) =>
  queryOptions({
    queryKey: ['tools', serverId],
    queryFn: () => api.tools(serverId),
    staleTime: 60_000,
  });

export function useTools(serverId: string | null) {
  return useQuery({ ...toolsQuery(serverId ?? ''), enabled: serverId !== null });
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

const CONVERSATION_PAGE_SIZE = 50;

/** 分页返回最新一页，select 再把「新→旧」的页面翻平成时间正序，调用方拿到的仍是 ConversationDetail。 */
export function useConversation(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: ['conversation', conversationId],
    queryFn: ({ pageParam }) =>
      api.conversation(conversationId ?? '', {
        limit: CONVERSATION_PAGE_SIZE,
        ...(pageParam === null ? {} : { before: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: conversationId !== null,
    staleTime: 0,
    refetchOnMount: 'always',
    select: (data): ConversationDetail => {
      const first = data.pages[0];
      if (!first) throw new Error('会话分页为空');
      return {
        conversation: first.conversation,
        messages: data.pages.toReversed().flatMap((page) => page.messages),
        nextBefore: data.pages.at(-1)?.nextBefore ?? null,
      };
    },
  });
}

export function useRuns(query: RunQuery = {}, enabled = true) {
  return useQuery<RunList>({
    queryKey: ['runs', query.agentId ?? null, query.status ?? null, query.limit ?? 50],
    queryFn: () => api.runs(query),
    enabled,
    staleTime: 5_000,
    // 运行期间列表有变化，轮询跟进；全部结束后停止。
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'queued' || run.status === 'running')
        ? 5_000
        : false,
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
export function useRunApprovals(runId: string | null, active = true) {
  const client = useQueryClient();
  const previous = useRef({ runId, active });
  useEffect(() => {
    const wasActive = previous.current.runId === runId && previous.current.active;
    previous.current = { runId, active };
    if (!runId || active || !wasActive) return;
    const queryKey = ['run-approvals', runId];
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  }, [runId, active, client]);
  return useQuery<ApprovalRequestList>({
    queryKey: ['run-approvals', runId],
    queryFn: () => api.runApprovals(runId ?? ''),
    enabled: runId !== null,
    // 只有运行还在进行时才轮询；结束后停止，避免在后台一直打接口。
    refetchInterval: active ? 2_000 : false,
  });
}

/** 审批写操作：成功后让该 run 的审批列表失效，不手动 refetch。 */
export function useApproveRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; serverId: string; toolName: string }) =>
      api.approveRun(input.runId, input.serverId, input.toolName),
    onSuccess: (_data, input) =>
      void client.invalidateQueries({ queryKey: ['run-approvals', input.runId] }),
  });
}

/** 取消排队中/运行中的运行；详情轮询会接着显示终态。 */
export function useCancelRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (_data, runId) => {
      void client.invalidateQueries({ queryKey: ['run', runId] });
      void client.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}

/** 重发一次运行：成功后跳转到新 run 并让运行列表失效。 */
export function useRerun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatRequest) => api.sendChat(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runs'] }),
  });
}

const AUDIT_PAGE_SIZE = 100;
export function useAudit(query: Omit<AuditQuery, 'before' | 'beforeId' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam }) =>
      api.audit({
        ...query,
        limit: AUDIT_PAGE_SIZE,
        ...(pageParam === null ? {} : { beforeId: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last, _pages, beforeId) => {
      if (last.items.length < AUDIT_PAGE_SIZE) return undefined;
      const next = last.items.at(-1)?.id;
      return next === undefined || next === beforeId ? undefined : next;
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

export function useImportMcpFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importMcpFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export function useServerToken(serverId: string) {
  return useQuery({
    queryKey: ['server-token', serverId],
    queryFn: () => api.serverToken(serverId),
    staleTime: 0,
  });
}

export function useRotateServerToken(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotateServerToken(serverId),
    onSuccess: (data) => {
      client.setQueryData(['server-token', serverId], data);
      void client.invalidateQueries({ queryKey: ['servers'] });
    },
  });
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

/** 编辑工具定义（名称/方法/路径/参数/schema）；与启停分开，互不覆盖。 */
export function useUpdateTool(serverId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { toolId: string; patch: Partial<ApiToolInput> & { enabled?: boolean } }) =>
      api.updateTool(serverId, vars.toolId, vars.patch),
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
            maxThinkingTokens: next.maxThinkingTokens ?? undefined,
          };
        }),
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

export function useImportSkillFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importSkillFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<SkillInput>; expectedUpdatedAt?: string }) =>
      api.updateSkill(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
    // 冲突说明列表里是旧版本：重取一次，关闭重开后拿到最新数据。
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        void client.invalidateQueries({ queryKey: ['skills'] });
      }
    },
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

export function useImportEvalDataset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; dataset: EvalDataset }) =>
      api.importEvalDataset(input.agentId, input.dataset),
    onSuccess: (_result, input) =>
      void client.invalidateQueries({ queryKey: ['eval-cases', input.agentId] }),
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

export function useCancelEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelEvalRun(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['eval-runs'] });
      void client.invalidateQueries({ queryKey: ['eval-run'] });
    },
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

export function useEvalComparison(baseId: string | null, headId: string | null) {
  return useQuery<EvalComparison>({
    queryKey: ['eval-comparison', baseId, headId],
    queryFn: () => api.compareEvalRuns(baseId ?? '', headId ?? ''),
    enabled: baseId !== null && headId !== null && baseId !== headId,
  });
}
