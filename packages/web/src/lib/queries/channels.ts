import type {
  ChannelDetail,
  ChannelMessage,
  ChannelRole,
  PublicQuestionResponse,
} from '@agentport/shared';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  api,
  type ChannelActiveRun,
  type ChannelApproval,
  type ChannelHandoffInput,
  type ChannelRunDetail,
  type ChannelRunOutputContent,
  type ChannelRunQuestions,
} from '../api.js';
import { mergeChannelMessages } from '../channel-state.js';
import { useCursorList } from './client.js';
import { mergeRunQuestions, useRefetchWhenRunEnds, withRunQuestion } from './run-questions.js';

export const channelKeys = {
  all: ['channels'] as const,
  detail: (id: string) => ['channel', id] as const,
  messages: (id: string) => ['channel-messages', id] as const,
  runs: (id: string) => ['channel-runs', id] as const,
  approvals: (id: string) => ['channel-approvals', id] as const,
  runDetail: (channelId: string, runId: string) =>
    ['channel-run-detail', channelId, runId] as const,
  runQuestions: (channelId: string, runId: string) =>
    ['channel-run-questions', channelId, runId] as const,
  runOutputs: (channelId: string, runId: string | null) =>
    ['channel-run-outputs', channelId, runId] as const,
  runOutputContent: (channelId: string, runId: string, path: string | null) =>
    ['channel-run-output-content', channelId, runId, path] as const,
  runOutputBlob: (channelId: string, runId: string, path: string | null) =>
    ['channel-run-output-blob', channelId, runId, path] as const,
};

function invalidateChannel(client: QueryClient, id: string) {
  void client.invalidateQueries({ queryKey: channelKeys.detail(id) });
  void client.invalidateQueries({ queryKey: channelKeys.all });
}

const channelQuery = (id: string) =>
  queryOptions<ChannelDetail>({
    queryKey: channelKeys.detail(id),
    queryFn: ({ signal }) => api.channel(id, signal),
    staleTime: 0,
  });

export const CHANNEL_MESSAGES_PAGE_SIZE = 200;

async function fetchChannelMessages(
  id: string,
  client: QueryClient,
  signal?: AbortSignal,
): Promise<ChannelMessage[]> {
  const page = await api.channelMessages(
    id,
    { before: Number.MAX_SAFE_INTEGER, limit: CHANNEL_MESSAGES_PAGE_SIZE },
    signal,
  );
  return mergeChannelMessages(
    client.getQueryData<ChannelMessage[]>(channelKeys.messages(id)) ?? [],
    page,
  );
}

const channelRunsQuery = (id: string) =>
  queryOptions<ChannelActiveRun[]>({
    queryKey: channelKeys.runs(id),
    queryFn: async ({ signal }) => (await api.channelRuns(id, signal)).items,
    refetchInterval: 15_000,
  });

const channelApprovalsQuery = (id: string) =>
  queryOptions<ChannelApproval[]>({
    queryKey: channelKeys.approvals(id),
    queryFn: async ({ signal }) => (await api.channelApprovals(id, signal)).items,
    refetchInterval: 15_000,
  });

export function useChannels() {
  return useCursorList({
    queryKey: channelKeys.all,
    queryFn: (cursor, signal) => api.channels(cursor, signal),
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useChannel(id: string) {
  return useQuery(channelQuery(id));
}

export function useChannelMessages(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: channelKeys.messages(id),
    queryFn: ({ signal }) => fetchChannelMessages(id, client, signal),
    staleTime: 0,
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
    onSuccess: () => void client.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

export function useUpdateChannel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      api.updateChannel(id, input),
    onSuccess: () => invalidateChannel(client, id),
  });
}

export function useAddChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { businessId: string; role: ChannelRole }) =>
      api.addChannelMember(id, input),
    onSuccess: () => invalidateChannel(client, id),
  });
}

export function useUpdateChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { businessId: string; role: ChannelRole }) =>
      api.updateChannelMember(id, vars.businessId, vars.role),
    onSuccess: () => invalidateChannel(client, id),
  });
}

export function useRemoveChannelMember(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (businessId: string) => api.removeChannelMember(id, businessId),
    onSettled: () => invalidateChannel(client, id),
  });
}

export function useRemoveChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.removeChannelAgent(id, agentId),
    onSettled: () => invalidateChannel(client, id),
  });
}

export function useDisconnectChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.disconnectChannelAgent(id, agentId),
    onSettled: () => invalidateChannel(client, id),
  });
}

export function useCloseChannel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.closeChannel(id),
    onSettled: () => invalidateChannel(client, id),
  });
}

export function useBindChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; autoWakeOnAll?: boolean }) =>
      api.bindChannelAgent(id, input),
    onSuccess: () => invalidateChannel(client, id),
  });
}

export function useUpdateChannelAgent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; autoWakeOnAll: boolean }) =>
      api.updateChannelAgent(id, vars.agentId, { autoWakeOnAll: vars.autoWakeOnAll }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: channelKeys.detail(id) });
      const prev = client.getQueryData<ChannelDetail>(channelKeys.detail(id));
      if (prev) {
        client.setQueryData<ChannelDetail>(channelKeys.detail(id), (old) =>
          old
            ? {
                ...old,
                agentBindings: old.agentBindings.map((b) =>
                  b.agentId === vars.agentId ? { ...b, autoWakeOnAll: vars.autoWakeOnAll } : b,
                ),
              }
            : old,
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        client.setQueryData<ChannelDetail>(channelKeys.detail(id), ctx.prev);
      }
      void client.invalidateQueries({ queryKey: channelKeys.detail(id) });
    },
    onSuccess: () => invalidateChannel(client, id),
  });
}

export function useChannelHandoff(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChannelHandoffInput) => api.handoffChannel(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: channelKeys.all });
      void client.invalidateQueries({ queryKey: channelKeys.messages(id) });
    },
  });
}

export function useStopChannelRun(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.stopChannelRun(id, runId),
    onSuccess: () => void client.invalidateQueries({ queryKey: channelKeys.runs(id) }),
  });
}

export function useApproveChannelApproval(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => api.approveChannelApproval(id, approvalId),
    onSuccess: () => void client.invalidateQueries({ queryKey: channelKeys.approvals(id) }),
  });
}

export function useDenyChannelApproval(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => api.denyChannelApproval(id, approvalId),
    onSuccess: () => void client.invalidateQueries({ queryKey: channelKeys.approvals(id) }),
  });
}

export function useMarkChannelRead(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) => api.markChannelRead(id, seq),
    onSuccess: () => void client.invalidateQueries({ queryKey: channelKeys.all }),
  });
}

export function useChannelRunDetail(channelId: string, runId: string) {
  return useQuery<ChannelRunDetail>({
    queryKey: channelKeys.runDetail(channelId, runId),
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
  const queryKey = useMemo(() => channelKeys.runQuestions(channelId, runId), [channelId, runId]);
  useRefetchWhenRunEnds(`${channelId}/${runId}`, active, queryKey);
  return useQuery<ChannelRunQuestions>({
    queryKey: channelKeys.runQuestions(channelId, runId),
    queryFn: async () => {
      const key = channelKeys.runQuestions(channelId, runId);
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
      const queryKey = channelKeys.runQuestions(channelId, question.runId);
      await client.cancelQueries({ queryKey });
      client.setQueryData<ChannelRunQuestions>(queryKey, (previous) => ({
        items: withRunQuestion(previous?.items, question),
      }));
    },
  });
}

export function useChannelRunOutputs(channelId: string, runId: string | null) {
  return useCursorList({
    queryKey: channelKeys.runOutputs(channelId, runId),
    queryFn: (cursor, signal) =>
      api.channelRunOutputs(
        channelId,
        runId ?? '',
        { limit: 50, ...(cursor === undefined ? {} : { cursor }) },
        signal,
      ),
    enabled: runId !== null,
    staleTime: 0,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.items),
      nextCursor: data.pages.at(-1)?.nextCursor ?? null,
    }),
  });
}

export function useChannelRunOutputContent(channelId: string, runId: string, path: string | null) {
  return useQuery<ChannelRunOutputContent>({
    queryKey: channelKeys.runOutputContent(channelId, runId, path),
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
    queryKey: channelKeys.runOutputBlob(channelId, runId, path),
    queryFn: ({ signal }) => api.channelRunOutputBlob(channelId, runId, path ?? '', signal),
    enabled: path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}
