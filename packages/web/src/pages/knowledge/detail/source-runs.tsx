import { ChevronRight, Clock } from 'lucide-react';
import { CursorListFooter } from '../../../components/cursor-list-footer.js';
import { jobStatusLabel, jobStatusTone } from '../../../components/knowledge/knowledge-shared.js';
import { EmptyState } from '../../../components/states.js';
import { StatusBadge } from '../../../components/status-badge.js';
import { Button } from '../../../components/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../components/ui/collapsible.js';
import {
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
} from '../../../components/ui/timeline.js';
import { formatDateTime } from '../../../lib/format.js';
import { knowledgeJobErrorText } from '../../../lib/knowledge-errors.js';
import {
  useKnowledgeJobDetail,
  useKnowledgeSourceRuns,
  useKnowledgeSyncItems,
} from '../../../lib/queries.js';

export function SourceProbeStatus({ jobId }: { jobId: string }) {
  const job = useKnowledgeJobDetail(jobId);
  if (job.isPending) {
    return <span className="text-xs text-muted-foreground">连接测试进行中…</span>;
  }
  if (job.isError) {
    return <span className="text-sm text-danger">连接测试结果没有加载出来。</span>;
  }
  const status = job.data?.status;
  const result = job.data?.result;
  if (!result) {
    return (
      <span className="text-xs text-muted-foreground">
        连接测试{status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : '进行中'}
        {status !== 'cancelled' && job.data?.error
          ? ` · ${knowledgeJobErrorText(job.data.error)}`
          : ''}
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
    return <EmptyState variant="clear" scale="inline" title="本次同步没有失败或跳过项" />;
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
      <CursorListFooter
        query={items}
        label="逐项结果"
        errorTitle="内容没有加载出来"
        className="justify-start"
      />
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
        <EmptyState
          variant="idle"
          scale="inline"
          icon={<Clock aria-hidden="true" />}
          title="还没有同步记录"
        />
      ) : null}
      {runs.data && runs.data.length > 0 ? (
        <Timeline aria-label="同步记录">
          {runs.data.map((run) => {
            const status =
              run.status === 'succeeded'
                ? ('complete' as const)
                : run.status === 'running' || run.status === 'queued'
                  ? ('current' as const)
                  : undefined;
            return (
              <TimelineItem
                key={run.id}
                value={run.id}
                density="compact"
                size="xs"
                {...(status === undefined ? {} : { status })}
              >
                <TimelineMarker tone={run.status === 'failed' ? 'danger' : 'default'} />
                <TimelineConnector />
                <div className="flex min-h-6 flex-wrap items-center gap-2">
                  <TimelineTitle size="xs" weight="normal">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={jobStatusTone[run.status]}>
                        {jobStatusLabel[run.status]}
                      </StatusBadge>
                      <span className="text-muted-foreground">
                        新增 {run.stats.created} · 更新 {run.stats.updated} · 失败{' '}
                        {run.stats.failed}
                      </span>
                    </span>
                  </TimelineTitle>
                  <TimelineTime dateTime={run.startedAt ?? run.createdAt}>
                    {formatDateTime(run.startedAt ?? run.createdAt)}
                  </TimelineTime>
                </div>
                {run.error ? (
                  <TimelineDescription size="xs" tone="danger">
                    {run.error}
                  </TimelineDescription>
                ) : null}
                <Collapsible className="ps-2">
                  <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 rounded-icon text-start text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronRight
                      className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
                      aria-hidden="true"
                    />
                    逐项结果
                    {run.stats.failed > 0 ? ` · 失败 ${run.stats.failed}` : ''}
                  </CollapsibleTrigger>
                  <CollapsibleContent keepMounted hiddenUntilFound>
                    <div className="mt-1">
                      <SyncRunItems
                        sourceId={sourceId}
                        syncRunId={run.id}
                        onOpenDocument={onOpenDocument}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </TimelineItem>
            );
          })}
        </Timeline>
      ) : null}
    </div>
  );
}
