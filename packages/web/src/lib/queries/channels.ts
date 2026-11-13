import type {
  ChannelDetail,
  ChannelListItem,
  ChannelMessage,
  ChannelRole,
  PublicQuestionResponse,
} from '@agentport/shared';
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  api,
  type ChannelActiveRun,
  type ChannelApproval,
  type ChannelRunDetail,
  type ChannelRunOutputContent,
  type ChannelRunQuestions,
} from '../api.js';
import { mergeChannelMessages } from '../channel-state.js';
import { mergeRunQuestions, useRefetchWhenRunEnds, withRunQuestion } from './shared.js';

// ---- 频道 ----------------------------------------------------------------

export const channelsQuery = queryOptions<ChannelListItem[]>({
  queryKey: ['channels'],
  queryFn: ({ signal }) => api.channels(signal),
  staleTime: 0,
});

export const channelQuery = (id: string) =>
  queryOptions<ChannelDetail>({
    queryKey: ['channel', id],
    queryFn: ({ signal }) => api.channel(id, signal),
    staleTime: 0,
  });

export const CHANNEL_MESSAGES_PAGE_SIZE = 200;

/** 取最新一页；更早消息由频道页按 before 游标补齐，重取只能并入不能替换。 */
export const channelMessagesQuery = (id: string) =>
  queryOptions<ChannelMessage[]>({
    queryKey: ['channel-messages', id],
    queryFn: ({ signal }) =>
      api.channelMessages(
        id,
        { before: Number.MAX_SAFE_INTEGER, limit: CHANNEL_MESSAGES_PAGE_SIZE },
        signal,
      ),
    staleTime: 0,
  });

export const channelRunsQuery = (id: string) =>
  queryOptions<ChannelActiveRun[]>({
    queryKey: ['channel-runs', id],
    queryFn: async ({ signal }) => (await api.channelRuns(id, signal)).items,
    // 事件流负责实时；低频轮询兜底漏发的 run 生命周期事件。
    refetchInterval: 15_000,
  });

export const channelApprovalsQuery = (id: string) =>
  queryOptions<ChannelApproval[]>({
    queryKey: ['channel-approvals', id],
    queryFn: async ({ signal }) => (await api.channelApprovals(id, signal)).items,
    refetchInterval: 15_000,
  });

export const channelRunDetailQueryKey = (channelId: string, runId: string) =>
  ['channel-run-detail', channelId, runId] as const;

export const channelRunQuestionsQueryKey = (channelId: string, runId: string) =>
  ['channel-run-questions', channelId, runId] as const;

export const channelRunOutputsQueryKey = (channelId: string, runId: string | null) =>
  ['channel-run-outputs', channelId, runId] as const;

const channelRunOutputContentQueryKey = (channelId: string, runId: string, path: string | null) =>
  ['channel-run-output-content', channelId, runId, path] as const;

const channelRunOutputBlobQueryKey = (channelId: string, runId: string, path: string | null) =>
  ['channel-run-output-blob', channelId, runId, path] as const;

export function useChannels() {
  return useQuery(channelsQuery);
}

export function useChannel(id: string) {
  return useQuery(channelQuery(id));
}

export function useChannelMessages(id: string) {
  const client = useQueryClient();
  return useQuery({
    ...channelMessagesQuery(id),
    // 缓存可能已补入更早消息与 SSE 消息，重取最新页只能并入，否则更早区间永久丢失。
    queryFn: async ({ signal }) => {
      const page = await api.channelMessages(
        id,
        { before: Number.MAX_SAFE_INTEGER, limit: CHANNEL_MESSAGES_PAGE_SIZE },
        signal,
      );
      return mergeChannelMessages(
        client.getQueryData<ChannelMessage[]>(channelMessagesQuery(id).queryKey) ?? [],
        page,
      );
    },
  });
}

export function useChannelRuns(id: string) {
  return useQuery(channelRunsQuery(id));
}

export function useChannelApprovals(id: string) {
  return useQuery(channelApprovalsQuery(id));
}

export function useCreateChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) => api.createChannel(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useUpdateChannel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      api.updateChannel(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useAddChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { businessId: string; role: ChannelRole }) =>
      api.addChannelMember(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useUpdateChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; role: ChannelRole }) =>
      api.updateChannelMember(id, vars.businessId, vars.role),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useRemoveChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (businessId: string) => api.removeChannelMember(id, businessId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useRemoveChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.removeChannelAgent(id, agentId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useDisconnectChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.disconnectChannelAgent(id, agentId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useCloseChannel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.closeChannel(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useBindChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; autoWakeOnAll?: boolean }) =>
      api.bindChannelAgent(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useUpdateChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; autoWakeOnAll: boolean }) =>
      api.updateChannelAgent(id, vars.agentId, { autoWakeOnAll: vars.autoWakeOnAll }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['channel', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useStopChannelRun(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.stopChannelRun(id, runId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['channel-runs', id] }),
  });
}

export function useApproveChannelApproval(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => api.approveChannelApproval(id, approvalId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['channel-approvals', id] }),
  });
}

export function useMarkChannelRead(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) => api.markChannelRead(id, seq),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useChannelRunDetail(channelId: string, runId: string) {
  return useQuery<ChannelRunDetail>({
    queryKey: channelRunDetailQueryKey(channelId, runId),
    queryFn: ({ signal }) => api.channelRunDetail(channelId, runId, signal),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'queued' || status === 'running' ? 2_000 : false;
    },
  });
}

export function useChannelRunQuestions(channelId: string, runId: string, active: boolean) {
  const client = useQueryClient();
  const queryKey = useMemo(() => channelRunQuestionsQueryKey(channelId, runId), [channelId, runId]);
  useRefetchWhenRunEnds(`${channelId}/${runId}`, active, queryKey);
  return useQuery<ChannelRunQuestions>({
    queryKey: channelRunQuestionsQueryKey(channelId, runId),
    queryFn: async () => {
      const key = channelRunQuestionsQueryKey(channelId, runId);
      const fetched = await api.channelRunQuestions(channelId, runId);
      return {
        items: mergeRunQuestions(
          client.getQueryData<ChannelRunQuestions>(key)?.items,
          fetched.items,
        ),
      };
    },
    staleTime: 0,
    refetchInterval: active ? 2_000 : false,
  });
}

export function useRespondToChannelQuestion(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; requestId: string; response: PublicQuestionResponse }) =>
      api.respondToChannelQuestion(channelId, input.runId, input.requestId, input.response),
    onSuccess: async (question) => {
      const queryKey = channelRunQuestionsQueryKey(channelId, question.runId);
      await client.cancelQueries({ queryKey });
      client.setQueryData<ChannelRunQuestions>(queryKey, (previous) => ({
        items: withRunQuestion(previous?.items, question),
      }));
    },
  });
}

export function useChannelRunOutputs(channelId: string, runId: string | null) {
  return useInfiniteQuery({
    queryKey: channelRunOutputsQueryKey(channelId, runId),
    queryFn: ({ pageParam, signal }) =>
      api.channelRunOutputs(
        channelId,
        runId ?? '',
        { limit: 50, ...(pageParam === null ? {} : { before: pageParam }) },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: runId !== null,
    staleTime: 0,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.items),
      nextBefore: data.pages.at(-1)?.nextBefore ?? null,
    }),
  });
}

export function useChannelRunOutputContent(channelId: string, runId: string, path: string | null) {
  return useQuery<ChannelRunOutputContent>({
    queryKey: channelRunOutputContentQueryKey(channelId, runId, path),
    queryFn: ({ signal }) => api.channelRunOutputContent(channelId, runId, path ?? '', signal),
    enabled: path !== null,
    staleTime: 5 * 60_000,
  });
}

export function useChannelRunOutputBlob(
  channelId: string,
  runId: string,
  path: string | null,
  enabled: boolean,
) {
  return useQuery<Blob>({
    queryKey: channelRunOutputBlobQueryKey(channelId, runId, path),
    queryFn: ({ signal }) => api.channelRunOutputBlob(channelId, runId, path ?? '', signal),
    enabled: path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}
