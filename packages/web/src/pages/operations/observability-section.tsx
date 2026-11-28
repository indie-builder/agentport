import {
  type ProviderMetric,
  type QueueSnapshot,
  type SloSettings,
  type SloStatus,
  sloSettingsSchema,
} from '@agentport/shared';
import { Link } from '@tanstack/react-router';
import { Activity, CircleAlert, Clock, Coins, Gauge, ShieldAlert, Timer } from 'lucide-react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { MetricCard, MetricGrid } from '../../components/metric-card.js';
import { PageNote, PageSection } from '../../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../../components/ui/number-input.js';
import { Switch } from '../../components/ui/switch.js';
import { SegmentedToggle } from '../../components/view-toggle.js';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatCost, formatDuration, formatPercent } from '../../lib/format.js';
import {
  useObservabilitySnapshot,
  useSloSettings,
  useUpdateSloSettings,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';

export type ObservabilityWindowMinutes = 15 | 60 | 360 | 1440;
export type ObservabilityTab = 'slo' | 'queues' | 'providers';

export const OBSERVABILITY_WINDOW_OPTIONS = [
  { value: '15', label: '15 分钟' },
  { value: '60', label: '1 小时' },
  { value: '360', label: '6 小时' },
  { value: '1440', label: '24 小时' },
];

const SLO_FORM_ID = 'operations-slo-form';

const sloFormSchema = sloSettingsSchema.extend({
  runSuccessTarget: z.number().min(0, '须在 0–100 之间').max(100, '须在 0–100 之间'),
  providerErrorRateTarget: z.number().min(0, '须在 0–100 之间').max(100, '须在 0–100 之间'),
});

function toPercent(ratio: number): number {
  return Number((ratio * 100).toFixed(2));
}

function fromPercent(percent: number): number {
  return Number((percent / 100).toFixed(4));
}

function toFormValues(settings: SloSettings): SloSettings {
  return {
    ...settings,
    runSuccessTarget: toPercent(settings.runSuccessTarget),
    providerErrorRateTarget: toPercent(settings.providerErrorRateTarget),
  };
}

function isPercentSlo(key: SloStatus['key']): boolean {
  return key === 'run_success' || key === 'provider_error_rate';
}

function formatSloValue(key: SloStatus['key'], value: number | null): string {
  if (value === null) return '无数据';
  return isPercentSlo(key) ? formatPercent(value) : formatDuration(value);
}

export interface ObservabilitySectionProps {
  windowMinutes: ObservabilityWindowMinutes;
  obsTab: ObservabilityTab;
  onWindowChange: (next: ObservabilityWindowMinutes) => void;
  onObsTabChange: (next: ObservabilityTab) => void;
  sloOpen: boolean;
  onSloOpenChange: (open: boolean) => void;
  canManage: boolean;
  sloButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
}

export function ObservabilitySection({
  windowMinutes,
  obsTab,
  onObsTabChange,
  sloOpen,
  onSloOpenChange,
  canManage,
  sloButtonRef,
}: ObservabilitySectionProps) {
  const snapshot = useObservabilitySnapshot(windowMinutes);
  const slo = useSloSettings();
  const data = snapshot.data;

  const oldestQueueWait =
    data && data.queues.length > 0
      ? data.queues.reduce<number | null>((oldest, queue) => {
          if (queue.oldestWaitingMs === null) return oldest;
          return oldest === null ? queue.oldestWaitingMs : Math.max(oldest, queue.oldestWaitingMs);
        }, null)
      : null;

  const sloColumns = useMemo<DataColumn<SloStatus>[]>(
    () => [
      {
        id: 'label',
        header: 'SLO',
        locked: true,
        width: 'minmax(160px,1.4fr)',
        sortValue: (item) => item.label,
        cell: (item) => <span className="font-medium text-fg">{item.label}</span>,
      },
      {
        id: 'target',
        header: '目标',
        numeric: true,
        width: '100px',
        sortValue: (item) => item.target,
        cell: (item) => formatSloValue(item.key, item.target),
      },
      {
        id: 'actual',
        header: '实际',
        numeric: true,
        width: '100px',
        sortValue: (item) => (item.sampleSize === 0 ? null : item.actual),
        cell: (item) => (item.sampleSize === 0 ? '无数据' : formatSloValue(item.key, item.actual)),
      },
      {
        id: 'sampleSize',
        header: '样本量',
        numeric: true,
        width: '90px',
        sortValue: (item) => item.sampleSize,
        cell: (item) => <span className="text-muted-foreground">{item.sampleSize}</span>,
      },
      {
        id: 'status',
        header: '状态',
        width: '96px',
        sortValue: (item) => (item.sampleSize === 0 || item.ok === null ? 1 : item.ok ? 2 : 0),
        cell: (item) =>
          item.sampleSize === 0 || item.ok === null ? (
            <StatusBadge>无数据</StatusBadge>
          ) : item.ok ? (
            <StatusBadge tone="success">达标</StatusBadge>
          ) : (
            <StatusBadge tone="danger">未达标</StatusBadge>
          ),
      },
    ],
    [],
  );

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

  const alertLinkClassName =
    'inline-flex min-w-0 items-center gap-2 rounded-item border border-line bg-surface px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <>
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
          <MetricGrid columns={4}>
            {[
              {
                label: '运行成功率',
                value: data.runs.finished === 0 ? '无数据' : formatPercent(data.runs.successRate),
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

          <nav aria-label="告警摘要" className="flex flex-wrap items-center gap-2">
            <Link to="/security" search={{ tab: 'violations' }} className={alertLinkClassName}>
              <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
              <span>未处理违规</span>
              <span
                className={cn(
                  'font-mono text-sm font-medium tabular-nums',
                  data.alerts.openViolations > 0 ? 'text-danger' : 'text-fg',
                )}
              >
                {data.alerts.openViolations}
              </span>
            </Link>
            <Link to="/security" search={{ tab: 'approvals' }} className={alertLinkClassName}>
              <Clock className="size-4 shrink-0" aria-hidden="true" />
              <span>待审批</span>
              <span
                className={cn(
                  'font-mono text-sm font-medium tabular-nums',
                  data.alerts.pendingApprovals > 0 ? 'text-warning' : 'text-fg',
                )}
              >
                {data.alerts.pendingApprovals}
              </span>
            </Link>
            <Link to="/notifications" className={alertLinkClassName}>
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              <span>最近运维告警</span>
              <span
                className={cn(
                  'font-mono text-sm font-medium tabular-nums',
                  data.alerts.recentOpsAlerts > 0 ? 'text-danger' : 'text-fg',
                )}
              >
                {data.alerts.recentOpsAlerts}
              </span>
            </Link>
          </nav>

          <PageSection
            divided={false}
            title="运行明细"
            {...(obsTab === 'slo' ? { description: `评估窗口 ${data.sloWindowMinutes} 分钟` } : {})}
            actions={
              <SegmentedToggle
                label="切换区段"
                value={obsTab}
                options={[
                  { value: 'slo', label: 'SLO' },
                  { value: 'queues', label: '队列' },
                  { value: 'providers', label: '供应商' },
                ]}
                onChange={onObsTabChange}
              />
            }
          >
            {obsTab === 'slo' ? (
              <>
                {slo.isError ? (
                  <ErrorState
                    error={slo.error}
                    onRetry={() => void slo.refetch()}
                    title="SLO 设置没有加载出来"
                  />
                ) : null}
                {!data.sloEnabled ? (
                  <EmptyState
                    variant="idle"
                    scale="section"
                    icon={<Gauge className="size-5" aria-hidden="true" />}
                    title="SLO 告警已停用"
                    description="启用后将按窗口评估达标率并触发告警。"
                    action={
                      canManage && slo.data ? (
                        <Button variant="outline" size="sm" onClick={() => onSloOpenChange(true)}>
                          前往 SLO 设置
                        </Button>
                      ) : undefined
                    }
                  />
                ) : data.slo.length === 0 ? (
                  <EmptyState
                    variant="idle"
                    scale="section"
                    icon={<Gauge className="size-5" aria-hidden="true" />}
                    title="当前窗口内没有样本读数"
                    description="窗口内没有样本时，SLO 会显示无数据而不是达标。"
                  />
                ) : (
                  <DataTable
                    rows={data.slo}
                    columns={sloColumns}
                    rowKey={(item) => item.key}
                    label="SLO 状态"
                    storageKey="pace.observability.slo-columns"
                    hideRowCount
                  />
                )}
              </>
            ) : null}

            {obsTab === 'queues' ? (
              data.queues.length === 0 ? (
                <EmptyState
                  variant="idle"
                  scale="section"
                  icon={<Clock className="size-5" aria-hidden="true" />}
                  title="当前没有活跃队列读数"
                />
              ) : (
                <DataTable
                  rows={data.queues}
                  columns={queueColumns}
                  rowKey={(queue) => queue.name}
                  label="队列"
                  storageKey="pace.observability.queue-columns"
                  hideRowCount
                />
              )
            ) : null}

            {obsTab === 'providers' ? (
              data.providers.length === 0 ? (
                <EmptyState
                  variant="idle"
                  scale="section"
                  icon={<Coins className="size-5" aria-hidden="true" />}
                  title="窗口内没有供应商请求"
                />
              ) : (
                <DataTable
                  rows={data.providers}
                  columns={providerColumns}
                  rowKey={(provider) => provider.providerId}
                  label="供应商指标"
                  storageKey="pace.observability.provider-columns"
                  hideRowCount
                />
              )
            ) : null}
          </PageSection>
        </>
      ) : null}

      {sloOpen ? (
        <SloSettingsSheet
          onClosed={() => onSloOpenChange(false)}
          {...(sloButtonRef
            ? {
                finalFocus: () => (sloButtonRef.current?.isConnected ? sloButtonRef.current : null),
              }
            : {})}
        />
      ) : null}
    </>
  );
}

function SloSettingsSheet({
  onClosed,
  finalFocus,
}: {
  onClosed: () => void;
  finalFocus?: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const slo = useSloSettings();
  const settings = slo.data;
  const update = useUpdateSloSettings();
  const { control, handleSubmit, reset, formState } = useZodForm(sloFormSchema, {
    defaultValues: settings
      ? toFormValues(settings)
      : {
          enabled: true,
          windowMinutes: 60,
          runSuccessTarget: 95,
          runP95LatencyMs: 120_000,
          queueOldestWaitMs: 60_000,
          providerErrorRateTarget: 5,
        },
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = update.isPending && !saved;
  const dirty = !saved && Boolean(settings) && isDirty;
  const guard = useDraftGuard(dirty, pending, dialog.close);

  const settingsRef = useRef(settings);
  useEffect(() => {
    if (!settings || settingsRef.current === settings) return;
    settingsRef.current = settings;
    if (!isDirty) {
      reset(toFormValues(settings));
    }
  }, [settings, isDirty, reset]);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      try {
        await update.mutateAsync({
          ...values,
          runSuccessTarget: fromPercent(values.runSuccessTarget),
          providerErrorRateTarget: fromPercent(values.providerErrorRateTarget),
        });
        toastSuccess('SLO 设置已保存');
        setSaved(true);
        guard.finish();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    () => setError(null),
  );

  const footer = settings ? (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
        取消
      </Button>
      <Button type="submit" form={SLO_FORM_ID} disabled={pending} aria-busy={pending}>
        {pending ? '正在保存…' : '保存设置'}
      </Button>
    </div>
  ) : undefined;

  return (
    <>
      <InspectorSheet
        size="sm"
        open={dialog.open}
        onOpenChange={(next) => {
          if (!next) guard.close();
        }}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        title="SLO 设置"
        description="目标用于评估观测窗口；无样本时显示无数据。"
        closeDisabled={pending}
        {...(finalFocus === undefined ? {} : { finalFocus })}
        {...(footer === undefined ? {} : { footer })}
      >
        {slo.isPending ? (
          <LoadingState rows={4} />
        ) : settings ? (
          <form
            id={SLO_FORM_ID}
            aria-label="SLO 设置"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup className="gap-5">
              <Field
                orientation="horizontal"
                className="items-center gap-3"
                data-disabled={pending}
              >
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

              <Field data-invalid={Boolean(errors.windowMinutes)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-window">统计窗口（分钟）</FieldLabel>
                <Controller
                  control={control}
                  name="windowMinutes"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={Number.isFinite(field.value) ? field.value : null}
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next ?? Number.NaN);
                      }}
                      step={1}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="slo-window"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.windowMinutes)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldDescription id="slo-window-hint">5–1440 分钟。</FieldDescription>
                <FieldError id="slo-window-error">{errors.windowMinutes?.message}</FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.runSuccessTarget)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-success-target">成功率目标（%）</FieldLabel>
                <Controller
                  control={control}
                  name="runSuccessTarget"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={Number.isFinite(field.value) ? field.value : null}
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next ?? Number.NaN);
                      }}
                      step={0.5}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="slo-success-target"
                          inputMode="decimal"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.runSuccessTarget)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldDescription id="slo-success-hint">0–100%，例如 95。</FieldDescription>
                <FieldError id="slo-success-target-error">
                  {errors.runSuccessTarget?.message}
                </FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.runP95LatencyMs)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-p95">P95 目标（ms）</FieldLabel>
                <Controller
                  control={control}
                  name="runP95LatencyMs"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={Number.isFinite(field.value) ? field.value : null}
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next ?? Number.NaN);
                      }}
                      step={1}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="slo-p95"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.runP95LatencyMs)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldError id="slo-p95-error">{errors.runP95LatencyMs?.message}</FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.queueOldestWaitMs)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-queue-wait">队列等待目标（ms）</FieldLabel>
                <Controller
                  control={control}
                  name="queueOldestWaitMs"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={Number.isFinite(field.value) ? field.value : null}
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next ?? Number.NaN);
                      }}
                      step={1}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="slo-queue-wait"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.queueOldestWaitMs)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldError id="slo-queue-wait-error">
                  {errors.queueOldestWaitMs?.message}
                </FieldError>
              </Field>

              <Field data-invalid={Boolean(errors.providerErrorRateTarget)} data-disabled={pending}>
                <FieldLabel htmlFor="slo-provider-error">供应商错误率目标（%）</FieldLabel>
                <Controller
                  control={control}
                  name="providerErrorRateTarget"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={Number.isFinite(field.value) ? field.value : null}
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next ?? Number.NaN);
                      }}
                      step={0.5}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="slo-provider-error"
                          inputMode="decimal"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.providerErrorRateTarget)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldDescription id="slo-provider-error-hint">0–100%，例如 5。</FieldDescription>
                <FieldError id="slo-provider-error-error">
                  {errors.providerErrorRateTarget?.message}
                </FieldError>
              </Field>

              <FieldError>{error ?? undefined}</FieldError>
            </FieldGroup>
          </form>
        ) : (
          <ErrorState
            error={slo.error}
            onRetry={() => void slo.refetch()}
            title="SLO 设置没有加载出来"
          />
        )}
      </InspectorSheet>
      <DraftGuardDialogs guard={guard} draft="填写的 SLO 设置会丢失。" pending={pending} />
    </>
  );
}
