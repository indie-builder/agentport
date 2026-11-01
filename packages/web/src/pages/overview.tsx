import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Activity, Bot, Plus, Server, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { type DataColumn, DataTable } from '../components/data-table.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/motion-collapsible.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { errorMessage, type OverviewAgentRow, type RecentRun } from '../lib/api.js';
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
import { judgeQueue } from '../lib/health.js';
import {
  healthMetricsQuery,
  useAttention,
  useOverview,
  useOverviewTimeseries,
} from '../lib/queries.js';
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
        to="/agents/$agentId"
        params={{ agentId: row.agentId }}
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
  const { data, isPending, isError, isFetching, refetch } = useQuery(healthMetricsQuery);
  if (!data) {
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>{isPending ? '健康指标加载中…' : '健康指标不可用'}</span>
        {isPending ? null : (
          <Button
            variant="plain"
            size="xs"
            className="h-auto p-0 font-normal text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            重试
          </Button>
        )}
        <Link
          to="/status"
          className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
        >
          查看健康
        </Link>
      </div>
    );
  }
  const queue = judgeQueue(data.queue);
  const redisIssue = data.redis === null;
  // 历史 failed 是队列保留计数，不是当前可用性；首页只提示需要处理的当前问题。
  const queueIssue = queue.condition !== 'ok' && queue.condition !== 'failed';
  if (!queueIssue && !redisIssue && !isError) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-warning">
      {queueIssue ? <span>{queue.message}</span> : null}
      {redisIssue ? <span>Redis 指标不可用</span> : null}
      {isError ? <span>健康指标刷新失败，显示上次结果</span> : null}
      {isError ? (
        <Button
          variant="plain"
          size="xs"
          className="h-auto p-0 font-normal text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          重试
        </Button>
      ) : null}
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

export function RunTrendCard({ days }: { days: number }) {
  const { data, isPending, isError, error, refetch } = useOverviewTimeseries(days);
  const [open, setOpen] = useState(false);
  const points = data ?? [];
  const hasRuns = points.some((point) => point.runs > 0);
  // 只有从没拿到过数据时才整块报错；后台刷新失败要保留已加载的图表与数据表。
  const firstLoadFailed = isError && data === undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-normal text-muted-foreground">运行趋势</CardTitle>
      </CardHeader>
      <CardContent>
        {firstLoadFailed ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : isPending ? (
          <LoadingState rows={4} />
        ) : (
          <>
            {isError ? (
              <PageNote
                tone="danger"
                title="刷新失败，保留上次趋势"
                description={errorMessage(error)}
                action={
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}
            {hasRuns ? (
              <div className="flex flex-col gap-2">
                {/* 图表仅视觉展示，读屏改走下方同源数据表。 */}
                <div aria-hidden="true">
                  <ChartContainer config={trendConfig} className="aspect-auto h-56 w-full">
                    {/* Recharts 3 默认开启 accessibilityLayer，会生成无名称的可聚焦 application。 */}
                    <AreaChart
                      accessibilityLayer={false}
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
                      <YAxis
                        allowDecimals={false}
                        axisLine={false}
                        tickLine={false}
                        tickMargin={8}
                        width={28}
                      />
                      <ChartTooltip
                        cursor={false}
                        content={<ChartTooltipContent indicator="line" />}
                      />
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
                </div>
                <Collapsible open={open} onOpenChange={setOpen}>
                  <CollapsibleTrigger
                    className="self-start text-muted-foreground"
                    render={<Button variant="ghost" />}
                  >
                    {open ? '收起趋势数据' : '查看趋势数据'}
                  </CollapsibleTrigger>
                  <CollapsibleContent animated className="pt-2">
                    {/* 滚动区可聚焦，键盘用户才能浏览超出一屏的趋势行。 */}
                    <section
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
                      tabIndex={0}
                      aria-label="趋势数据"
                      className="max-h-64 overflow-y-auto overscroll-contain"
                    >
                      <Table>
                        <caption className="sr-only">最近 {days} 天运行趋势明细</caption>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs text-muted-foreground">日期</TableHead>
                            <TableHead className="text-right text-xs text-muted-foreground">
                              运行
                            </TableHead>
                            <TableHead className="text-right text-xs text-muted-foreground">
                              失败
                            </TableHead>
                            <TableHead className="text-right text-xs text-muted-foreground">
                              成本
                            </TableHead>
                            <TableHead className="text-right text-xs text-muted-foreground">
                              Tokens
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {points.map((point) => (
                            <TableRow key={point.date}>
                              <TableHead
                                scope="row"
                                className="h-auto text-xs font-normal text-muted-foreground"
                              >
                                {point.date}
                              </TableHead>
                              <TableCell className="text-right font-mono tabular-nums">
                                {point.runs}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {point.failed}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {formatCost(point.costUsd)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {formatTokens(point.tokens)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </section>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ) : (
              <EmptyState title="发起对话后生成趋势" bordered={false} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const overview = useOverview();
  const attention = useAttention();
  // 后台刷新失败时旧 data 仍在，只有本次请求成功才前置，避免失败后区块跳位。
  const hasAttention = attention.isSuccess && (attention.data?.total ?? 0) > 0;
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

  const days = data?.window.days ?? 7;
  const windowLabel = data ? `最近 ${days} 天` : '';
  const failedCount = data?.counts.failed ?? 0;

  const attentionSection = <AttentionPanel />;

  return (
    <Page>
      <PageHeader
        title="概况"
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
          <HealthLine />
          <PageSection title="平台概况" description={windowLabel} divided={false}>
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
          </PageSection>

          {hasAttention ? attentionSection : null}

          <RunTrendCard days={days} />

          {hasAttention ? null : attentionSection}

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
                rowLabel={(run) =>
                  `${run.agentName ?? '已删除的专家'} · ${formatDateTime(run.startedAt)} · ${shortId(run.id)}`
                }
                label="最近运行"
                storageKey="pace.overview.run-columns"
                onRowClick={(run) =>
                  void navigate({
                    to: '/runs/$runId',
                    params: { runId: run.id },
                    search: { backTo: location.href },
                  })
                }
              />
            ) : (
              <PageNote title="发起对话后在这里查看运行" />
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
        </>
      ) : null}
    </Page>
  );
}
