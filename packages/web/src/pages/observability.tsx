import {
  type ProviderMetric,
  type QueueSnapshot,
  type SloSettings,
  type SloStatus,
  sloSettingsSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Activity,
  CircleAlert,
  Clock,
  Coins,
  Gauge,
  Settings2,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller } from 'react-hook-form';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterSelect } from '../components/filter-select.js';
import { MetricCard, MetricGrid } from '../components/metric-card.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Switch } from '../components/ui/switch.js';
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
import { errorMessage } from '../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { formatCost, formatDuration, formatPercent } from '../lib/format.js';
import {
  meQuery,
  useObservabilitySnapshot,
  useSloSettings,
  useUpdateSloSettings,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const WINDOW_OPTIONS = [
  { value: '15', label: '15 分钟' },
  { value: '60', label: '1 小时' },
  { value: '360', label: '6 小时' },
  { value: '1440', label: '24 小时' },
];

function isPercentSlo(key: SloStatus['key']): boolean {
  return key === 'run_success' || key === 'provider_error_rate';
}

function formatSloValue(key: SloStatus['key'], value: number | null): string {
  if (value === null) return '无数据';
  return isPercentSlo(key) ? formatPercent(value) : formatDuration(value);
}

export function ObservabilityPage() {
  const search = useSearch({ from: '/_shell/observability' });
  const navigate = useNavigate({ from: '/observability' });
  const tab = search.tab ?? 'slo';
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'operations.manage');
  const windowMinutes = search.windowMinutes ?? 60;
  const snapshot = useObservabilitySnapshot(windowMinutes);
  const slo = useSloSettings();
  const [editingSlo, setEditingSlo] = useState(false);

  const data = snapshot.data;
  const oldestQueueWait =
    data && data.queues.length > 0
      ? data.queues.reduce<number | null>((oldest, queue) => {
          if (queue.oldestWaitingMs === null) return oldest;
          return oldest === null ? queue.oldestWaitingMs : Math.max(oldest, queue.oldestWaitingMs);
        }, null)
      : null;

  const queueColumns = useMemo<DataColumn<QueueSnapshot>[]>(
    () => [
      {
        id: 'name',
        header: '队列',
        locked: true,
        width: 'minmax(160px,1.4fr)',
        sortValue: (queue) => queue.name,
        cell: (queue) => (
          <span className="font-mono text-xs text-fg [overflow-wrap:anywhere]">{queue.name}</span>
        ),
      },
      {
        id: 'waiting',
        header: '等待',
        numeric: true,
        width: '70px',
        sortValue: (queue) => queue.waiting,
        cell: (queue) => queue.waiting,
      },
      {
        id: 'active',
        header: '处理中',
        numeric: true,
        width: '76px',
        sortValue: (queue) => queue.active,
        cell: (queue) => queue.active,
      },
      {
        id: 'completed',
        header: '完成',
        numeric: true,
        width: '70px',
        sortValue: (queue) => queue.completed,
        cell: (queue) => queue.completed,
      },
      {
        id: 'failed',
        header: '失败',
        numeric: true,
        width: '70px',
        sortValue: (queue) => queue.failed,
        cell: (queue) => queue.failed,
      },
      {
        id: 'delayed',
        header: '延迟',
        numeric: true,
        width: '70px',
        sortValue: (queue) => queue.delayed,
        cell: (queue) => queue.delayed,
      },
      {
        id: 'oldestWaitingMs',
        header: '最老等待',
        numeric: true,
        width: '96px',
        sortValue: (queue) => queue.oldestWaitingMs,
        cell: (queue) => formatDuration(queue.oldestWaitingMs),
      },
    ],
    [],
  );

  const providerColumns = useMemo<DataColumn<ProviderMetric>[]>(
    () => [
      {
        id: 'name',
        header: '供应商',
        locked: true,
        width: 'minmax(150px,1.2fr)',
        sortValue: (provider) => provider.name,
        cell: (provider) => (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-medium text-fg [overflow-wrap:anywhere]">{provider.name}</span>
            <StatusBadge tone={provider.enabled ? 'success' : 'default'}>
              {provider.enabled ? '启用' : '停用'}
            </StatusBadge>
          </span>
        ),
      },
      {
        id: 'priority',
        header: '优先级',
        numeric: true,
        width: '76px',
        sortValue: (provider) => provider.priority,
        cell: (provider) => provider.priority,
      },
      {
        id: 'requests',
        header: '请求',
        numeric: true,
        width: '76px',
        sortValue: (provider) => provider.requests,
        cell: (provider) => provider.requests,
      },
      {
        id: 'errorRate',
        header: '错误率',
        numeric: true,
        width: '84px',
        sortValue: (provider) => provider.errorRate,
        cell: (provider) =>
          provider.requests === 0 ? (
            <span className="text-muted-foreground">无数据</span>
          ) : (
            formatPercent(provider.errorRate)
          ),
      },
      {
        id: 'cost',
        header: '成本',
        numeric: true,
        width: '88px',
        sortValue: (provider) => provider.costUsd,
        cell: (provider) => formatCost(provider.costUsd),
      },
      {
        id: 'lastError',
        header: '最近错误',
        width: 'minmax(140px,1.4fr)',
        cell: (provider) =>
          provider.lastError ? (
            <span
              className="text-xs text-danger [overflow-wrap:anywhere]"
              title={provider.lastError}
            >
              {provider.lastError}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="观测"
          actions={
            <>
              <FilterSelect
                value={String(windowMinutes)}
                onValueChange={(next) =>
                  void navigate({
                    to: '/observability',
                    search: (prev) => ({
                      ...prev,
                      windowMinutes: Number(next) as 15 | 60 | 360 | 1440,
                    }),
                    replace: true,
                  })
                }
                options={WINDOW_OPTIONS}
                label="看板统计窗口"
                className="w-28"
              />
              {canManage ? (
                <Button disabled={!slo.data} onClick={() => setEditingSlo(true)}>
                  <Settings2 data-icon="inline-start" aria-hidden="true" /> SLO 设置
                </Button>
              ) : null}
            </>
          }
        />
      </PageTopbar>

      <PageBody className="pt-2">
        {snapshot.isError && !data ? (
          <ErrorState
            error={snapshot.error}
            onRetry={() => void snapshot.refetch()}
            title="观测数据没有加载出来"
          />
        ) : null}
        {snapshot.isPending ? <LoadingState rows={3} /> : null}
        {snapshot.isError && data ? (
          <PageNote
            tone="danger"
            title="刷新失败，保留上次读数"
            description={errorMessage(snapshot.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void snapshot.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {data ? (
          <>
            <PageSection divided={false} title="窗口指标">
              <MetricGrid columns={4}>
                {[
                  {
                    label: '运行成功率',
                    value:
                      data.runs.finished === 0 ? '无数据' : formatPercent(data.runs.successRate),
                    hint:
                      data.runs.finished === 0
                        ? null
                        : `${data.runs.succeeded} / ${data.runs.finished} 成功 · ${data.runs.failed} 失败`,
                    icon: Activity,
                  },
                  {
                    label: 'P95 延迟',
                    value:
                      data.runs.p95LatencyMs === null
                        ? '无数据'
                        : formatDuration(data.runs.p95LatencyMs),
                    hint: data.runs.total > 0 ? `${data.runs.total} 次运行` : null,
                    icon: Timer,
                  },
                  {
                    label: '队列最老等待',
                    value: oldestQueueWait === null ? '无数据' : formatDuration(oldestQueueWait),
                    hint: data.queues.length > 0 ? `${data.queues.length} 个队列（实时）` : null,
                    icon: Clock,
                  },
                  {
                    label: '成本',
                    value: formatCost(data.runs.costUsd),
                    hint: null,
                    icon: Coins,
                  },
                ].map(({ label, value, hint, icon }) => (
                  <MetricCard key={label} label={label} value={value} hint={hint} icon={icon} />
                ))}
              </MetricGrid>
            </PageSection>

            <PageSection divided={false} title="告警">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {[
                  {
                    label: '未处理违规',
                    value: data.alerts.openViolations,
                    icon: ShieldAlert,
                  },
                  {
                    label: '待审批',
                    value: data.alerts.pendingApprovals,
                    icon: Clock,
                  },
                  {
                    label: '最近运维告警',
                    value: data.alerts.recentOpsAlerts,
                    icon: CircleAlert,
                  },
                ].map(({ label, value, icon: Icon }) => (
                  <Card key={label} size="sm" className="min-w-0">
                    <CardContent className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {label}
                      </span>
                      <span className="text-xl font-medium tabular-nums text-fg">{value}</span>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </PageSection>

            <PageSection
              divided={false}
              title="运行明细"
              {...(tab === 'slo' ? { description: `评估窗口 ${data.sloWindowMinutes} 分钟` } : {})}
              actions={
                <SegmentedToggle
                  label="切换区段"
                  value={tab}
                  options={[
                    { value: 'slo', label: 'SLO' },
                    { value: 'queues', label: '队列' },
                    { value: 'providers', label: '供应商' },
                  ]}
                  onChange={(value) =>
                    void navigate({
                      to: '/observability',
                      search: (prev) => ({ ...prev, tab: value }),
                    })
                  }
                />
              }
            >
              {tab === 'slo' ? (
                <>
                  {slo.isError ? (
                    <ErrorState
                      error={slo.error}
                      onRetry={() => void slo.refetch()}
                      title="SLO 设置没有加载出来"
                    />
                  ) : null}
                  {!data.sloEnabled ? (
                    <PageNote
                      icon={<Gauge aria-hidden="true" />}
                      title="SLO 告警已停用"
                      description="停用后不再发送未达标告警，因此这里不展示达标评估；可在 SLO 设置中重新启用。"
                    />
                  ) : data.slo.length === 0 ? (
                    <PageNote
                      icon={<Gauge aria-hidden="true" />}
                      title="无 SLO 读数"
                      description="窗口内没有样本时，SLO 会显示无数据而不是达标。"
                    />
                  ) : (
                    <Table aria-label="SLO 状态">
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">SLO</TableHead>
                          <TableHead scope="col" className="text-right">
                            目标
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            实际
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            样本量
                          </TableHead>
                          <TableHead scope="col">状态</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.slo.map((item) => (
                          <TableRow key={item.key}>
                            <TableCell className="text-fg">{item.label}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatSloValue(item.key, item.target)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {item.sampleSize === 0
                                ? '无数据'
                                : formatSloValue(item.key, item.actual)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {item.sampleSize}
                            </TableCell>
                            <TableCell>
                              {item.sampleSize === 0 || item.ok === null ? (
                                <StatusBadge>无数据</StatusBadge>
                              ) : item.ok ? (
                                <StatusBadge tone="success">达标</StatusBadge>
                              ) : (
                                <StatusBadge tone="danger">未达标</StatusBadge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </>
              ) : null}

              {tab === 'queues' ? (
                data.queues.length === 0 ? (
                  <PageNote title="当前没有队列读数" />
                ) : (
                  <DataTable
                    rows={data.queues}
                    columns={queueColumns}
                    rowKey={(queue) => queue.name}
                    label="队列"
                    storageKey="pace.observability.queue-columns"
                  />
                )
              ) : null}

              {tab === 'providers' ? (
                data.providers.length === 0 ? (
                  <PageNote icon={<Coins aria-hidden="true" />} title="窗口内没有供应商请求" />
                ) : (
                  <DataTable
                    rows={data.providers}
                    columns={providerColumns}
                    rowKey={(provider) => provider.providerId}
                    label="供应商指标"
                    storageKey="pace.observability.provider-columns"
                  />
                )
              ) : null}
            </PageSection>
          </>
        ) : null}
      </PageBody>

      {editingSlo && slo.data ? (
        <SloDialog settings={slo.data} onClose={() => setEditingSlo(false)} />
      ) : null}
    </Page>
  );
}

function SloDialog({
  settings,
  onClose: onClosed,
}: {
  settings: SloSettings;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const update = useUpdateSloSettings();
  const { register, control, handleSubmit, formState } = useZodForm(sloSettingsSchema, {
    defaultValues: settings,
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = update.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      try {
        await update.mutateAsync(values);
        toastSuccess('SLO 设置已保存');
        setSaved(true);
        guard.finish();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    () => setError(null),
  );

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title="SLO 设置"
        description="目标用于评估观测窗口；无样本时显示无数据。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="SLO 设置"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field orientation="horizontal" className="items-center gap-3" data-disabled={pending}>
              <FieldLabel htmlFor="slo-enabled">启用 SLO 告警</FieldLabel>
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="slo-enabled"
                    ref={field.ref}
                    checked={field.value}
                    disabled={pending}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.windowMinutes)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-window">统计窗口（分钟）</FieldLabel>
                <Input
                  id="slo-window"
                  type="number"
                  min={5}
                  max={1440}
                  step={1}
                  disabled={pending}
                  aria-invalid={Boolean(errors.windowMinutes)}
                  aria-describedby={errors.windowMinutes ? 'slo-window-error' : 'slo-window-hint'}
                  {...register('windowMinutes', { valueAsNumber: true })}
                />
                <FieldDescription id="slo-window-hint">5–1440 分钟。</FieldDescription>
                <FieldError id="slo-window-error">{errors.windowMinutes?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.runSuccessTarget)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-success-target">成功率目标</FieldLabel>
                <Input
                  id="slo-success-target"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  disabled={pending}
                  aria-invalid={Boolean(errors.runSuccessTarget)}
                  aria-describedby={
                    errors.runSuccessTarget ? 'slo-success-target-error' : 'slo-success-hint'
                  }
                  {...register('runSuccessTarget', { valueAsNumber: true })}
                />
                <FieldDescription id="slo-success-hint">0–1，例如 0.99。</FieldDescription>
                <FieldError id="slo-success-target-error">
                  {errors.runSuccessTarget?.message}
                </FieldError>
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.runP95LatencyMs)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-p95">P95 目标（ms）</FieldLabel>
                <Input
                  id="slo-p95"
                  type="number"
                  min={1}
                  step={1}
                  disabled={pending}
                  aria-invalid={Boolean(errors.runP95LatencyMs)}
                  aria-describedby={errors.runP95LatencyMs ? 'slo-p95-error' : undefined}
                  {...register('runP95LatencyMs', { valueAsNumber: true })}
                />
                <FieldError id="slo-p95-error">{errors.runP95LatencyMs?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.queueOldestWaitMs)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-queue-wait">队列等待目标（ms）</FieldLabel>
                <Input
                  id="slo-queue-wait"
                  type="number"
                  min={1}
                  step={1}
                  disabled={pending}
                  aria-invalid={Boolean(errors.queueOldestWaitMs)}
                  aria-describedby={errors.queueOldestWaitMs ? 'slo-queue-wait-error' : undefined}
                  {...register('queueOldestWaitMs', { valueAsNumber: true })}
                />
                <FieldError id="slo-queue-wait-error">
                  {errors.queueOldestWaitMs?.message}
                </FieldError>
              </Field>
            </div>

            <Field data-invalid={Boolean(errors.providerErrorRateTarget)} data-disabled={pending}>
              <FieldLabel htmlFor="slo-provider-error">供应商错误率目标</FieldLabel>
              <Input
                id="slo-provider-error"
                type="number"
                min={0}
                max={1}
                step={0.01}
                disabled={pending}
                aria-invalid={Boolean(errors.providerErrorRateTarget)}
                aria-describedby={
                  errors.providerErrorRateTarget
                    ? 'slo-provider-error-error'
                    : 'slo-provider-error-hint'
                }
                {...register('providerErrorRateTarget', { valueAsNumber: true })}
              />
              <FieldDescription id="slo-provider-error-hint">0–1，例如 0.05。</FieldDescription>
              <FieldError id="slo-provider-error-error">
                {errors.providerErrorRateTarget?.message}
              </FieldError>
            </Field>

            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : '保存设置'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的 SLO 设置会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
