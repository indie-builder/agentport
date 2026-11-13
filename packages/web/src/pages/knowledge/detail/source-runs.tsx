import { jobStatusLabel, jobStatusTone } from '../../../components/knowledge/knowledge-shared.js';
import { ErrorState } from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button } from '../../../components/ui/button.js';
import { formatDateTime } from '../../../lib/format.js';
import { knowledgeJobErrorText } from '../../../lib/knowledge-errors.js';
import {
  useKnowledgeJobDetail,
  useKnowledgeSourceRuns,
  useKnowledgeSyncItems,
} from '../../../lib/queries.js';

/** 每个展开的来源各自取同步记录；收起动画期间仍显示自己的数据。 */
export function SourceProbeStatus({ jobId }: { jobId: string }) {
  const job = useKnowledgeJobDetail(jobId);
  if (job.isPending) {
    return <span className="text-xs text-muted-foreground">连接测试进行中…</span>;
  }
  if (job.isError) {
    return <span className="text-sm text-danger">连接测试结果没有加载出来。</span>;
  }
  const result = job.data?.result;
  if (!result) {
    return (
      <span className="text-xs text-muted-foreground">
        连接测试{job.data?.status === 'failed' ? '失败' : '进行中'}
        {job.data?.error ? ` · ${knowledgeJobErrorText(job.data.error)}` : ''}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-item border border-line px-2 py-1">
      <span className={`text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>
        连接测试{result.ok ? '通过' : '失败'}
      </span>
      {result.checks.map((check) => (
        <span key={check.rangeId} className="text-xs text-muted-foreground">
          {check.rangeId} · {check.ok ? '可读' : (check.code ?? '不可读')}
          {check.message ? ` · ${check.message}` : ''}
        </span>
      ))}
    </div>
  );
}

function SyncRunItems({
  sourceId,
  syncRunId,
  onOpenDocument,
}: {
  sourceId: string;
  syncRunId: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const items = useKnowledgeSyncItems(sourceId, syncRunId);
  if (items.isPending) return <span className="text-xs text-muted-foreground">加载中…</span>;
  if (items.isError && items.data === undefined) {
    return (
      <Button variant="link" size="xs" onClick={() => void items.refetch()}>
        逐项结果没有加载出来，重试
      </Button>
    );
  }
  const itemRows = items.data?.pages.flatMap((page) => page.items) ?? [];
  if (itemRows.length === 0) {
    return <span className="text-xs text-muted-foreground">没有失败或跳过项</span>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {itemRows.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge tone={item.status === 'failed' ? 'danger' : 'outline'}>
              {item.status === 'failed' ? '失败' : '跳过'}
            </StatusBadge>
            <span className="font-mono text-xs text-muted-foreground">{item.externalId}</span>
            <span className="text-danger">
              {item.code}
              {item.message ? `: ${item.message}` : ''}
            </span>
            {item.documentId ? (
              <Button
                variant="link"
                size="xs"
                onClick={() => onOpenDocument(item.documentId ?? '')}
              >
                打开文档
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {items.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          disabled={items.isFetchingNextPage}
          onClick={() => void items.fetchNextPage()}
        >
          {items.isFetchingNextPage ? '加载中…' : '加载更多逐项结果'}
        </Button>
      ) : null}
      {items.isFetchNextPageError ? (
        <ErrorState error={items.error} onRetry={() => void items.fetchNextPage()} />
      ) : null}
    </div>
  );
}

export function SourceRuns({
  sourceId,
  onOpenDocument,
}: {
  sourceId: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const runs = useKnowledgeSourceRuns(sourceId);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-item bg-sunken/40 p-2">
      <span className="text-sm font-medium text-muted-foreground">同步记录</span>
      {runs.isPending ? <span className="text-xs text-muted-foreground">加载中…</span> : null}
      {runs.isError ? (
        <Button variant="link" size="xs" onClick={() => void runs.refetch()}>
          同步记录没有加载出来，重试
        </Button>
      ) : null}
      {runs.data && runs.data.length === 0 ? (
        <span className="text-xs text-muted-foreground">还没有同步记录</span>
      ) : null}
      {runs.data && runs.data.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {runs.data.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 text-2xs">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={jobStatusTone[run.status]}>
                  {jobStatusLabel[run.status]}
                </StatusBadge>
                <span className="text-muted-foreground">
                  新增 {run.stats.created} · 更新 {run.stats.updated} · 失败 {run.stats.failed}
                </span>
                <span className="text-muted-foreground">
                  {formatDateTime(run.startedAt ?? run.createdAt)}
                </span>
                {run.error ? <span className="text-danger">{run.error}</span> : null}
              </div>
              {/* 统计没有 skipped 字段，也始终给出逐项入口：仅有跳过项时同样能展开。 */}
              <details className="pl-2">
                <summary className="cursor-pointer text-muted-foreground">
                  逐项结果
                  {run.stats.failed > 0 ? ` · 失败 ${run.stats.failed}` : ''}
                </summary>
                <div className="mt-1">
                  <SyncRunItems
                    sourceId={sourceId}
                    syncRunId={run.id}
                    onOpenDocument={onOpenDocument}
                  />
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
