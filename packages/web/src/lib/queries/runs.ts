import type { ChatRequest, PublicQuestionResponse, PublicRunQuestion } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type ApprovalRequestList,
  api,
  type RunDetail,
  type RunFeedbackList,
  type RunList,
  type RunQuery,
  type SubmitRunFeedback,
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
  if (query.since) queryKey.push(query.since);
  return useQuery<RunList>({
    queryKey,
    queryFn: () => api.runs(query),
    enabled,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'queued' || run.status === 'running')
        ? 5_000
        : false,
  });
}

export const runQuery = (runId: string) =>
  queryOptions<RunDetail>({
    queryKey: ['run', runId],
    queryFn: ({ signal }) => api.run(runId, signal),
    staleTime: 5_000,
  });

export function useRun(runId: string, poll = true) {
  return useQuery({
    ...runQuery(runId),
    refetchInterval: (query) =>
      poll &&
      (query.state.data?.run.status === 'running' || query.state.data?.run.status === 'queued')
        ? 2_000
        : false,
  });
}

export function useRunApprovals(runId: string | null, active = true) {
  const queryKey = useMemo(() => ['run-approvals', runId], [runId]);
  useRefetchWhenRunEnds(runId ?? '', active, queryKey);
  return useQuery<ApprovalRequestList>({
    queryKey,
    queryFn: () => api.runApprovals(runId ?? ''),
    enabled: runId !== null,
    refetchInterval: active ? 2_000 : false,
  });
}

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

export function useRunFeedback(runId: string) {
  return useQuery<RunFeedbackList>({
    queryKey: ['run-feedback', runId],
    queryFn: () => api.runFeedback(runId),
    staleTime: 5_000,
  });
}

export function useSubmitRunFeedback() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, ...body }: { runId: string } & SubmitRunFeedback) =>
      api.submitRunFeedback(runId, body),
    onSuccess: (_feedback, input) =>
      void client.invalidateQueries({ queryKey: ['run-feedback', input.runId] }),
  });
}

export interface RunQuestionList {
  items: PublicRunQuestion[];
}

export const runQuestionsQueryKey = (runId: string) => ['run-questions', runId];

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

export function useRespondToQuestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; requestId: string; response: PublicQuestionResponse }) =>
      api.respondToQuestion(input.runId, input.requestId, input.response),
    onSuccess: async (question) => {
      const queryKey = runQuestionsQueryKey(question.runId);
      await client.cancelQueries({ queryKey });
      client.setQueryData<RunQuestionList>(queryKey, (previous) => ({
        items: withRunQuestion(previous?.items, question),
      }));
    },
  });
}

export function useRerun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatRequest) => api.sendChat(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runs'] }),
  });
}
