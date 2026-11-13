import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, type KnowledgeJob, type KnowledgeSearchResponse } from '../api.js';
import { isTerminalKnowledgeJob, KNOWLEDGE_PAGE_SIZE, knowledgeKeys } from './shared.js';

// ---- FAQ -----------------------------------------------------------------

export function useKnowledgeFaqs(
  baseId: string,
  filter: NonNullable<Parameters<typeof api.knowledgeFaqs>[1]>,
) {
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.faqs(baseId), filter],
    queryFn: ({ pageParam, signal }) =>
      api.knowledgeFaqs(
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
  });
}

export function useKnowledgeFaq(documentId: string | null) {
  return useQuery({
    queryKey: knowledgeKeys.faq(documentId ?? ''),
    queryFn: ({ signal }) => api.knowledgeFaq(documentId ?? '', signal),
    enabled: documentId !== null,
    staleTime: 0,
  });
}

function useKnowledgeFaqInvalidate(baseId: string) {
  const client = useQueryClient();
  return (documentId: string): void => {
    void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.faq(documentId) });
    void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
  };
}

export function useCreateKnowledgeFaq(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeFaq>[1]) =>
      api.createKnowledgeFaq(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function useUpdateKnowledgeFaq(baseId: string) {
  const client = useQueryClient();
  const invalidate = useKnowledgeFaqInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { documentId: string } & Parameters<typeof api.updateKnowledgeFaq>[1]) =>
      api.updateKnowledgeFaq(vars.documentId, vars),
    onSuccess: (_data, vars) => {
      invalidate(vars.documentId);
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function usePublishKnowledgeFaq(baseId: string) {
  const invalidate = useKnowledgeFaqInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: {
      documentId: string;
      versionId: string;
      expectedVersionId: string | null;
    }) =>
      api.publishKnowledgeFaq(vars.documentId, {
        versionId: vars.versionId,
        expectedVersionId: vars.expectedVersionId,
      }),
    onSuccess: (_data, vars) => invalidate(vars.documentId),
  });
}

export function useSetKnowledgeFaqStatus(baseId: string) {
  const invalidate = useKnowledgeFaqInvalidate(baseId);
  return useMutation({
    mutationFn: (vars: { documentId: string; enabled: boolean }) =>
      api.setKnowledgeFaqStatus(vars.documentId, vars.enabled),
    onSuccess: (_data, vars) => invalidate(vars.documentId),
  });
}

export function useDeleteKnowledgeFaq(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.deleteKnowledgeFaq(documentId),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) }),
  });
}

export function useImportKnowledgeFaqs(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.importKnowledgeFaqs>[1]) =>
      api.importKnowledgeFaqs(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
    },
  });
}

export function usePublishKnowledgeFaqBatch(baseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.batchKnowledgeFaqs>[1]) =>
      api.batchKnowledgeFaqs(baseId, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
      void client.invalidateQueries({ queryKey: knowledgeKeys.jobs(baseId) });
      void client.invalidateQueries({ queryKey: ['knowledge', 'faq'] });
      void client.invalidateQueries({ queryKey: knowledgeKeys.documents(baseId) });
    },
  });
}

/** 导入批次逐任务轮询；全部终态后停止，供 UI 判断能否显式整批发布。 */
export function useKnowledgeFaqImportJobs(jobIds: string[]) {
  return useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: knowledgeKeys.job(jobId),
      queryFn: () => api.knowledgeJob(jobId),
      refetchInterval: (query: { state: { data?: KnowledgeJob | undefined } }) =>
        isTerminalKnowledgeJob(query.state.data?.status) ? false : 1_500,
    })),
  });
}

/** 导入草稿版本在任务完成后才生成；按文档取详情，不凭列表猜版本。 */
export function useKnowledgeFaqDraftVersions(documentIds: string[], enabled: boolean) {
  return useQueries({
    queries: documentIds.map((documentId) => ({
      queryKey: knowledgeKeys.faq(documentId),
      queryFn: () => api.knowledgeFaq(documentId),
      enabled,
      staleTime: 0,
    })),
  });
}

export function useExportKnowledgeFaqs() {
  return useMutation({
    mutationFn: (vars: {
      baseId: string;
      format: 'json' | 'csv';
      version: 'published' | 'draft';
    }) => api.exportKnowledgeFaqs(vars.baseId, vars.format, vars.version),
  });
}

export function useKnowledgeFaqTest(
  baseId: string,
  options: {
    q: string;
    limit?: number | undefined;
    rerank?: boolean | undefined;
    minVectorScore?: number | undefined;
    onlyRecommended?: boolean | undefined;
    faqPriority?: boolean | undefined;
    faqDirectAnswerThreshold?: number | undefined;
  },
) {
  const term = options.q.trim();
  return useQuery<KnowledgeSearchResponse>({
    queryKey: [
      ...knowledgeKeys.faqs(baseId),
      'test',
      term,
      options.limit ?? 10,
      options.rerank ?? true,
      options.minVectorScore ?? 0.3,
      options.onlyRecommended ?? false,
      options.faqPriority ?? false,
      options.faqDirectAnswerThreshold ?? 0.9,
    ],
    queryFn: ({ signal }) =>
      api.testKnowledgeFaqs(
        baseId,
        {
          q: term,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
          ...(options.minVectorScore === undefined
            ? {}
            : { minVectorScore: options.minVectorScore }),
          onlyRecommended: options.onlyRecommended ?? false,
          faqPriority: options.faqPriority ?? false,
          faqDirectAnswerThreshold: options.faqDirectAnswerThreshold ?? 0.9,
        },
        signal,
      ),
    enabled: term.length > 0,
    staleTime: 10_000,
  });
}
