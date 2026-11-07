import { Link, useLocation } from '@tanstack/react-router';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import { formatRelative } from '../lib/format.js';
import { useAttention } from '../lib/queries.js';
import { PageNote, PageSection } from './page.js';
import { ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';

export function AttentionPanel() {
  const location = useLocation();
  const attention = useAttention();
  const data = attention.data;
  if (attention.isSuccess && (data?.total ?? 0) === 0) return null;

  return (
    <PageSection
      title="需要处理"
      actions={data ? <StatusBadge tone="danger">{data.total} 项</StatusBadge> : null}
    >
      {attention.isPending ? <LoadingState rows={2} /> : null}
      {attention.isError && !data ? (
        <ErrorState error={attention.error} onRetry={() => void attention.refetch()} />
      ) : null}
      {attention.isError && data ? (
        <PageNote
          tone="danger"
          title="刷新失败，已保留上次结果"
          description="以下为上次成功加载的待处理项。"
          action={
            <Button variant="outline" size="sm" onClick={() => void attention.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}
      {data ? (
        <ul className="flex flex-col">
          {data.approvals.map((item) =>
            item.kind !== 'approval' ? null : (
              <li key={`approval-${item.runId}-${item.serverId}-${item.toolName}`}>
                <Link
                  to="/runs/$runId"
                  params={{ runId: item.runId }}
                  search={{ backTo: location.href }}
                  className="-mx-2 flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5 hover:bg-hover"
                >
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {item.agentName ?? '已删除的专家'} · 等待批准 {item.toolName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatRelative(item.createdAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
          {data.failedRuns.map((item) =>
            item.kind !== 'failed_run' ? null : (
              <li key={`failed-${item.runId}`}>
                <Link
                  to="/runs/$runId"
                  params={{ runId: item.runId }}
                  search={{ backTo: location.href }}
                  className="-mx-2 flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5 hover:bg-hover"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {item.agentName ?? '已删除的专家'} · 运行失败
                    </span>
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={item.error ?? undefined}
                    >
                      {item.error ?? formatRelative(item.endedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </PageSection>
  );
}
