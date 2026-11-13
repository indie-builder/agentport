import type { AuthMe, PublicRunQuestion } from '@agentport/shared';
import { QueryClient, type QueryKey, queryOptions, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError, api, type KnowledgeSearchOptions } from '../api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

export const meQuery = queryOptions<AuthMe>({
  queryKey: ['me'],
  // 身份确认后再把聊天状态交给受保护页面；同一个人重复 /me 不会清草稿。
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

/** 只清查询缓存；登录、改密等拿不准身份的时机用它，不能顺手删草稿。 */
export function clearSessionQueries(client = queryClient): void {
  client.clear();
}

/** 用户主动退出登录：清查询缓存与聊天状态；401 等隐式过期不走这里。 */
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

export function useInvalidate() {
  const client = useQueryClient();
  return (key: string) => client.invalidateQueries({ queryKey: [key] });
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

export function isMissingJob(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isTerminalKnowledgeJob(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

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
  pins: ['knowledge', 'base-pins'] as const,
  base: (id: string) => ['knowledge', 'base', id] as const,
  summary: (id: string) => ['knowledge', 'base-summary', id] as const,
  activity: (id: string) => ['knowledge', 'base-activity', id] as const,
  documents: (baseId: string) => ['knowledge', 'documents', baseId] as const,
  documentVersions: (documentId: string) => ['knowledge', 'document-versions', documentId] as const,
  manual: (documentId: string) => ['knowledge', 'manual', documentId] as const,
  faqs: (baseId: string) => ['knowledge', 'faqs', baseId] as const,
  faq: (documentId: string) => ['knowledge', 'faq', documentId] as const,
  chunks: (documentId: string, versionId: string) =>
    ['knowledge', 'chunks', documentId, versionId] as const,
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
  wikiDiff: (pageId: string, fromVersionId: string, toVersionId: string) =>
    ['knowledge', 'wiki-diff', pageId, fromVersionId, toVersionId] as const,
  profiles: ['knowledge', 'model-profiles'] as const,
  profileSelections: ['knowledge', 'model-profiles', 'selection'] as const,
};

export const KNOWLEDGE_PAGE_SIZE = 50;

/** 小型集合（来源/Wiki/版本）自动取完剩余游标页；失败后停下，交给调用方的显式重试。 */
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

/** probe 结果落在 job.result；只轮询本次提交的任务，终态后停止。 */
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
