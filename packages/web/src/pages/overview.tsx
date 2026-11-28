import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Activity,
  Bot,
  Download,
  ListChecks,
  RefreshCw,
  Server,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { AttentionPanel } from '../components/attention-panel.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import { MetricCard, MetricGrid } from '../components/metric-card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/motion-collapsible.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RunStatusBadge } from '../components/run/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { SegmentedToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage, type OverviewAgentRow, type RecentRun } from '../lib/api.js';
import { downloadBlob } from '../lib/browser-files.js';
import { toCsv } from '../lib/csv.js';
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
  healthLiveQuery,
  healthMetricsQuery,
  healthReadyQuery,
  meQuery,
  useOverview,
  useOverviewTimeseries,
} from '../lib/queries.js';
import { HealthSection } from './operations/health-section.js';
import {
  OBSERVABILITY_WINDOW_OPTIONS,
  ObservabilitySection,
  type ObservabilityTab,
  type ObservabilityWindowMinutes,
} from './operations/observability-section.js';
import { RetentionSheet } from './operations/retention-sheet.js';

const SECTIONS = [
  { value: 'overview', label: '总览' },
  { value: 'observability', label: 'SLO 与队列' },
  { value: 'health', label: '系统健康' },
] as const;

type OperationsSection = (typeof SECTIONS)[number]['value'];

function toUsageCsv(agents: OverviewAgentRow[]) {
  const rows = agents.map((agent) => [
    agent.name,
    agent.slug,
    agent.runCount,
    `${(agent.errorRate * 100).toFixed(1)}%`,
    agent.totalCost,
    agent.totalTokens,
    agent.latencyP50 ?? '',
    agent.latencyP99 ?? '',
    agent.lastRunStartTime ?? '',
    agent.enabled ? '是' : '否',
  ]);
  if (agents.length > 0) {
    const totalRuns = agents.reduce((sum, agent) => sum + agent.runCount, 0);
    const totalCost = Number(agents.reduce((sum, agent) => sum + agent.totalCost, 0).toFixed(4));
    const totalTokens = agents.reduce((sum, agent) => sum + agent.totalTokens, 0);
    rows.push(['合计', '', totalRuns, '', totalCost, totalTokens, '', '', '', '']);
  }
  return toCsv(
    [
      '专家',
      '标识',
      '运行数',
      '错误率',
      '成本(USD)',
      'Token',
      'P50延迟(ms)',
      'P99延迟(ms)',
      '最近运行',
      '启用',
    ],
    rows,
  );
}

const buildAgentColumns = (canReadAgents: boolean): DataColumn<OverviewAgentRow>[] => [
  {
    id: 'name',
    header: '专家',
    locked: true,
    width: 'minmax(160px,1.4fr)',
    sortValue: (row) => row.name,
    cell: (row) => {
      const content = (
        <>
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>
          <StatusBadge tone={row.enabled ? 'success' : 'default'}>
            {row.enabled ? '已启用' : '已停用'}
          </StatusBadge>
        </>
      );
      return canReadAgents ? (
        <Link
          to="/agents/$agentId"
          params={{ agentId: row.agentId }}
          className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-fg hover:underline hover:underline-offset-4"
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-fg">
          {content}
        </span>
      );
    },
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
        {run.agentName ?? <span className="text-muted-foreground">已删除的专家</span>}
      </span>
    ),
  },
  {
    id: 'status',
    header: '状态',
    width: 'minmax(140px,1.2fr)',
    sortValue: (run) => run.status,
    cell: (run) => (
      <div className="flex min-w-0 items-center gap-2">
        <RunStatusBadge status={run.status} />
        {run.error ? (
          <span className="min-w-0 line-clamp-1 text-xs text-danger" title={run.error}>
            {run.error}
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
          to="/operations"
          search={{ section: 'health' }}
          className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
        >
          查看健康
        </Link>
      </div>
    );
  }
  const queue = judgeQueue(data.queue);
  const redisIssue = data.redis === null;
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
        to="/operations"
        search={{ section: 'health' }}
        className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
      >
        查看健康
      </Link>
    </div>
  );
}

const RunTrendChart = lazy(() =>
  import('./overview-trend-chart.js').then((module) => ({ default: module.RunTrendChart })),
);

export function RunTrendCard({ days }: { days: number }) {
  const { data, isPending, isError, error, refetch } = useOverviewTimeseries(days);
  const [open, setOpen] = useState(false);
  const points = data ?? [];
  const hasRuns = points.some((point) => point.runs > 0);
  const firstLoadFailed = isError && data === undefined;

  return (
    <Card hover="static" className="min-w-0">
      <CardHeader>
        <CardTitle>运行趋势</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0">
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
              <div className="flex min-w-0 flex-col gap-2">
                <div aria-hidden="true" className="min-w-0 overflow-hidden">
                  <Suspense fallback={<div className="h-56 w-full" />}>
                    <RunTrendChart points={points} />
                  </Suspense>
                </div>
                <Collapsible open={open} onOpenChange={setOpen}>
                  <CollapsibleTrigger
                    className="self-start text-muted-foreground"
                    render={<Button variant="ghost" />}
                  >
                    {open ? '收起趋势数据' : '查看趋势数据'}
                  </CollapsibleTrigger>
                  <CollapsibleContent animated className="pt-2">
                    <section
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
                      tabIndex={0}
                      aria-label="趋势数据"
                      className="max-h-64 min-w-0 overflow-y-auto overscroll-contain"
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
                            <TableRow key={point.date} className="hover:bg-transparent">
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
              <EmptyState
                variant="idle"
                scale="section"
                specimen="trend"
                title={`发起对话后生成 ${days} 日趋势`}
                description="运行记录会自动按日汇总耗时、失败与成本。"
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const navigate = useNavigate({ from: '/operations' });
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/_shell/operations' });
  const section: OperationsSection = search.section ?? 'overview';
  const tab = search.tab ?? 'recent';
  const obsTab: ObservabilityTab = search.obsTab ?? 'slo';
  const windowMinutes: ObservabilityWindowMinutes = search.windowMinutes ?? 60;
  const location = useLocation();
  const me = useQuery(meQuery);
  const canReadServers = can(me.data, 'servers.read');
  const canReadRuns = can(me.data, 'runs.read');
  const canReadAgents = can(me.data, 'agents.read');
  const canManage = can(me.data, 'operations.manage');
  const agentColumns = useMemo(() => buildAgentColumns(canReadAgents), [canReadAgents]);
  const overview = useOverview();
  const data = overview.data ?? null;

  const [retentionOpen, setRetentionOpen] = useState(false);
  const retentionButtonRef = useRef<HTMLButtonElement>(null);

  const [sloOpen, setSloOpen] = useState(false);
  const sloButtonRef = useRef<HTMLButtonElement>(null);

  const [smokeOpen, setSmokeOpen] = useState(false);
  const [smokeRunTrigger, setSmokeRunTrigger] = useState(0);
  const smokeButtonRef = useRef<HTMLButtonElement>(null);

  const healthFetchingCount = useIsFetching({
    predicate: (query) => {
      const key = query.queryKey[0];
      return key === 'health-live' || key === 'health-ready' || key === 'health-metrics';
    },
  });
  const healthFetching = healthFetchingCount > 0;

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
  const headerDescription =
    section === 'overview'
      ? data && !empty
        ? `最近 ${days} 天`
        : undefined
      : section === 'health'
        ? '运行指标每 10 秒自动刷新'
        : undefined;
  const failedCount = data?.counts.failed ?? 0;

  const exportUsageCsv = (): void => {
    if (!data || data.agents.length === 0) return;
    downloadBlob(
      new Blob([toUsageCsv(data.agents)], { type: 'text/csv;charset=utf-8' }),
      `overview-usage-${days}d.csv`,
    );
  };

  const handleWindowChange = (next: ObservabilityWindowMinutes): void => {
    void navigate({
      to: '/operations',
      search: (prev) => ({ ...prev, windowMinutes: next }),
      replace: true,
    });
  };

  const handleObsTabChange = (next: ObservabilityTab): void => {
    void navigate({
      to: '/operations',
      search: (prev) => ({ ...prev, obsTab: next }),
      replace: true,
    });
  };

  const openAndRunSmoke = (): void => {
    setSmokeOpen(true);
    setSmokeRunTrigger((count) => count + 1);
  };

  const refreshHealth = (): void => {
    void queryClient.refetchQueries({ queryKey: healthLiveQuery.queryKey });
    void queryClient.refetchQueries({ queryKey: healthReadyQuery.queryKey });
    void queryClient.refetchQueries({ queryKey: healthMetricsQuery.queryKey });
  };

  const headerActions =
    section === 'overview' ? (
      <Button ref={retentionButtonRef} variant="outline" onClick={() => setRetentionOpen(true)}>
        数据保留
      </Button>
    ) : section === 'observability' ? (
      <>
        <FilterSelect
          value={String(windowMinutes)}
          onValueChange={(next) => handleWindowChange(Number(next) as ObservabilityWindowMinutes)}
          options={OBSERVABILITY_WINDOW_OPTIONS}
          label="看板统计窗口"
          className="w-28"
        />
        {canManage ? (
          <Button ref={sloButtonRef} onClick={() => setSloOpen(true)}>
            <Settings2 data-icon="inline-start" aria-hidden="true" /> SLO 设置
          </Button>
        ) : null}
      </>
    ) : (
      <>
        <Button ref={smokeButtonRef} variant="outline" onClick={openAndRunSmoke}>
          <ListChecks data-icon="inline-start" aria-hidden="true" /> 运行冒烟检查
        </Button>
        <Button variant="outline" onClick={refreshHealth} disabled={healthFetching}>
          <RefreshCw
            data-icon="inline-start"
            className={healthFetching ? 'animate-spin' : undefined}
            aria-hidden="true"
          />
          {healthFetching ? '刷新中…' : '刷新'}
        </Button>
      </>
    );

  return (
    <Page>
      <Tabs
        value={section}
        onValueChange={(next) => {
          if (next === section || !SECTIONS.some((item) => item.value === next)) return;
          void navigate({
            to: '/operations',
            search: (prev) => ({ ...prev, section: next as OperationsSection }),
            replace: true,
          });
        }}
        className="min-h-0 flex-1 gap-4"
      >
        <PageTopbar>
          <PageHeader
            title="概况"
            {...(headerDescription ? { description: headerDescription } : {})}
            actions={headerActions}
          />
          <PageToolbar>
            <TabsList variant="line" aria-label="概况分区">
              {SECTIONS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </PageToolbar>
        </PageTopbar>

        <PageBody className="pt-2">
          <TabsContent value={section} className="flex min-w-0 flex-col gap-6">
            {section === 'overview' ? (
              <>
                {error && !data ? (
                  <ErrorState error={error} onRetry={() => void overview.refetch()} />
                ) : null}

                {error && data ? (
                  <PageNote
                    tone="danger"
                    title="刷新失败，已保留加载的内容"
                    description={errorMessage(error)}
                    action={
                      <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>
                        重试
                      </Button>
                    }
                  />
                ) : null}

                {loading ? <LoadingState rows={3} /> : null}

                {empty ? (
                  <EmptyState
                    variant="stage"
                    scale="page"
                    specimen="runs"
                    title="还没有运行数据"
                    description="创建专家并发起对话后，这里会展示 7 日运行趋势与汇总指标。"
                    action={
                      canReadAgents ? (
                        <Link to="/agents" className={buttonVariants()}>
                          前往找专家
                        </Link>
                      ) : canReadServers ? (
                        <Link to="/servers" className={buttonVariants()}>
                          接入连接器
                        </Link>
                      ) : (
                        <Link to="/chat" className={buttonVariants()}>
                          开始对话
                        </Link>
                      )
                    }
                    secondaryAction={
                      canReadAgents || canReadServers ? (
                        <Link to="/chat" className={buttonVariants({ variant: 'outline' })}>
                          开始对话
                        </Link>
                      ) : undefined
                    }
                  />
                ) : null}

                {data && !empty ? (
                  <>
                    <HealthLine />
                    <MetricGrid columns={4}>
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
                            data.counts.tokens === 0
                              ? null
                              : `${formatTokens(data.counts.tokens)} tokens`,
                          icon: Sparkles,
                        },
                        { label: '专家', value: data.counts.agents, hint: null, icon: Bot },
                        { label: '连接器', value: data.counts.servers, hint: null, icon: Server },
                      ].map(({ label, value, hint, icon }) => (
                        <MetricCard
                          key={label}
                          label={label}
                          value={value}
                          hint={hint}
                          icon={icon}
                        />
                      ))}
                    </MetricGrid>

                    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                      <RunTrendCard days={days} />
                      <AttentionPanel layout="card" canOpenRuns={canReadRuns} />
                    </div>

                    <PageSection
                      title="运行"
                      divided={false}
                      className="overflow-x-clip"
                      actions={
                        <>
                          <SegmentedToggle
                            label="切换区段"
                            value={tab}
                            options={[
                              { value: 'recent', label: '最近运行' },
                              { value: 'agents', label: '专家运行' },
                            ]}
                            onChange={(value) =>
                              void navigate({
                                to: '/operations',
                                search: (prev) => ({ ...prev, tab: value }),
                              })
                            }
                          />
                          {tab === 'recent' && canReadRuns ? (
                            <Link
                              to="/runs"
                              data-variant="ghost"
                              data-size="sm"
                              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                            >
                              查看运行
                            </Link>
                          ) : null}
                          {tab === 'agents' ? (
                            <>
                              {data.agents.length > 0 ? (
                                <Button variant="outline" size="sm" onClick={exportUsageCsv}>
                                  <Download data-icon="inline-start" aria-hidden="true" /> 导出 CSV
                                </Button>
                              ) : null}
                              {canReadAgents ? (
                                <Link
                                  to="/agents"
                                  data-variant="ghost"
                                  data-size="sm"
                                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                                >
                                  管理专家
                                </Link>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      }
                    >
                      {tab === 'recent' ? (
                        data.recent.length > 0 ? (
                          <DataTable
                            rows={data.recent.slice(0, 6)}
                            columns={runColumns}
                            rowKey={(run) => run.id}
                            rowLabel={(run) =>
                              `${run.agentName ?? '已删除的专家'} · ${formatDateTime(run.startedAt)} · ${shortId(run.id)}`
                            }
                            label="最近运行"
                            storageKey="pace.overview.run-columns"
                            hideRowCount
                            {...(canReadRuns
                              ? {
                                  onRowClick: (run: RecentRun) =>
                                    void navigate({
                                      to: '/runs/$runId',
                                      params: { runId: run.id },
                                      search: { backTo: location.href },
                                    }),
                                }
                              : {})}
                          />
                        ) : (
                          <EmptyState
                            variant="idle"
                            scale="inline"
                            icon={<Activity className="size-4" aria-hidden="true" />}
                            title="发起对话后在这里查看最近运行"
                            action={
                              <Link
                                to="/chat"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                去对话
                              </Link>
                            }
                          />
                        )
                      ) : data.agents.length > 0 ? (
                        <DataTable
                          rows={data.agents}
                          columns={agentColumns}
                          rowKey={(row) => row.agentId}
                          label="专家指标"
                          storageKey="pace.overview.agent-columns"
                          className="max-h-96 overflow-y-auto"
                          hideRowCount
                        />
                      ) : (
                        <EmptyState
                          variant="idle"
                          scale="inline"
                          icon={<Bot className="size-4" aria-hidden="true" />}
                          title="创建专家后统计活跃表现"
                          action={
                            canReadAgents ? (
                              <Link
                                to="/agents"
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                              >
                                去创建
                              </Link>
                            ) : undefined
                          }
                        />
                      )}
                    </PageSection>
                  </>
                ) : null}

                <RetentionSheet
                  open={retentionOpen}
                  onOpenChange={setRetentionOpen}
                  canManage={canManage}
                  finalFocus={() =>
                    retentionButtonRef.current?.isConnected ? retentionButtonRef.current : null
                  }
                />
              </>
            ) : null}

            {section === 'observability' ? (
              <ObservabilitySection
                windowMinutes={windowMinutes}
                obsTab={obsTab}
                onWindowChange={handleWindowChange}
                onObsTabChange={handleObsTabChange}
                sloOpen={sloOpen}
                onSloOpenChange={setSloOpen}
                canManage={canManage}
                sloButtonRef={sloButtonRef}
              />
            ) : null}

            {section === 'health' ? (
              <HealthSection
                smokeOpen={smokeOpen}
                onSmokeOpenChange={setSmokeOpen}
                smokeRunTrigger={smokeRunTrigger}
                smokeButtonRef={smokeButtonRef}
              />
            ) : null}
          </TabsContent>
        </PageBody>
      </Tabs>
    </Page>
  );
}
