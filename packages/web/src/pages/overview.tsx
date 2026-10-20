import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, Bot, MessagesSquare, Plus, Server } from 'lucide-react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageSection } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { buttonVariants } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Skeleton } from '../components/ui/skeleton.js';
import type { OverviewAgentRow, RecentRun } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
  shortId,
} from '../lib/format.js';
import { agentsQuery, healthMetricsQuery, serversQuery, useOverview } from '../lib/queries.js';

const links = [
  {
    to: '/servers',
    label: 'MCP Servers',
    description: '接入 stdio / HTTP，或把 HTTP API 包装成 MCP',
    icon: Server,
  },
  {
    to: '/agents',
    label: '智能体',
    description: '配置提示词、模型、技能与绑定的 MCP Servers',
    icon: Bot,
  },
  {
    to: '/chat',
    label: '对话',
    description: '选择智能体发起一次带工具的对话',
    icon: MessagesSquare,
  },
] as const;

/**
 * 首屏的四个数字合成一条账本，而不是四张同款指标卡。
 * 理由：四张等宽卡片会把视线均匀摊开，读者不知道哪个数字值得先看；
 * 一条横向账本按「规模 → 活动 → 成本」的顺序阅读，分隔线给出节奏。
 */
function LedgerCell({
  label,
  value,
  hint,
  loading,
  emphasis = false,
}: {
  label: string;
  value: number | string;
  hint: string;
  loading: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0 px-4 py-3.5 first:pl-5 last:pr-5 sm:px-5">
      <div className="text-[11px] font-medium tracking-[0.04em] text-subtle">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-14" />
      ) : (
        <div
          className={cn(
            'mt-1 leading-none tabular-nums',
            emphasis ? 'text-[26px] font-semibold text-fg' : 'text-[22px] font-medium text-fg',
          )}
        >
          {value}
        </div>
      )}
      <div className="mt-1.5 truncate text-[11px] text-subtle" title={hint}>
        {hint}
      </div>
    </div>
  );
}

/** 智能体聚合表：参考 LangSmith 的 agents 表，列可显隐、可排序。 */
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
        className="flex items-center gap-2 font-medium text-fg hover:text-accent"
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
      <span className="text-[12.5px] text-muted" title={formatDateTime(row.lastRunStartTime)}>
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
    cell: (row) => <span className="text-[12.5px]">{formatRelative(row.createdAt)}</span>,
  },
  {
    id: 'agentId',
    header: 'Agent ID',
    width: '120px',
    hiddenByDefault: true,
    cell: (row) => (
      <code className="font-mono text-[11.5px] text-subtle" title={row.agentId}>
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
      <code className="font-mono text-[11.5px] text-subtle" title={run.id}>
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
            <Badge variant="danger">错误</Badge>
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
      <span className="text-[12.5px] text-muted" title={formatDateTime(run.startedAt)}>
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

/** 平台健康：队列堆积与进程内存，每 30 秒刷新；读取失败只显示「不可用」。 */
function PlatformHealth() {
  const { data } = useQuery(healthMetricsQuery);
  const queue = data?.queue ?? null;
  const rows: Array<[string, string]> = [
    ['队列等待', queue ? String(queue.waiting) : '不可用'],
    ['队列运行中', queue ? String(queue.active) : '不可用'],
    ['队列失败', queue ? String(queue.failed) : '不可用'],
    ['Redis 延迟', data?.redis ? `${data.redis.pingMs} ms` : '不可用'],
    ['内存 RSS', data ? formatBytes(data.process.memoryRssBytes) : '不可用'],
  ];

  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-fg">平台健康</h2>
          <span className="text-[11px] text-subtle">每 30 秒刷新</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-5">
          {rows.map(([label, value]) => (
            <div key={label}>
              <div className="text-[11px] text-subtle">{label}</div>
              <div
                className="mt-0.5 text-[13px] font-medium tabular-nums text-fg"
                title={value === '不可用' ? '这项指标暂时读不到，稍后会自动重试' : undefined}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  // overview 已带 servers/agents 计数，列表只作为旧后端（返回 null）的兜底，正常不请求。
  const fallback = overview.data === null;
  const servers = useQuery({ ...serversQuery, enabled: fallback });
  const agents = useQuery({ ...agentsQuery, enabled: fallback });

  const counts = overview.data?.counts ?? {
    servers: servers.data?.length ?? 0,
    agents: agents.data?.length ?? 0,
    runs: null,
    running: null,
  };
  const recent = overview.data?.recent ?? null;
  const agentRows = overview.data?.agents ?? null;

  const error = overview.isError ? overview.error : (servers.error ?? agents.error);
  const loading = overview.isPending || servers.isPending || agents.isPending;
  const empty = !loading && !error && counts.servers === 0 && counts.agents === 0;

  return (
    <Page>
      <PageHeader
        title="概览"
        description="智能体的运行次数、成本与延迟，以及最近的执行记录。"
        actions={
          <Link
            to="/agents"
            className={cn(buttonVariants({ size: 'sm' }), 'hidden sm:inline-flex')}
          >
            <Plus className="size-3.5" /> 新建智能体
          </Link>
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
        <EmptyState
          title="平台还没有任何配置"
          description="先接入一个 MCP Server，再创建智能体把工具交给它。"
          action={
            <Link to="/servers" className={buttonVariants({ size: 'sm' })}>
              <Plus className="size-3.5" /> 接入 MCP Server
            </Link>
          }
        />
      ) : null}

      {!empty && !error ? (
        <>
          <div className="grid divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
            <LedgerCell
              label="MCP Servers"
              value={counts.servers}
              hint="已注册的连接"
              loading={loading}
            />
            <LedgerCell label="智能体" value={counts.agents} hint="已定义" loading={loading} />
            <LedgerCell
              label="运行总数"
              value={counts.runs ?? '—'}
              hint={fallback ? '需要 /api/overview' : '统计窗口内'}
              loading={loading}
              emphasis
            />
            <LedgerCell
              label="累计成本"
              value={counts.costUsd === undefined ? '—' : formatCost(counts.costUsd)}
              hint={counts.running ? `${counts.running} 个正在运行` : '当前空闲'}
              loading={loading}
            />
          </div>

          <PlatformHealth />

          <PageSection title="智能体" description="最近 7 天">
            {overview.isPending ? <LoadingState rows={3} /> : null}
            {fallback ? (
              <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-muted">
                聚合指标暂不可用：后端还没有提供{' '}
                <code className="font-mono text-fg/80">GET /api/overview</code>
                。接入后这里会自动显示；其余内容不受影响。
              </div>
            ) : null}
            {agentRows && agentRows.length === 0 ? (
              <EmptyState
                icon={<Bot className="size-5" />}
                title="还没有智能体"
                description="创建智能体、绑定 MCP Server 后，这里会显示运行次数与成本。"
                action={
                  <Link to="/agents" className={buttonVariants({ size: 'sm' })}>
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

          <PageSection
            title="最近运行"
            description={fallback ? '后端未提供 /api/overview' : '最近 20 条'}
          >
            {recent && recent.length === 0 ? (
              <EmptyState
                icon={<Activity className="size-5" />}
                title="还没有运行记录"
                description="在对话页发起一次运行，这里会显示状态、耗时与成本。"
                action={
                  <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
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

          <div className="grid gap-2 sm:grid-cols-3">
            {links.map(({ to, label, description, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="group rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-sunken/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="flex items-center justify-between">
                  <Icon className="size-4 text-subtle transition-colors group-hover:text-accent" />
                </div>
                <div className="mt-3 text-[13px] font-medium text-fg">{label}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-subtle">{description}</div>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </Page>
  );
}
