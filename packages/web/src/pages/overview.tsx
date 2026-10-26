import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Activity, Bot, Plus, Server, Sparkles } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { buttonVariants } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../components/ui/chart.js';
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
import { healthMetricsQuery, useOverview, useOverviewTimeseries } from '../lib/queries.js';
import { AttentionPanel } from './ops.js';

const agentColumns: DataColumn<OverviewAgentRow>[] = [
  {
    id: 'name',
    header: '专家',
    locked: true,
    width: 'minmax(160px,1.4fr)',
    sortValue: (row) => row.name,
    cell: (row) => (
      <Link
        to="/agents"
        className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-fg hover:underline hover:underline-offset-4"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>
        <StatusBadge tone={row.enabled ? 'success' : 'default'}>
          {row.enabled ? '已启用' : '已停用'}
        </StatusBadge>
      </Link>
    ),
  },
  {
    id: 'lastRunStartTime',
    header: '最近运行',
    width: '110px',
    sortValue: (row) => row.lastRunStartTime,
    cell: (row) => (
      <span className="text-sm text-muted-foreground" title={formatDateTime(row.lastRunStartTime)}>
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
        <span className="text-muted-foreground">—</span>
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
    header: '专家 ID',
    width: '120px',
    hiddenByDefault: true,
    cell: (row) => (
      <code className="font-mono text-xs text-muted-foreground" title={row.agentId}>
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
      <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
        {run.agentName ?? <span className="text-muted-foreground">已删除</span>}
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
      <span className="text-sm text-muted-foreground" title={formatDateTime(run.startedAt)}>
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

function HealthLine() {
  const { data, isPending } = useQuery(healthMetricsQuery);
  if (!data) {
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-2xs text-muted-foreground">
        <span>{isPending ? '健康指标加载中…' : '健康指标不可用'}</span>
        <Link
          to="/status"
          className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
        >
          详情
        </Link>
      </div>
    );
  }
  const queue = data.queue;
  // 正常的运维数字不占首页；只有积压、失败或指标缺失才需要在这里出现。
  const queueIssue = queue === null || (queue?.failed ?? 0) > 0 || (queue?.waiting ?? 0) > 5;
  const redisIssue = data.redis === null || data.redis === undefined;
  if (!queueIssue && !redisIssue) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-2xs tabular-nums text-warning">
      {queue ? (
        <span>
          队列 {queue.waiting} 等待 / {queue.active} 运行
          {queue.failed ? ` / ${queue.failed} 失败` : ''}
        </span>
      ) : (
        <span>队列指标不可用</span>
      )}
      {redisIssue ? <span>Redis 指标不可用</span> : null}
      <Link
        to="/status"
        className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
      >
        查看健康
      </Link>
    </div>
  );
}

const trendConfig = {
  runs: { label: '运行', color: 'var(--color-chart-runs)' },
  failed: { label: '失败', color: 'var(--color-chart-failed)' },
} satisfies ChartConfig;

function RunTrendCard() {
  const { data, isPending, isError, error, refetch } = useOverviewTimeseries();
  const points = data ?? [];
  const hasRuns = points.some((point) => point.runs > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">运行趋势</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isPending ? (
          <LoadingState rows={4} />
        ) : hasRuns ? (
          <ChartContainer config={trendConfig} className="aspect-auto h-56 w-full">
            <AreaChart
              accessibilityLayer
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                dataKey="runs"
                type="monotone"
                fill="var(--color-runs)"
                fillOpacity={0.08}
                stroke="var(--color-runs)"
                strokeWidth={1.5}
                isAnimationActive={false}
              />
              <Area
                dataKey="failed"
                type="monotone"
                fill="var(--color-failed)"
                fillOpacity={0.16}
                stroke="var(--color-failed)"
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <EmptyState title="发起对话后生成趋势" />
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const overview = useOverview();
  const data = overview.data ?? null;

  const error = overview.isError ? overview.error : null;
  const loading = overview.isPending && !error;
  const empty =
    !loading &&
    !error &&
    data !== null &&
    data.counts.servers === 0 &&
    data.counts.agents === 0 &&
    data.counts.runs === 0 &&
    data.counts.running === 0 &&
    data.recent.length === 0;

  const windowLabel = data ? `最近 ${data.window.days} 天` : '';
  const failedCount = data?.counts.failed ?? 0;

  return (
    <Page>
      <PageHeader
        title="工作台"
        actions={
          <Link to="/chat" className={buttonVariants()}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建对话
          </Link>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void overview.refetch()} /> : null}

      {loading ? <LoadingState rows={3} /> : null}

      {empty ? (
        <PageNote
          icon={<Bot className="size-4" aria-hidden="true" />}
          title="开始配置"
          description="三步开始：接入一个 MCP Server → 创建专家并绑定它 → 在对话里使用。"
          action={
            <Link to="/servers" className={cn(buttonVariants({ size: 'sm' }))}>
              <Plus className="size-3.5" /> 接入 MCP Server
            </Link>
          }
        />
      ) : null}

      {data && !empty ? (
        <>
          <section className="flex flex-col gap-3" aria-label="平台概况">
            <p className="text-xs text-muted-foreground">{windowLabel}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: '运行次数',
                  value: data.counts.runs,
                  hint: failedCount > 0 ? `${failedCount} 次失败` : null,
                  icon: Activity,
                },
                {
                  label: '运行成本',
                  value: formatCost(data.counts.costUsd),
                  hint:
                    data.counts.tokens === 0 ? null : `${formatTokens(data.counts.tokens)} tokens`,
                  icon: Sparkles,
                },
                { label: '专家', value: data.counts.agents, hint: null, icon: Bot },
                { label: '连接器', value: data.counts.servers, hint: null, icon: Server },
              ].map(({ label, value, hint, icon: Icon }) => (
                <Card key={label}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-3">
                      <span className="text-sm font-normal text-muted-foreground">{label}</span>
                      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <span className="min-w-0 break-words text-3xl font-medium tabular-nums text-fg [overflow-wrap:anywhere]">
                      {value}
                    </span>
                    {hint ? <CardDescription>{hint}</CardDescription> : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <RunTrendCard />

          <PageSection title="需要处理" divided={false}>
            <AttentionPanel hideTitle />
          </PageSection>

          <PageSection
            title="最近运行"
            divided={false}
            {...(data.counts.running ? { description: `${data.counts.running} 个正在运行` } : {})}
            actions={
              <Link to="/runs" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                查看运行
              </Link>
            }
          >
            {data.recent.length > 0 ? (
              <DataTable
                rows={data.recent.slice(0, 6)}
                columns={runColumns}
                rowKey={(run) => run.id}
                label="最近运行"
                storageKey="pace.overview.run-columns"
                onRowClick={(run) =>
                  void navigate({ to: '/runs/$runId', params: { runId: run.id } })
                }
              />
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y py-5 text-sm">
                <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
                  <Plus className="size-3.5" aria-hidden="true" /> 新建对话
                </Link>
              </div>
            )}
          </PageSection>

          <PageSection
            title="专家运行"
            divided={false}
            actions={
              <Link to="/agents" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                管理专家
              </Link>
            }
          >
            {data.agents.length > 0 ? (
              <DataTable
                rows={data.agents}
                columns={agentColumns}
                rowKey={(row) => row.agentId}
                label="专家指标"
                storageKey="pace.overview.agent-columns"
                className="max-h-96 overflow-y-auto"
              />
            ) : (
              <PageNote title="创建专家后开始对话" />
            )}
          </PageSection>
          <HealthLine />
        </>
      ) : null}
    </Page>
  );
}
