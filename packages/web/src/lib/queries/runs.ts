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
import { useCursorList } from './client.js';
import { mergeRunQuestions, useRefetchWhenRunEnds, withRunQuestion } from './run-questions.js';

export const runKeys = {
  all: ['runs'] as const,
  list: (query: RunQuery = {}) =>
    [
      'runs',
      query.agentId ?? null,
      query.status ?? null,
      query.trigger ?? null,
      query.since ?? null,
      query.limit ?? 50,
    ] as const,
  detail: (runId: string) => ['run', runId] as const,
  approvals: (runId: string | null) => ['run-approvals', runId] as const,
  feedback: (runId: string) => ['run-feedback', runId] as const,
  feedbackAll: ['run-feedback'] as const,
  questions: (runId: string) => ['run-questions', runId] as const,
};

export function useRuns(query: RunQuery = {}, enabled = true) {
  return useCursorList<RunList>({
    queryKey: runKeys.list(query),
    queryFn: (cursor, signal) =>
      api.runs({ ...query, ...(cursor === undefined ? {} : { cursor }) }, signal),
    enabled,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((run) => run.status === 'queued' || run.status === 'running'),
      )
        ? 5_000
        : false,
  });
}

export const runQuery = (runId: string) =>
  queryOptions<RunDetail>({
    queryKey: runKeys.detail(runId),
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
  const queryKey = useMemo(() => runKeys.approvals(runId), [runId]);
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
    mutationFn: (input: { runId: string; approvalId: string }) =>
      api.approveRun(input.runId, input.approvalId),
    onSuccess: (_data, input) =>
      void client.invalidateQueries({ queryKey: runKeys.approvals(input.runId) }),
  });
}

export function useDenyRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; approvalId: string }) =>
      api.denyRun(input.runId, input.approvalId),
    onSuccess: (_data, input) =>
      void client.invalidateQueries({ queryKey: runKeys.approvals(input.runId) }),
  });
}

export function useCancelRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (_data, runId) => {
      void client.invalidateQueries({ queryKey: runKeys.detail(runId) });
      void client.invalidateQueries({ queryKey: runKeys.all });
    },
  });
}

export function useRunFeedback(runId: string) {
  return useQuery<RunFeedbackList>({
    queryKey: runKeys.feedback(runId),
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
      void client.invalidateQueries({ queryKey: runKeys.feedback(input.runId) }),
  });
}

export interface RunQuestionList {
  items: PublicRunQuestion[];
}

export const runQuestionsQueryKey = (runId: string) => runKeys.questions(runId);

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
    onSuccess: () => void client.invalidateQueries({ queryKey: runKeys.all }),
  });
}
