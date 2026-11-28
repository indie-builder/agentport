import {
  type RunTrigger,
  runStatusSchema,
  runTriggerSchema,
  utcWindowStart,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { CircleAlert, Download, EllipsisVertical, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CopyButton } from '../../components/copy-button.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { FilterPopover } from '../../components/filter-popover.js';
import { FilterSelect } from '../../components/filter-select.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
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
import { stepIcons, stepName } from '../../components/run/run-steps.js';
import {
  ActiveFilterChips,
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
import { useDialogClose } from '../../lib/dialog-guard.js';
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
import { meQuery, useAgents, useRun, useRuns } from '../../lib/queries.js';
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
      <ButtonPrimitive
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? '收起' : '展开全文'}
      </ButtonPrimitive>
    </div>
  );
}

function createColumns(
  onPreview: (runId: string, trigger: HTMLElement) => void,
): DataColumn<RunListItem>[] {
  return [
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
      id: 'cost',
      header: '成本',
      numeric: true,
      width: '80px',
      sortValue: (run) => run.costUsd ?? null,
      cell: (run) => formatCost(run.costUsd),
    },
    {
      id: 'turns',
      header: '轮次',
      numeric: true,
      hiddenByDefault: true,
      width: '64px',
      sortValue: (run) => run.turns ?? null,
      cell: (run) => run.turns ?? '—',
    },
    {
      id: 'tokens',
      header: 'Tokens',
      numeric: true,
      hiddenByDefault: true,
      width: '104px',
      sortValue: (run) => (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
      cell: (run) => (
        <span title={`输入 ${run.inputTokens ?? '—'} / 输出 ${run.outputTokens ?? '—'}`}>
          {formatTokens(run.inputTokens)} / {formatTokens(run.outputTokens)}
        </span>
      ),
    },
    {
      id: 'trigger',
      header: '来源',
      hiddenByDefault: true,
      width: '88px',
      sortValue: (run) => run.trigger ?? null,
      cell: (run) => (run.trigger ? runTriggerLabel[run.trigger] : '—'),
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
    {
      id: 'actions',
      header: '操作',
      locked: true,
      align: 'end',
      width: '72px',
      cell: (run) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`速览运行 ${shortId(run.id)}`}
          onClick={(event) => {
            event.stopPropagation();
            onPreview(run.id, event.currentTarget);
          }}
        >
          速览
        </Button>
      ),
    },
  ];
}

function RunCard({
  run,
  onPreview,
}: {
  run: RunListItem;
  onPreview: (runId: string, trigger: HTMLElement) => void;
}) {
  const backTo = useLocation().href;
  const agentName = run.agentName ?? '已删除的专家';
  const detailLink = {
    to: '/runs/$runId' as const,
    params: { runId: run.id },
    search: { backTo },
  };
  const hasTokens = run.inputTokens != null || run.outputTokens != null;
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
                <span title={formatDateTime(run.startedAt)}>
                  {formatRelative(run.startedAt)}
                  {run.latencyMs != null ? ` · ${formatDuration(run.latencyMs)}` : ''}
                </span>
              ),
            },
            {
              label: '成本 / 轮次',
              ...(hasTokens
                ? { title: `输入 ${run.inputTokens ?? '—'} / 输出 ${run.outputTokens ?? '—'}` }
                : {}),
              value: `${formatCost(run.costUsd)}${run.turns != null ? ` · ${run.turns} 轮` : ''}`,
            },
            ...(hasTokens
              ? [
                  {
                    label: 'Tokens',
                    mono: true,
                    value: `${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`,
                  },
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
      <CardFooter className="mt-auto justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">运行 ID</span>
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={run.id}>
            {shortId(run.id)}
          </code>
        </span>
        <div className="flex shrink-0 items-center gap-1 -me-2.5">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`速览运行 ${shortId(run.id)}`}
            onClick={(event) => onPreview(run.id, event.currentTarget)}
          >
            速览
          </Button>
          <Link
            {...detailLink}
            data-variant="ghost"
            data-size="sm"
            aria-label={`查看 ${agentName} 运行 ${shortId(run.id)} 详情`}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}
          >
            查看详情
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}

function RunPreviewSheet({
  runId,
  fallback,
  backTo,
  onClose,
  finalFocus,
}: {
  runId: string;
  fallback?: RunListItem | undefined;
  backTo: string;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const sheet = useDialogClose(onClose);
  const run = useRun(runId);
  const detail = run.data?.run;
  const conversation = run.data?.conversation;
  const steps = run.data?.steps ?? [];
  const status = detail?.status ?? fallback?.status;
  const recentSteps = steps.slice(-5);
  const recentStartIndex = Math.max(0, steps.length - recentSteps.length);
  const cleanBackUrl = new URL(backTo, 'http://localhost');
  cleanBackUrl.searchParams.delete('preview');
  const cleanBackQuery = cleanBackUrl.searchParams.toString();
  const cleanBackTo = `${cleanBackUrl.pathname}${cleanBackQuery ? `?${cleanBackQuery}` : ''}${cleanBackUrl.hash}`;

  return (
    <InspectorSheet
      open={sheet.open}
      onOpenChange={(next) => {
        if (!next) sheet.close();
      }}
      onOpenChangeComplete={sheet.onOpenChangeComplete}
      size="md"
      title={`运行 ${shortId(runId)}`}
      eyebrow={status ? <RunStatusBadge status={status} /> : null}
      finalFocus={finalFocus}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            to="/chat"
            search={
              conversation ? { agent: conversation.agentId, conversation: conversation.id } : {}
            }
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            打开对话
          </Link>
          <Link
            to="/runs/$runId"
            params={{ runId }}
            search={{ backTo: cleanBackTo }}
            className={buttonVariants({ size: 'sm' })}
          >
            进入完整轨迹
          </Link>
        </div>
      }
    >
      {run.isPending ? (
        <LoadingState rows={4} />
      ) : run.data === undefined ? (
        <ErrorState error={run.error} onRetry={() => void run.refetch()} />
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          <RecordRows
            rows={[
              {
                label: '专家',
                value: detail?.agentName ?? (
                  <span className="text-muted-foreground">已删除的专家</span>
                ),
              },
              {
                label: '状态',
                value: detail ? runStatusLabel[detail.status] : '—',
              },
              {
                label: '开始时间',
                mono: true,
                value: formatDateTime(detail?.startedAt),
              },
              {
                label: '耗时',
                mono: true,
                value: formatDuration(detail?.latencyMs),
              },
              {
                label: '轮次',
                mono: true,
                value: detail?.turns ?? '—',
              },
              {
                label: '成本',
                mono: true,
                value: formatCost(detail?.costUsd),
              },
              {
                label: 'Tokens',
                mono: true,
                value: `${formatTokens(detail?.inputTokens)} / ${formatTokens(detail?.outputTokens)}`,
              },
            ]}
          />

          {detail?.error ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-item border border-line bg-danger-soft p-3"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-fg">
                  运行{runStatusLabel[detail.status]}
                </div>
                <pre className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-5 text-muted-foreground">
                  {detail.error}
                </pre>
              </div>
              <CopyButton value={detail.error} label="复制错误" />
            </div>
          ) : null}

          <section className="flex min-w-0 flex-col gap-2 border-t border-line pt-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">步骤概览</h3>
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                共 {steps.length} 步
              </span>
            </div>
            {recentSteps.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无执行步骤。</p>
            ) : (
              <ol className="flex min-w-0 flex-col divide-y divide-line rounded-item border border-line bg-surface">
                {recentSteps.map((step, offset) => {
                  const Icon = stepIcons[step.kind];
                  const number = recentStartIndex + offset + 1;
                  return (
                    <li
                      key={`${number}:${step.at}:${step.kind}`}
                      className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs"
                    >
                      <span className="w-5 shrink-0 text-end font-mono text-2xs tabular-nums text-muted-foreground">
                        {number}
                      </span>
                      <Icon className="shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">
                        {stepName(step)}
                      </span>
                      <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {formatDateTime(step.at)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      )}
    </InspectorSheet>
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
  const view: ListView = search.view ?? 'table';
  const previewId = search.preview;
  const previewTriggerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const setFilter = (patch: {
    agent?: string | undefined;
    status?: RunStatus | undefined;
    trigger?: RunTrigger | undefined;
    range?: '7' | '30' | '90' | undefined;
  }): void => {
    void navigate({ to: '/runs', search: { ...search, ...patch } });
  };
  const clearAllFilters = (): void => {
    setFilter({
      agent: undefined,
      status: undefined,
      trigger: undefined,
      range: undefined,
    });
  };
  const setView = (next: ListView): void => {
    void navigate({ to: '/runs', search: { ...search, view: next }, replace: true });
  };
  const openPreview = useCallback(
    (runId: string, triggerElement: HTMLElement): void => {
      previewTriggerRef.current = triggerElement;
      void navigate({
        to: '/runs',
        search: { ...searchRef.current, preview: runId },
        replace: true,
      });
    },
    [navigate],
  );
  const closePreview = useCallback((): void => {
    void navigate({
      to: '/runs',
      search: { ...searchRef.current, preview: undefined },
      replace: true,
    });
  }, [navigate]);
  const columns = useMemo(() => createColumns(openPreview), [openPreview]);
  const runs = useRuns({
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    ...(trigger ? { trigger } : {}),
    ...(since ? { since } : {}),
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

  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const firstLoadFailed = runs.isError && runs.data === undefined;
  const empty = !runs.isPending && !firstLoadFailed && items.length === 0;
  const filtered = Boolean(agentId || status || trigger || range !== 'all');
  const activeFilterCount =
    (agentId ? 1 : 0) + (status ? 1 : 0) + (trigger ? 1 : 0) + (range !== 'all' ? 1 : 0);

  const activeFilters: EmptyFilterChip[] = [
    ...(agentId
      ? [
          {
            key: 'agent',
            label: '专家',
            value: agents.data?.find((agent) => agent.id === agentId)?.name ?? agentId,
            onRemove: () => setFilter({ agent: undefined }),
          },
        ]
      : []),
    ...(status
      ? [
          {
            key: 'status',
            label: '状态',
            value: runStatusLabel[status],
            onRemove: () => setFilter({ status: undefined }),
          },
        ]
      : []),
    ...(trigger
      ? [
          {
            key: 'trigger',
            label: '触发',
            value: runTriggerLabel[trigger],
            onRemove: () => setFilter({ trigger: undefined }),
          },
        ]
      : []),
    ...(range !== 'all'
      ? [
          {
            key: 'range',
            label: '时间范围',
            value: timeRangeOptions.find((option) => option.value === range)?.label ?? range,
            onRemove: () => setFilter({ range: undefined }),
          },
        ]
      : []),
  ];

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
          description={`${filtered ? '符合筛选条件的运行' : '全部运行'} · 排序仅作用于当前显示`}
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
          {!empty && activeFilters.length > 0 ? (
            <ActiveFilterChips filters={activeFilters} onClearAll={clearAllFilters} />
          ) : null}
          <span className="sr-only">
            {`时间范围：${timeRangeOptions.find((option) => option.value === range)?.label ?? '全部时间'}`}
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {runs.isPending
                ? '加载中…'
                : firstLoadFailed
                  ? '数量不可用'
                  : runs.hasNextPage
                    ? `已加载 ${items.length} 条运行`
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
              filtered ? (
                <EmptyState
                  variant="filter"
                  scale="section"
                  title="没有匹配的运行记录"
                  activeFilters={activeFilters}
                  action={
                    <Button variant="outline" size="sm" onClick={clearAllFilters}>
                      清除全部筛选
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  variant="stage"
                  scale="page"
                  specimen="runs"
                  title="等待首次运行"
                  description="在对话、频道或定时任务中调用专家后，每次执行的耗时与成本都会记录在这里。"
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
                  aria-label="运行列表"
                  className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 pt-2"
                >
                  {items.map((run) => (
                    <li key={run.id} className="min-w-0">
                      <RunCard run={run} onPreview={openPreview} />
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
                storageKey="pace.runs.columns-v2"
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
            <CursorListFooter
              className="pt-2"
              query={runs}
              errorVariant="note"
              errorTitle="更多运行没有加载出来"
            />
          </>
        )}
      </PageBody>

      {previewId ? (
        <RunPreviewSheet
          key={previewId}
          runId={previewId}
          fallback={items.find((item) => item.id === previewId)}
          backTo={location.href}
          onClose={closePreview}
          finalFocus={() =>
            previewTriggerRef.current?.isConnected ? previewTriggerRef.current : null
          }
        />
      ) : null}
    </Page>
  );
}
