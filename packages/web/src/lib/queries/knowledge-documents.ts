import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, type KnowledgeBaseInput, type KnowledgeBatchInput } from '../api.js';
import {
  isTerminalKnowledgeJob,
  KNOWLEDGE_PAGE_SIZE,
  knowledgeJobQuery,
  knowledgeKeys,
  knowledgeShouldPoll,
  useDrainPages,
} from './shared.js';

export function useKnowledgeBases(enabled = true) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.bases,
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeBases(pageParam === null ? {} : { cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // 调用方（专家绑定等）只关心已加载的库；分页方法仍保留在结果上。
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

/** 置顶只影响列表排序，读取失败时页面按未置顶处理，不重试也不打断列表。 */
export function useKnowledgeBasePins() {
  return useQuery({
    queryKey: knowledgeKeys.pins,
    queryFn: ({ signal }) => api.knowledgeBasePins(signal),
    retry: false,
  });
}

export function useSetKnowledgeBasePin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { baseId: string; pinned: boolean }) =>
      api.setKnowledgeBasePin(vars.baseId, vars.pinned),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.pins }),
  });
}

export function useKnowledgeBase(id: string) {
  return useQuery({
    queryKey: knowledgeKeys.base(id),
    queryFn: () => api.knowledgeBase(id),
    staleTime: 0,
  });
}

export function useKnowledgeBaseSummary(id: string) {
  return useQuery({
    queryKey: knowledgeKeys.summary(id),
    queryFn: ({ signal }) => api.knowledgeBaseSummary(id, signal),
    staleTime: 0,
    // 最近一条任务仍活跃时刷新计数与任务状态；终态、超过轮询窗口或没有任务时不轮询。
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.lastJob ? [query.state.data.lastJob] : [])
        ? 3_000
        : false,
  });
}

/** 概览只展示最近一页活动，不需要翻页；进入概览时按 staleTime 0 重新取一次。 */
export function useKnowledgeBaseActivity(id: string) {
  return useQuery({
    queryKey: knowledgeKeys.activity(id),
    queryFn: () => api.knowledgeBaseActivity(id).then((page) => page.items),
    staleTime: 0,
  });
}

export function useCreateKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeBaseInput) => api.createKnowledgeBase(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

/** 分块预览是纯计算，不写库也不影响缓存，所以用 mutation 而不是 query。 */
export function usePreviewKnowledgeChunks(baseId: string) {
  return useMutation({
    mutationFn: (input: { sample: string; chunkTokens?: number; chunkOverlap?: number }) =>
      api.previewKnowledgeChunks(baseId, input),
  });
}

/** 复制只复制库与配置；文档、Wiki 与索引留在原库，由服务端决定默认名与 slug 落点。 */
export function useDuplicateKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      baseId: string;
      body: { name?: string; slug?: string; description?: string };
    }) => api.duplicateKnowledgeBase(vars.baseId, vars.body),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useUpdateKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { baseId: string; patch: Parameters<typeof api.updateKnowledgeBase>[1] }) =>
      api.updateKnowledgeBase(vars.baseId, vars.patch),
    onSuccess: (_data, vars) => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
      void client.invalidateQueries({ queryKey: knowledgeKeys.base(vars.baseId) });
    },
  });
}

export function useDeleteKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (baseId: string) => api.deleteKnowledgeBase(baseId),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useKnowledgeFolders(baseId: string) {
  return useQuery({
    queryKey: knowledgeKeys.folders(baseId),
    queryFn: () => api.knowledgeFolders(baseId),
  });
}

/** 文件夹与标签的写操作都会影响文档筛选与列表。 */
function useKnowledgeStructureInvalidate(baseId: string) {
  const client = useQueryClient();
  return (): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.folders(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.tags(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
  };
}

export function useCreateKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (input: { parentId: string | null; name: string }) =>
      api.createKnowledgeFolder(baseId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { folderId: string; patch: { name?: string } }) =>
      api.updateKnowledgeFolder(vars.folderId, vars.patch),
    onSuccess: invalidate,
  });
}

export function useDeleteKnowledgeFolder(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (folderId: string) => api.deleteKnowledgeFolder(folderId),
    onSuccess: invalidate,
  });
}

export function useKnowledgeTags(baseId: string) {
  return useQuery({
    queryKey: knowledgeKeys.tags(baseId),
    queryFn: () => api.knowledgeTags(baseId),
  });
}

export function useCreateKnowledgeTag(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (name: string) => api.createKnowledgeTag(baseId, name),
    onSuccess: invalidate,
  });
}

export function useRenameKnowledgeTag(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { tagId: string; name: string }) =>
      api.renameKnowledgeTag(vars.tagId, vars.name),
    onSuccess: invalidate,
  });
}

export function useDeleteKnowledgeTag(baseId: string) {
  const invalidate = useKnowledgeStructureInvalidate(baseId);
  return useMutation({
    mutationFn: (tagId: string) => api.deleteKnowledgeTag(tagId),
    onSuccess: invalidate,
  });
}

/**
 * 文档列表按游标翻页：首屏 50 条，其余由「加载更多」显式取。
 * 轮询只看已加载的条目，避免为检查状态把整库都拉下来。
 */
export function useKnowledgeDocuments(
  baseId: string,
  filter: NonNullable<Parameters<typeof api.knowledgeDocuments>[1]>,
) {
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.documents(baseId), filter],
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeDocuments(
        baseId,
        {
          ...filter,
          limit: KNOWLEDGE_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // 摄取期间刷新状态；全部稳定或超过轮询窗口后停止。
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.pages.flatMap((page) => page.items)) ? 3_000 : false,
  });
}

export function useKnowledgeDocument(documentId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['knowledge', 'document', documentId],
    queryFn: ({ signal }) => api.knowledgeDocument(documentId ?? '', signal),
    enabled: documentId !== null && enabled,
    staleTime: 0,
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data ? [query.state.data] : []) ? 3_000 : false,
  });
}

export function useUploadKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.uploadKnowledgeDocument>[1]) =>
      api.uploadKnowledgeDocument(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      // 目录上传会按 relativePath 创建或复用真实文件夹。
      void client.invalidateQueries({ queryKey: knowledgeKeys.folders(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      // 列表用游标分页，拉取过的页数要保持不变才能看到新文档。
      void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
    },
  });
}

/** 手写正文与 URL 抓取都由服务端建行并入队，成功后与上传同样刷新文档和任务。 */
function useKnowledgeDocumentImport(baseId: string) {
  const client = useQueryClient();
  return (): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
  };
}

export function useCreateKnowledgeManualDocument(baseId: string) {
  const invalidate = useKnowledgeDocumentImport(baseId);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeManualDocument>[1]) =>
      api.createKnowledgeManualDocument(baseId, input),
    onSuccess: invalidate,
  });
}

export function useImportKnowledgeUrl(baseId: string) {
  const invalidate = useKnowledgeDocumentImport(baseId);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.importKnowledgeUrl>[1]) =>
      api.importKnowledgeUrl(baseId, input),
    onSuccess: invalidate,
  });
}

export function useExportKnowledgeBase() {
  return useMutation({
    mutationFn: (baseId: string) => api.exportKnowledgeBase(baseId),
  });
}

export function useImportKnowledgeBase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (archive: Blob) => api.importKnowledgeBase(archive),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });
}

export function useUpdateKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      documentId: string;
      patch: Parameters<typeof api.updateKnowledgeDocument>[1];
    }) => api.updateKnowledgeDocument(vars.documentId, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) }),
  });
}

export function useDeleteKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.deleteKnowledgeDocument(documentId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.wikiPages(baseId) });
    },
  });
}

/** 分块同样按游标翻页：一个版本的 chunk 可能上千条。 */
export function useKnowledgeDocumentChunks(documentId: string, versionId: string | null) {
  return useInfiniteQuery({
    queryKey: knowledgeKeys.chunks(documentId, versionId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeChunks(
        documentId,
        versionId ?? undefined,
        signal,
        pageParam === null ? undefined : pageParam,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: versionId !== null,
  });
}

export function useKnowledgeVersionDetails(versionId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.versionDetails(versionId ?? ''),
    queryFn: ({ signal }) => api.knowledgeVersionDetails(versionId ?? '', signal),
    enabled: versionId !== null,
    staleTime: 60_000,
  });
}

/** 解析正文按版本缓存：同一版本内容不变。 */
export function useKnowledgeMarkdown(versionId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.markdown(versionId ?? ''),
    queryFn: ({ signal }) => api.knowledgeMarkdown(versionId ?? '', signal),
    enabled: versionId !== null,
    staleTime: 60_000,
  });
}

export function useUpdateKnowledgeChunk(
  baseId: string,
  documentId: string,
  versionId: string | null,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      chunkId: string;
      patch: {
        content?: string;
        heading?: string | null;
        enabled?: boolean;
      };
    }) =>
      api.updateKnowledgeChunk(vars.chunkId, {
        ...vars.patch,
        expectedVersionId: versionId ?? '',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', documentId] });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      // 改正文会清空向量并补建，任务列表需要刷新。
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useCreateKnowledgeChunk(
  baseId: string,
  documentId: string,
  versionId: string | null,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: string; heading?: string | null }) =>
      api.createKnowledgeChunk(documentId, {
        ...input,
        expectedVersionId: versionId ?? '',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', documentId] });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useDeleteKnowledgeChunk(
  baseId: string,
  documentId: string,
  versionId: string | null,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (chunkId: string) => api.deleteKnowledgeChunk(chunkId, versionId ?? ''),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', documentId] });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

export function useReprocessKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    // 确认框已说明人工分块会丢弃，这里显式覆盖，避免后端一律拒绝。
    mutationFn: (documentId: string) => api.reprocessKnowledgeDocument(documentId, true),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

/** 文档版本是完整历史：对话框内一次取完，切版与回退都读同一列表。 */
export function useKnowledgeDocumentVersions(documentId: string | null) {
  const query = useInfiniteQuery({
    queryKey: knowledgeKeys.documentVersions(documentId ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeDocumentVersions(
        documentId ?? '',
        pageParam === null ? undefined : pageParam,
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: documentId !== null,
  });
  useDrainPages(query);
  return {
    ...query,
    versions: query.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

function useDocumentVersionInvalidate(baseId: string) {
  const client = useQueryClient();
  return (documentId: string): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.manual(documentId) });
    void client.invalidateQueries({ queryKey: ['knowledge', 'document', documentId] });
  };
}

export function useRollbackKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  const invalidate = useDocumentVersionInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: {
      documentId: string;
      versionId: string;
      expectedVersionId: string | null;
    }) =>
      api.rollbackKnowledgeDocument(vars.documentId, {
        versionId: vars.versionId,
        expectedVersionId: vars.expectedVersionId,
      }),
    onSuccess: (_data, vars) => {
      invalidate(vars.documentId);
      void client.invalidateQueries({ queryKey: ['knowledge', 'chunks', vars.documentId] });
    },
  });
}

export function useKnowledgeDocumentManual(documentId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.manual(documentId ?? ''),
    queryFn: ({ signal }) => api.knowledgeDocumentManual(documentId ?? '', signal),
    enabled: documentId !== null,
    staleTime: 0,
  });
}

export function useSaveKnowledgeDocumentManual(baseId: string) {
  const client = useQueryClient();
  const invalidate = useDocumentVersionInvalidate(baseId);
  return useMutation({
    mutationFn: (
      vars: { documentId: string } & Parameters<typeof api.saveKnowledgeDocumentManual>[1],
    ) =>
      api.saveKnowledgeDocumentManual(vars.documentId, {
        content: vars.content,
        expectedVersionId: vars.expectedVersionId,
      }),
    onSuccess: (_data, vars) => {
      invalidate(vars.documentId);
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function usePublishKnowledgeDocumentVersion(baseId: string) {
  const invalidate = useDocumentVersionInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: {
      documentId: string;
      versionId: string;
      expectedVersionId: string | null;
    }) =>
      api.publishKnowledgeDocumentVersion(vars.documentId, {
        versionId: vars.versionId,
        expectedVersionId: vars.expectedVersionId,
      }),
    onSuccess: (_data, vars) => invalidate(vars.documentId),
  });
}

export function useBatchKnowledgeDocuments(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeBatchInput) => api.batchKnowledgeDocuments(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.folders(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.tags(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
    },
  });
}

/**
 * 任务按游标翻页；select 仍返回扁平数组，旧的 data?.find 调用不变。
 * queryKey 保留 knowledgeKeys.jobs(baseId) 前缀，重试/取消/同步的前缀失效覆盖所有过滤。
 */
export function useKnowledgeJobs(baseId: string, filters: { documentId?: string } = {}) {
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.jobs(baseId), filters],
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeJobs(
        baseId,
        {
          ...(filters.documentId ? { documentId: filters.documentId } : {}),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
    // 轮询只看已加载的页，过时窗口规则不变。
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.pages.flatMap((page) => page.items)) ? 2_000 : false,
  });
}

export function useRetryKnowledgeJob(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.retryKnowledgeJob(jobId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      // 失败文档重试后状态会回到排队，列表轮询要立刻重新接上。
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

export function useCancelKnowledgeJob(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelKnowledgeJob(jobId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

export function useKnowledgeJobDetail(jobId: string | null) {
  return useQuery(knowledgeJobQuery(jobId));
}

export function useKnowledgeDocumentJob(baseId: string, documentId: string, jobId: string | null) {
  const job = useKnowledgeJobDetail(jobId);
  const client = useQueryClient();
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !isTerminalKnowledgeJob(job.data?.status) || settled.current === jobId) return;
    settled.current = jobId;
    void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.manual(documentId) });
    void client.invalidateQueries({ queryKey: ['knowledge', 'document', documentId] });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
  }, [jobId, job.data?.status, client, documentId, baseId]);
  return job;
}
