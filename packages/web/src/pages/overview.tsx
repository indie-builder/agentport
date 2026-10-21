import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, ArrowRight, Bot, CircleAlert, Plus, Server } from 'lucide-react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { TelemetryReadout, TelemetryStrip } from '../components/telemetry.js';
import { buttonVariants } from '../components/ui/button.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import type { OverviewAgentRow, RecentRun } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
  shortId,
} from '../lib/format.js';
import {
  agentsQuery,
  healthMetricsQuery,
  serversQuery,
  useOverview,
  useRuns,
} from '../lib/queries.js';

const agentColumns: DataColumn<OverviewAgentRow>[] = [
  {
    id: 'name',
    header: '智能体',
    locked: true,
    width: 'minmax(160px,1.4fr)',
    sortValue: (row) => row.name,
    cell: (row) => (
      <Link
        to="/agents"
        className="flex items-center gap-2 font-medium text-fg hover:underline hover:underline-offset-4"
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className={cn('size-1.5 shrink-0 rounded-full', row.enabled ? 'bg-success' : 'bg-subtle')}
        />
        <span className="truncate">{row.name}</span>
      </Link>
    ),
  },
  {
    id: 'lastRunStartTime',
    header: '最近运行',
    width: '110px',
    sortValue: (row) => row.lastRunStartTime,
    cell: (row) => (
      <span className="text-sm text-muted" title={formatDateTime(row.lastRunStartTime)}>
        {formatRelative(row.lastRunStartTime)}
      </span>
    ),
  },
  {
    id: 'runCount',
    header: '运行次数',
    numeric: true,
    width: '90px',
    sortValue: (row) => row.runCount,
    cell: (row) => row.runCount,
  },
  {
    id: 'totalCost',
    header: '总成本',
    numeric: true,
    width: '90px',
    sortValue: (row) => row.totalCost,
    cell: (row) => formatCost(row.totalCost),
  },
  {
    id: 'errorRate',
    header: '错误率',
    numeric: true,
    width: '80px',
    hiddenByDefault: true,
    sortValue: (row) => row.errorRate,
    cell: (row) =>
      row.runCount === 0 ? (
        <span className="text-subtle">—</span>
      ) : (
        <span className={row.errorRate > 0 ? 'text-danger' : undefined}>
          {formatPercent(row.errorRate)}
        </span>
      ),
  },
  {
    id: 'latencyP50',
    header: 'P50',
    numeric: true,
    width: '78px',
    hiddenByDefault: true,
    sortValue: (row) => row.latencyP50,
    cell: (row) => formatDuration(row.latencyP50),
  },
  {
    id: 'latencyP99',
    header: 'P99',
    numeric: true,
    width: '78px',
    hiddenByDefault: true,
    sortValue: (row) => row.latencyP99,
    cell: (row) => formatDuration(row.latencyP99),
  },
  {
    id: 'totalTokens',
    header: 'Tokens',
    numeric: true,
    width: '86px',
    hiddenByDefault: true,
    sortValue: (row) => row.totalTokens,
    cell: (row) => formatTokens(row.totalTokens),
  },
  {
    id: 'createdAt',
    header: '创建时间',
    width: '100px',
    hiddenByDefault: true,
    sortValue: (row) => row.createdAt,
    cell: (row) => <span className="text-sm">{formatRelative(row.createdAt)}</span>,
  },
  {
    id: 'agentId',
    header: 'Agent ID',
    width: '120px',
    hiddenByDefault: true,
    cell: (row) => (
      <code className="font-mono text-xs text-subtle" title={row.agentId}>
        {shortId(row.agentId)}
      </code>
    ),
  },
];

const runColumns: DataColumn<RecentRun>[] = [
  {
    id: 'id',
    header: '运行',
    width: '110px',
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
    width: '96px',
    sortValue: (run) => run.status,
    cell: (run) => (
      <div className="flex items-center gap-1">
        <RunStatusBadge status={run.status} />
        {run.error ? (
          <span title={run.error}>
            <StatusBadge tone="danger">错误</StatusBadge>
          </span>
        ) : null}
      </div>
    ),
  },
  {
    id: 'latency',
    header: '耗时',
    numeric: true,
    width: '80px',
    hiddenByDefault: true,
    sortValue: (run) => run.latencyMs ?? null,
    cell: (run) => formatDuration(run.latencyMs ?? null),
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
    width: '76px',
    sortValue: (run) => run.costUsd ?? null,
    cell: (run) => formatCost(run.costUsd),
  },
];

/** 平台健康：只在异常时占据注意力；正常时压成一行读数。 */
function HealthLine() {
  const { data } = useQuery(healthMetricsQuery);
  if (!data) {
    return <span className="text-2xs text-subtle">健康指标不可用</span>;
  }
  const queue = data.queue;
  const degraded = (queue?.failed ?? 0) > 0 || (queue?.waiting ?? 0) > 5;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-2xs tabular-nums text-muted">
      <span>
        队列 <span className={cn(degraded && 'text-warning')}>{queue?.waiting ?? 0}</span> 等待 /{' '}
        {queue?.active ?? 0} 运行
      </span>
      <span>Redis {data.redis?.pingMs ?? '—'} ms</span>
      <span>RSS {(data.process.memoryRssBytes / 1024 / 1024).toFixed(0)} MB</span>
      <Link to="/status" className="text-subtle underline-offset-2 hover:text-fg hover:underline">
        详情
      </Link>
    </div>
  );
}

/** 「需要处理」的一条：结论 + 定位链接。 */
interface AttentionItem {
  id: string;
  tone: 'danger' | 'warning';
  title: string;
  detail: string;
  runId: string;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: item.runId }}
      className="group flex h-14 items-center gap-3 border-b border-line px-2.5 last:border-b-0 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          item.tone === 'danger' ? 'bg-danger' : 'bg-warning',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
        <span className="block truncate text-2xs text-subtle">{item.detail}</span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-subtle group-hover:text-fg"
      />
    </Link>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  // overview 已带 servers/agents 计数，列表只作为旧后端（返回 null）的兜底，正常不请求。
  const fallback = overview.data === null;
  const servers = useQuery({ ...serversQuery, enabled: fallback });
  const agents = useQuery({ ...agentsQuery, enabled: fallback });
  // 待办与刻度带来自最近运行；/api/overview 的 recent 优先。
  const runs = useRuns({ limit: 50 });

  const counts = overview.data?.counts ?? {
    servers: servers.data?.length ?? 0,
    agents: agents.data?.length ?? 0,
    runs: null,
    running: null,
  };
  const recent = overview.data?.recent ?? runs.data?.items ?? null;
  const agentRows = overview.data?.agents ?? null;
  // 只有 runs 是最近运行来源时才由它报错；否则「没有失败」会被当成结论。
  const runsSource = (overview.data?.recent ?? null) === null;
  const runsError = runsSource && runs.isError ? runs.error : null;

  const error = overview.isError ? overview.error : (servers.error ?? agents.error);
  const loading = overview.isPending || servers.isPending || agents.isPending;
  const empty = !loading && !error && counts.servers === 0 && counts.agents === 0;

  const attention: AttentionItem[] = (recent ?? [])
    .filter((run) => run.status === 'failed' || run.status === 'timeout')
    .slice(0, 5)
    .map((run) => ({
      id: run.id,
      tone: run.status === 'timeout' ? 'warning' : 'danger',
      title: `${run.agentName ?? '已删除的智能体'} · ${run.status === 'timeout' ? '超时' : '失败'}`,
      detail: run.error ?? `${formatRelative(run.startedAt)} · ${shortId(run.id)}`,
      runId: run.id,
    }));

  const ticks = (recent ?? [])
    .slice(0, 40)
    .reverse()
    .map((run) => ({
      id: run.id,
      state:
        run.status === 'running'
          ? ('live' as const)
          : run.status === 'failed' || run.status === 'timeout'
            ? ('error' as const)
            : run.status === 'queued'
              ? ('idle' as const)
              : ('ok' as const),
      label: `${run.agentName ?? run.id} · ${run.status} · ${formatRelative(run.startedAt)}`,
    }));

  return (
    <Page>
      <PageHeader
        title="工作台"
        description="需要处理的事项、平台读数与最近运行。"
        meta={
          <>
            <TelemetryReadout
              label="运行"
              value={counts.runs ?? recent?.length ?? 0}
              hint={counts.running ? `${counts.running} 个正在进行` : '当前空闲'}
            />
            <TelemetryReadout
              label="成本"
              value={counts.costUsd === undefined ? '—' : formatCost(counts.costUsd)}
              hint="统计窗口内"
            />
            <div>
              <div className="text-2xs font-medium uppercase tracking-[0.08em] text-subtle">
                最近 40 次
              </div>
              <div className="mt-1.5">
                <TelemetryStrip ticks={ticks} label="最近运行状态" />
              </div>
            </div>
          </>
        }
        actions={
          <>
            <Link
              to="/servers"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'hidden sm:inline-flex',
              )}
            >
              <Server className="size-3.5" /> 接入 API
            </Link>
            <Link to="/chat" className={cn(buttonVariants({ size: 'sm' }))}>
              <Plus className="size-3.5" /> 新建对话
            </Link>
          </>
        }
      />

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void overview.refetch();
            void servers.refetch();
            void agents.refetch();
          }}
        />
      ) : null}

      {empty ? (
        <PageNote
          icon={<Bot className="size-4" aria-hidden="true" />}
          title="平台还没有任何配置"
          description="三步开始：接入一个 MCP Server → 创建智能体并绑定它 → 在对话里使用。"
          action={
            <Link to="/servers" className={cn(buttonVariants({ size: 'sm' }))}>
              <Plus className="size-3.5" /> 接入 MCP Server
            </Link>
          }
        />
      ) : null}

      {!empty && !error ? (
        <>
          <PageSection
            title="需要处理"
            {...(attention.length === 0 ? {} : { description: `${attention.length} 项` })}
            divided={false}
          >
            {runsError ? (
              <ErrorState error={runsError} onRetry={() => void runs.refetch()} />
            ) : runs.isPending && runsSource ? (
              <LoadingState rows={2} />
            ) : attention.length === 0 ? (
              <PageNote title="过去 24 小时没有失败或超时的运行" />
            ) : (
              <div>
                {attention.map((item) => (
                  <AttentionRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </PageSection>

          <PageSection
            title="平台"
            actions={<HealthLine />}
            description={
              counts.servers === 0
                ? '还没有接入任何 MCP Server，智能体暂时无法调用工具。'
                : `${counts.servers} 个 MCP Server · ${counts.agents} 个智能体`
            }
          >
            <div className="flex flex-wrap gap-2">
              <Link
                to="/servers"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
              >
                <Server aria-hidden="true" className="size-3.5 text-subtle" />
                MCP Servers
                <span className="font-mono tabular-nums text-subtle">{counts.servers}</span>
              </Link>
              <Link
                to="/agents"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
              >
                <Bot aria-hidden="true" className="size-3.5 text-subtle" />
                智能体
                <span className="font-mono tabular-nums text-subtle">{counts.agents}</span>
              </Link>
              <Link
                to="/runs"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}
              >
                <Activity aria-hidden="true" className="size-3.5 text-subtle" />
                运行
                <span className="font-mono tabular-nums text-subtle">{counts.runs ?? '—'}</span>
              </Link>
            </div>
          </PageSection>

          <PageSection title="智能体" description="最近 7 天">
            {overview.isPending ? <LoadingState rows={3} /> : null}
            {fallback ? (
              <PageNote
                title="聚合指标暂不可用"
                description={
                  <>
                    后端还没有提供 <code className="font-mono text-fg/80">GET /api/overview</code>
                    ；接入后这里会自动显示。
                  </>
                }
              />
            ) : null}
            {agentRows && agentRows.length === 0 ? (
              <PageNote
                icon={<Bot className="size-4" aria-hidden="true" />}
                title="还没有智能体"
                description="创建智能体、绑定 MCP Server 后，这里会显示运行次数与成本。"
                action={
                  <Link to="/agents" className={cn(buttonVariants({ size: 'sm' }))}>
                    <Plus className="size-3.5" /> 新建智能体
                  </Link>
                }
              />
            ) : null}
            {agentRows && agentRows.length > 0 ? (
              <DataTable
                rows={agentRows}
                columns={agentColumns}
                rowKey={(row) => row.agentId}
                label="智能体指标"
                storageKey="pace.overview.agent-columns"
                empty="还没有智能体"
              />
            ) : null}
          </PageSection>

          <PageSection title="最近运行" description="最近 20 条；失败项在上方「需要处理」">
            {runsError ? (
              <ErrorState error={runsError} onRetry={() => void runs.refetch()} />
            ) : null}
            {recent && recent.length === 0 ? (
              <PageNote
                icon={<Activity className="size-4" aria-hidden="true" />}
                title="还没有运行记录"
                description="在对话页发起一次运行，这里会显示状态、耗时与成本。"
                action={
                  <Link to="/chat" className={cn(buttonVariants({ size: 'sm' }))}>
                    去发起运行
                  </Link>
                }
              />
            ) : null}
            {recent && recent.length > 0 ? (
              <DataTable
                rows={recent}
                columns={runColumns}
                rowKey={(run) => run.id}
                label="最近运行"
                storageKey="pace.overview.run-columns"
                empty="还没有运行记录"
              />
            ) : null}
          </PageSection>

          {attention.length > 0 ? (
            <p className="flex items-center gap-1.5 text-2xs text-subtle">
              <CircleAlert aria-hidden="true" className="size-3" />
              失败原因与下一步见每条运行的详情；权限类失败需要在运行页批准后重试。
            </p>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
