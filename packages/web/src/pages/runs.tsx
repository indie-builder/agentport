import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { ErrorState } from '../components/states.js';
import { buttonVariants } from '../components/ui/button.js';
import { Select } from '../components/ui/select.js';
import type { RunListItem, RunStatus } from '../lib/api.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { useAgents, useRuns } from '../lib/queries.js';

const statuses: RunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

const columns: DataColumn<RunListItem>[] = [
  {
    id: 'id',
    header: '运行 ID',
    locked: true,
    width: '148px',
    sortValue: (run) => run.id,
    cell: (run) => (
      <code className="font-mono text-xs text-subtle" title={run.id}>
        {shortId(run.id)}
      </code>
    ),
  },
  {
    id: 'agent',
    header: '智能体',
    locked: true,
    width: 'minmax(140px,1fr)',
    sortValue: (run) => run.agentName ?? '',
    cell: (run) => (
      <span className="truncate text-fg">
        {run.agentName ?? <span className="text-subtle">已删除</span>}
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
    sortValue: (run) => run.startedAt ?? '',
    cell: (run) => (
      <span className="text-sm text-muted" title={formatDateTime(run.startedAt)}>
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
    width: 'minmax(140px,1.2fr)',
    cell: (run) =>
      run.error ? (
        <span className="truncate text-danger" title={run.error}>
          {run.error}
        </span>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
];

export function RunsPage() {
  const navigate = useNavigate();
  const agents = useAgents();
  // 筛选放在 URL 里：刷新、分享、前进后退都保留条件。
  const search = useSearch({ from: '/shell/runs' });
  const agentId = search.agent ?? '';
  const status = search.status ?? '';
  const setFilter = (patch: {
    agent?: string | undefined;
    status?: RunStatus | undefined;
  }): void => {
    void navigate({ to: '/runs', search: { ...search, ...patch } });
  };
  const runs = useRuns({
    ...(agentId ? { agentId } : {}),
    ...(status ? { status } : {}),
    limit: 100,
  });

  const items = runs.data?.items ?? [];
  const empty = !runs.isPending && !runs.isError && items.length === 0;

  return (
    <Page>
      <PageHeader title="运行" />

      <PageToolbar>
        <Select
          aria-label="按智能体筛选"
          className="w-48 rounded-[9px]"
          value={agentId}
          onValueChange={(next) => setFilter({ agent: next || undefined })}
          options={[
            { value: '', label: '全部智能体' },
            ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
        />
        <Select
          aria-label="按状态筛选"
          className="w-32 rounded-[9px]"
          value={status}
          onValueChange={(next) =>
            setFilter({ status: (next || undefined) as RunStatus | undefined })
          }
          options={[
            { value: '', label: '全部状态' },
            ...statuses.map((value) => ({ value, label: runStatusLabel[value] })),
          ]}
        />
        <span className="ml-auto text-xs text-subtle">
          {runs.isPending ? '加载中…' : `最近 ${items.length} 条`}
        </span>
      </PageToolbar>

      {runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : empty ? (
        <PageNote
          icon={<Activity className="size-4" strokeWidth={1.75} aria-hidden="true" />}
          title="没有匹配的运行"
          description="在对话页发起一次运行，或调整上方的筛选条件。"
          action={
            <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
              去发起运行
            </Link>
          }
        />
      ) : (
        <DataTable
          rows={items}
          columns={columns}
          rowKey={(run) => run.id}
          label="运行列表"
          loading={runs.isPending}
          storageKey="pace.runs.columns"
          empty="没有匹配的运行"
          // DataTable 只在提供 renderExpanded 时启用整行按钮；这里不展开，只借它跳详情。
          renderExpanded={() => null}
          onRowClick={(run) => void navigate({ to: '/runs/$runId', params: { runId: run.id } })}
        />
      )}
    </Page>
  );
}
