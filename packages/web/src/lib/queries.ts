import type {
  Agent,
  AgentInput,
  AgentPatch,
  ApiTool,
  ApiToolInput,
  Attention,
  ChatRequest,
  ConnectorCatalogItem,
  CreateMemoryReviewInput,
  EvalDataset,
  KnowledgeSourceInput,
  MarketInstallInput,
  MarketView,
  MemoryChange,
  MemoryFileContent,
  MemoryFileList,
  MemoryReview,
  MemoryReviewTarget,
  NativePluginImportInput,
  NativePluginInstallInput,
  OutputContent,
  OutputFile,
  OutputStyle,
  PersonalMemory,
  Plugin,
  PluginInput,
  PluginWithAgentCount,
  PublicQuestionResponse,
  PublicRunQuestion,
  Rule,
  RuntimeEnvironment,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
  Schedule,
  Server,
  ServerInput,
  ServerTestResult,
  SkillInput,
  SkillWithAgentCount,
} from '@agentport/shared';
import {
  infiniteQueryOptions,
  QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  type AgentFiles,
  type AgentVersionDetail,
  type AgentVersionSummary,
  ApiError,
  type ApprovalRequestList,
  type AuditQuery,
  api,
  type Conversation,
  type ConversationDetail,
  type ConversationSearchOptions,
  type EvalCase,
  type EvalCaseInput,
  type EvalComparison,
  type EvalRunDetail,
  type HealthLive,
  type HealthMetrics,
  type HealthProbe,
  type HealthReady,
  type KnowledgeBaseInput,
  type KnowledgeSearchResponse,
  type Me,
  type NativePlugins,
  type OutputShareList,
  type Overview,
  type OverviewTimeseriesPoint,
  type RunDetail,
  type RunList,
  type RunQuery,
} from './api.js';
import { toastError, toastSuccess } from './toast.js';
import { useDebouncedValue } from './use-debounced-value.js';

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
export const pluginsQuery = queryOptions<PluginWithAgentCount[]>({
  queryKey: ['plugins'],
  queryFn: api.plugins,
});
export const nativePluginsQuery = queryOptions<NativePlugins>({
  queryKey: ['plugins-native'],
  queryFn: api.nativePlugins,
});
/** 详情挂在 `['plugins']` 前缀下，列表与详情的失效一次覆盖。 */
export const pluginQuery = (id: string) =>
  queryOptions<Plugin>({
    queryKey: ['plugins', id],
    queryFn: () => api.plugin(id),
  });
export const connectorCatalogQuery = queryOptions<ConnectorCatalogItem[]>({
  queryKey: ['connector-catalog'],
  queryFn: api.connectorCatalog,
  staleTime: 5 * 60_000,
});
export const agentsQuery = queryOptions<Agent[]>({
  queryKey: ['agents'],
  queryFn: api.agents,
});

export const skillsQuery = queryOptions<SkillWithAgentCount[]>({
  queryKey: ['skills'],
  queryFn: api.skills,
});

export const overviewQuery = queryOptions<Overview>({
  queryKey: ['overview'],
  queryFn: api.overview,
  staleTime: 15_000,
});

export const overviewTimeseriesQuery = (days = 7) =>
  queryOptions<OverviewTimeseriesPoint[]>({
    queryKey: ['overview', 'timeseries', days],
    queryFn: () => api.overviewTimeseries(days),
    staleTime: 15_000,
  });

// ---- 以下为运营层（待办/看板/定时/统计/记忆）的查询与变更，集中在此供各页面复用 ----
export const attentionQuery = queryOptions<Attention>({
  queryKey: ['attention'],
  queryFn: api.attention,
  refetchInterval: 15_000,
});

export const schedulesQuery = queryOptions<Schedule[]>({
  queryKey: ['schedules'],
  queryFn: api.schedules,
});

export const agentMemoryQuery = (id: string) =>
  queryOptions<MemoryFileList>({
    queryKey: ['agent-memory', id],
    queryFn: () => api.agentMemory(id),
  });

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

export const agentMemoryFileQuery = (id: string, name: string) =>
  queryOptions<MemoryFileContent>({
    queryKey: ['agent-memory-file', id, name],
    queryFn: () => api.agentMemoryFile(id, name),
  });

export function useAttention() {
  return useQuery(attentionQuery);
}

export function useSchedules() {
  return useQuery(schedulesQuery);
}

// ---- 记忆：个人偏好、版本回顾与审核 ---------------------------------------

export const personalMemoryQuery = queryOptions<PersonalMemory>({
  queryKey: ['personal-memory'],
  queryFn: () => api.personalMemory(),
  staleTime: 0,
});

export const personalMemoryVersionsQuery = queryOptions<{ items: MemoryChange[] }>({
  queryKey: ['personal-memory-versions'],
  queryFn: ({ signal }) => api.personalMemoryVersions({}, signal),
  staleTime: 0,
});

/** 三类记忆目标各自的变更账本；审核详情与列表据此识别已回滚的采用。 */
export const memoryVersionsQuery = (target: MemoryReviewTarget) =>
  queryOptions<{ items: MemoryChange[] }>({
    queryKey: ['memory-versions', target],
    queryFn: ({ signal }) => {
      if (target.kind === 'personal') return api.personalMemoryVersions({}, signal);
      if (target.kind === 'agent_memory') return api.agentMemoryVersions(target.agentId, signal);
      return api.agentRuleVersions(target.agentId, target.slug, signal);
    },
    staleTime: 0,
  });

export function usePersonalMemory() {
  return useQuery(personalMemoryQuery);
}

export function usePersonalMemoryVersions() {
  return useQuery(personalMemoryVersionsQuery);
}

/** 保存只改个人偏好：写回缓存让编辑器立即拿到新内容，再失效偏好与版本账本。 */
export function useSavePersonalMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; expectedRevision: number }) =>
      api.writePersonalMemory(input),
    onSuccess: (saved) => {
      client.setQueryData(personalMemoryQuery.queryKey, saved);
      void client.invalidateQueries({ queryKey: personalMemoryQuery.queryKey });
      void client.invalidateQueries({ queryKey: personalMemoryVersionsQuery.queryKey });
      void client.invalidateQueries({ queryKey: ['memory-versions'] });
    },
  });
}

/** 记忆写入会改动偏好、专家文件/规则与变更账本，相关读取一次全部失效。 */
function invalidateMemoryContent(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: personalMemoryQuery.queryKey });
  void client.invalidateQueries({ queryKey: personalMemoryVersionsQuery.queryKey });
  void client.invalidateQueries({ queryKey: ['memory-versions'] });
  void client.invalidateQueries({ queryKey: ['agent-memory'] });
  void client.invalidateQueries({ queryKey: ['agent-rules'] });
}

/** 回滚会改写个人偏好或专家文件/规则，相关列表与实际内容一起失效。 */
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

/** 审核在后台排队/运行：3 秒刷新；全部进入终态后停止，卸载自动清理。 */
export function useMemoryReviews(agentId: string | null) {
  return useQuery({
    queryKey: memoryReviewKey(agentId),
    queryFn: ({ signal }) => api.memoryReviews(agentId === null ? {} : { agentId }, signal),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.items.some(memoryReviewActive) ? 3_000 : false),
  });
}

function invalidateMemoryReviews(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: ['memory-reviews'] });
}

export function useCreateMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { input: CreateMemoryReviewInput; idempotencyKey: string }) =>
      api.createMemoryReview(vars.input, vars.idempotencyKey),
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

/** 取消生成复用运行取消接口；列表继续轮询到服务端终态。 */
export function useCancelMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: () => invalidateMemoryReviews(client),
  });
}

export function useServers() {
  return useQuery(serversQuery);
}

export function usePlugins() {
  return useQuery(pluginsQuery);
}

export function usePlugin(id: string) {
  return useQuery(pluginQuery(id));
}

export function useNativePlugins(enabled = true) {
  // 列表要起一次沙盒，只在「已安装」页签可见时请求。
  return useQuery({ ...nativePluginsQuery, enabled });
}

export function useAgents() {
  return useQuery(agentsQuery);
}

/** 单个专家从列表缓存里取；配置页用它，slug 不存在时返回 null。 */
export function useAgent(id: string) {
  return useQuery({
    ...agentsQuery,
    select: (agents) => agents.find((agent) => agent.id === id) ?? null,
  });
}

export function useOverview() {
  return useQuery(overviewQuery);
}

export function useOverviewTimeseries(days = 7) {
  return useQuery(overviewTimeseriesQuery(days));
}

export const healthMetricsQuery = queryOptions<HealthMetrics>({
  queryKey: ['health-metrics'],
  // 失败时抛错而不是回退 null，React Query 才会保留上次成功读数。
  queryFn: async () => {
    const data = await api.healthMetrics();
    if (!data) throw new Error('指标端点不可达或返回非 200');
    return data;
  },
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
  return useQuery<Conversation[]>({
    queryKey: ['conversations', agentId],
    queryFn: ({ signal }) => api.conversations(agentId ?? undefined, signal),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

/** 全局历史搜索的 Query options；空 q 返回最近会话，nextBefore 作为下一页游标。 */
export const searchConversationsOptions = (options: ConversationSearchOptions) =>
  infiniteQueryOptions({
    queryKey: [
      'conversation-search',
      options.q ?? '',
      options.agentId ?? null,
      options.limit ?? 20,
      options.before ?? null,
    ],
    queryFn: ({ pageParam, signal }) =>
      api.searchConversations(
        { ...options, ...(pageParam === null ? {} : { before: pageParam }) },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 0,
  });

const CONVERSATION_PAGE_SIZE = 50;

/** 分页返回最新一页，select 再把「新→旧」的页面翻平成时间正序，调用方拿到的仍是 ConversationDetail。 */
export function useConversation(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: ['conversation', conversationId],
    queryFn: ({ pageParam, signal }) =>
      api.conversation(
        conversationId ?? '',
        {
          limit: CONVERSATION_PAGE_SIZE,
          ...(pageParam === null ? {} : { before: pageParam }),
        },
        signal,
      ),
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
        runMetrics: data.pages.flatMap((page) => page.runMetrics),
        nextBefore: data.pages.at(-1)?.nextBefore ?? null,
      };
    },
  });
}

export function useRuns(query: RunQuery = {}) {
  return useQuery<RunList>({
    queryKey: ['runs', query.agentId ?? null, query.status ?? null, query.limit ?? 50],
    queryFn: () => api.runs(query),
    staleTime: 5_000,
    // 运行期间列表有变化，轮询跟进；全部结束后停止。
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'queued' || run.status === 'running')
        ? 5_000
        : false,
  });
}

/** 恢复会话与运行详情页共用同一份运行缓存，同键才能复用。 */
export const runQuery = (runId: string) =>
  queryOptions<RunDetail>({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => api.run(runId, signal),
    // 短 staleTime：恢复后 useRun 立即挂载也不会重复请求，轮询仍按间隔继续。
    staleTime: 5_000,
  });

export function useRun(runId: string) {
  return useQuery({
    ...runQuery(runId),
    // 运行中要能看到新落库的步骤。
    refetchInterval: (query) =>
      query.state.data?.run.status === 'running' || query.state.data?.run.status === 'queued'
        ? 2_000
        : false,
  });
}

/**
 * 会话成果按发布版本倒序；同一路径由页面分组。
 * 旧版可能落在后续页，按 `nextBefore` 继续翻页，不静默丢弃。
 */
export function useConversationOutputs(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: ['conversation-outputs', conversationId],
    queryFn: ({ pageParam, signal }) =>
      api.outputs(
        conversationId ?? '',
        { limit: 50, ...(pageParam === null ? {} : { before: pageParam }) },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: conversationId !== null,
    staleTime: 0,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.items),
      nextBefore: data.pages.at(-1)?.nextBefore ?? null,
    }),
  });
}

/** 选中成果的文本正文；非文本或超过预览上限时由后端拒绝，页面改为下载。 */
export function useOutputContent(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
) {
  return useQuery<OutputContent>({
    queryKey: ['conversation-output-content', conversationId, runId, path],
    queryFn: ({ signal }) =>
      api.outputContent(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null,
    staleTime: 5 * 60_000,
  });
}

/** 列表里没有该版本时用它拿真实 mediaType；只有缺列表元信息才启用。 */
export function useOutputFile(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery<{ file: OutputFile }>({
    queryKey: ['conversation-output-file', conversationId, runId, path],
    queryFn: ({ signal }) => api.outputFile(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

/** 图片字节走鉴权下载端点；key 与选中三元组一致，切换选择即换请求。 */
export function useOutputBlob(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery<Blob>({
    queryKey: ['conversation-output-blob', conversationId, runId, path],
    queryFn: ({ signal }) => api.outputBlob(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

export const outputSharesQueryKey = (
  conversationId: string | null,
  runId: string | null,
  path: string | null,
) => ['output-shares', conversationId, runId, path] as const;

export function useOutputShares(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
) {
  return useQuery<OutputShareList>({
    queryKey: outputSharesQueryKey(conversationId, runId, path),
    queryFn: ({ signal }) =>
      api.outputShares(conversationId ?? '', { runId: runId ?? '', path: path ?? '' }, signal),
    enabled: conversationId !== null && runId !== null && path !== null,
    staleTime: 0,
  });
}

/** 创建后先写回缓存，列表刷新失败也能立刻看到可用链接。 */
export function useCreateOutputShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; runId: string; path: string }) =>
      api.createOutputShare(input.conversationId, { runId: input.runId, path: input.path }),
    onSuccess: (share, input) => {
      const key = outputSharesQueryKey(input.conversationId, input.runId, input.path);
      client.setQueryData<OutputShareList>(key, (old) => ({
        items: [share, ...(old?.items ?? []).filter((item) => item.id !== share.id)],
      }));
      void client.invalidateQueries({ queryKey: key });
    },
  });
}

export function useRevokeOutputShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeOutputShare(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['output-shares'] }),
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

/** 一个 run 的全部原生提问；回答状态只放 Query 缓存，SSE 快照与提交结果都写这里。 */
export interface RunQuestionList {
  items: PublicRunQuestion[];
}

export const runQuestionsQueryKey = (runId: string) => ['run-questions', runId];

/** 状态只向前走：已回答/已拒答/已关闭的快照不会被迟到的 pending 覆盖。 */
function mergeRunQuestion(
  previous: PublicRunQuestion,
  incoming: PublicRunQuestion,
): PublicRunQuestion {
  return previous.status !== 'pending' && incoming.status === 'pending' ? previous : incoming;
}

export function withRunQuestion(
  items: PublicRunQuestion[] | undefined,
  question: PublicRunQuestion,
): PublicRunQuestion[] {
  if (items === undefined) return [question];
  const index = items.findIndex((item) => item.requestId === question.requestId);
  if (index < 0) return [...items, question];
  const current = items[index];
  return current === undefined ? items : items.with(index, mergeRunQuestion(current, question));
}

/** GET 结果与已缓存的较新状态合并，避免在途请求把刚回答的卡片打回待回答。 */
export function mergeRunQuestions(
  previous: PublicRunQuestion[] | undefined,
  incoming: PublicRunQuestion[],
): PublicRunQuestion[] {
  const merged = [...incoming];
  for (const item of previous ?? []) {
    const index = merged.findIndex((question) => question.requestId === item.requestId);
    if (index < 0) merged.push(item);
    else {
      const current = merged[index];
      if (current !== undefined) merged[index] = mergeRunQuestion(item, current);
    }
  }
  return merged;
}

/** 实时运行才轮询；结束后保留最后一次快照，刷新页面时历史里的工具快照仍可读。 */
export function useRunQuestions(runId: string | null, active = true) {
  const client = useQueryClient();
  const previous = useRef({ runId, active });
  useEffect(() => {
    const wasActive = previous.current.runId === runId && previous.current.active;
    previous.current = { runId, active };
    if (!runId || active || !wasActive) return;
    // 终态时再取一次，确保关闭/回答结果不只依赖最后一条 SSE。
    const queryKey = runQuestionsQueryKey(runId);
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  }, [runId, active, client]);
  return useQuery<RunQuestionList>({
    queryKey: runQuestionsQueryKey(runId ?? ''),
    queryFn: async () => {
      const key = runQuestionsQueryKey(runId ?? '');
      const fetched = await api.runQuestions(runId ?? '');
      return {
        items: mergeRunQuestions(client.getQueryData<RunQuestionList>(key)?.items, fetched.items),
      };
    },
    enabled: runId !== null,
    staleTime: 5_000,
    refetchInterval: active ? 2_000 : false,
  });
}

/** 提交回答或暂不回答；更新对应 run 的提问缓存，不新建运行。 */
export function useRespondToQuestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; requestId: string; response: PublicQuestionResponse }) =>
      api.respondToQuestion(input.runId, input.requestId, input.response),
    onSuccess: async (question) => {
      const queryKey = runQuestionsQueryKey(question.runId);
      // 先取消在途 GET，避免它带着旧的 pending 结果稍后覆盖这次回答。
      await client.cancelQueries({ queryKey });
      client.setQueryData<RunQuestionList>(queryKey, (previous) => ({
        items: withRunQuestion(previous?.items, question),
      }));
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

/** 「录制学习」：把一次运行沉淀为技能草稿，成功后刷新技能列表。 */
export function useSkillDraftFromRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.skillDraftFromRun(runId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

const AUDIT_PAGE_SIZE = 100;
export function useAudit(query: Omit<AuditQuery, 'before' | 'beforeId' | 'limit'>) {
  return useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam, signal }) =>
      api.audit(
        {
          ...query,
          limit: AUDIT_PAGE_SIZE,
          ...(pageParam === null ? {} : { beforeId: pageParam }),
        },
        signal,
      ),
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
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      runtimeEnvironmentId?: string | null;
    }): Promise<ServerTestResult> => api.testServer(vars.id, vars.runtimeEnvironmentId),
    // 后端把最近一次试连身份写进 server；刷新后卡片仍能显示这次实际用的环境。
    onSuccess: () => void client.invalidateQueries({ queryKey: ['servers'] }),
  });
}

export const runtimeEnvironmentsQuery = queryOptions<RuntimeEnvironment[]>({
  queryKey: ['runtime-environments'],
  queryFn: api.runtimeEnvironments,
});

export function runtimeEnvironmentQuery(id: string) {
  return queryOptions<RuntimeEnvironment>({
    queryKey: ['runtime-environments', id],
    queryFn: () => api.runtimeEnvironment(id),
  });
}

/** 只在使用中版本离开终态后继续轮询；全部结束就停止。 */
export function buildShouldPoll(
  versions: Array<Pick<RuntimeEnvironmentVersionSummary, 'status'>> | undefined,
): boolean {
  return (
    versions?.some((version) => version.status === 'queued' || version.status === 'building') ??
    false
  );
}

export function runtimeEnvironmentVersionsQuery(id: string) {
  return queryOptions<RuntimeEnvironmentVersionSummary[]>({
    queryKey: ['runtime-environments', id, 'versions'],
    queryFn: () => api.runtimeEnvironmentVersions(id),
    refetchInterval: (query) => (buildShouldPoll(query.state.data) ? 2_000 : false),
  });
}

export function runtimeEnvironmentVersionQuery(id: string, versionId: string) {
  return queryOptions<RuntimeEnvironmentVersion>({
    queryKey: ['runtime-environments', id, 'versions', versionId],
    queryFn: () => api.runtimeEnvironmentVersion(id, versionId),
    enabled: Boolean(versionId),
    refetchInterval: (query) =>
      buildShouldPoll(query.state.data ? [query.state.data] : undefined) ? 2_000 : false,
  });
}

export function useRuntimeEnvironments() {
  return useQuery(runtimeEnvironmentsQuery);
}

export function useRuntimeEnvironment(id: string) {
  return useQuery(runtimeEnvironmentQuery(id));
}

export function useRuntimeEnvironmentVersions(id: string) {
  return useQuery(runtimeEnvironmentVersionsQuery(id));
}

export function useRuntimeEnvironmentVersion(id: string, versionId: string) {
  return useQuery(runtimeEnvironmentVersionQuery(id, versionId));
}

export function useCreateRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createRuntimeEnvironment,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useUpdateRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Parameters<typeof api.updateRuntimeEnvironment>[1] }) =>
      api.updateRuntimeEnvironment(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useDeleteRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeEnvironment(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useBuildRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.buildRuntimeEnvironment,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function usePublishRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; versionId: string }) =>
      api.publishRuntimeEnvironment(vars.id, vars.versionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
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
    // 删除成功才移除缓存：失败时要保留详情与草稿，等用户重试或取消。
    onSuccess: (_data, id) => {
      client.setQueryData<Agent[]>(['agents'], (old) => old?.filter((agent) => agent.id !== id));
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['agents'] });
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

/** 市场搜索要求至少 2 个字符；空查询走 skills.sh 榜单。 */
export function useMarketSkills(view: MarketView, query: string) {
  // 每个字符都打一次 skills.sh 会把外部榜单打爆：停 300ms 再换 queryKey。
  const settled = useDebouncedValue(query.trim(), 300);
  const result = useQuery({
    queryKey: ['market-skills', view, settled],
    queryFn: ({ signal }) =>
      api.marketSkills({ view, ...(settled === '' ? {} : { q: settled }) }, signal),
    enabled: settled.length === 0 || settled.length >= 2,
    staleTime: 5 * 60_000,
  });
  // 防抖窗口里页面要显示加载态，不能继续展示上一个词的结果。
  return { ...result, isDebouncing: settled !== query.trim() };
}

export function useInstallMarketSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarketInstallInput) => api.installMarketSkill(input),
    onSuccess: ({ skill, warnings }) => {
      toastSuccess(`已安装「${skill.name}」`);
      for (const warning of warnings) toast.info(warning);
      // 安装总是新建，安装接口不返回 agentCount：先插一条 0，再由服务端结果校正。
      client.setQueryData<SkillWithAgentCount[]>(['skills'], (old) =>
        old ? [{ ...skill, agentCount: 0 }, ...old] : old,
      );
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: toastError,
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

export function useUpdatePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<PluginInput>; expectedUpdatedAt?: string }) =>
      api.updatePlugin(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

export function useImportPlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: Blob; slug: string }) => api.importPlugin(vars.file, vars.slug),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

/** 安装与纳入都不要草稿缓存，只让两份列表失效。 */
export function useInstallNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginInstallInput) => api.installNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins-native'] });
      void client.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useImportNativePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NativePluginImportInput) => api.importNativePlugin(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins-native'] });
      void client.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useDeletePlugin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['plugins'] });
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

const EVAL_RUNS_PAGE_SIZE = 50;

export function useEvalRuns(agentId: string | null) {
  return useInfiniteQuery({
    queryKey: ['eval-runs', agentId, EVAL_RUNS_PAGE_SIZE],
    queryFn: ({ pageParam, signal }) =>
      api.evalRuns(
        {
          ...(agentId === null ? {} : { agentId }),
          limit: EVAL_RUNS_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: agentId !== null,
    // 跑批在后台进行，已加载的列表里有 running 时轮询。
    refetchInterval: (query) => {
      const runs = query.state.data?.pages.flatMap((page) => page.items);
      return runs?.some((run) => run.status === 'running') ? 3_000 : false;
    },
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

// ---- 知识库 ---------------------------------------------------------------

/**
 * 轮询窗口按任务硬超时（与 worker KNOWLEDGE_TIMEOUT_MS 一致）：只有任务还在
 * 可能运行的窗口内才继续刷新。超窗后由页面显式提示手动刷新，不静默假装还在跑。
 */
const KNOWLEDGE_JOB_WINDOW_MS: Record<string, number> = {
  ingest: 30 * 60_000,
  sync: 30 * 60_000,
  reindex: 2 * 60 * 60_000,
  wiki_generate: 15 * 60_000,
  cleanup: 30 * 60_000,
};
/** 文档列表拿不到任务类型；按最长的摄取超时兜底，宁可多刷也不提前停。 */
const KNOWLEDGE_DOCUMENT_WINDOW_MS = 30 * 60_000;

type PollableJob = {
  status: string;
  type?: string;
  createdAt: string;
  startedAt?: string | null;
};

/** 活跃且仍未超过该类型的超时窗口；页面用同一函数决定「已停止自动刷新」提示。 */
export function knowledgeShouldPoll(items: readonly PollableJob[] | undefined): boolean {
  const now = Date.now();
  return (items ?? []).some((item) => {
    if (!['pending', 'queued', 'running', 'processing'].includes(item.status)) {
      return false;
    }
    const window =
      item.type === undefined
        ? KNOWLEDGE_DOCUMENT_WINDOW_MS
        : (KNOWLEDGE_JOB_WINDOW_MS[item.type] ?? KNOWLEDGE_DOCUMENT_WINDOW_MS);
    return now - new Date(item.startedAt ?? item.createdAt).getTime() < window;
  });
}

export const knowledgeKeys = {
  bases: ['knowledge', 'bases'] as const,
  base: (id: string) => ['knowledge', 'base', id] as const,
  documents: (baseId: string) => ['knowledge', 'documents', baseId] as const,
  chunks: (documentId: string, versionId: string) =>
    ['knowledge', 'chunks', documentId, versionId] as const,
  markdown: (versionId: string) => ['knowledge', 'markdown', versionId] as const,
  versionDetails: (versionId: string) => ['knowledge', 'version-details', versionId] as const,
  search: (baseId: string, q: string, limit: number) =>
    ['knowledge', 'search', baseId, q, limit] as const,
  jobs: (baseId: string) => ['knowledge', 'jobs', baseId] as const,
  job: (jobId: string) => ['knowledge', 'job', jobId] as const,
  folders: (baseId: string) => ['knowledge', 'folders', baseId] as const,
  tags: (baseId: string) => ['knowledge', 'tags', baseId] as const,
  sources: (baseId: string) => ['knowledge', 'sources', baseId] as const,
  sourceRuns: (sourceId: string) => ['knowledge', 'source-runs', sourceId] as const,
  wikiPages: (baseId: string) => ['knowledge', 'wiki-pages', baseId] as const,
  wikiPage: (pageId: string) => ['knowledge', 'wiki-page', pageId] as const,
  profiles: ['knowledge', 'model-profiles'] as const,
};

export function useKnowledgeBases() {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.bases,
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeBases(pageParam === null ? {} : { cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // 调用方（专家绑定等）只关心已加载的库；分页方法仍保留在结果上。
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useKnowledgeBase(id: string) {
  return useQuery({
    queryKey: knowledgeKeys.base(id),
    queryFn: () => api.knowledgeBase(id),
    staleTime: 0,
  });
}

export function useCreateKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeBaseInput) => api.createKnowledgeBase(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useUpdateKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { baseId: string; patch: Parameters<typeof api.updateKnowledgeBase>[1] }) =>
      api.updateKnowledgeBase(vars.baseId, vars.patch),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
      void client.invalidateQueries({ queryKey: knowledgeKeys.base(vars.baseId) });
    },
  });
}

export function useDeleteKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (baseId: string) => api.deleteKnowledgeBase(baseId),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useKnowledgeFolders(baseId: string) {
  return useQuery({
    queryKey: knowledgeKeys.folders(baseId),
    queryFn: () => api.knowledgeFolders(baseId),
  });
}

/** 文件夹与标签的写操作都会影响文档筛选与列表。 */
function useKnowledgeStructureInvalidate(baseId: string) {
  const client = useQueryClient();
  return (): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.folders(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.tags(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
  };
}

export function useCreateKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (input: { parentId: string | null; name: string }) =>
      api.createKnowledgeFolder(baseId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { folderId: string; patch: { name?: string } }) =>
      api.updateKnowledgeFolder(vars.folderId, vars.patch),
    onSuccess: invalidate,
  });
}

export function useDeleteKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (folderId: string) => api.deleteKnowledgeFolder(folderId),
    onSuccess: invalidate,
  });
}

export function useKnowledgeTags(baseId: string) {
  return useQuery({
    queryKey: knowledgeKeys.tags(baseId),
    queryFn: () => api.knowledgeTags(baseId),
  });
}

export function useCreateKnowledgeTag(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (name: string) => api.createKnowledgeTag(baseId, name),
    onSuccess: invalidate,
  });
}

export function useDeleteKnowledgeTag(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (tagId: string) => api.deleteKnowledgeTag(tagId),
    onSuccess: invalidate,
  });
}

const KNOWLEDGE_PAGE_SIZE = 50;

/**
 * 文档列表按游标翻页：首屏 50 条，其余由「加载更多」显式取。
 * 轮询只看已加载的条目，避免为检查状态把整库都拉下来。
 */
export function useKnowledgeDocuments(
  baseId: string,
  filter: { folderId?: string; tag?: string; status?: string; q?: string },
) {
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.documents(baseId), filter],
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeDocuments(
        baseId,
        {
          ...filter,
          limit: KNOWLEDGE_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // 摄取期间刷新状态；全部稳定或超过轮询窗口后停止。
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.pages.flatMap((page) => page.items)) ? 3_000 : false,
  });
}

export function useUploadKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.uploadKnowledgeDocument>[1]) =>
      api.uploadKnowledgeDocument(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      // 列表用游标分页，拉取过的页数要保持不变才能看到新文档。
      void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
    },
  });
}

/** 手写正文与 URL 抓取都由服务端建行并入队，成功后与上传同样刷新文档和任务。 */
function useKnowledgeDocumentImport(baseId: string) {
  const client = useQueryClient();
  return (): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
  };
}

export function useCreateKnowledgeManualDocument(baseId: string) {
  const invalidate = useKnowledgeDocumentImport(baseId);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeManualDocument>[1]) =>
      api.createKnowledgeManualDocument(baseId, input),
    onSuccess: invalidate,
  });
}

export function useImportKnowledgeUrl(baseId: string) {
  const invalidate = useKnowledgeDocumentImport(baseId);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.importKnowledgeUrl>[1]) =>
      api.importKnowledgeUrl(baseId, input),
    onSuccess: invalidate,
  });
}

export function useExportKnowledgeBase() {
  return useMutation({
    mutationFn: (baseId: string) => api.exportKnowledgeBase(baseId),
  });
}

export function useImportKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (archive: Blob) => api.importKnowledgeBase(archive),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useUpdateKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      documentId: string;
      patch: Parameters<typeof api.updateKnowledgeDocument>[1];
    }) => api.updateKnowledgeDocument(vars.documentId, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) }),
  });
}

export function useDeleteKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.deleteKnowledgeDocument(documentId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
    },
  });
}

/** 分块同样按游标翻页：一个版本的 chunk 可能上千条。 */
export function useKnowledgeDocumentChunks(documentId: string, versionId: string | null) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.chunks(documentId, versionId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeChunks(
        documentId,
        versionId ?? undefined,
        signal,
        pageParam === null ? undefined : pageParam,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: versionId !== null,
  });
}

export function useKnowledgeVersionDetails(versionId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.versionDetails(versionId ?? ''),
    queryFn: ({ signal }) => api.knowledgeVersionDetails(versionId ?? '', signal),
    enabled: versionId !== null,
    staleTime: 60_000,
  });
}

/** 解析正文按版本缓存：同一版本内容不变。 */
export function useKnowledgeMarkdown(versionId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.markdown(versionId ?? ''),
    queryFn: ({ signal }) => api.knowledgeMarkdown(versionId ?? '', signal),
    enabled: versionId !== null,
    staleTime: 60_000,
  });
}

export function useUpdateKnowledgeChunk(baseId: string, documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      chunkId: string;
      patch: Parameters<typeof api.updateKnowledgeChunk>[1];
    }) => api.updateKnowledgeChunk(vars.chunkId, vars.patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', documentId] });
      // 改正文会清空向量并补建，任务列表需要刷新。
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useDeleteKnowledgeChunk(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) => api.deleteKnowledgeChunk(chunkId),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', documentId] }),
  });
}

export function useReprocessKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    // 确认框已说明人工分块会丢弃，这里显式覆盖，避免后端一律拒绝。
    mutationFn: (documentId: string) => api.reprocessKnowledgeDocument(documentId, true),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useKnowledgeSearch(baseId: string, q: string, limit = 10) {
  const term = q.trim();
  return useQuery<KnowledgeSearchResponse>({
    queryKey: knowledgeKeys.search(baseId, term, limit),
    queryFn: ({ signal }) => api.knowledgeSearch(baseId, term, limit, signal),
    enabled: term.length > 0,
    staleTime: 10_000,
  });
}

export function useKnowledgeJobs(baseId: string) {
  return useQuery({
    queryKey: knowledgeKeys.jobs(baseId),
    queryFn: () => api.knowledgeJobs(baseId),
    select: (page) => page.items,
    refetchInterval: (query) => (knowledgeShouldPoll(query.state.data?.items) ? 2_000 : false),
  });
}

export function useRetryKnowledgeJob(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.retryKnowledgeJob(jobId),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) }),
  });
}

export function useCancelKnowledgeJob(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelKnowledgeJob(jobId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

/** 来源是小型集合：一次取完全部元数据页，调用方拿到的仍是数组。 */
export function useKnowledgeSources(baseId: string) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.sources(baseId),
    queryFn: ({ pageParam }) => api.knowledgeSources(baseId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useCreateKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeSourceInput) => api.createKnowledgeSource(baseId, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) }),
  });
}

export function useDeleteKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { sourceId: string; documents: 'keep' | 'delete' }) =>
      api.deleteKnowledgeSource(vars.sourceId, vars.documents),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
      // 选 delete 时文档也一并消失。
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

export function useUpdateKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      sourceId: string;
      patch: Parameters<typeof api.updateKnowledgeSource>[1];
    }) => api.updateKnowledgeSource(vars.sourceId, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) }),
  });
}

export function useTestKnowledgeSource() {
  return useMutation({
    mutationFn: (sourceId: string) => api.testKnowledgeSource(sourceId),
  });
}

export function useSyncKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.syncKnowledgeSource(sourceId),
    onSuccess: (_result, sourceId) => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.sourceRuns(sourceId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useKnowledgeSourceRuns(sourceId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.sourceRuns(sourceId ?? ''),
    queryFn: () => api.knowledgeSourceRuns(sourceId ?? ''),
    enabled: sourceId !== null,
    select: (page) => page.items,
    // 同步进行中才轮询；终态或超过窗口后停止。
    refetchInterval: (query) => (knowledgeShouldPoll(query.state.data?.items) ? 2_000 : false),
  });
}

/** Wiki 页面同样是小型集合：一次取完全部元数据页，避免旧页面永久不可选。 */
export function useKnowledgeWikiPages(baseId: string) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.wikiPages(baseId),
    queryFn: ({ pageParam }) => api.knowledgeWikiPages(baseId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useKnowledgeWikiPage(pageId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.wikiPage(pageId ?? ''),
    queryFn: () => api.knowledgeWikiPage(pageId ?? ''),
    enabled: pageId !== null,
    staleTime: 0,
  });
}

/** 详情只回第一页版本；更早的版本按游标显式加载，追加到本页列表。 */
export function useLoadOlderKnowledgeWikiVersions() {
  return useMutation({
    mutationFn: (vars: { pageId: string; cursor: string }) =>
      api.knowledgeWikiVersions(vars.pageId, vars.cursor),
  });
}

export function useCreateKnowledgeWikiPage(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: string; title: string }) =>
      api.createKnowledgeWikiPage(baseId, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) }),
  });
}

/** Wiki 写操作都会产生新版本，页面详情与列表一起失效。 */
function useKnowledgeWikiInvalidate(baseId: string) {
  const client = useQueryClient();
  return (pageId: string): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPage(pageId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
  };
}

export function useSaveKnowledgeWikiPage(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: {
      pageId: string;
      patch: { title?: string; markdown?: string; expectedVersion?: string | null };
    }) => api.updateKnowledgeWikiPage(vars.pageId, vars.patch),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}

export function useGenerateKnowledgeWikiPage() {
  // Invalidation waits for the submitted job to reach a terminal state; the page tracks its id.
  return useMutation({
    mutationFn: (vars: { pageId: string; instruction?: string }) =>
      api.generateKnowledgeWikiPage(vars.pageId, {
        ...(vars.instruction ? { instruction: vars.instruction } : {}),
      }),
  });
}

export function useRollbackKnowledgeWikiPage(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { pageId: string; versionId: string }) =>
      api.rollbackKnowledgeWikiPage(vars.pageId, vars.versionId),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}

/** 发布只是切当前指针；草稿仍留在版本列表里，历史版本不消失。 */
export function usePublishKnowledgeWikiVersion(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { pageId: string; versionId: string }) =>
      api.publishKnowledgeWikiVersion(vars.pageId, vars.versionId),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}

export function useKnowledgeModelProfiles() {
  return useQuery({
    queryKey: knowledgeKeys.profiles,
    queryFn: () => api.knowledgeModelProfiles(),
    staleTime: 60_000,
  });
}

/** 知识库必须绑定 embedding profile；首次使用时在新建弹层里就地创建。 */
export function useCreateKnowledgeModelProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeModelProfile>[0]) =>
      api.createKnowledgeModelProfile(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.profiles }),
  });
}
