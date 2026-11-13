import type { OutputContent, OutputFile } from '@agentport/shared';
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  api,
  type Conversation,
  type ConversationDetail,
  type ConversationSearchOptions,
  type OutputShareList,
} from '../api.js';

export const chatKeys = {
  conversations: (...ids: [] | [string | null]) => ['conversations', ...ids] as const,
  conversation: (id: string | null) => ['conversation', id] as const,
  outputs: (id: string | null) => ['conversation-outputs', id] as const,
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
      options.before ?? null,
    ] as const,
};

export function useConversations(agentId: string | null) {
  return useQuery<Conversation[]>({
    queryKey: chatKeys.conversations(agentId),
    queryFn: ({ signal }) => api.conversations(agentId ?? undefined, signal),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

/** 全局历史搜索的 Query options；空 q 返回最近会话，nextBefore 作为下一页游标。 */
export const searchConversationsOptions = (options: ConversationSearchOptions) =>
  infiniteQueryOptions({
    queryKey: chatKeys.search(options),
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
    queryKey: chatKeys.conversation(conversationId),
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

/**
 * 会话成果按发布版本倒序；同一路径由页面分组。
 * 旧版可能落在后续页，按 `nextBefore` 继续翻页，不静默丢弃。
 */
export function useConversationOutputs(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: chatKeys.outputs(conversationId),
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
    queryKey: chatKeys.outputContent(conversationId, runId, path),
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
    queryKey: chatKeys.outputFile(conversationId, runId, path),
    queryFn: ({ signal }) => api.outputFile(conversationId ?? '', runId ?? '', path ?? '', signal),
    enabled: conversationId !== null && runId !== null && path !== null && enabled,
    staleTime: 5 * 60_000,
  });
}

/** 图片与 PDF 字节走鉴权下载端点；key 与选中三元组一致，切换选择即换请求。 */
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
