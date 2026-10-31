import { type Schedule, type ScheduleInput, scheduleInputSchema } from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { BusinessIllustration } from '../components/business-illustration.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field.js';
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
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import { can } from '../lib/access.js';
import { ApiError, api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { fieldErrors, useFormBlocker } from '../lib/form.js';
import { formatRelative } from '../lib/format.js';
import { meQuery, useAgents, useAttention, useSchedules } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

type ScheduleFrequency = 'daily' | 'weekly' | 'custom';

const frequencyOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'custom', label: '自定义 cron' },
];

const weekdayOptions = [
  { value: '1', label: '一', name: '周一' },
  { value: '2', label: '二', name: '周二' },
  { value: '3', label: '三', name: '周三' },
  { value: '4', label: '四', name: '周四' },
  { value: '5', label: '五', name: '周五' },
  { value: '6', label: '六', name: '周六' },
  { value: '0', label: '日', name: '周日' },
] as const;

const defaultWeekdays = ['1', '2', '3', '4', '5'];

// cron 与下次触发都以 UTC 为准；表格不再跟随浏览器本地时区显示。
const utcDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'UTC',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : utcDateTimeFormatter.format(date);
}

function parseTime(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function timeFromCronParts(minutesPart: string, hoursPart: string): string | null {
  const minutes = Number(minutesPart);
  const hours = Number(hoursPart);
  if (!Number.isInteger(minutes) || !Number.isInteger(hours)) return null;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** 每天的 m h * * *；每周的 m h * * 升序日（周日为 0）。 */
function serializeCron(
  frequency: Exclude<ScheduleFrequency, 'custom'>,
  time: string,
  weekdays: string[],
): string | null {
  const parsed = parseTime(time);
  if (!parsed) return null;
  if (frequency === 'daily') return `${parsed.minutes} ${parsed.hours} * * *`;
  const days = [...new Set(weekdays.map(Number))].sort((a, b) => a - b);
  if (days.length === 0 || days.some((day) => day < 0 || day > 6)) return null;
  return `${parsed.minutes} ${parsed.hours} * * ${days.join(',')}`;
}

/** 只接受能逐字符往返的规范简单表达式；其余一律按 custom 原文保留。 */
function decodeCron(
  cron: string,
): { frequency: 'daily' | 'weekly'; time: string; weekdays: string[] } | null {
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (daily) {
    const time = timeFromCronParts(daily[1] ?? '', daily[2] ?? '');
    if (!time || serializeCron('daily', time, []) !== cron) return null;
    return { frequency: 'daily', time, weekdays: [] };
  }
  const weekly = /^(\d+) (\d+) \* \* ([0-9,]+)$/.exec(cron);
  if (!weekly) return null;
  const time = timeFromCronParts(weekly[1] ?? '', weekly[2] ?? '');
  if (!time) return null;
  const rawDays = (weekly[3] ?? '').split(',');
  if (rawDays.some((day) => !/^\d$/.test(day))) return null;
  const days = rawDays.map(Number);
  if (days.some((day) => day < 0 || day > 6)) return null;
  if (serializeCron('weekly', time, rawDays) !== cron) return null;
  return { frequency: 'weekly', time, weekdays: rawDays };
}

const emptyScheduleForm: ScheduleFormValues = {
  agentId: '',
  name: '',
  cron: '',
  prompt: '',
  enabled: true,
  frequency: 'daily',
  time: '09:00',
  weekdays: [],
};

function draftFromSchedule(schedule: Schedule): ScheduleFormValues {
  const decoded = decodeCron(schedule.cron);
  return {
    agentId: schedule.agentId,
    name: schedule.name,
    // 非简单表达式保留原文；简单表达式由 time/weekdays 重新投影，避免保存时改写 cron。
    cron: decoded ? '' : schedule.cron,
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    frequency: decoded?.frequency ?? 'custom',
    time: decoded?.time ?? '09:00',
    weekdays: decoded?.weekdays ?? [],
  };
}

function projectScheduleInput(values: ScheduleFormValues): ScheduleInput {
  const cron =
    values.frequency === 'custom'
      ? values.cron
      : (serializeCron(values.frequency, values.time, values.weekdays) ?? values.cron);
  return {
    agentId: values.agentId,
    name: values.name,
    cron,
    prompt: values.prompt,
    enabled: values.enabled,
  };
}

const scheduleFormSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    cron: z.string(),
    prompt: z.string(),
    enabled: z.boolean(),
    frequency: z.enum(['daily', 'weekly', 'custom']),
    time: z.string(),
    weekdays: z.array(z.string()),
  })
  .superRefine((values, ctx) => {
    const generated =
      values.frequency === 'custom'
        ? values.cron
        : (serializeCron(values.frequency, values.time, values.weekdays) ?? '');
    // 复用与 API 相同的约束；频率模式自身的错误映射到可见字段，隐藏的 cron 不接收错误。
    const parsed = scheduleInputSchema.safeParse({
      agentId: values.agentId,
      name: values.name,
      cron: generated,
      prompt: values.prompt,
      enabled: values.enabled,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (key === 'cron' && values.frequency !== 'custom') continue;
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: Object.values(fieldErrors([issue]))[0] ?? issue.message,
        });
      }
    }
    if (values.frequency !== 'custom') {
      if (!parseTime(values.time)) {
        ctx.addIssue({ code: 'custom', path: ['time'], message: '请选择时间' });
      } else if (values.frequency === 'weekly' && values.weekdays.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '至少选择一天' });
      }
    }
  });

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

export function SchedulesPage() {
  const schedules = useSchedules();
  const agents = useAgents();
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'schedules.manage');
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  // 删除成功标记：finalFocus 在弹层卸载时才读取，用 ref 保证读到的是本次结果。
  const deletedRef = useRef(false);
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
  // 启停和删除共用列表状态：任一请求在途时锁住所有行，避免用旧列表并发改同一批任务。
  const rowBusy = toggle.isPending || remove.isPending || !canManage;

  return (
    <Page>
      <PageHeader
        title="定时任务"
        actions={
          canManage ? (
            <Button ref={createButtonRef} onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" aria-hidden="true" /> 新建定时任务
            </Button>
          ) : null
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
          icon={<BusinessIllustration name="schedule" size="compact" />}
          title="按 cron 自动发起运行"
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
                  下次触发（UTC）
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
                <tr
                  key={schedule.id}
                  className="border-b border-line transition-colors duration-150 ease-out-soft hover:bg-hover"
                >
                  <th scope="row" className="min-w-0 py-3 pr-2 text-left font-normal">
                    <span className="block truncate text-sm font-medium text-fg">
                      {schedule.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {schedule.agentName ?? '已删除的专家'}
                    </span>
                    {/* 窄屏收起列，用可见标签保留每项数据。 */}
                    <span className="block text-2xs text-muted-foreground sm:hidden">
                      {schedule.cron} · 下次 UTC {formatUtcDateTime(schedule.nextDueAt)} · 上次{' '}
                      {formatRelative(schedule.lastRunAt)}
                    </span>
                  </th>
                  <td className="hidden py-3 pr-2 sm:table-cell">
                    <code className="font-mono text-xs text-muted-foreground">{schedule.cron}</code>
                  </td>
                  <td className="hidden py-3 pr-2 text-xs text-muted-foreground sm:table-cell">
                    {formatUtcDateTime(schedule.nextDueAt)}
                  </td>
                  <td className="hidden py-3 pr-2 text-xs text-muted-foreground sm:table-cell">
                    {formatRelative(schedule.lastRunAt)}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <Switch
                        size="sm"
                        checked={schedule.enabled}
                        disabled={rowBusy}
                        aria-label={`${schedule.enabled ? '暂停' : '启用'} ${schedule.name}`}
                        onCheckedChange={(enabled) => {
                          if (rowBusy) return;
                          toggle.mutate({ id: schedule.id, enabled });
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`编辑 ${schedule.name}`}
                        disabled={rowBusy}
                        onClick={() => {
                          if (rowBusy) return;
                          setEditing(schedule);
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除 ${schedule.name}`}
                        disabled={rowBusy}
                        onClick={() => {
                          if (rowBusy) return;
                          deletedRef.current = false;
                          setDeleting(schedule);
                        }}
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
          // 被删行会随刷新消失；只有删除成功才把焦点交给页头创建按钮，失败或取消走默认返回触发控件。
          finalFocus={() => (deletedRef.current ? createButtonRef.current : null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            deletedRef.current = true;
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
  const [confirmReload, setConfirmReload] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [reloading, setReloading] = useState(false);
  // 版本基线独立于打开弹层时的快照：冲突后重新加载才推进基线。
  const [baseline, setBaseline] = useState(schedule?.updatedAt);
  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    formState,
    getValues,
    setValue,
    clearErrors,
  } = useZodForm(scheduleFormSchema, {
    defaultValues: schedule ? draftFromSchedule(schedule) : emptyScheduleForm,
  });
  // 首次切到每周才补默认一至五；用户清空后不再自动填充。
  const firstWeekly = useRef(true);
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
      finish();
    },
    onError: toastError,
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateSchedule>[1]) =>
      api.updateSchedule(schedule?.id ?? '', input),
    onSuccess: () => {
      toastSuccess('定时任务已更新');
      finish();
    },
    onError: (error) => {
      // 冲突就地保留草稿；只有用户确认重新加载才推进版本基线，绝不自动重发旧稿。
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        setConflict(true);
        toastError(new Error('定时任务已被修改；当前草稿已保留，请加载最新版本后重新编辑。'));
        return;
      }
      // 编辑目标已被删除时同样保留草稿，只提供显式「另存为新建」，不自动转创建。
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        setConflict(true);
        setDeleted(true);
        toastError(new Error('该定时任务已被删除，当前草稿已保留；可另存为新建。'));
        return;
      }
      toastError(error);
    },
    onSettled: invalidate,
  });
  const pending = create.isPending || update.isPending || reloading;
  const reload = async (): Promise<void> => {
    if (!schedule || pending) return;
    setReloading(true);
    try {
      // throwOnError 是 refetchQueries 的第二个参数，放进 filters 会被忽略并吞掉失败。
      await client.refetchQueries({ queryKey: ['schedules'] }, { throwOnError: true });
      const latest = client
        .getQueryData<Schedule[]>(['schedules'])
        ?.find((item) => item.id === schedule.id);
      if (!latest) {
        setDeleted(true);
        throw new Error('该定时任务已被删除，当前草稿已保留；可另存为新建。');
      }
      reset(draftFromSchedule(latest));
      firstWeekly.current = true;
      setBaseline(latest.updatedAt);
      setConflict(false);
      setDeleted(false);
      setConfirmReload(false);
    } catch (error) {
      toastError(error);
    } finally {
      setReloading(false);
    }
  };
  const blocker = useFormBlocker(dirty, pending);
  // 成功回调在拦截发生前创建，读不到后来的 blocker：用 ref 拿最新一次。
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  // 关闭会卸载弹层并摘掉 blocker：先取消期间被拦下的离开，否则它的 resolver 一直挂着。
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  // Esc、遮罩、取消和关闭按钮走同一路径：有未保存输入时先确认。
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };

  const agentOptions = [
    ...(schedule && !agents.some((agent) => agent.id === schedule.agentId)
      ? [{ value: schedule.agentId, label: schedule.agentName ?? '已删除的专家' }]
      : []),
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const changeFrequency = (next: ScheduleFrequency): void => {
    const current = getValues('frequency');
    if (next === current) return;
    if (next === 'custom') {
      const generated =
        current === 'custom'
          ? getValues('cron')
          : serializeCron(current, getValues('time'), getValues('weekdays'));
      setValue('cron', generated ?? '', { shouldDirty: true });
      clearErrors(['time', 'weekdays']);
    } else {
      clearErrors('cron');
      if (current === 'custom') {
        const decoded = decodeCron(getValues('cron'));
        setValue('time', decoded?.time ?? '09:00', { shouldDirty: true });
        // 规范每日 cron 解码出的周为空，首次进入每周仍按简单模式补默认工作日。
        const weeklyFromDaily =
          next === 'weekly' && decoded?.frequency === 'daily' && firstWeekly.current;
        setValue(
          'weekdays',
          weeklyFromDaily ? [...defaultWeekdays] : (decoded?.weekdays ?? [...defaultWeekdays]),
          { shouldDirty: true },
        );
        if (weeklyFromDaily) firstWeekly.current = false;
      } else if (next === 'weekly' && firstWeekly.current && getValues('weekdays').length === 0) {
        setValue('weekdays', [...defaultWeekdays], { shouldDirty: true });
        firstWeekly.current = false;
      }
      if (next === 'daily') clearErrors('weekdays');
      // 简单模式约定隐藏 cron 为空值；恢复空值让 RHF 按默认值重新计算 dirty。
      setValue('cron', '', { shouldDirty: true });
    }
    setValue('frequency', next, { shouldDirty: true });
  };

  const submit = handleSubmit((values) => {
    if (pending) return;
    const input = projectScheduleInput(values);
    if (schedule) {
      update.mutate({
        name: input.name,
        cron: input.cron,
        prompt: input.prompt,
        enabled: input.enabled,
        expectedUpdatedAt: baseline,
      });
    } else {
      create.mutate(input);
    }
  });

  // 任务已被删除时只有用户显式点「另存为新建」才把草稿建成新任务，不自动重发。
  const saveAsNew = handleSubmit((values) => {
    if (pending || !deleted) return;
    create.mutate(projectScheduleInput(values));
  });

  const primaryLabel = schedule
    ? pending
      ? '保存中…'
      : '保存更改'
    : pending
      ? '创建中…'
      : '创建任务';

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
      <DialogShell
        title={schedule ? '编辑定时任务' : '新建定时任务'}
        closeDisabled={pending}
        className="max-w-[1024px] sm:max-w-[1024px]"
      >
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 pb-4 text-sm">
            <p>
              {deleted
                ? '定时任务已被删除，当前草稿已保留。'
                : '定时任务已被修改，当前草稿已保留。加载最新版本会放弃此草稿。'}
            </p>
            {deleted ? (
              <Button variant="outline" size="sm" disabled={pending} onClick={saveAsNew}>
                另存为新建
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setConfirmReload(true)}
              >
                重新加载
              </Button>
            )}
          </div>
        ) : null}
        <form onSubmit={submit} className="@container flex flex-col" noValidate>
          <div className="grid grid-cols-1 gap-6 @min-[800px]:grid-cols-[minmax(0,1fr)_320px]">
            <FieldGroup className="gap-4">
              <Field
                className="gap-1.5"
                data-disabled={pending}
                data-invalid={Boolean(errors.name)}
              >
                <FieldLabel htmlFor="schedule-name" className="sr-only">
                  名称 <RequiredMark />
                </FieldLabel>
                <Input
                  {...register('name')}
                  value={watched.name}
                  id="schedule-name"
                  disabled={pending}
                  placeholder="任务名称"
                  className="border-transparent text-base font-medium md:text-base"
                  aria-required="true"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'schedule-name-error' : undefined}
                />
                <FieldError id="schedule-name-error">{errors.name?.message}</FieldError>
              </Field>

              <div className="flex flex-col gap-3">
                <Field
                  className="gap-1.5"
                  data-disabled={pending}
                  data-invalid={Boolean(errors.prompt)}
                >
                  <FieldLabel htmlFor="schedule-prompt">
                    任务内容 <RequiredMark />
                  </FieldLabel>
                  <Textarea
                    {...register('prompt')}
                    value={watched.prompt}
                    id="schedule-prompt"
                    disabled={pending}
                    rows={8}
                    className="min-h-40 border-transparent"
                    placeholder="希望专家定期完成什么？"
                    aria-required="true"
                    aria-invalid={Boolean(errors.prompt)}
                    aria-describedby={errors.prompt ? 'schedule-prompt-error' : undefined}
                  />
                  <FieldError id="schedule-prompt-error">{errors.prompt?.message}</FieldError>
                </Field>

                <Field
                  className="gap-1.5"
                  data-disabled={pending || Boolean(schedule)}
                  data-invalid={Boolean(errors.agentId)}
                >
                  <div className="flex items-center gap-3">
                    <FieldLabel htmlFor="schedule-agent">
                      执行专家 <RequiredMark />
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
                            className="max-w-60 min-w-0"
                            ref={field.ref}
                            onBlur={field.onBlur}
                            aria-invalid={Boolean(errors.agentId)}
                            aria-describedby={
                              [
                                schedule ? 'schedule-agent-hint' : null,
                                errors.agentId ? 'schedule-agent-error' : null,
                              ]
                                .filter(Boolean)
                                .join(' ') || undefined
                            }
                          >
                            <SelectValue placeholder="选择专家" />
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
                  </div>
                  {schedule ? (
                    <FieldDescription id="schedule-agent-hint">创建后不可更换</FieldDescription>
                  ) : null}
                  <FieldError id="schedule-agent-error">{errors.agentId?.message}</FieldError>
                </Field>
              </div>
            </FieldGroup>

            <FieldSet className="w-full gap-5 @min-[800px]:self-start @min-[800px]:border-l @min-[800px]:border-line @min-[800px]:pl-6">
              <FieldLegend className="mb-0 text-base font-medium leading-8">执行计划</FieldLegend>
              <FieldGroup className="gap-5">
                <div
                  className={cn(
                    'grid gap-3',
                    watched.frequency === 'custom' ? 'grid-cols-1' : 'grid-cols-2',
                  )}
                >
                  <Field className="min-w-0 gap-1.5" data-disabled={pending}>
                    <FieldLabel htmlFor="schedule-frequency">频率</FieldLabel>
                    <Controller
                      control={control}
                      name="frequency"
                      render={({ field }) => (
                        <Select
                          disabled={pending}
                          value={field.value}
                          items={frequencyOptions}
                          onValueChange={(next) => {
                            if (next === 'daily' || next === 'weekly' || next === 'custom') {
                              changeFrequency(next);
                            }
                          }}
                        >
                          <SelectTrigger
                            id="schedule-frequency"
                            className="w-full min-w-0"
                            ref={field.ref}
                            onBlur={field.onBlur}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {frequencyOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>

                  {watched.frequency !== 'custom' ? (
                    <Field
                      className="min-w-0 gap-1.5"
                      data-disabled={pending}
                      data-invalid={Boolean(errors.time)}
                    >
                      <FieldLabel htmlFor="schedule-time">
                        时间（UTC） <RequiredMark />
                      </FieldLabel>
                      <Input
                        {...register('time')}
                        value={watched.time}
                        id="schedule-time"
                        type="time"
                        disabled={pending}
                        aria-required="true"
                        aria-invalid={Boolean(errors.time)}
                        aria-describedby={errors.time ? 'schedule-time-error' : undefined}
                      />
                      <FieldError id="schedule-time-error">{errors.time?.message}</FieldError>
                    </Field>
                  ) : null}
                </div>

                {watched.frequency === 'weekly' ? (
                  <Field
                    className="gap-1.5"
                    data-disabled={pending}
                    data-invalid={Boolean(errors.weekdays)}
                  >
                    <FieldLabel id="schedule-weekdays-label">
                      星期 <RequiredMark />
                    </FieldLabel>
                    <Controller
                      control={control}
                      name="weekdays"
                      render={({ field }) => (
                        <ToggleGroup
                          ref={field.ref}
                          multiple
                          spacing={2}
                          tabIndex={-1}
                          value={field.value}
                          onValueChange={(next) => {
                            firstWeekly.current = false;
                            field.onChange(next);
                          }}
                          onBlur={field.onBlur}
                          disabled={pending}
                          aria-labelledby="schedule-weekdays-label"
                          aria-invalid={Boolean(errors.weekdays)}
                          aria-describedby={errors.weekdays ? 'schedule-weekdays-error' : undefined}
                          className="flex-wrap"
                        >
                          {weekdayOptions.map((day) => (
                            <ToggleGroupItem
                              key={day.value}
                              value={day.value}
                              aria-label={day.name}
                              className="w-8 min-w-8 px-0"
                            >
                              {day.label}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      )}
                    />
                    <FieldError id="schedule-weekdays-error">{errors.weekdays?.message}</FieldError>
                  </Field>
                ) : null}

                {watched.frequency === 'custom' ? (
                  <Field
                    className="min-w-0 gap-1.5"
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
                      aria-describedby={
                        errors.cron
                          ? 'schedule-cron-hint schedule-cron-error'
                          : 'schedule-cron-hint'
                      }
                    />
                    <FieldDescription id="schedule-cron-hint">
                      五段：分 时 日 月 周，按 UTC 解析；切换频率会替换此表达式。
                    </FieldDescription>
                    <FieldError id="schedule-cron-error">{errors.cron?.message}</FieldError>
                  </Field>
                ) : null}

                <Field
                  orientation="horizontal"
                  className="items-center gap-3"
                  data-disabled={pending}
                >
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
            </FieldSet>
          </div>

          <div className="sticky -bottom-4 z-10 -mx-5 -mb-4 mt-4 flex justify-end gap-2 rounded-b-xl border-t border-line bg-surface px-5 py-4">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" aria-busy={pending} disabled={pending}>
              {primaryLabel}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={confirmReload}
          onClose={() => {
            if (!pending) setConfirmReload(false);
          }}
          title="放弃草稿并加载最新版本？"
          description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
          confirmLabel="放弃并加载"
          confirmDisabled={pending}
          onConfirm={reload}
        />
        <ConfirmDialog
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          title="放弃未保存的更改？"
          description="关闭后这次填写的定时任务内容会丢失。"
          confirmLabel="放弃并关闭"
          confirmDisabled={pending}
          onConfirm={async () => {
            if (!pending) finish();
          }}
        />
        {/* 路由离开/刷新与弹层关闭共用同一确认文案；取消保留草稿，确认才真正离开。 */}
        <ConfirmDialog
          open={blocker.status === 'blocked'}
          onClose={() => blocker.reset?.()}
          title="放弃未保存的更改？"
          description={
            pending ? '正在保存，请等待请求完成。' : '离开后这次填写的定时任务内容会丢失。'
          }
          confirmLabel="放弃并离开"
          confirmDisabled={pending}
          onConfirm={async () => blocker.proceed()}
        />
      </DialogShell>
    </Dialog>
  );
}

export function AttentionPanel({ hideTitle = false }: { hideTitle?: boolean } = {}) {
  const attention = useAttention();
  const data = attention.data;

  return (
    <PageSection
      divided={false}
      {...(hideTitle ? {} : { title: '需要处理' })}
      actions={
        data && data.total > 0 ? <StatusBadge tone="danger">{data.total} 项</StatusBadge> : null
      }
    >
      {attention.isPending ? <LoadingState rows={2} /> : null}
      {attention.isError ? (
        <ErrorState error={attention.error} onRetry={() => void attention.refetch()} />
      ) : null}
      {data && data.total === 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-y py-5 text-sm">
          <span className="text-muted-foreground">没有等待批准的调用或失败的运行</span>
          <Link
            to="/runs"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'ml-auto')}
          >
            查看运行
          </Link>
        </div>
      ) : null}
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
