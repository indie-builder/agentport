import type { KnowledgeSourceInput } from '@agentport/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { isTerminalKnowledgeJob, knowledgeKeys, knowledgeShouldPoll } from './shared.js';

/** 来源是小型集合：一次取完全部元数据页，调用方拿到的仍是数组。 */
export function useKnowledgeSources(baseId: string) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.sources(baseId),
    queryFn: ({ pageParam }) => api.knowledgeSources(baseId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useCreateKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeSourceInput) => api.createKnowledgeSource(baseId, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) }),
  });
}

export function useDeleteKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { sourceId: string; documents: 'keep' | 'delete' }) =>
      api.deleteKnowledgeSource(vars.sourceId, vars.documents),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
      // 选 delete 时文档也一并消失。
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

export function useUpdateKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      sourceId: string;
      patch: Parameters<typeof api.updateKnowledgeSource>[1];
    }) => api.updateKnowledgeSource(vars.sourceId, vars.patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
      // 收缩范围会在响应前撤权，文档与 Wiki 派生内容必须立刻刷新。
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
    },
  });
}

export function useTestKnowledgeSource() {
  return useMutation({
    mutationFn: (sourceId: string) => api.testKnowledgeSource(sourceId),
  });
}

export function useKnowledgeSyncItems(
  sourceId: string | null,
  syncRunId: string | null,
  status: 'failed' | 'skipped' | undefined = undefined,
) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.syncItems(sourceId ?? '', syncRunId ?? '', status),
    queryFn: ({ pageParam }) =>
      api.knowledgeSyncItems(sourceId ?? '', syncRunId ?? '', {
        ...(status === undefined ? {} : { status }),
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: sourceId !== null && syncRunId !== null,
  });
}

export function useSyncKnowledgeSource(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => api.syncKnowledgeSource(sourceId),
    onSuccess: (_result, sourceId) => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.sourceRuns(sourceId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.sources(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useKnowledgeSourceRuns(sourceId: string | null) {
  const client = useQueryClient();
  const settled = useRef(new Set<string>());
  const query = useQuery({
    queryKey: knowledgeKeys.sourceRuns(sourceId ?? ''),
    queryFn: () => api.knowledgeSourceRuns(sourceId ?? ''),
    enabled: sourceId !== null,
    select: (page) => page.items,
    refetchInterval: (query) => (knowledgeShouldPoll(query.state.data?.items) ? 2_000 : false),
  });
  useEffect(() => {
    for (const run of query.data ?? []) {
      if (!isTerminalKnowledgeJob(run.status) || settled.current.has(run.id)) continue;
      settled.current.add(run.id);
      void client.invalidateQueries({ queryKey: ['knowledge', 'sync-items', sourceId, run.id] });
    }
  }, [client, sourceId, query.data]);
  return query;
}
