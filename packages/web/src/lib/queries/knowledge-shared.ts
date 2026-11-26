import { KNOWLEDGE_JOB_TIMEOUT_MS, type KnowledgeJob } from '@agentport/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, api, type KnowledgeSearchOptions } from '../api.js';

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
  all: ['knowledge'] as const,
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
  faqAll: ['knowledge', 'faq'] as const,
  faq: (documentId: string) => ['knowledge', 'faq', documentId] as const,
  faqDrafts: ['knowledge', 'faq-drafts'] as const,
  faqDraftList: (ids: string[]) => ['knowledge', 'faq-drafts', ...ids] as const,
  faqCitationVersion: (documentId: string, versionId: string) =>
    ['knowledge', 'faq-citation-version', documentId, versionId] as const,
  chunks: (documentId: string, versionId: string) =>
    ['knowledge', 'chunks', documentId, versionId] as const,
  chunksOfDocument: (documentId: string) => ['knowledge', 'chunks', documentId] as const,
  markdown: (versionId: string) => ['knowledge', 'markdown', versionId] as const,
  original: (versionId: string) => ['knowledge', 'original', versionId] as const,
  versionDetails: (versionId: string) => ['knowledge', 'version-details', versionId] as const,
  search: (baseId: string, options: KnowledgeSearchOptions) =>
    ['knowledge', 'search', baseId, options] as const,
  jobs: (baseId: string) => ['knowledge', 'jobs', baseId] as const,
  batchJobs: (baseId: string, ids: string[]) =>
    ['knowledge', 'jobs', 'batch', baseId, ...ids] as const,
  job: (jobId: string) => ['knowledge', 'job', jobId] as const,
  folders: (baseId: string) => ['knowledge', 'folders', baseId] as const,
  tags: (baseId: string) => ['knowledge', 'tags', baseId] as const,
  sources: (baseId: string) => ['knowledge', 'sources', baseId] as const,
  sourceRuns: (sourceId: string) => ['knowledge', 'source-runs', sourceId] as const,
  syncItems: (sourceId: string, syncRunId: string, status?: string) =>
    ['knowledge', 'sync-items', sourceId, syncRunId, status ?? 'all'] as const,
  syncItemsAll: (sourceId: string, syncRunId: string) =>
    ['knowledge', 'sync-items', sourceId, syncRunId] as const,
  wikiPages: (baseId: string) => ['knowledge', 'wiki-pages', baseId] as const,
  wikiPage: (pageId: string) => ['knowledge', 'wiki-page', pageId] as const,
  wikiLinks: (pageId: string) => ['knowledge', 'wiki-links', pageId] as const,
  wikiGraph: (baseId: string) => ['knowledge', 'wiki-graph', baseId] as const,
  wikiDiff: (pageId: string, fromVersionId: string, toVersionId: string) =>
    ['knowledge', 'wiki-diff', pageId, fromVersionId, toVersionId] as const,
  wikiCitationVersion: (pageId: string, versionId: string) =>
    ['knowledge', 'wiki-citation-version', pageId, versionId] as const,
  profiles: ['knowledge', 'model-profiles'] as const,
  profileSelections: ['knowledge', 'model-profiles', 'selection'] as const,
};

export const KNOWLEDGE_PAGE_SIZE = 50;

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
