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

export const agentMemoryKeys = {
  list: (...ids: [] | [string]) => ['agent-memory', ...ids] as const,
  file: (...parts: [] | [string] | [string, string]) => ['agent-memory-file', ...parts] as const,
  /** 概览与装配挂在列表前缀下：记忆写入失效列表时统计一起刷新。 */
  overview: (id: string) => ['agent-memory', id, 'overview'] as const,
  assembly: (id: string) => ['agent-memory', id, 'assembly'] as const,
};

export const agentMemoryQuery = (id: string) =>
  queryOptions<MemoryFileList>({
    queryKey: agentMemoryKeys.list(id),
    queryFn: () => api.agentMemory(id),
  });

/** 记忆概览只读派生数据：策略、索引/主题/规则/个人记忆规模、健康提示与最近账本。 */
export const agentMemoryOverviewQuery = (id: string) =>
  queryOptions<AgentMemoryOverview>({
    queryKey: agentMemoryKeys.overview(id),
    queryFn: () => api.agentMemoryOverview(id),
  });

/** 运行期装配视图；与概览分开请求，任一失败不阻塞另一块。 */
export const agentMemoryAssemblyQuery = (id: string) =>
  queryOptions<AgentMemoryAssembly>({
    queryKey: agentMemoryKeys.assembly(id),
    queryFn: () => api.agentMemoryAssembly(id),
  });

/** 策略同时决定概览里的健康提示与装配里的 skipped 原因，两份快照都要失效。 */
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
export const memoryVersionsQuery = (target: MemoryReviewTarget, enabled = true) =>
  queryOptions<{ items: MemoryChange[] }>({
    queryKey: ['memory-versions', target],
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
  void client.invalidateQueries({ queryKey: agentMemoryKeys.list() });
  // 采纳主题会同时补索引，两个文件的正文缓存都必须刷新。
  void client.invalidateQueries({ queryKey: agentMemoryKeys.file() });
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
  // 深链详情可能不在列表页里，单独按 run 缓存的详情也要刷新。
  void client.invalidateQueries({ queryKey: ['memory-review'] });
}

/** 列表分页外的回顾（如深链 run）按 id 取同一份详情；运行中同样 3 秒刷新。 */
export const memoryReviewQuery = (runId: string) =>
  queryOptions<MemoryReview>({
    queryKey: ['memory-review', runId],
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

/** 取消生成复用运行取消接口；列表继续轮询到服务端终态。 */
export function useCancelMemoryReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: () => invalidateMemoryReviews(client),
  });
}
