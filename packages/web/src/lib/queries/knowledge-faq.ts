import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type KnowledgeFaqDetail, type KnowledgeSearchResponse } from '../api.js';
import {
  isMissingJob,
  isTerminalKnowledgeJob,
  KNOWLEDGE_PAGE_SIZE,
  knowledgeKeys,
  useCursorList,
} from './shared.js';

export function useKnowledgeFaqs(
  baseId: string,
  filter: NonNullable<Parameters<typeof api.knowledgeFaqs>[1]>,
) {
  return useCursorList({
    queryKey: [...knowledgeKeys.faqs(baseId), filter],
    queryFn: (cursor, signal) =>
      api.knowledgeFaqs(
        baseId,
        {
          ...filter,
          limit: KNOWLEDGE_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
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

type KnowledgeFaqVersion = NonNullable<KnowledgeFaqDetail['draftVersion']>;

const FAQ_BATCH_SIZE = 100;

function chunk<T>(items: T[], size = FAQ_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface FaqDraftSummary {
  byDocumentId: Map<string, KnowledgeFaqVersion | null>;
  complete: boolean;
  errorCount: number;
  retrying: boolean;
}

export function summarizeFaqDrafts(
  results: Array<{
    data?: Array<{ documentId: string; draft: KnowledgeFaqVersion | null }> | undefined;
    isSuccess: boolean;
    isError: boolean;
    isFetching: boolean;
  }>,
): FaqDraftSummary {
  const byDocumentId = new Map<string, KnowledgeFaqVersion | null>();
  for (const result of results) {
    for (const item of result.data ?? []) byDocumentId.set(item.documentId, item.draft);
  }
  return {
    byDocumentId,
    complete:
      results.length > 0 && results.every((r) => r.isSuccess && !r.isError && !r.isFetching),
    errorCount: results.filter((r) => r.isError).length,
    retrying: results.some((r) => r.isError && r.isFetching),
  };
}

export function useKnowledgeFaqDrafts(documentIds: string[], enabled: boolean) {
  const chunks = chunk(documentIds);
  return useQueries({
    queries: chunks.map((ids) => ({
      queryKey: ['knowledge', 'faq-drafts', ...ids],
      queryFn: () => api.knowledgeFaqDrafts(ids),
      enabled: enabled && ids.length > 0,
      staleTime: 0,
    })),
  });
}

export interface FaqJobSummary {
  statuses: Map<string, string | undefined>;
  missing: Set<string>;
  error: boolean;
  retrying: boolean;
}

export function summarizeFaqJobs(
  results: Array<{
    data?: { items: Array<{ id: string; status: string }> } | undefined;
    error?: unknown;
    isError: boolean;
    isFetching: boolean;
  }>,
  jobIds: string[],
): FaqJobSummary {
  const byId = new Map<string, string>();
  for (const result of results) {
    for (const job of result.data?.items ?? []) byId.set(job.id, job.status);
  }
  const deleted = results.some((result) => result.isError && isMissingJob(result.error));
  const loaded = results.every((result) => result.data !== undefined);
  return {
    statuses: new Map(jobIds.map((id) => [id, byId.get(id)])),
    missing: new Set(deleted ? jobIds : loaded ? jobIds.filter((id) => !byId.has(id)) : []),
    error: results.some((r) => r.isError && !isMissingJob(r.error)),
    retrying: results.some((r) => r.isError && r.isFetching),
  };
}

export function useKnowledgeFaqImportJobs(baseId: string, jobIds: string[]) {
  const chunks = chunk(jobIds);
  return useQueries({
    queries: chunks.map((ids) => ({
      queryKey: ['knowledge', 'jobs', 'batch', baseId, ...ids],
      queryFn: () => api.knowledgeJobs(baseId, { ids, limit: ids.length }),
      enabled: ids.length > 0,
      retry: (failureCount: number, error: unknown) => !isMissingJob(error) && failureCount < 1,
      refetchInterval: (query: {
        state: {
          data?: { items: Array<{ status: string }> } | undefined;
          error?: unknown;
        };
      }) => {
        if (isMissingJob(query.state.error)) return false;
        const items = query.state.data?.items;
        if (items === undefined) return 2_000;
        return items.every((job) => isTerminalKnowledgeJob(job.status)) ? false : 2_000;
      },
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
