import type { KnowledgeDocumentSummaryStatus } from '@agentport/shared';

export function visibleDocumentSummary(row: {
  currentVersionId: string | null;
  summary: string | null;
  summaryStatus: KnowledgeDocumentSummaryStatus;
  summaryVersionId: string | null;
  summaryGeneratedAt: Date | null;
  summaryError: string | null;
}) {
  if (row.currentVersionId === null || row.summaryVersionId !== row.currentVersionId) {
    return {
      summary: null,
      summaryStatus: 'none' as const,
      summaryGeneratedAt: null,
      summaryError: null,
    };
  }
  return {
    summary: row.summary,
    summaryStatus: row.summaryStatus,
    summaryGeneratedAt: row.summaryGeneratedAt?.toISOString() ?? null,
    summaryError: row.summaryError,
  };
}
