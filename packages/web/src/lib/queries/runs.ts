import type { ChatRequest, PublicQuestionResponse, PublicRunQuestion } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type ApprovalRequestList,
  api,
  type RunDetail,
  type RunList,
  type RunQuery,
} from '../api.js';
import { mergeRunQuestions, useRefetchWhenRunEnds, withRunQuestion } from './shared.js';

export function useRuns(query: RunQuery = {}, enabled = true) {
  const queryKey: (string | number | null)[] = [
    'runs',
    query.agentId ?? null,
    query.status ?? null,
    query.limit ?? 50,
  ];
  if (query.trigger) queryKey.push(query.trigger);
  return useQuery<RunList>({
    queryKey,
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

/** 恢复会话与运行详情页共用同一份运行缓存，同键才能复用。 */
export const runQuery = (runId: string) =>
  queryOptions<RunDetail>({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => api.run(runId, signal),
    // 短 staleTime：恢复后 useRun 立即挂载也不会重复请求，轮询仍按间隔继续。
    staleTime: 5_000,
  });

export function useRun(runId: string, poll = true) {
  return useQuery({
    ...runQuery(runId),
    // 运行中要能看到新落库的步骤；会话里事件流健康时可临时关掉周期请求。
    refetchInterval: (query) =>
      poll &&
      (query.state.data?.run.status === 'running' || query.state.data?.run.status === 'queued')
        ? 2_000
        : false,
  });
}

/** 审批请求由 MCP 端点在工具被拒时写入；运行期间轮询，结束后停。 */
export function useRunApprovals(runId: string | null, active = true) {
  const queryKey = useMemo(() => ['run-approvals', runId], [runId]);
  useRefetchWhenRunEnds(runId ?? '', active, queryKey);
  return useQuery<ApprovalRequestList>({
    queryKey,
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

export function useDenyRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; serverId: string; toolName: string }) =>
      api.denyRun(input.runId, input.serverId, input.toolName),
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

/** 实时运行才轮询；结束后保留最后一次快照，刷新页面时历史里的工具快照仍可读。 */
export function useRunQuestions(runId: string | null, active = true) {
  const client = useQueryClient();
  const queryKey = useMemo(() => runQuestionsQueryKey(runId ?? ''), [runId]);
  useRefetchWhenRunEnds(runId ?? '', active, queryKey);
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
