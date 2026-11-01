import type { PersonalRun, PersonalRunListQuery } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import type { ReactNode } from 'react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import type { RunStatus } from '../lib/api.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { agentsQuery, meQuery, usePersonalRuns, usePersonalUsage } from '../lib/queries.js';

const triggers = ['chat', 'mcp', 'schedule', 'event', 'review', 'channel'] as const;
type Trigger = (typeof triggers)[number];

const triggerLabel: Record<Trigger, string> = {
  chat: '对话',
  mcp: '连接器',
  schedule: '定时任务',
  event: '事件',
  review: '记忆提案',
  channel: '频道',
};

const statuses: RunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

// 汇总窗口是 UTC 日界，固定按 UTC 显示，不跟随浏览器本地时区。
const utcDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

function formatUtcDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : utcDateTimeFormatter.format(date);
}

// 成本按货币保留 4 位小数；Token 是计数，统一用精确整数加千分位，避免同屏混用 k/M 缩写。
const tokenCountFormatter = new Intl.NumberFormat('zh-CN');

function formatTokenCount(value: number): string {
  return tokenCountFormatter.format(value);
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-fg">{value}</span>
    </span>
  );
}

function runDestination(
  run: PersonalRun,
  options: { canReadMemory: boolean; canReadConversations: boolean },
): 'review' | 'chat' | 'detail' {
  if (run.trigger === 'review' && options.canReadMemory) return 'review';
  if (run.trigger === 'chat' && run.conversationId && options.canReadConversations) return 'chat';
  return 'detail';
}

function RunCard({ run, action }: { run: PersonalRun; action: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0 truncate" title={run.agentName ?? '已删除'}>
          {run.agentName ?? '已删除'}
        </CardTitle>
        <CardAction>
          <RunStatusBadge status={run.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">来源</dt>
          <dd className="text-right text-muted-foreground">{triggerLabel[run.trigger]}</dd>
          <dt className="text-muted-foreground">时间</dt>
          <dd className="text-right text-muted-foreground" title={run.startedAt ?? run.createdAt}>
            {formatDateTime(run.startedAt ?? run.createdAt)}
          </dd>
          <dt className="text-muted-foreground">耗时</dt>
          <dd className="font-mono tabular-nums text-fg">{formatDuration(run.latencyMs)}</dd>
          <dt className="text-muted-foreground">成本</dt>
          <dd className="font-mono tabular-nums text-fg">{formatCost(run.costUsd)}</dd>
          <dt className="text-muted-foreground">Token</dt>
          <dd className="font-mono tabular-nums text-fg">
            {`${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`}
          </dd>
          <dt className="text-muted-foreground">运行 ID</dt>
          <dd className="font-mono text-xs text-fg" title={run.id}>
            {shortId(run.id)}
          </dd>
        </dl>
      </CardContent>
      <CardFooter className="justify-end">{action}</CardFooter>
    </Card>
  );
}

export function PersonalUsagePage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/usage' });
  const location = useLocation();
  const navigate = useNavigate({ from: '/personal/usage' });
  const canOverview = can(me.data, 'overview.read');
  const canRuns = can(me.data, 'runs.read');
  const canAgents = can(me.data, 'agents.read');
  const canReadMemory = can(me.data, 'personal_memory.read');
  const canReadConversations = can(me.data, 'conversations.read');
  const days = search.days ?? 30;
  const cursor = search.cursor ?? null;
  const view = search.view ?? 'table';
  const usage = usePersonalUsage(days, canOverview);
  const agents = useQuery({ ...agentsQuery, enabled: canAgents });
  const query: PersonalRunListQuery = {
    days,
    limit: 50,
    ...(search.agent ? { agentId: search.agent } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.trigger ? { trigger: search.trigger } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const runs = usePersonalRuns(query, canRuns);

  const patchSearch = (patch: {
    days?: number;
    agent?: string | undefined;
    status?: RunStatus | undefined;
    trigger?: Trigger | undefined;
    cursor?: string | undefined;
    view?: ListView | undefined;
  }): void => {
    void navigate({
      to: '/personal/usage',
      search: (current) => ({ ...current, ...patch }),
    });
  };

  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const actionLinkClass = buttonVariants({ variant: 'link', size: 'sm' });

  const daysControl = (
    <FilterSelect
      value={String(days)}
      onValueChange={(next) => patchSearch({ days: Number(next), cursor: undefined })}
      options={[
        { value: '7', label: '最近 7 天' },
        { value: '30', label: '最近 30 天' },
        { value: '90', label: '最近 90 天' },
      ]}
      label="统计窗口"
      className="w-32"
    />
  );

  const runAction = (run: PersonalRun): ReactNode => {
    const destination = runDestination(run, { canReadMemory, canReadConversations });
    if (destination === 'review') {
      return (
        <Link
          to="/personal/reviews"
          search={{ run: run.id }}
          aria-label={`审核提案 ${run.agentName ?? shortId(run.id)}`}
          className={actionLinkClass}
        >
          审核提案
        </Link>
      );
    }
    if (destination === 'chat' && run.conversationId) {
      return (
        <Link
          to="/chat"
          search={{ agent: run.agentId, conversation: run.conversationId }}
          aria-label={`回到对话 ${run.agentName ?? shortId(run.id)}`}
          className={actionLinkClass}
        >
          回到对话
        </Link>
      );
    }
    return (
      <Link
        to="/runs/$runId"
        params={{ runId: run.id }}
        search={{ backTo: location.href }}
        aria-label={`查看运行 ${run.agentName ?? shortId(run.id)}`}
        className={actionLinkClass}
      >
        查看运行
      </Link>
    );
  };

  const columns: DataColumn<PersonalRun>[] = [
    {
      id: 'agent',
      header: '专家',
      width: 'minmax(150px,1fr)',
      cell: (run) => (
        <span className="block truncate text-fg" title={run.agentName ?? '已删除'}>
          {run.agentName ?? '已删除'}
        </span>
      ),
    },
    {
      id: 'trigger',
      header: '来源',
      width: '88px',
      cell: (run) => (
        <span className="text-sm text-muted-foreground">{triggerLabel[run.trigger]}</span>
      ),
    },
    {
      id: 'status',
      header: '状态',
      width: '96px',
      cell: (run) => <RunStatusBadge status={run.status} />,
    },
    {
      id: 'startedAt',
      header: '时间',
      width: '110px',
      cell: (run) => (
        <span className="text-sm text-muted-foreground" title={run.startedAt ?? run.createdAt}>
          {formatDateTime(run.startedAt ?? run.createdAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '去向',
      locked: true,
      width: '96px',
      cell: (run) => runAction(run),
    },
  ];

  const summary = usage.data;

  return (
    <Page>
      <PageHeader title="使用记录" />

      {canOverview ? (
        <PageSection className="gap-3" divided={false}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-base font-medium text-fg">使用汇总</h2>
              <p className="text-sm text-muted-foreground">
                {summary
                  ? `${formatUtcDateTime(summary.since)} – ${formatUtcDateTime(summary.until)}（UTC，按运行创建时间）`
                  : `最近 ${days} 天（UTC，按运行创建时间）`}
              </p>
            </div>
            {daysControl}
          </div>
          {usage.isPending ? <LoadingState rows={3} /> : null}
          {usage.isError ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : null}
          {summary ? (
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-y-2 text-sm">
              <dt className="text-muted-foreground">运行</dt>
              <dd className="min-w-0">
                <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 lg:grid-cols-7">
                  <SummaryStat label="总计" value={String(summary.runCount)} />
                  {statuses.map((status) => (
                    <SummaryStat
                      key={status}
                      label={runStatusLabel[status]}
                      value={String(summary[status])}
                    />
                  ))}
                </div>
              </dd>
              <dt className="text-muted-foreground">Token</dt>
              <dd className="min-w-0 text-fg">
                <span className="font-mono tabular-nums">
                  {formatTokenCount(summary.inputTokens)}
                </span>
                {' 输入 / '}
                <span className="font-mono tabular-nums">
                  {formatTokenCount(summary.outputTokens)}
                </span>
                {' 输出'}
              </dd>
              <dt className="text-muted-foreground">已记录成本</dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-fg">
                {summary.costUsd === null ? (
                  <span>未记录</span>
                ) : (
                  <>
                    <span className="font-mono tabular-nums">
                      {`${formatCost(summary.costUsd)} · ${summary.runCount} 次中 ${summary.costRecordedRuns} 次已记录`}
                    </span>
                    {summary.costMissingRuns > 0 ? (
                      <span className="text-muted-foreground">
                        {`${summary.costMissingRuns} 次运行未记录成本`}
                      </span>
                    ) : null}
                  </>
                )}
              </dd>
            </dl>
          ) : null}
        </PageSection>
      ) : null}

      {canRuns ? (
        <PageSection className="gap-2" divided={canOverview}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-base font-medium text-fg">运行</h2>
              {canOverview ? (
                <p className="text-sm text-muted-foreground">汇总不随下面的筛选和分页变化。</p>
              ) : null}
            </div>
            {!canOverview || cursor || runs.data?.nextCursor ? (
              <div className="flex flex-wrap items-center gap-2">
                {canOverview ? null : daysControl}
                {cursor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patchSearch({ cursor: undefined })}
                  >
                    回到最新
                  </Button>
                ) : null}
                {runs.data?.nextCursor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patchSearch({ cursor: runs.data?.nextCursor ?? undefined })}
                  >
                    下一页
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <PageToolbar>
            {canAgents ? (
              <FilterSelect
                value={search.agent ?? ''}
                onValueChange={(next) =>
                  patchSearch({ agent: next || undefined, cursor: undefined })
                }
                options={agentOptions}
                label="按专家筛选"
                className="w-full sm:w-36"
              />
            ) : null}
            <FilterSelect
              value={search.status ?? ''}
              onValueChange={(next) =>
                patchSearch({
                  status: (next || undefined) as RunStatus | undefined,
                  cursor: undefined,
                })
              }
              options={[
                { value: '', label: '全部状态' },
                ...statuses.map((status) => ({ value: status, label: runStatusLabel[status] })),
              ]}
              label="按状态筛选"
              className="w-full sm:w-32"
            />
            <FilterSelect
              value={search.trigger ?? ''}
              onValueChange={(next) =>
                patchSearch({
                  trigger: (next || undefined) as Trigger | undefined,
                  cursor: undefined,
                })
              }
              options={[
                { value: '', label: '全部来源' },
                ...triggers.map((trigger) => ({ value: trigger, label: triggerLabel[trigger] })),
              ]}
              label="按来源筛选"
              className="w-full sm:w-32"
            />
            <Button
              type="button"
              variant="outline"
              aria-pressed={search.status === 'failed'}
              onClick={() =>
                patchSearch({
                  status: search.status === 'failed' ? undefined : 'failed',
                  cursor: undefined,
                })
              }
            >
              {search.status === 'failed' ? '清除失败筛选' : '只看失败'}
            </Button>
            <div className="ml-auto">
              <ViewToggle value={view} onChange={(next) => patchSearch({ view: next })} />
            </div>
          </PageToolbar>

          {runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : runs.data && runs.data.items.length === 0 ? (
            <PageNote
              icon={<Activity className="size-4" aria-hidden="true" />}
              title="这个窗口还没有运行记录"
              action={
                <Link to="/chat" className="text-sm text-primary underline underline-offset-4">
                  新建对话
                </Link>
              }
            />
          ) : view === 'cards' ? (
            runs.isPending ? (
              <LoadingState rows={3} layout="cards" columns={3} />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {(runs.data?.items ?? []).map((run) => (
                  <RunCard key={run.id} run={run} action={runAction(run)} />
                ))}
              </div>
            )
          ) : (
            <DataTable
              rows={runs.data?.items ?? []}
              columns={columns}
              rowKey={(run) => run.id}
              label="我的运行"
              loading={runs.isPending}
              empty="没有运行记录"
              renderExpanded={(run) => (
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">耗时</dt>
                  <dd className="font-mono tabular-nums text-fg">
                    {formatDuration(run.latencyMs)}
                  </dd>
                  <dt className="text-muted-foreground">成本</dt>
                  <dd className="font-mono tabular-nums text-fg">{formatCost(run.costUsd)}</dd>
                  <dt className="text-muted-foreground">Token</dt>
                  <dd className="font-mono tabular-nums text-fg">
                    {`${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`}
                  </dd>
                  <dt className="text-muted-foreground">运行 ID</dt>
                  <dd className="font-mono text-xs text-fg" title={run.id}>
                    {shortId(run.id)}
                  </dd>
                </dl>
              )}
            />
          )}
        </PageSection>
      ) : null}
    </Page>
  );
}
