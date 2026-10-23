import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Activity, ArrowRight, Bot, Plus, Server, Sparkles } from 'lucide-react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { buttonVariants } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
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
  const degraded = (queue?.failed ?? 0) > 0 || (queue?.waiting ?? 0) > 5;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-2xs tabular-nums text-muted-foreground">
      {queue ? (
        <span>
          队列 <span className={cn(degraded && 'text-warning')}>{queue.waiting}</span> 等待 /{' '}
          {queue.active} 运行
        </span>
      ) : (
        <span>队列指标不可用</span>
      )}
      <span>Redis {data.redis?.pingMs ?? '—'} ms</span>
      <span>RSS {(data.process.memoryRssBytes / 1024 / 1024).toFixed(0)} MB</span>
      <Link
        to="/status"
        className="text-muted-foreground underline-offset-2 hover:text-fg hover:underline"
      >
        详情
      </Link>
    </div>
  );
}

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
      className="group flex min-h-14 items-center gap-3 border-b px-2.5 py-3 last:border-b-0 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          item.tone === 'danger' ? 'bg-danger' : 'bg-warning',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg [overflow-wrap:anywhere]">
          {item.title}
        </span>
        <span className="block text-2xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.detail}
        </span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground group-hover:text-fg"
      />
    </Link>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const overview = useOverview();
  // overview 已带 servers/agents 计数，列表只作为旧后端（返回 null）的兜底，正常不请求。
  const fallback = overview.data === null;
  const servers = useQuery({ ...serversQuery, enabled: fallback });
  const agents = useQuery({ ...agentsQuery, enabled: fallback });
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

  const error = overview.isError
    ? overview.error
    : fallback
      ? (servers.error ?? agents.error)
      : null;
  const loading = overview.isPending || (fallback && (servers.isPending || agents.isPending));
  const empty =
    !loading &&
    !error &&
    !runsError &&
    counts.servers === 0 &&
    counts.agents === 0 &&
    (counts.runs ?? 0) === 0 &&
    (counts.running ?? 0) === 0 &&
    recent?.length === 0;

  const failures = (recent ?? []).filter(
    (run) => run.status === 'failed' || run.status === 'timeout',
  );
  const attention: AttentionItem[] = failures.slice(0, 5).map((run) => ({
    id: run.id,
    tone: run.status === 'timeout' ? 'warning' : 'danger',
    title: `${run.agentName ?? '已删除的专家'} · ${run.status === 'timeout' ? '超时' : '失败'}`,
    detail: run.error ?? `${formatRelative(run.startedAt)} · ${shortId(run.id)}`,
    runId: run.id,
  }));

  const windowLabel = overview.data?.window
    ? `最近 ${overview.data.window.days} 天`
    : '统计窗口未提供';

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

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void overview.refetch();
            if (fallback) {
              void servers.refetch();
              void agents.refetch();
            }
          }}
        />
      ) : null}

      {loading && !error ? <LoadingState rows={3} /> : null}

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

      {!loading && !error && !empty ? (
        <>
          <section className="grid grid-cols-2 gap-4 xl:grid-cols-4" aria-label="平台概况">
            {[
              { label: '专家', value: counts.agents, hint: null, icon: Bot },
              { label: '连接器', value: counts.servers, hint: null, icon: Server },
              { label: '运行次数', value: counts.runs ?? '—', hint: windowLabel, icon: Activity },
              {
                label: '运行成本',
                value: counts.costUsd === undefined ? '—' : formatCost(counts.costUsd),
                hint: windowLabel,
                icon: Sparkles,
              },
            ].map(({ label, value, hint, icon: Icon }) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-3">
                    <span className="text-sm font-normal text-muted-foreground">{label}</span>
                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <span className="text-lg font-medium tabular-nums text-fg">{value}</span>
                  {hint ? <CardDescription>{hint}</CardDescription> : null}
                </CardContent>
              </Card>
            ))}
          </section>

          <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
            <PageSection
              title="最近运行"
              divided={false}
              {...(counts.running ? { description: `${counts.running} 个正在运行` } : {})}
              actions={
                <Link to="/runs" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  查看运行
                </Link>
              }
            >
              {runsError ? (
                <ErrorState error={runsError} onRetry={() => void runs.refetch()} />
              ) : runsSource && runs.isPending ? (
                <LoadingState rows={3} />
              ) : recent && recent.length > 0 ? (
                <DataTable
                  rows={recent.slice(0, 6)}
                  columns={runColumns}
                  rowKey={(run) => run.id}
                  label="最近运行"
                  storageKey="pace.overview.run-columns"
                  onRowClick={(run) =>
                    void navigate({ to: '/runs/$runId', params: { runId: run.id } })
                  }
                />
              ) : (
                <PageNote title="还没有运行记录" description="发起一次对话以开始运行。" />
              )}
            </PageSection>

            <div className="flex min-w-0 flex-col gap-5">
              <PageSection
                title="需要处理"
                divided={false}
                description={recent ? `最近 ${recent.length} 条运行` : ''}
              >
                {runsError ? (
                  <ErrorState error={runsError} onRetry={() => void runs.refetch()} />
                ) : runsSource && runs.isPending ? (
                  <LoadingState rows={2} />
                ) : attention.length > 0 ? (
                  <div>
                    {attention.slice(0, 3).map((item) => (
                      <AttentionRow key={item.id} item={item} />
                    ))}
                  </div>
                ) : (
                  <PageNote title="暂无失败运行" />
                )}
              </PageSection>
              <PageSection title="快捷入口">
                <div className="flex flex-col">
                  {[
                    {
                      to: '/agents',
                      label: '管理专家',
                      icon: Bot,
                    },
                    {
                      to: '/skills',
                      label: '管理技能',
                      icon: Sparkles,
                    },
                    {
                      to: '/servers',
                      label: '管理连接器',
                      icon: Server,
                    },
                  ].map(({ to, label, icon: Icon }) => (
                    <Link
                      key={to}
                      to={to}
                      className="flex min-h-14 min-w-0 items-center gap-3 rounded-item px-2.5 hover:bg-hover"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
                      <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              </PageSection>
            </div>
          </div>

          <PageSection
            title="专家运行概况"
            description={windowLabel}
            actions={
              <Link to="/agents" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                管理专家
              </Link>
            }
          >
            {fallback ? (
              <PageNote title="聚合指标暂不可用" />
            ) : agentRows && agentRows.length > 0 ? (
              <DataTable
                rows={agentRows}
                columns={agentColumns}
                rowKey={(row) => row.agentId}
                label="专家指标"
                storageKey="pace.overview.agent-columns"
                className="max-h-96 overflow-y-auto"
              />
            ) : (
              <PageNote
                title="还没有专家"
                description="创建专家并绑定技能或连接器后，即可开始对话。"
              />
            )}
          </PageSection>
          <HealthLine />
        </>
      ) : null}
    </Page>
  );
}
