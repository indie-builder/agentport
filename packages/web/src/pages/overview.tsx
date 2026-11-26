import { type RetentionSettings, retentionSettingsSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Activity, Bot, Download, Server, Sparkles } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AttentionPanel } from '../components/attention-panel.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
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
  PageTopbar,
} from '../components/page.js';
import { RunStatusBadge } from '../components/run/run-status-badge.js';
import {
  type EmptyChecklistStep,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { SegmentedToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage, type OverviewAgentRow, type RecentRun } from '../lib/api.js';
import { downloadBlob } from '../lib/browser-files.js';
import { toCsv } from '../lib/csv.js';
import { useFormBlocker } from '../lib/form.js';
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
  meQuery,
  useOverview,
  useOverviewTimeseries,
  useRetention,
  useUpdateRetention,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

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

const retentionFormSchema = retentionSettingsSchema.pick({
  runDays: true,
  messageDays: true,
  agentVersions: true,
});

type RetentionFormValues = Pick<RetentionSettings, 'runDays' | 'messageDays' | 'agentVersions'>;

const RETENTION_FIELDS = [
  {
    name: 'runDays',
    id: 'retention-run-days',
    label: '运行记录保留天数',
    hint: '超过该天数的运行记录及其消息会被清理。',
    max: 3650,
  },
  {
    name: 'messageDays',
    id: 'retention-message-days',
    label: '消息保留天数',
    hint: '无运行归属的会话消息与频道消息超过该天数后清理（随运行的对话消息按运行记录保留天数清理）。',
    max: 3650,
  },
  {
    name: 'agentVersions',
    id: 'retention-agent-versions',
    label: '版本保留个数',
    hint: '每个专家保留最近的历史版本数量。',
    max: 1000,
  },
] as const satisfies ReadonlyArray<{
  name: keyof RetentionFormValues;
  id: string;
  label: string;
  hint: string;
  max: number;
}>;

function RetentionForm({
  settings,
  canManage,
}: {
  settings: RetentionSettings;
  canManage: boolean;
}) {
  const save = useUpdateRetention();
  const { register, handleSubmit, reset, formState } = useZodForm(retentionFormSchema, {
    defaultValues: {
      runDays: settings.runDays,
      messageDays: settings.messageDays,
      agentVersions: settings.agentVersions,
    },
  });
  const { errors, isDirty: dirty } = formState;
  const pending = save.isPending;
  const disabled = pending || !canManage;
  const blocker = useFormBlocker(dirty, pending);

  const settingsRef = useRef(settings);
  useEffect(() => {
    if (settingsRef.current === settings) return;
    settingsRef.current = settings;
    if (!dirty) {
      reset({
        runDays: settings.runDays,
        messageDays: settings.messageDays,
        agentVersions: settings.agentVersions,
      });
    }
  }, [settings, dirty, reset]);

  const submit = handleSubmit((values) => {
    if (disabled) return;
    save.mutate(values, {
      onSuccess: (saved) => {
        reset({
          runDays: saved.runDays,
          messageDays: saved.messageDays,
          agentVersions: saved.agentVersions,
        });
        toastSuccess('数据保留策略已保存');
      },
      onError: toastError,
    });
  });

  return (
    <>
      <form className="flex flex-col gap-5" noValidate onSubmit={submit}>
        <FieldGroup className="gap-4">
          {RETENTION_FIELDS.map((field) => {
            const error = errors[field.name]?.message;
            return (
              <Field
                key={field.name}
                orientation="horizontal"
                className="items-start gap-3"
                data-disabled={disabled}
                data-invalid={Boolean(error)}
              >
                <FieldContent>
                  <FieldLabel htmlFor={field.id}>{field.label}</FieldLabel>
                  <FieldDescription id={`${field.id}-hint`}>{field.hint}</FieldDescription>
                  <FieldError id={`${field.id}-error`}>{error}</FieldError>
                </FieldContent>
                <Input
                  {...register(field.name, { valueAsNumber: true })}
                  id={field.id}
                  type="number"
                  min={1}
                  max={field.max}
                  step={1}
                  inputMode="numeric"
                  className="w-24"
                  disabled={disabled}
                  aria-invalid={Boolean(error)}
                  aria-describedby={
                    error ? `${field.id}-hint ${field.id}-error` : `${field.id}-hint`
                  }
                />
              </Field>
            );
          })}
        </FieldGroup>

        <div className="flex items-center justify-end gap-3">
          {settings.updatedAt && settings.updatedBy ? (
            <span className="mr-auto text-xs text-muted-foreground">
              上次修改：{formatDateTime(settings.updatedAt)} · {settings.updatedBy}
            </span>
          ) : null}
          {canManage ? (
            <Button type="submit" disabled={disabled || !dirty} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的数据保留策略？"
        description="离开后本次修改不会保存。可以先保存再继续。"
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </>
  );
}

function RetentionSection() {
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'operations.manage');
  const retention = useRetention();
  return (
    <PageSection
      title="数据保留"
      description="每日维护任务据此清理；修改后下次维护生效。"
      divided={false}
    >
      {retention.isPending ? (
        <LoadingState rows={3} />
      ) : retention.data ? (
        <RetentionForm settings={retention.data} canManage={canManage} />
      ) : (
        <ErrorState error={retention.error} onRetry={() => void retention.refetch()} />
      )}
    </PageSection>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/operations' });
  const tab = search.tab ?? 'recent';
  const location = useLocation();
  const me = useQuery(meQuery);
  const canReadServers = can(me.data, 'servers.read');
  const canReadRuns = can(me.data, 'runs.read');
  const canReadAgents = can(me.data, 'agents.read');
  const agentColumns = useMemo(() => buildAgentColumns(canReadAgents), [canReadAgents]);
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

  const days = data?.window.days ?? 7;
  const windowLabel = data && !empty ? `最近 ${days} 天` : '';
  const failedCount = data?.counts.failed ?? 0;

  const exportUsageCsv = (): void => {
    if (!data || data.agents.length === 0) return;
    downloadBlob(
      new Blob([toUsageCsv(data.agents)], { type: 'text/csv;charset=utf-8' }),
      `overview-usage-${days}d.csv`,
    );
  };

  const attentionSection = <AttentionPanel canOpenRuns={canReadRuns} />;

  return (
    <Page>
      <PageTopbar>
        <PageHeader title="概况" {...(windowLabel ? { description: windowLabel } : {})} />
      </PageTopbar>

      <PageBody className="pt-2">
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
            variant="checklist"
            scale="page"
            title="开启工作区运行"
            description="完成以下基础步骤后，此处将呈现运行趋势与指标。"
            steps={
              [
                {
                  id: 'servers',
                  title: '接入连接器（可选）',
                  description: '挂载 MCP 服务或 HTTP API，让专家在对话中调用外部工具。',
                  status: data.counts.servers > 0 ? 'done' : 'current',
                  action: canReadServers ? (
                    <Link
                      to="/servers"
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      前往连接器
                    </Link>
                  ) : undefined,
                },
                {
                  id: 'agents',
                  title: '创建第一位专家',
                  description: '定义系统指令、技能与工具，组成可复用的工作区专家。',
                  status:
                    data.counts.agents > 0
                      ? 'done'
                      : data.counts.servers > 0
                        ? 'current'
                        : 'upcoming',
                  action: canReadAgents ? (
                    <Link
                      to="/agents"
                      className={buttonVariants({
                        variant:
                          data.counts.servers > 0 && data.counts.agents === 0
                            ? 'default'
                            : 'outline',
                        size: 'sm',
                      })}
                    >
                      前往创建
                    </Link>
                  ) : undefined,
                },
                {
                  id: 'chat',
                  title: '发起首次对话',
                  description: '与专家完成一次交互后，此处将自动呈现运行趋势与活跃指标。',
                  status:
                    data.counts.runs > 0 ? 'done' : data.counts.agents > 0 ? 'current' : 'upcoming',
                  action: (
                    <Link to="/chat" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      去对话
                    </Link>
                  ),
                },
              ] satisfies EmptyChecklistStep[]
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
                    data.counts.tokens === 0 ? null : `${formatTokens(data.counts.tokens)} tokens`,
                  icon: Sparkles,
                },
                { label: '专家', value: data.counts.agents, hint: null, icon: Bot },
                { label: '连接器', value: data.counts.servers, hint: null, icon: Server },
              ].map(({ label, value, hint, icon }) => (
                <MetricCard key={label} label={label} value={value} hint={hint} icon={icon} />
              ))}
            </MetricGrid>

            <RunTrendCard days={days} />

            {attentionSection}

            <PageSection
              title="运行"
              divided={false}
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

        <RetentionSection />
      </PageBody>
    </Page>
  );
}
