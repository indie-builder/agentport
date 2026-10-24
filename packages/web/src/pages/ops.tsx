import { type Schedule, type ScheduleInput, scheduleInputSchema } from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarClock, CircleAlert, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import { Switch } from '../components/ui/switch.js';
import { Textarea } from '../components/ui/textarea.js';
import { api } from '../lib/api.js';
import { fieldErrors } from '../lib/form.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
} from '../lib/format.js';
import {
  agentStatsQuery,
  boardSummaryQuery,
  useAgents,
  useAttention,
  useSchedules,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const emptySchedule: ScheduleInput = {
  agentId: '',
  name: '',
  cron: '',
  prompt: '',
  enabled: true,
};

const scheduleFormSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    cron: z.string().trim(),
    prompt: z.string(),
    enabled: z.boolean(),
  })
  .superRefine((values, ctx) => {
    const parsed = scheduleInputSchema.safeParse(values);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path as (string | number)[],
        message: Object.values(fieldErrors([issue]))[0] ?? issue.message,
      });
    }
  });

export function SchedulesPage() {
  const schedules = useSchedules();
  const agents = useAgents();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['schedules'] });
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled }),
    onSuccess: (_schedule, vars) => {
      toastSuccess(vars.enabled ? '定时任务已启用' : '定时任务已暂停');
    },
    onError: toastError,
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => toastSuccess('定时任务已删除'),
    onError: toastError,
    onSettled: invalidate,
  });

  const items = schedules.data ?? [];

  return (
    <Page>
      <PageHeader
        title="定时任务"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建定时任务
          </Button>
        }
      />

      {schedules.data ? (
        <PageToolbar>
          <p className="text-sm text-muted-foreground">
            {schedules.data.length} 个定时任务，cron 按 UTC 解析。
          </p>
        </PageToolbar>
      ) : null}

      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}

      {schedules.isPending ? <LoadingState rows={3} /> : null}
      {schedules.isError ? (
        <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : null}

      {schedules.data && items.length === 0 ? (
        <PageNote
          icon={<CalendarClock className="size-4" aria-hidden="true" />}
          title="按 cron 自动发起运行"
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建定时任务
            </Button>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <PageSection divided={false}>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">定时任务列表</caption>
            <thead>
              <tr className="border-t border-line text-2xs text-muted-foreground">
                <th scope="col" className="py-2 pr-2 text-left font-normal">
                  名称
                </th>
                <th
                  scope="col"
                  className="hidden w-[150px] py-2 pr-2 text-left font-normal sm:table-cell"
                >
                  cron
                </th>
                <th
                  scope="col"
                  className="hidden w-[120px] py-2 pr-2 text-left font-normal sm:table-cell"
                >
                  下次触发
                </th>
                <th
                  scope="col"
                  className="hidden w-[120px] py-2 pr-2 text-left font-normal sm:table-cell"
                >
                  上次运行
                </th>
                <th scope="col" className="w-px py-2">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((schedule) => (
                <tr key={schedule.id} className="border-b border-line">
                  <th scope="row" className="min-w-0 py-3 pr-2 text-left font-normal">
                    <span className="block truncate text-sm font-medium text-fg">
                      {schedule.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {schedule.agentName ?? '已删除的专家'}
                    </span>
                    {/* 窄屏收起列，用可见标签保留每项数据。 */}
                    <span className="block text-2xs text-muted-foreground sm:hidden">
                      {schedule.cron} · 下次 {formatDateTime(schedule.nextDueAt)} · 上次{' '}
                      {formatRelative(schedule.lastRunAt)}
                    </span>
                  </th>
                  <td className="hidden py-3 pr-2 sm:table-cell">
                    <code className="font-mono text-xs text-muted-foreground">{schedule.cron}</code>
                  </td>
                  <td className="hidden py-3 pr-2 text-xs text-muted-foreground sm:table-cell">
                    {formatDateTime(schedule.nextDueAt)}
                  </td>
                  <td className="hidden py-3 pr-2 text-xs text-muted-foreground sm:table-cell">
                    {formatRelative(schedule.lastRunAt)}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <Switch
                        size="sm"
                        checked={schedule.enabled}
                        disabled={toggle.isPending && toggle.variables?.id === schedule.id}
                        aria-label={`${schedule.enabled ? '暂停' : '启用'} ${schedule.name}`}
                        onCheckedChange={(enabled) => toggle.mutate({ id: schedule.id, enabled })}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`编辑 ${schedule.name}`}
                        onClick={() => setEditing(schedule)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除 ${schedule.name}`}
                        onClick={() => setDeleting(schedule)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageSection>
      ) : null}

      {creating ? (
        <ScheduleDialog agents={agents.data ?? []} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <ScheduleDialog
          schedule={editing}
          agents={agents.data ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除定时任务"
          description={`将删除「${deleting.name}」，之后不再按计划自动运行。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
          }}
        />
      ) : null}
    </Page>
  );
}

function ScheduleDialog({
  schedule,
  agents,
  onClose,
}: {
  schedule?: Schedule;
  agents: { id: string; name: string }[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { register, control, handleSubmit, watch, formState } = useZodForm(scheduleFormSchema, {
    defaultValues: schedule
      ? {
          agentId: schedule.agentId,
          name: schedule.name,
          cron: schedule.cron,
          prompt: schedule.prompt,
          enabled: schedule.enabled,
        }
      : emptySchedule,
  });
  const { errors, isDirty } = formState;
  const watched = watch();
  const dirty = isDirty;
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['schedules'] });
  };
  const create = useMutation({
    mutationFn: (input: ScheduleInput) => api.createSchedule(input),
    onSuccess: () => {
      toastSuccess('定时任务已创建');
      onClose();
    },
    onError: toastError,
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateSchedule>[1]) =>
      api.updateSchedule(schedule?.id ?? '', input),
    onSuccess: () => {
      toastSuccess('定时任务已更新');
      onClose();
    },
    onError: toastError,
    onSettled: invalidate,
  });
  const pending = create.isPending || update.isPending;
  // Esc、遮罩、取消和关闭按钮走同一路径：有未保存输入时先确认。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const agentOptions = [
    ...(schedule && !agents.some((agent) => agent.id === schedule.agentId)
      ? [{ value: schedule.agentId, label: schedule.agentName ?? '已删除的专家' }]
      : []),
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const submit = handleSubmit((values) => {
    if (pending) return;
    if (schedule) {
      update.mutate({
        name: values.name,
        cron: values.cron,
        prompt: values.prompt,
        enabled: values.enabled,
        expectedUpdatedAt: schedule.updatedAt,
      });
    } else {
      create.mutate(values);
    }
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <DialogShell title={schedule ? '编辑定时任务' : '新建定时任务'} closeDisabled={pending}>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <FieldGroup className="gap-3">
            <Field
              className="gap-1.5"
              data-disabled={pending || Boolean(schedule)}
              data-invalid={Boolean(errors.agentId)}
            >
              <FieldLabel htmlFor="schedule-agent">
                专家 <RequiredMark />
              </FieldLabel>
              <Controller
                control={control}
                name="agentId"
                render={({ field }) => (
                  <Select
                    disabled={pending || Boolean(schedule)}
                    value={field.value}
                    items={agentOptions}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                  >
                    <SelectTrigger
                      id="schedule-agent"
                      className="w-full min-w-0"
                      ref={field.ref}
                      onBlur={field.onBlur}
                      aria-invalid={Boolean(errors.agentId)}
                      aria-describedby={errors.agentId ? 'schedule-agent-error' : undefined}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {agentOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError id="schedule-agent-error">{errors.agentId?.message}</FieldError>
            </Field>

            <FieldGroup className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <Field
                className="gap-1.5"
                data-disabled={pending}
                data-invalid={Boolean(errors.name)}
              >
                <FieldLabel htmlFor="schedule-name">
                  名称 <RequiredMark />
                </FieldLabel>
                <Input
                  {...register('name')}
                  value={watched.name}
                  id="schedule-name"
                  disabled={pending}
                  aria-required="true"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'schedule-name-error' : undefined}
                />
                <FieldError id="schedule-name-error">{errors.name?.message}</FieldError>
              </Field>
              <Field
                className="gap-1.5"
                data-disabled={pending}
                data-invalid={Boolean(errors.cron)}
              >
                <FieldLabel htmlFor="schedule-cron">
                  cron <RequiredMark />
                </FieldLabel>
                <Input
                  {...register('cron')}
                  value={watched.cron}
                  id="schedule-cron"
                  disabled={pending}
                  placeholder="0 9 * * *"
                  className="font-mono"
                  aria-required="true"
                  aria-invalid={Boolean(errors.cron)}
                  aria-describedby={errors.cron ? 'schedule-cron-error' : undefined}
                />
                <FieldError id="schedule-cron-error">{errors.cron?.message}</FieldError>
              </Field>
            </FieldGroup>

            <Field
              className="gap-1.5"
              data-disabled={pending}
              data-invalid={Boolean(errors.prompt)}
            >
              <FieldLabel htmlFor="schedule-prompt">
                提示词 <RequiredMark />
              </FieldLabel>
              <Textarea
                {...register('prompt')}
                value={watched.prompt}
                id="schedule-prompt"
                disabled={pending}
                rows={6}
                aria-required="true"
                aria-invalid={Boolean(errors.prompt)}
                aria-describedby={errors.prompt ? 'schedule-prompt-error' : undefined}
              />
              <FieldError id="schedule-prompt-error">{errors.prompt?.message}</FieldError>
            </Field>

            <Field orientation="horizontal" className="items-center gap-3" data-disabled={pending}>
              <FieldLabel htmlFor="schedule-enabled">启用</FieldLabel>
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    ref={field.ref}
                    id="schedule-enabled"
                    checked={field.value}
                    disabled={pending}
                    onCheckedChange={(enabled) => field.onChange(enabled)}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </Field>
          </FieldGroup>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" aria-busy={pending} disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这次填写的定时任务内容会丢失。"
          confirmLabel="放弃并关闭"
          onConfirm={async () => {
            if (!pending) onClose();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}

export function AttentionPanel() {
  const attention = useAttention();
  const data = attention.data;

  return (
    <PageSection
      divided={false}
      title="需要处理"
      actions={
        data && data.total > 0 ? <StatusBadge tone="danger">{data.total} 项</StatusBadge> : null
      }
    >
      {attention.isPending ? <LoadingState rows={2} /> : null}
      {attention.isError ? (
        <ErrorState error={attention.error} onRetry={() => void attention.refetch()} />
      ) : null}
      {data && data.total === 0 ? <PageNote title="没有需要处理的运行" /> : null}
      {data && data.total > 0 ? (
        <ul className="flex flex-col">
          {data.approvals.map((item) =>
            item.kind !== 'approval' ? null : (
              <li key={`approval-${item.runId}-${item.serverId}-${item.toolName}`}>
                <Link
                  to="/runs/$runId"
                  params={{ runId: item.runId }}
                  className="-mx-2 flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5 hover:bg-hover"
                >
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {item.agentName ?? '已删除的专家'} · 等待批准 {item.toolName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatRelative(item.createdAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
          {data.failedRuns.map((item) =>
            item.kind !== 'failed_run' ? null : (
              <li key={`failed-${item.runId}`}>
                <Link
                  to="/runs/$runId"
                  params={{ runId: item.runId }}
                  className="-mx-2 flex min-w-0 items-start gap-3 rounded-item px-2 py-2.5 hover:bg-hover"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {item.agentName ?? '已删除的专家'} · 运行失败
                    </span>
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={item.error ?? undefined}
                    >
                      {item.error ?? formatRelative(item.endedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </PageSection>
  );
}

const triggerLabels = [
  ['chat', '对话'],
  ['mcp', '外部调用'],
  ['schedule', '定时'],
  ['event', '事件'],
] as const;

export function BoardSummaryCards() {
  const summary = useQuery(boardSummaryQuery(30));

  if (summary.isError) {
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  }

  const data = summary.data;
  const cards = [
    { label: '任务总数', value: data?.total },
    { label: '进行中', value: data?.running },
    { label: '需要操作', value: data?.needsAction },
    { label: '已结束', value: data?.finished },
  ];

  return (
    <section className="flex flex-col gap-3" aria-label="任务概况">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {cards.map(({ label, value }) => (
          <Card key={label}>
            <CardHeader>
              <CardTitle className="text-sm font-normal text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <span
                className={`text-lg font-medium tabular-nums ${
                  label === '需要操作' && value ? 'text-danger' : 'text-fg'
                }`}
              >
                {value ?? '—'}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {triggerLabels.map(([key, label]) => (
          <span key={key}>
            {label}{' '}
            <span className="tabular-nums text-fg">
              {data ? (data.byTrigger?.[key] ?? 0) : '—'}
            </span>
          </span>
        ))}
      </p>
    </section>
  );
}

/** 单个智能体的运行统计与活跃度热力图（对标 QoderWake 的概览/工作日志）。 */
export function AgentStatsPanel({ agentId }: { agentId: string }) {
  const stats = useQuery(agentStatsQuery(agentId, 30));

  if (stats.isPending) return <LoadingState rows={3} />;
  if (stats.isError) {
    return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;
  }
  const s = stats.data;
  const cells = [
    { label: '运行次数', value: String(s.runCount) },
    { label: '成功率', value: formatPercent(s.runCount > 0 ? s.succeeded / s.runCount : 0) },
    { label: '失败率', value: formatPercent(s.errorRate) },
    { label: '累计成本', value: formatCost(s.totalCost) },
    { label: 'Token', value: formatTokens(s.totalTokens) },
    { label: 'P50 延迟', value: formatDuration(s.latencyP50) },
    { label: 'P99 延迟', value: formatDuration(s.latencyP99) },
    { label: '最近运行', value: formatRelative(s.lastRunStartTime) },
  ];
  const maxRuns = Math.max(1, ...s.daily.map((d) => d.runs));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="rounded-card bg-surface px-4 py-3 ring-1 ring-line">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-lg font-medium tabular-nums text-fg">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="rounded-card bg-surface px-4 py-4 ring-1 ring-line">
        <div className="mb-3 text-xs text-muted-foreground">近 30 天活跃度</div>
        {s.daily.length === 0 ? (
          <p className="text-sm text-muted-foreground">近 30 天没有运行记录。</p>
        ) : (
          <>
            {/* 柱子只是视觉，数据由下方离屏表格提供，键盘与读屏都能读到。 */}
            <div className="flex items-end gap-1" style={{ height: 64 }} aria-hidden="true">
              {s.daily.map((d) => (
                <div
                  key={d.day}
                  className="flex-1 rounded-t-sm bg-ink/80"
                  style={{ height: `${Math.max(4, Math.round((d.runs / maxRuns) * 64))}px` }}
                  title={`${d.day} · ${d.runs} 次 · ${formatCost(d.cost)}`}
                />
              ))}
            </div>
            <table className="sr-only">
              <caption>近 30 天每日运行次数与成本</caption>
              <thead>
                <tr>
                  <th scope="col">日期</th>
                  <th scope="col">运行次数</th>
                  <th scope="col">成本</th>
                </tr>
              </thead>
              <tbody>
                {s.daily.map((d) => (
                  <tr key={d.day}>
                    <th scope="row">{d.day}</th>
                    <td>{d.runs}</td>
                    <td>{formatCost(d.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
