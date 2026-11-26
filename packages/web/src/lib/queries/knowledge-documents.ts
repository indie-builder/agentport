import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, type KnowledgeBaseInput, type KnowledgeBatchInput } from '../api.js';
import { useCursorList, useDrainPages } from './client.js';
import {
  isTerminalKnowledgeJob,
  KNOWLEDGE_PAGE_SIZE,
  knowledgeJobQuery,
  knowledgeKeys,
  knowledgeShouldPoll,
} from './knowledge-shared.js';

export function useKnowledgeBases(enabled = true) {
  return useCursorList({
    queryKey: knowledgeKeys.bases,
    queryFn: (cursor, signal) => api.knowledgeBases(cursor === undefined ? {} : { cursor }, signal),
    enabled,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

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
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.lastJob ? [query.state.data.lastJob] : [])
        ? 3_000
        : false,
  });
}

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

export function usePreviewKnowledgeChunks(baseId: string) {
  return useMutation({
    mutationFn: (input: { sample: string; chunkTokens?: number; chunkOverlap?: number }) =>
      api.previewKnowledgeChunks(baseId, input),
  });
}

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

export function useKnowledgeDocuments(
  baseId: string,
  filter: NonNullable<Parameters<typeof api.knowledgeDocuments>[1]>,
) {
  return useCursorList({
    queryKey: [...knowledgeKeys.documents(baseId), filter],
    queryFn: (cursor, signal) =>
      api.knowledgeDocuments(
        baseId,
        {
          ...filter,
          limit: KNOWLEDGE_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    refetchInterval: (query) =>
      knowledgeShouldPoll(query.state.data?.pages.flatMap((page) => page.items)) ? 3_000 : false,
  });
}

export function useKnowledgeImages(baseId: string, filter: { q: string }) {
  return useCursorList({
    queryKey: knowledgeKeys.images(baseId, filter.q),
    queryFn: (cursor, signal) =>
      api.knowledgeImages(
        baseId,
        {
          ...(filter.q === '' ? {} : { q: filter.q }),
          limit: KNOWLEDGE_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
  });
}

export function useKnowledgeDocument(documentId: string | null, enabled = true) {
  return useQuery({
    queryKey: knowledgeKeys.document(documentId),
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
      void client.invalidateQueries({ queryKey: knowledgeKeys.folders(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.bases });
    },
  });
}

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

export function useKnowledgeDocumentChunks(documentId: string, versionId: string | null) {
  return useCursorList({
    queryKey: knowledgeKeys.chunks(documentId, versionId ?? ''),
    queryFn: (cursor, signal) =>
      api.knowledgeChunks(documentId, versionId ?? undefined, signal, cursor),
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

export function useKnowledgeMarkdown(versionId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.markdown(versionId ?? ''),
    queryFn: ({ signal }) => api.knowledgeMarkdown(versionId ?? '', signal),
    enabled: versionId !== null,
    staleTime: 60_000,
  });
}

function invalidateChunkData(client: QueryClient, baseId: string, documentId: string) {
  void client.invalidateQueries({ queryKey: knowledgeKeys.chunksOfDocument(documentId) });
  void client.invalidateQueries({ queryKey: knowledgeKeys.documentVersions(documentId) });
  void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
}

function invalidateGeneratedDocument(client: QueryClient, baseId: string, documentId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: knowledgeKeys.document(documentId) }),
    client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) }),
    client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) }),
  ]);
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
      invalidateChunkData(client, baseId, documentId);
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
      invalidateChunkData(client, baseId, documentId);
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
    onSuccess: () => invalidateChunkData(client, baseId, documentId),
  });
}

export function useReprocessKnowledgeDocument(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.reprocessKnowledgeDocument(documentId, true),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useGenerateKnowledgeDocumentSummary(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.generateKnowledgeDocumentSummary(documentId),
    onSuccess: async (_data, documentId) => {
      await invalidateGeneratedDocument(client, baseId, documentId);
    },
  });
}

export function useGenerateKnowledgeDocumentTags(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.generateKnowledgeDocumentTags(documentId),
    onSuccess: async (_data, documentId) => {
      await invalidateGeneratedDocument(client, baseId, documentId);
    },
  });
}

export function useKnowledgeDocumentDiff(
  documentId: string,
  params: { fromVersionId: string; toVersionId: string },
  enabled = true,
) {
  return useQuery({
    queryKey: knowledgeKeys.documentDiff(documentId, params.fromVersionId, params.toVersionId),
    queryFn: ({ signal }) => api.knowledgeDocumentDiff(documentId, params, signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useDownloadKnowledgeDocuments(baseId: string) {
  return useMutation({
    mutationFn: (documentIds: string[]) => api.downloadKnowledgeDocuments(baseId, documentIds),
  });
}

export function useKnowledgeDocumentVersions(documentId: string | null) {
  const query = useCursorList({
    queryKey: knowledgeKeys.documentVersions(documentId ?? ''),
    queryFn: (cursor, signal) => api.knowledgeDocumentVersions(documentId ?? '', cursor, signal),
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
    void client.invalidateQueries({ queryKey: knowledgeKeys.document(documentId) });
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
      void client.invalidateQueries({ queryKey: knowledgeKeys.chunksOfDocument(vars.documentId) });
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

export function useKnowledgeJobs(baseId: string, filters: { documentId?: string } = {}) {
  return useCursorList({
    queryKey: [...knowledgeKeys.jobs(baseId), filters],
    queryFn: (cursor, signal) =>
      api.knowledgeJobs(
        baseId,
        {
          ...(filters.documentId ? { documentId: filters.documentId } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    select: (data) => data.pages.flatMap((page) => page.items),
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
    void client.invalidateQueries({ queryKey: knowledgeKeys.document(documentId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
  }, [jobId, job.data?.status, client, documentId, baseId]);
  return job;
}
