import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { BusinessIllustration } from '../components/business-illustration.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
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
import { api, errorMessage, type RunListItem, type RunStatus } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { meQuery, useAgents, useRuns } from '../lib/queries.js';
import { toastError } from '../lib/toast.js';

const statuses: RunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

function ExpandableError({ error }: { error: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span
        className={cn(
          'min-w-0 text-danger',
          // DataTable 会把 .truncate 还原成换行；这里显式单行省略，展开后只在单元格内换行。
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
        {run.agentName ?? <span className="text-muted-foreground">已删除</span>}
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
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0">
          <h2 className="min-w-0">
            <Link {...detailLink} className="block truncate hover:underline" title={agentName}>
              {run.agentName ?? <span className="text-muted-foreground">已删除</span>}
            </Link>
          </h2>
        </CardTitle>
        <CardAction>
          <RunStatusBadge status={run.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">开始</dt>
          <dd className="text-right text-muted-foreground" title={formatDateTime(run.startedAt)}>
            {formatRelative(run.startedAt)}
          </dd>
          <dt className="text-muted-foreground">耗时</dt>
          <dd className="text-right">{formatDuration(run.latencyMs)}</dd>
          <dt className="text-muted-foreground">轮次</dt>
          <dd className="text-right">{run.turns ?? '—'}</dd>
          <dt className="text-muted-foreground">成本</dt>
          <dd className="text-right">{formatCost(run.costUsd)}</dd>
          <dt className="text-muted-foreground">输入 Tokens</dt>
          <dd className="text-right">{formatTokens(run.inputTokens)}</dd>
          <dt className="text-muted-foreground">输出 Tokens</dt>
          <dd className="text-right">{formatTokens(run.outputTokens)}</dd>
        </dl>
        {run.error ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">错误</span>
            <p className="break-words whitespace-pre-wrap text-xs text-danger">{run.error}</p>
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-xs text-muted-foreground">运行 ID</span>
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={run.id}>
            {shortId(run.id)}
          </code>
        </span>
        <Link
          {...detailLink}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          aria-label={`查看运行 ${shortId(run.id)}`}
        >
          查看运行
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
  // 筛选放在 URL 里：刷新、分享、前进后退都保留条件。
  const search = useSearch({ from: '/_shell/runs/' });
  const agentId = search.agent ?? '';
  const status = search.status ?? '';
  const view: ListView = search.view ?? 'table';
  const setFilter = (patch: {
    agent?: string | undefined;
    status?: RunStatus | undefined;
  }): void => {
    void navigate({ to: '/runs', search: { ...search, ...patch } });
  };
  const setView = (next: ListView): void => {
    void navigate({ to: '/runs', search: { ...search, view: next }, replace: true });
  };
  const runs = useRuns({
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    limit: 100,
  });
  const [exporting, setExporting] = useState(false);

  const exportRuns = async (): Promise<void> => {
    setExporting(true);
    try {
      const data = await api.exportRuns({
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'runs.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toastError(error);
    } finally {
      setExporting(false);
    }
  };

  const items = runs.data?.items ?? [];
  const firstLoadFailed = runs.isError && runs.data === undefined;
  const empty = !runs.isPending && !firstLoadFailed && items.length === 0;
  const filtered = Boolean(agentId || status);

  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  const statusOptions = [
    { value: '', label: '全部状态' },
    ...statuses.map((value) => ({ value, label: runStatusLabel[value] })),
  ];

  return (
    <Page>
      <PageHeader
        title="运行"
        actions={
          <>
            {canExport ? (
              <Button variant="outline" onClick={() => void exportRuns()} disabled={exporting}>
                <Download data-icon="inline-start" aria-hidden="true" />
                {exporting ? '导出中…' : '导出运行'}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void runs.refetch()}
              disabled={runs.isFetching}
            >
              <RefreshCw
                data-icon="inline-start"
                className={runs.isFetching ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
              {runs.isFetching ? '刷新中…' : '刷新'}
            </Button>
          </>
        }
      />

      <PageToolbar>
        <FilterSelect
          value={agentId}
          onValueChange={(next) => setFilter({ agent: next || undefined })}
          options={agentOptions}
          label="按专家筛选"
          className="w-full sm:w-36"
        />
        <FilterSelect
          value={status}
          onValueChange={(next) =>
            setFilter({ status: (next || undefined) as RunStatus | undefined })
          }
          options={statusOptions}
          label="按状态筛选"
          className="w-full sm:w-36"
        />
        <p className="text-sm text-muted-foreground">
          最多显示{filtered ? '符合筛选条件的最近 100 条运行' : '最近 100 条运行'}
          ，按开始时间选取，未开始的排在最后；排序仅作用于当前显示的记录。
        </p>
        <div className="ml-auto">
          <ViewToggle value={view} onChange={setView} />
        </div>
      </PageToolbar>

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
              title={filtered ? '没有匹配的运行' : '还没有运行记录'}
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter({ agent: undefined, status: undefined })}
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
              <LoadingState rows={3} layout="cards" columns={3} />
            ) : (
              <ul
                aria-label="运行列表"
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
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
    </Page>
  );
}
