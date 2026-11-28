import type { PersonalRun, PersonalRunListQuery } from '@agentport/shared';
import { runStatusSchema, runTriggerSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Activity, CircleCheck, CircleDollarSign, Cpu } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterSelect } from '../../components/filter-select.js';
import { MetricCard, MetricGrid } from '../../components/metric-card.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import { RunStatusBadge } from '../../components/run/run-status-badge.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { type ListView, ViewToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { api, errorMessage, type RunStatus } from '../../lib/api.js';
import { downloadBlob } from '../../lib/browser-files.js';
import { toCsv } from '../../lib/csv.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  formatUtcDateTime,
  runStatusLabel,
  runTriggerLabel,
  shortId,
} from '../../lib/format.js';
import { agentsQuery, meQuery, usePersonalRuns, usePersonalUsage } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';

const triggers = runTriggerSchema.options;
type Trigger = (typeof triggers)[number];

const statuses = runStatusSchema.options;

const tokenCountFormatter = new Intl.NumberFormat('zh-CN');

function formatTokenCount(value: number): string {
  return tokenCountFormatter.format(value);
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
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0 truncate" title={run.agentName ?? '已删除的专家'}>
          {run.agentName ?? '已删除的专家'}
        </CardTitle>
        <CardAction>
          <RunStatusBadge status={run.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <RecordRows
          rows={[
            { label: '来源', value: runTriggerLabel[run.trigger] },
            {
              label: '时间',
              value: formatDateTime(run.startedAt ?? run.createdAt),
              title: run.startedAt ?? run.createdAt,
            },
            { label: '耗时', value: formatDuration(run.latencyMs) },
            { label: '成本', value: formatCost(run.costUsd) },
            {
              label: 'Token',
              value: `${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`,
            },
            { label: '运行 ID', value: shortId(run.id), mono: true, title: run.id },
          ]}
        />
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
  const view = search.view ?? 'cards';
  const hasActiveFilter = Boolean(search.agent || search.trigger || search.status);
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
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await api.personalExportRuns({
        days,
        ...(search.agent ? { agentId: search.agent } : {}),
        ...(search.status ? { status: search.status } : {}),
        ...(search.trigger ? { trigger: search.trigger } : {}),
      });
      const rows = result.items.map((run) => [
        run.agentName || '已删除的专家',
        runTriggerLabel[run.trigger],
        runStatusLabel[run.status],
        formatDateTime(run.startedAt || run.createdAt),
        run.latencyMs ?? '',
        run.costUsd ?? '',
        run.inputTokens,
        run.outputTokens,
        run.id,
      ]);
      const csv = toCsv(
        ['专家', '来源', '状态', '时间', '耗时ms', '成本USD', '输入Token', '输出Token', '运行ID'],
        rows,
      );
      downloadBlob(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        `personal-usage-${days}d.csv`,
      );
      if (result.truncated) toastSuccess('已导出前 5000 条，请缩小时间范围或加筛选');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

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
    ...(agents.data?.items ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const activeFilters: EmptyFilterChip[] = [
    ...(search.agent
      ? [
          {
            key: 'agent',
            label: '专家',
            value:
              agents.data?.items.find((agent) => agent.id === search.agent)?.name ?? search.agent,
            onRemove: () => patchSearch({ agent: undefined, cursor: undefined }),
          },
        ]
      : []),
    ...(search.status
      ? [
          {
            key: 'status',
            label: '状态',
            value: runStatusLabel[search.status],
            onRemove: () => patchSearch({ status: undefined, cursor: undefined }),
          },
        ]
      : []),
    ...(search.trigger
      ? [
          {
            key: 'trigger',
            label: '来源',
            value: runTriggerLabel[search.trigger],
            onRemove: () => patchSearch({ trigger: undefined, cursor: undefined }),
          },
        ]
      : []),
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
      className="w-36"
    />
  );

  const runAction = (run: PersonalRun): ReactNode => {
    const destination = runDestination(run, { canReadMemory, canReadConversations });
    if (destination === 'review') {
      return (
        <Link
          to="/personal/reviews"
          search={{ run: run.id }}
          data-variant="link"
          data-size="sm"
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
          data-variant="link"
          data-size="sm"
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
        data-variant="link"
        data-size="sm"
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
        <span className="block truncate text-base text-fg" title={run.agentName ?? '已删除的专家'}>
          {run.agentName ?? '已删除的专家'}
        </span>
      ),
    },
    {
      id: 'trigger',
      header: '来源',
      width: '88px',
      cell: (run) => (
        <span className="text-sm text-muted-foreground">{runTriggerLabel[run.trigger]}</span>
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
      <PageTopbar>
        <PageHeader title="使用记录" />
      </PageTopbar>

      <PageBody>
        {canOverview ? (
          <PageSection
            title="使用汇总"
            description={
              summary
                ? `${formatUtcDateTime(summary.since)} – ${formatUtcDateTime(summary.until)}（UTC，按运行创建时间）`
                : `最近 ${days} 天（UTC，按运行创建时间）`
            }
            actions={daysControl}
            className="gap-3"
            divided={false}
          >
            {usage.isPending ? <LoadingState rows={2} /> : null}
            {usage.isError ? (
              <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
            ) : null}
            {summary ? (
              <MetricGrid>
                <MetricCard label="运行总数" icon={Activity} value={summary.runCount} />
                <MetricCard
                  label="成功率"
                  icon={CircleCheck}
                  value={
                    summary.runCount === 0
                      ? '—'
                      : `${Math.round((summary.succeeded / summary.runCount) * 100)}%`
                  }
                />
                <MetricCard
                  label="已记录成本"
                  icon={CircleDollarSign}
                  value={summary.costUsd === null ? '未记录' : formatCost(summary.costUsd)}
                  hint={
                    summary.runCount > 0 && summary.costMissingRuns > 0
                      ? `${summary.costRecordedRuns} 次已记录 · ${summary.costMissingRuns} 次未记录`
                      : undefined
                  }
                />
                <MetricCard
                  label="Token"
                  icon={Cpu}
                  value={
                    <span className="flex flex-col">
                      <span>{`输入 ${formatTokenCount(summary.inputTokens)}`}</span>
                      <span>{`输出 ${formatTokenCount(summary.outputTokens)}`}</span>
                    </span>
                  }
                />
              </MetricGrid>
            ) : null}
          </PageSection>
        ) : null}

        {canRuns ? (
          <PageSection className="gap-2" divided={canOverview}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-base font-medium text-fg">运行</h2>
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
                className="w-full sm:w-36"
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
                  ...triggers.map((trigger) => ({
                    value: trigger,
                    label: runTriggerLabel[trigger],
                  })),
                ]}
                label="按来源筛选"
                className="w-full sm:w-36"
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
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                aria-busy={exporting}
                onClick={() => void exportCsv()}
              >
                导出 CSV
              </Button>
              <div className="ml-auto">
                <ViewToggle value={view} onChange={(next) => patchSearch({ view: next })} />
              </div>
            </PageToolbar>

            {canAgents && agents.isError && agents.data !== undefined ? (
              <PageNote
                tone="danger"
                title="专家筛选项刷新失败"
                description="已保留上次加载的专家选项。"
                action={
                  <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}

            {canAgents && agents.isError && agents.data === undefined ? (
              <PageNote
                tone="danger"
                title="专家筛选项加载失败"
                description="无法加载可筛选的专家，下拉仅显示「全部专家」。"
                action={
                  <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}

            {runs.isError && runs.data !== undefined ? (
              <PageNote
                tone="danger"
                title="刷新失败，已保留加载的内容"
                description={errorMessage(runs.error)}
                action={
                  <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}

            {runs.isError && runs.data === undefined ? (
              <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
            ) : runs.data && runs.data.items.length === 0 ? (
              hasActiveFilter ? (
                <EmptyState
                  variant="filter"
                  scale="section"
                  title="没有匹配的运行记录"
                  activeFilters={activeFilters}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        patchSearch({
                          agent: undefined,
                          trigger: undefined,
                          status: undefined,
                          cursor: undefined,
                        })
                      }
                    >
                      清除全部筛选
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  variant="stage"
                  scale="section"
                  specimen="runs"
                  title="当前时间窗口还没有运行记录"
                  description="与专家发起对话或运行任务后，每次执行的耗时与成本会汇总在这里。"
                  action={
                    <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
                      新建对话
                    </Link>
                  }
                />
              )
            ) : view === 'cards' ? (
              runs.isPending ? (
                <LoadingState rows={3} layout="cards" />
              ) : (
                <ul
                  aria-label="运行用量列表"
                  className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-0 pt-2"
                >
                  {(runs.data?.items ?? []).map((run) => (
                    <li key={run.id} className="min-w-0">
                      <RunCard run={run} action={runAction(run)} />
                    </li>
                  ))}
                </ul>
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
      </PageBody>
    </Page>
  );
}
