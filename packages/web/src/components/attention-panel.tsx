import { Link, useLocation } from '@tanstack/react-router';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import { errorMessage } from '../lib/api.js';
import { formatRelative } from '../lib/format.js';
import { useAttention } from '../lib/queries.js';
import { PageNote, PageSection } from './page.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card.js';

const sectionRowClassName = '-mx-2 flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5';
const cardRowClassName = 'flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5';
const hoverTransitionClassName = 'transition-colors duration-150 ease-out-soft hover:bg-hover';

export function AttentionPanel({
  canOpenRuns = true,
  layout = 'section',
}: {
  canOpenRuns?: boolean;
  layout?: 'section' | 'card' | undefined;
}) {
  const location = useLocation();
  const attention = useAttention();
  const data = attention.data;
  const isEmpty = attention.isSuccess && (data?.total ?? 0) === 0;
  if (layout === 'section' && isEmpty) return null;

  const failedRuns = data?.failedRuns.filter((item) => item.kind === 'failed_run') ?? [];
  const failedGroups = new Map<
    string,
    { sample: (typeof failedRuns)[number]; count: number; latestEndedAt: string | null }
  >();
  failedRuns.forEach((item) => {
    const key = item.error ?? '';
    const group = failedGroups.get(key);
    if (group) {
      group.count += 1;
      if (
        item.endedAt !== null &&
        (group.latestEndedAt === null || Date.parse(item.endedAt) > Date.parse(group.latestEndedAt))
      ) {
        group.latestEndedAt = item.endedAt;
      }
    } else {
      failedGroups.set(key, { sample: item, count: 1, latestEndedAt: item.endedAt });
    }
  });
  const groupedFailures = [...failedGroups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (b.latestEndedAt === null ? 0 : Date.parse(b.latestEndedAt)) -
        (a.latestEndedAt === null ? 0 : Date.parse(a.latestEndedAt)),
  );

  const rowClassName = layout === 'card' ? cardRowClassName : sectionRowClassName;
  const interactiveRowClassName = `${rowClassName} ${hoverTransitionClassName}`;

  const body = (
    <>
      {attention.isPending ? <LoadingState rows={2} /> : null}
      {attention.isError && !data ? (
        <ErrorState error={attention.error} onRetry={() => void attention.refetch()} />
      ) : null}
      {attention.isError && data ? (
        <PageNote
          tone="danger"
          title="刷新失败，已保留上次结果"
          description={errorMessage(attention.error)}
          action={
            <Button variant="outline" size="sm" onClick={() => void attention.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}
      {isEmpty ? (
        <EmptyState
          variant="clear"
          scale="panel"
          title="暂无待处理事项"
          description="当前没有待审批工具或失败运行。"
        />
      ) : data ? (
        <ul
          className={
            layout === 'card'
              ? '-mx-2 flex max-h-[300px] flex-col overflow-y-auto overscroll-contain px-2'
              : 'flex flex-col'
          }
        >
          {data.approvals.map((item) => {
            if (item.kind !== 'approval') return null;
            const content = (
              <>
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {item.agentName ?? '已删除的专家'} · 等待批准 {item.toolName}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatRelative(item.createdAt)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={`approval-${item.runId}-${item.serverId}-${item.toolName}`}>
                {canOpenRuns ? (
                  <Link
                    to="/runs/$runId"
                    params={{ runId: item.runId }}
                    search={{ backTo: location.href }}
                    className={interactiveRowClassName}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className={rowClassName}>{content}</div>
                )}
              </li>
            );
          })}
          {groupedFailures.map(({ sample, count, latestEndedAt }) => {
            const content = (
              <>
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {count > 1
                      ? `${count} 次运行失败`
                      : `${sample.agentName ?? '已删除的专家'} · 运行失败`}
                  </span>
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={sample.error ?? undefined}
                  >
                    {sample.error
                      ? `${sample.error}${count > 1 ? ` · 最近 ${formatRelative(latestEndedAt)}` : ''}`
                      : formatRelative(latestEndedAt)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={`failed-${sample.error ?? ''}`}>
                {canOpenRuns ? (
                  <Link
                    {...(count === 1
                      ? {
                          to: '/runs/$runId',
                          params: { runId: sample.runId },
                          search: { backTo: location.href },
                        }
                      : { to: '/runs', search: { status: 'failed' } })}
                    className={interactiveRowClassName}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className={rowClassName}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );

  if (layout === 'card') {
    return (
      <Card hover="static" className="flex min-h-0 min-w-0 flex-col">
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-medium text-fg">需要处理</h2>
          </CardTitle>
          {data && data.total > 0 ? (
            <CardAction>
              <StatusBadge tone="danger">{data.total} 项</StatusBadge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">{body}</CardContent>
      </Card>
    );
  }

  return (
    <PageSection
      title="需要处理"
      divided={false}
      className="overflow-x-clip"
      actions={data ? <StatusBadge tone="danger">{data.total} 项</StatusBadge> : null}
    >
      {body}
    </PageSection>
  );
}
