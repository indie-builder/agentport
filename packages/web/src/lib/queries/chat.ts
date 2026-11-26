import type { OutputContent, OutputFile } from '@agentport/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type ConversationDetail,
  type ConversationSearchOptions,
  type OutputShareList,
} from '../api.js';
import { useCursorList } from './client.js';

export const chatKeys = {
  conversations: (...ids: [] | [string | null]) => ['conversations', ...ids] as const,
  conversation: (id: string | null) => ['conversation', id] as const,
  outputs: (id: string | null) => ['conversation-outputs', id] as const,
  runOutputs: (id: string | null, runId: string) => ['run-outputs', id, runId] as const,
  outputContent: (id: string | null, runId: string | null, path: string | null) =>
    ['conversation-output-content', id, runId, path] as const,
  outputFile: (id: string | null, runId: string | null, path: string | null) =>
    ['conversation-output-file', id, runId, path] as const,
  outputBlob: (id: string | null, runId: string | null, path: string | null) =>
    ['conversation-output-blob', id, runId, path] as const,
  search: (options: ConversationSearchOptions) =>
    [
      'conversation-search',
      options.q ?? '',
      options.agentId ?? null,
      options.limit ?? 20,
      options.cursor ?? null,
    ] as const,
  outputShares: (conversationId: string | null, runId: string | null, path: string | null) =>
    ['output-shares', conversationId, runId, path] as const,
  outputSharesAll: ['output-shares'] as const,
};

export function useConversations(agentId: string | null) {
  return useCursorList({
    queryKey: chatKeys.conversations(agentId),
    queryFn: (cursor, signal) =>
      api.conversations(
        {
          ...(agentId === null ? {} : { agentId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled: agentId !== null,
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

const CONVERSATION_PAGE_SIZE = 50;

export function useConversation(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: chatKeys.conversation(conversationId),
    queryFn: ({ pageParam, signal }) =>
      api.conversation(
        conversationId ?? '',
        {
          limit: CONVERSATION_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
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
        nextCursor: data.pages.at(-1)?.nextCursor ?? null,
      };
    },
  });
}

export function useConversationOutputs(conversationId: string | null, runId: string | null = null) {
  return useCursorList({
    queryKey:
      runId === null
        ? chatKeys.outputs(conversationId)
        : chatKeys.runOutputs(conversationId, runId),
    queryFn: (cursor, signal) =>
      api.outputs(
        conversationId ?? '',
        {
          limit: 50,
          ...(runId === null ? {} : { runId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled: conversationId !== null,
    staleTime: 0,
    select: (data) => ({
      items: data.pages.flatMap((page) => page.items),
      nextCursor: data.pages.at(-1)?.nextCursor ?? null,
    }),
  });
}

export function useOutputContent(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
) {
  return useQuery<OutputContent>({
    queryKey: chatKeys.outputContent(conversationId, runId, path),
    queryFn: ({ signal }) =>
      api.outputContent(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null,
    staleTime: 5 * 60_000,
  });
}

export function useOutputFile(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery<{ file: OutputFile }>({
    queryKey: chatKeys.outputFile(conversationId, runId, path),
    queryFn: ({ signal }) => api.outputFile(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useOutputBlob(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery<Blob>({
    queryKey: chatKeys.outputBlob(conversationId, runId, path),
    queryFn: ({ signal }) => api.outputBlob(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useOutputShares(
  conversationId: string | null,
  runId: string | null,
  path: string | null,
) {
  return useQuery<OutputShareList>({
    queryKey: chatKeys.outputShares(conversationId, runId, path),
    queryFn: ({ signal }) =>
      api.outputShares(conversationId ?? '', { runId: runId ?? '', path: path ?? '' }, signal),
    enabled: conversationId !== null && runId !== null && path !== null,
    staleTime: 0,
  });
}

export function useCreateOutputShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; runId: string; path: string }) =>
      api.createOutputShare(input.conversationId, { runId: input.runId, path: input.path }),
    onSuccess: (share, input) => {
      const key = chatKeys.outputShares(input.conversationId, input.runId, input.path);
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
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.outputSharesAll }),
  });
}
