import {
  type RunTrigger,
  runStatusSchema,
  runTriggerSchema,
  utcWindowStart,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Download, EllipsisVertical, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { BusinessIllustration } from '../../components/business-illustration.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterPopover } from '../../components/filter-popover.js';
import { FilterSelect } from '../../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import { RunStatusBadge } from '../../components/run/run-status-badge.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { type ListView, ViewToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { api, errorMessage, type RunListItem, type RunStatus } from '../../lib/api.js';
import { downloadBlob, downloadJson } from '../../lib/browser-files.js';
import { cn } from '../../lib/cn.js';
import { toCsv } from '../../lib/csv.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  runStatusLabel,
  runTriggerLabel,
  shortId,
  timeRangeOptions,
} from '../../lib/format.js';
import { meQuery, useAgents, useRuns } from '../../lib/queries.js';
import { toastError } from '../../lib/toast.js';

const statuses = runStatusSchema.options;

function ExpandableError({ error }: { error: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span
        className={cn(
          'min-w-0 text-danger',
          open
            ? 'break-words whitespace-normal'
            : 'overflow-hidden text-ellipsis whitespace-nowrap',
        )}
        title={open ? undefined : error}
      >
        {error}
      </span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-fg"
      >
        {open ? '收起' : '展开全文'}
      </button>
    </div>
  );
}

const columns: DataColumn<RunListItem>[] = [
  {
    id: 'id',
    header: '运行 ID',
    locked: true,
    width: '148px',
    sortValue: (run) => run.id,
    cell: (run) => (
      <code className="font-mono text-xs text-muted-foreground" title={run.id}>
        {shortId(run.id)}
      </code>
    ),
  },
  {
    id: 'agent',
    header: '专家',
    locked: true,
    width: 'minmax(140px,1fr)',
    sortValue: (run) => run.agentName ?? '',
    cell: (run) => (
      <span className="truncate text-fg">
        {run.agentName ?? <span className="text-muted-foreground">已删除的专家</span>}
      </span>
    ),
  },
  {
    id: 'status',
    header: '状态',
    width: '104px',
    sortValue: (run) => run.status,
    cell: (run) => <RunStatusBadge status={run.status} />,
  },
  {
    id: 'startedAt',
    header: '开始',
    width: '96px',
    sortValue: (run) => run.startedAt,
    cell: (run) => (
      <span className="text-sm text-muted-foreground" title={formatDateTime(run.startedAt)}>
        {formatRelative(run.startedAt)}
      </span>
    ),
  },
  {
    id: 'latency',
    header: '耗时',
    numeric: true,
    width: '80px',
    sortValue: (run) => run.latencyMs ?? null,
    cell: (run) => formatDuration(run.latencyMs),
  },
  {
    id: 'turns',
    header: '轮次',
    numeric: true,
    width: '64px',
    sortValue: (run) => run.turns ?? null,
    cell: (run) => run.turns ?? '—',
  },
  {
    id: 'cost',
    header: '成本',
    numeric: true,
    width: '80px',
    sortValue: (run) => run.costUsd ?? null,
    cell: (run) => formatCost(run.costUsd),
  },
  {
    id: 'tokens',
    header: 'Tokens',
    numeric: true,
    width: '104px',
    sortValue: (run) => (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
    cell: (run) => (
      <span title={`输入 ${run.inputTokens ?? '—'} / 输出 ${run.outputTokens ?? '—'}`}>
        {formatTokens(run.inputTokens)} / {formatTokens(run.outputTokens)}
      </span>
    ),
  },
  {
    id: 'error',
    header: '错误',
    width: 'minmax(140px,1fr)',
    cell: (run) =>
      run.error ? (
        <ExpandableError error={run.error} />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

function RunCard({ run }: { run: RunListItem }) {
  const backTo = useLocation().href;
  const agentName = run.agentName ?? '已删除的专家';
  const detailLink = {
    to: '/runs/$runId' as const,
    params: { runId: run.id },
    search: { backTo },
  };
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0">
          <h2 className="min-w-0">
            <Link {...detailLink} className="block truncate hover:underline" title={agentName}>
              {run.agentName ?? <span className="text-muted-foreground">已删除的专家</span>}
            </Link>
          </h2>
        </CardTitle>
        <CardAction>
          <RunStatusBadge status={run.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col gap-3">
        <RecordRows
          rows={[
            {
              label: '开始',
              value: (
                <span title={formatDateTime(run.startedAt)}>{formatRelative(run.startedAt)}</span>
              ),
            },
            ...(run.latencyMs != null
              ? [{ label: '耗时', value: formatDuration(run.latencyMs) }]
              : []),
            ...(run.turns != null ? [{ label: '轮次', value: run.turns }] : []),
            ...(run.costUsd != null ? [{ label: '成本', value: formatCost(run.costUsd) }] : []),
            ...(run.inputTokens != null || run.outputTokens != null
              ? [
                  { label: '输入 Tokens', value: formatTokens(run.inputTokens) },
                  { label: '输出 Tokens', value: formatTokens(run.outputTokens) },
                ]
              : []),
          ]}
        />
        {run.error ? (
          <div className="flex min-w-0 flex-col gap-0.5 text-xs">
            <span className="text-xs text-muted-foreground">错误</span>
            <ExpandableError error={run.error} />
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="mt-auto justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">运行 ID</span>
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={run.id}>
            {shortId(run.id)}
          </code>
        </span>
        <Link
          {...detailLink}
          aria-label={`查看 ${agentName} 运行 ${shortId(run.id)} 详情`}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}
        >
          查看详情
        </Link>
      </CardFooter>
    </Card>
  );
}

export function RunsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const me = useQuery(meQuery);
  const canExport = can(me.data, 'runs.export');
  const agents = useAgents();
  const search = useSearch({ from: '/_shell/runs/' });
  const agentId = search.agent ?? '';
  const status = search.status ?? '';
  const trigger = search.trigger ?? '';
  const range = search.range ?? 'all';
  const since = range === 'all' ? undefined : utcWindowStart(Number(range)).toISOString();
  const view: ListView = search.view ?? 'cards';
  const setFilter = (patch: {
    agent?: string | undefined;
    status?: RunStatus | undefined;
    trigger?: RunTrigger | undefined;
    range?: '7' | '30' | '90' | undefined;
  }): void => {
    void navigate({ to: '/runs', search: { ...search, ...patch } });
  };
  const setView = (next: ListView): void => {
    void navigate({ to: '/runs', search: { ...search, view: next }, replace: true });
  };
  const runs = useRuns({
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    ...(trigger ? { trigger } : {}),
    ...(since ? { since } : {}),
    limit: 100,
  });
  const [exporting, setExporting] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);

  const exportRuns = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportRuns({
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
        ...(trigger ? { trigger } : {}),
        ...(since ? { since } : {}),
      });
      downloadJson(data, 'runs.json');
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const exportRunsCsv = async () => {
    setExportingCsv(true);
    try {
      const data = await api.exportRuns({
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
        ...(trigger ? { trigger } : {}),
        ...(since ? { since } : {}),
      });
      const csv = toCsv(
        ['运行ID', '专家', '状态', '来源', '时间', '耗时ms', '成本USD', '输入Token', '输出Token'],
        data.items.map((run) => [
          run.id,
          run.agentName ?? '已删除的专家',
          runStatusLabel[run.status],
          run.trigger ? runTriggerLabel[run.trigger] : '',
          formatDateTime(run.startedAt),
          run.latencyMs ?? '',
          run.costUsd ?? '',
          run.inputTokens,
          run.outputTokens,
        ]),
      );
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'runs.csv');
    } catch (error) {
      toastError(error);
    } finally {
      setExportingCsv(false);
    }
  };

  const items = runs.data?.items ?? [];
  const firstLoadFailed = runs.isError && runs.data === undefined;
  const empty = !runs.isPending && !firstLoadFailed && items.length === 0;
  const filtered = Boolean(agentId || status || trigger || range !== 'all');
  const activeFilterCount =
    (agentId ? 1 : 0) + (status ? 1 : 0) + (trigger ? 1 : 0) + (range !== 'all' ? 1 : 0);

  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  const statusOptions = [
    { value: '', label: '全部状态' },
    ...statuses.map((value) => ({ value, label: runStatusLabel[value] })),
  ];
  const triggerOptions = [
    { value: '', label: '全部触发' },
    ...runTriggerSchema.options.map((value) => ({ value, label: runTriggerLabel[value] })),
  ];

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="运行"
          description={`${filtered ? '符合筛选条件的最近 100 条' : '最近 100 条'} · 排序仅作用于当前显示`}
          actions={
            <>
              <Button onClick={() => void runs.refetch()} disabled={runs.isFetching}>
                <RefreshCw
                  data-icon="inline-start"
                  className={runs.isFetching ? 'animate-spin' : undefined}
                  aria-hidden="true"
                />
                {runs.isFetching ? '刷新中…' : '刷新'}
              </Button>
              {canExport ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon" aria-label="更多操作">
                        <EllipsisVertical aria-hidden="true" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" sideOffset={4} className="w-48">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        disabled={exporting}
                        aria-busy={exporting}
                        onSelect={() => void exportRuns()}
                      >
                        <Download aria-hidden="true" />
                        {exporting ? '导出中…' : '导出运行 (JSON)'}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={exportingCsv}
                        aria-busy={exportingCsv}
                        onSelect={() => void exportRunsCsv()}
                      >
                        <Download aria-hidden="true" />
                        {exportingCsv ? '导出中…' : '导出 CSV'}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          }
        />

        <PageToolbar>
          <FilterPopover activeCount={activeFilterCount}>
            <FilterSelect
              value={agentId}
              onValueChange={(next) => setFilter({ agent: next || undefined })}
              options={agentOptions}
              label="按专家筛选"
              className="w-full"
            />
            <FilterSelect
              value={status}
              onValueChange={(next) =>
                setFilter({ status: (next || undefined) as RunStatus | undefined })
              }
              options={statusOptions}
              label="按状态筛选"
              className="w-full"
            />
            <FilterSelect
              value={trigger}
              onValueChange={(next) =>
                setFilter({ trigger: (next || undefined) as RunTrigger | undefined })
              }
              options={triggerOptions}
              label="按触发筛选"
              className="w-full"
            />
            <FilterSelect
              value={range}
              onValueChange={(next) =>
                setFilter({ range: next === 'all' ? undefined : (next as '7' | '30' | '90') })
              }
              options={timeRangeOptions}
              label="按时间范围过滤"
              className="w-full"
            />
          </FilterPopover>
          <span className="sr-only">
            {`时间范围：${timeRangeOptions.find((option) => option.value === range)?.label ?? '全部时间'}`}
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {runs.isPending
                ? '加载中…'
                : firstLoadFailed
                  ? '数量不可用'
                  : `共 ${items.length} 条运行`}
            </span>
            <ViewToggle value={view} onChange={setView} />
          </div>
        </PageToolbar>
      </PageTopbar>

      <PageBody>
        {agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : null}

        {firstLoadFailed ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : (
          <>
            {runs.isError ? (
              <PageNote
                tone="danger"
                title="刷新失败，保留上次运行记录"
                description={errorMessage(runs.error)}
                action={
                  <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}
            {empty ? (
              <PageNote
                icon={<BusinessIllustration name={filtered ? 'search' : 'runs'} size="compact" />}
                title={filtered ? '没有匹配的运行' : '无运行记录'}
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setFilter({
                          agent: undefined,
                          status: undefined,
                          trigger: undefined,
                          range: undefined,
                        })
                      }
                    >
                      清除筛选
                    </Button>
                  ) : (
                    <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
                      新建对话
                    </Link>
                  )
                }
              />
            ) : view === 'cards' ? (
              runs.isPending ? (
                <LoadingState rows={3} layout="cards" />
              ) : (
                <ul
                  aria-label="运行列表"
                  className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 pt-2"
                >
                  {items.map((run) => (
                    <li key={run.id} className="min-w-0">
                      <RunCard run={run} />
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <DataTable
                rows={items}
                columns={columns}
                rowKey={(run) => run.id}
                rowLabel={(run) =>
                  `${run.agentName ?? '已删除的专家'} · ${formatDateTime(run.startedAt)} · ${shortId(run.id)}`
                }
                label="运行列表"
                loading={runs.isPending}
                hideRowCount
                storageKey="pace.runs.columns"
                initialSorting={[{ id: 'startedAt', desc: true }]}
                empty="没有匹配的运行"
                onRowClick={(run) =>
                  void navigate({
                    to: '/runs/$runId',
                    params: { runId: run.id },
                    search: { backTo: location.href },
                  })
                }
              />
            )}
          </>
        )}
      </PageBody>
    </Page>
  );
}
