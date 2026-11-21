import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { knowledgeKeys } from './shared.js';

export function useKnowledgeWikiPages(baseId: string) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.wikiPages(baseId),
    queryFn: ({ pageParam }) => api.knowledgeWikiPages(baseId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function useKnowledgeWikiPage(pageId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.wikiPage(pageId ?? ''),
    queryFn: () => api.knowledgeWikiPage(pageId ?? ''),
    enabled: pageId !== null,
    staleTime: 0,
  });
}

export function useLoadOlderKnowledgeWikiVersions() {
  return useMutation({
    mutationFn: (vars: { pageId: string; cursor: string }) =>
      api.knowledgeWikiVersions(vars.pageId, vars.cursor),
  });
}

export function useCreateKnowledgeWikiPage(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      slug: string;
      title: string;
      parentId?: string | null;
      position?: number;
    }) => api.createKnowledgeWikiPage(baseId, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) }),
  });
}

function useKnowledgeWikiInvalidate(baseId: string) {
  const client = useQueryClient();
  return (pageId: string): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPage(pageId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
  };
}

export function useSaveKnowledgeWikiPage(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: {
      pageId: string;
      patch: {
        title?: string;
        markdown?: string;
        expectedVersion?: string | null;
        parentId?: string | null;
        position?: number;
      };
    }) => api.updateKnowledgeWikiPage(vars.pageId, vars.patch),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}

export function useKnowledgeWikiLinks(pageId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.wikiLinks(pageId ?? ''),
    queryFn: () => api.knowledgeWikiLinks(pageId ?? ''),
    enabled: pageId !== null,
    staleTime: 5_000,
  });
}

export function useKnowledgeWikiDiff(
  pageId: string | null,
  fromVersionId: string | null,
  toVersionId: string | null,
) {
  return useQuery({
    queryKey: knowledgeKeys.wikiDiff(pageId ?? '', fromVersionId ?? '', toVersionId ?? ''),
    queryFn: () => api.knowledgeWikiDiff(pageId ?? '', fromVersionId ?? '', toVersionId ?? ''),
    enabled: pageId !== null && fromVersionId !== null && toVersionId !== null,
    staleTime: 60_000,
  });
}

export function useGenerateKnowledgeWikiPage() {
  return useMutation({
    mutationFn: (vars: { pageId: string; instruction?: string }) =>
      api.generateKnowledgeWikiPage(vars.pageId, {
        ...(vars.instruction ? { instruction: vars.instruction } : {}),
      }),
  });
}

export function useRollbackKnowledgeWikiPage(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { pageId: string; versionId: string }) =>
      api.rollbackKnowledgeWikiPage(vars.pageId, vars.versionId),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}

export function usePublishKnowledgeWikiVersion(baseId: string) {
  const invalidate = useKnowledgeWikiInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { pageId: string; versionId: string }) =>
      api.publishKnowledgeWikiVersion(vars.pageId, vars.versionId),
    onSuccess: (_data, vars) => invalidate(vars.pageId),
  });
}
