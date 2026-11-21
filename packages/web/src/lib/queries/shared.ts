import {
  type AuthMe,
  type CursorPage,
  KNOWLEDGE_JOB_TIMEOUT_MS,
  type KnowledgeJob,
  type PublicRunQuestion,
} from '@agentport/shared';
import {
  type InfiniteData,
  type Query,
  QueryClient,
  type QueryKey,
  queryOptions,
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError, api, type KnowledgeSearchOptions } from '../api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

export const ME_QUERY_KEY = ['me'] as const;

export const meQuery = queryOptions<AuthMe>({
  queryKey: ME_QUERY_KEY,
  queryFn: async () => {
    const identity = await api.me();
    if (identity.authenticated) {
      const { bindChatIdentity } = await import('../chat-store.js');
      bindChatIdentity(identity.user.businessId);
    }
    return identity;
  },
  staleTime: 30_000,
});

export function clearSessionQueries(client = queryClient): void {
  client.clear();
}

export async function logoutAccount(): Promise<void> {
  await api.logout().catch(() => undefined);
  clearSessionQueries();
  const { useChatStore } = await import('../chat-store.js');
  useChatStore.getState().reset();
}

export function useRefetchWhenRunEnds(identity: string, active: boolean, queryKey: QueryKey): void {
  const client = useQueryClient();
  const previous = useRef({ identity, active });
  useEffect(() => {
    const wasActive = previous.current.identity === identity && previous.current.active;
    previous.current = { identity, active };
    if (!identity || active || !wasActive) return;
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  }, [identity, active, client, queryKey]);
}

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

export function useInvalidate() {
  const client = useQueryClient();
  return (key: string) => client.invalidateQueries({ queryKey: [key] });
}

const KNOWLEDGE_DOCUMENT_WINDOW_MS = 30 * 60_000;

type PollableJob = {
  status: string;
  type?: string;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string | null;
  summaryStatus?: string;
};

export function isMissingJob(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isTerminalKnowledgeJob(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function knowledgeShouldPoll(items: readonly PollableJob[] | undefined): boolean {
  const now = Date.now();
  return (items ?? []).some((item) => {
    const summaryPending = item.summaryStatus === 'pending' || item.summaryStatus === 'generating';
    const jobPending = ['pending', 'queued', 'running', 'processing'].includes(item.status);
    if (!summaryPending && !jobPending) return false;
    const window =
      item.type !== undefined && Object.hasOwn(KNOWLEDGE_JOB_TIMEOUT_MS, item.type)
        ? KNOWLEDGE_JOB_TIMEOUT_MS[item.type as KnowledgeJob['type']]
        : KNOWLEDGE_DOCUMENT_WINDOW_MS;
    const reference = item.startedAt ?? item.updatedAt ?? item.createdAt;
    return now - new Date(reference).getTime() < window;
  });
}

export const knowledgeKeys = {
  bases: ['knowledge', 'bases'] as const,
  pins: ['knowledge', 'base-pins'] as const,
  base: (id: string) => ['knowledge', 'base', id] as const,
  summary: (id: string) => ['knowledge', 'base-summary', id] as const,
  activity: (id: string) => ['knowledge', 'base-activity', id] as const,
  documents: (baseId: string) => ['knowledge', 'documents', baseId] as const,
  images: (baseId: string, q: string) => ['knowledge', 'images', baseId, q] as const,
  document: (documentId: string | null) => ['knowledge', 'document', documentId] as const,
  documentVersions: (documentId: string) => ['knowledge', 'document-versions', documentId] as const,
  documentDiff: (documentId: string, fromVersionId: string, toVersionId: string) =>
    ['knowledge', 'document-diff', documentId, fromVersionId, toVersionId] as const,
  manual: (documentId: string) => ['knowledge', 'manual', documentId] as const,
  faqs: (baseId: string) => ['knowledge', 'faqs', baseId] as const,
  faq: (documentId: string) => ['knowledge', 'faq', documentId] as const,
  chunks: (documentId: string, versionId: string) =>
    ['knowledge', 'chunks', documentId, versionId] as const,
  chunksOfDocument: (documentId: string) => ['knowledge', 'chunks', documentId] as const,
  markdown: (versionId: string) => ['knowledge', 'markdown', versionId] as const,
  versionDetails: (versionId: string) => ['knowledge', 'version-details', versionId] as const,
  search: (baseId: string, options: KnowledgeSearchOptions) =>
    ['knowledge', 'search', baseId, options] as const,
  jobs: (baseId: string) => ['knowledge', 'jobs', baseId] as const,
  job: (jobId: string) => ['knowledge', 'job', jobId] as const,
  folders: (baseId: string) => ['knowledge', 'folders', baseId] as const,
  tags: (baseId: string) => ['knowledge', 'tags', baseId] as const,
  sources: (baseId: string) => ['knowledge', 'sources', baseId] as const,
  sourceRuns: (sourceId: string) => ['knowledge', 'source-runs', sourceId] as const,
  syncItems: (sourceId: string, syncRunId: string, status?: string) =>
    ['knowledge', 'sync-items', sourceId, syncRunId, status ?? 'all'] as const,
  wikiPages: (baseId: string) => ['knowledge', 'wiki-pages', baseId] as const,
  wikiPage: (pageId: string) => ['knowledge', 'wiki-page', pageId] as const,
  wikiLinks: (pageId: string) => ['knowledge', 'wiki-links', pageId] as const,
  wikiGraph: (baseId: string) => ['knowledge', 'wiki-graph', baseId] as const,
  wikiDiff: (pageId: string, fromVersionId: string, toVersionId: string) =>
    ['knowledge', 'wiki-diff', pageId, fromVersionId, toVersionId] as const,
  profiles: ['knowledge', 'model-profiles'] as const,
  profileSelections: ['knowledge', 'model-profiles', 'selection'] as const,
};

export const KNOWLEDGE_PAGE_SIZE = 50;

export function useCursorList<
  TPage extends CursorPage<unknown>,
  TData = InfiniteData<TPage, string | undefined>,
>(options: {
  queryKey: readonly unknown[];
  queryFn: (cursor: string | undefined, signal: AbortSignal) => Promise<TPage>;
  enabled?: boolean | undefined;
  staleTime?: number | undefined;
  refetchInterval?:
    | number
    | false
    | ((
        query: Query<TPage, Error, InfiniteData<TPage, string | undefined>>,
      ) => number | false | undefined)
    | undefined;
  refetchIntervalInBackground?: boolean | undefined;
  select?: ((data: InfiniteData<TPage, string | undefined>) => TData) | undefined;
}) {
  return useInfiniteQuery({
    queryKey: options.queryKey,
    queryFn: ({ pageParam, signal }) => options.queryFn(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
    ...(options.refetchIntervalInBackground === undefined
      ? {}
      : { refetchIntervalInBackground: options.refetchIntervalInBackground }),
    ...(options.select === undefined ? {} : { select: options.select }),
  });
}

export function useDrainPages(query: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
}

export const knowledgeJobQuery = (jobId: string | null) =>
  queryOptions({
    queryKey: knowledgeKeys.job(jobId ?? ''),
    queryFn: () => api.knowledgeJob(jobId ?? ''),
    enabled: jobId !== null,
    retry: (failureCount, error) => !isMissingJob(error) && failureCount < 1,
    refetchInterval: (query) =>
      isTerminalKnowledgeJob(query.state.data?.status) || isMissingJob(query.state.error)
        ? false
        : 2_000,
  });
