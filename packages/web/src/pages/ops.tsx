import {
  type AgentSummary,
  type CursorPage,
  DEFAULT_TIMEZONE,
  type Schedule,
  type ScheduleInput,
  scheduleInputSchema,
  scheduleMissedPolicySchema,
} from '@agentport/shared';
import { type InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { Clock, History, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { AgentPicker } from '../components/agent/agent-picker.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../components/page.js';
import { RecordRows } from '../components/record-rows.js';
import { RequiredMark } from '../components/required-mark.js';
import { RunStatusBadge } from '../components/run/run-status-badge.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';

import { Button } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { Textarea } from '../components/ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { ApiError, api, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { fieldErrors } from '../lib/form.js';
import { formatCost, formatDuration, formatRelative, formatZonedDateTime } from '../lib/format.js';
import {
  meQuery,
  opsKeys,
  scheduleRunsQuery,
  useAgentsTruncated,
  useExperts,
  useScheduleRuns,
  useSchedules,
} from '../lib/queries.js';
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

const timeZoneOptions = [...Intl.supportedValuesOf('timeZone')]
  .sort()
  .map((value) => ({ value, label: value }));
const knownTimeZones = new Set(timeZoneOptions.map((option) => option.value));

const missedPolicyOptions = [
  { value: 'skip', label: '跳过' },
  { value: 'run_once', label: '补跑一次' },
] as const;

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
  timezone: DEFAULT_TIMEZONE,
  missedPolicy: 'skip',
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
    cron: decoded ? '' : schedule.cron,
    timezone: schedule.timezone,
    missedPolicy: schedule.missedPolicy,
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
    timezone: values.timezone,
    missedPolicy: values.missedPolicy,
    prompt: values.prompt,
    enabled: values.enabled,
  };
}

const scheduleFormSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    cron: z.string(),
    timezone: z.string(),
    missedPolicy: scheduleMissedPolicySchema,
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
    const parsed = scheduleInputSchema.safeParse({
      agentId: values.agentId,
      name: values.name,
      cron: generated,
      timezone: values.timezone,
      missedPolicy: values.missedPolicy,
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
  const navigate = useNavigate();
  const search = useSearch({ from: '/_shell/schedules' });
  const view: ListView = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({ to: '/schedules', search: { ...search, view: next }, replace: true });
  };
  const schedules = useSchedules();
  const agents = useExperts();
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'schedules.manage');
  const agentsError = agents.isError ? agents.error : null;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [historyOf, setHistoryOf] = useState<Schedule | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const deletedRef = useRef(false);
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: opsKeys.schedules });
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: opsKeys.schedules });
      const prev = client.getQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules);
      if (prev) {
        client.setQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules, (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  items: page.items.map((s) =>
                    s.id === vars.id ? { ...s, enabled: vars.enabled } : s,
                  ),
                })),
              }
            : old,
        );
      }
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        client.setQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules, ctx.prev);
      }
      toastError(error);
    },
    onSuccess: (_schedule, vars) => {
      toastSuccess(vars.enabled ? '定时任务已启用' : '定时任务已暂停');
    },
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => toastSuccess('定时任务已删除'),
    onError: toastError,
    onSettled: invalidate,
  });

  const items = schedules.data?.pages.flatMap((page) => page.items) ?? [];
  const rowBusy = toggle.isPending || remove.isPending || !canManage;

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="定时任务"
          {...(items.length > 0
            ? {
                description: schedules.hasNextPage
                  ? `已加载 ${items.length} 个定时任务`
                  : `共 ${items.length} 个定时任务`,
              }
            : {})}
          actions={
            <>
              {items.length > 0 ? <ViewToggle value={view} onChange={setView} /> : null}
              {canManage ? (
                <Button ref={createButtonRef} onClick={() => setCreating(true)}>
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建定时任务
                </Button>
              ) : null}
            </>
          }
        />
      </PageTopbar>

      <PageBody>
        {schedules.isPending ? (
          <LoadingState rows={3} layout={view === 'cards' ? 'cards' : 'rows'} />
        ) : null}
        {schedules.isError && !schedules.data ? (
          <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
        ) : null}
        {schedules.isError && schedules.data ? (
          <PageNote
            tone="danger"
            title="刷新失败，已保留上次列表"
            description={errorMessage(schedules.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void schedules.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {schedules.data && items.length === 0 ? (
          <EmptyState
            variant="stage"
            scale="page"
            specimen="schedules"
            title="还没有定时任务"
            description="按计划自动触发专家运行，结果会沉淀到运行记录。"
            action={
              canManage ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  新建定时任务
                </Button>
              ) : undefined
            }
            footer={
              !canManage ? (
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="size-3.5" aria-hidden="true" />
                  当前账户没有管理定时任务的权限，请联系管理员配置。
                </span>
              ) : undefined
            }
          />
        ) : null}

        {items.length > 0 && view === 'cards' ? (
          <ul
            aria-label="定时任务列表"
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 pt-2"
          >
            {items.map((schedule) => {
              const nextDue =
                schedule.enabled || schedule.nextDueAt
                  ? formatZonedDateTime(schedule.nextDueAt, schedule.timezone)
                  : '未安排';
              return (
                <li key={schedule.id} className="min-w-0">
                  <ScheduleCard
                    schedule={schedule}
                    nextDue={nextDue}
                    busy={rowBusy}
                    onHistory={() => setHistoryOf(schedule)}
                    onToggle={(enabled) => {
                      if (rowBusy) return;
                      toggle.mutate({ id: schedule.id, enabled });
                    }}
                    onEdit={() => {
                      if (rowBusy) return;
                      setEditing(schedule);
                    }}
                    onDelete={() => {
                      if (rowBusy) return;
                      deletedRef.current = false;
                      setDeleting(schedule);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}

        {items.length > 0 && view === 'table' ? (
          <PageSection divided={false}>
            <Table>
              <caption className="sr-only">定时任务列表</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-[34%]">
                    名称
                  </TableHead>
                  <TableHead scope="col" className="hidden w-[16%] sm:table-cell">
                    执行计划
                  </TableHead>
                  <TableHead scope="col" className="hidden w-[18%] sm:table-cell">
                    下次触发
                  </TableHead>
                  <TableHead scope="col" className="hidden w-[16%] sm:table-cell">
                    上次触发
                  </TableHead>
                  <TableHead scope="col" className="w-[16%] text-right">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((schedule) => {
                  const nextDue =
                    schedule.enabled || schedule.nextDueAt
                      ? formatZonedDateTime(schedule.nextDueAt, schedule.timezone)
                      : '未安排';
                  return (
                    <TableRow key={schedule.id}>
                      <TableHead scope="row" className="h-auto min-w-0 py-2 font-normal text-fg">
                        <span className="block truncate text-sm font-medium text-fg">
                          {schedule.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {schedule.agentName ?? '已删除的专家'}
                        </span>
                        <span className="block text-xs text-muted-foreground sm:hidden">
                          {schedule.description}（{schedule.timezone}） · 下次 {nextDue} · 上次触发{' '}
                          {formatRelative(schedule.lastRunAt)}
                        </span>
                      </TableHead>
                      <TableCell className="hidden sm:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {schedule.description}（{schedule.timezone}）
                        </span>
                      </TableCell>
                      <TableCell className="hidden text-xs tabular-nums text-muted-foreground sm:table-cell">
                        {nextDue}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {formatRelative(schedule.lastRunAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`执行历史 ${schedule.name}`}
                            onClick={() => setHistoryOf(schedule)}
                          >
                            <History />
                          </Button>
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
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </PageSection>
        ) : null}

        {schedules.isFetchNextPageError ? (
          <PageNote
            tone="danger"
            title="更多定时任务没有加载出来"
            action={
              <Button variant="outline" size="sm" onClick={() => void schedules.fetchNextPage()}>
                重试
              </Button>
            }
          />
        ) : schedules.hasNextPage ? (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={schedules.isFetchingNextPage}
              aria-busy={schedules.isFetchingNextPage}
              onClick={() => void schedules.fetchNextPage()}
            >
              {schedules.isFetchingNextPage ? '加载中…' : '加载更多'}
            </Button>
          </div>
        ) : null}
      </PageBody>

      {creating ? (
        <ScheduleDialog
          agents={agents.data ?? []}
          agentsError={agentsError}
          onRetryAgents={() => void agents.refetch()}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <ScheduleDialog
          schedule={editing}
          agents={agents.data ?? []}
          agentsError={agentsError}
          onRetryAgents={() => void agents.refetch()}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {historyOf ? (
        <ScheduleRunsDialog
          schedule={historyOf}
          canManage={canManage}
          onClose={() => setHistoryOf(null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除定时任务"
          description={`将删除「${deleting.name}」，之后不再按计划自动运行。`}
          onClose={() => setDeleting(null)}
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

function ScheduleCard({
  schedule,
  nextDue,
  busy,
  onToggle,
  onHistory,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  nextDue: string;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onHistory: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0">
          <h2 className="truncate" title={schedule.name}>
            {schedule.name}
          </h2>
        </CardTitle>
        <CardDescription className="truncate text-xs" title={schedule.agentName ?? '已删除的专家'}>
          {schedule.agentName ?? '已删除的专家'}
        </CardDescription>
        <CardAction>
          <Switch
            size="sm"
            checked={schedule.enabled}
            disabled={busy}
            aria-label={`${schedule.enabled ? '暂停' : '启用'} ${schedule.name}`}
            onCheckedChange={onToggle}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <RecordRows
          rows={[
            {
              label: '执行计划',
              value: `${schedule.description}（${schedule.timezone}）`,
            },
            { label: '下次触发', value: nextDue },
            { label: '上次触发', value: formatRelative(schedule.lastRunAt) },
          ]}
        />
      </CardContent>
      <CardFooter className="justify-end gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`执行历史 ${schedule.name}`}
          onClick={onHistory}
        >
          <History />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`编辑 ${schedule.name}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`删除 ${schedule.name}`}
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </CardFooter>
    </Card>
  );
}

function ScheduleRunsDialog({
  schedule,
  canManage,
  onClose: onClosed,
}: {
  schedule: Schedule;
  canManage: boolean;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const location = useLocation();
  const client = useQueryClient();
  const runs = useScheduleRuns(schedule.id);
  const retry = useMutation({
    mutationFn: (runId: string) => api.retryScheduleRun(schedule.id, runId),
    onSuccess: () => toastSuccess('已重新排队执行'),
    onError: toastError,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: scheduleRunsQuery(schedule.id).queryKey });
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(false, dialog.close)}
    >
      <DialogShell
        title="执行历史"
        description={`${schedule.name} · ${schedule.description}（${schedule.timezone}）`}
        className="max-w-215 sm:max-w-215"
      >
        {runs.isPending ? <LoadingState rows={3} /> : null}
        {runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : null}
        {runs.data && runs.data.length === 0 ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<Clock className="size-4" aria-hidden="true" />}
            title="还没有触发执行过"
            description="到达下一次计划时间后，运行记录会显示在这里。"
          />
        ) : null}
        {runs.data && runs.data.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{schedule.name} 的执行历史</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">状态</TableHead>
                  <TableHead scope="col">开始时间</TableHead>
                  <TableHead scope="col">结束时间</TableHead>
                  <TableHead scope="col">耗时</TableHead>
                  <TableHead scope="col" className="w-[32%]">
                    失败原因
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((run) => {
                  const retryable =
                    canManage &&
                    schedule.enabled &&
                    (run.status === 'failed' || run.status === 'timeout');
                  return (
                    <TableRow key={run.id}>
                      <TableCell>
                        <RunStatusBadge status={run.status} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatZonedDateTime(run.startedAt ?? run.createdAt, schedule.timezone)}
                        {run.startedAt ? null : <span className="ml-1 text-2xs">创建</span>}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatZonedDateTime(run.endedAt, schedule.timezone)}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatDuration(run.latencyMs)}
                        {run.costUsd !== null ? (
                          <span className="block text-2xs">{formatCost(run.costUsd)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <span className="block max-w-64 truncate" title={run.error ?? undefined}>
                          {run.error ?? '—'}
                        </span>
                        {run.errorKind !== null ? (
                          <span className="block text-2xs">{run.errorKind}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          {retryable ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={retry.isPending}
                              aria-label={`重试 ${run.id}`}
                              onClick={() => retry.mutate(run.id)}
                            >
                              重试
                            </Button>
                          ) : null}
                          <Link
                            to="/runs/$runId"
                            params={{ runId: run.id }}
                            search={{ backTo: location.href }}
                            className="text-xs text-[var(--color-link)] underline underline-offset-2"
                          >
                            查看
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}

function ScheduleDialog({
  schedule,
  agents,
  agentsError,
  onRetryAgents,
  onClose: onClosed,
}: {
  schedule?: Schedule;
  agents: AgentSummary[];
  agentsError: unknown;
  onRetryAgents: () => void;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const client = useQueryClient();
  const agentsTruncated = useAgentsTruncated().data ?? false;
  const [confirmReload, setConfirmReload] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
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
  const firstWeekly = useRef(true);
  const { errors, isDirty } = formState;
  const watched = watch();
  const dirty = isDirty;
  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: opsKeys.schedules });
  };
  const create = useMutation({
    mutationFn: (input: ScheduleInput) => api.createSchedule(input),
    onSuccess: () => {
      toastSuccess('定时任务已创建');
      guard.finish();
    },
    onError: toastError,
    onSettled: invalidate,
  });
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateSchedule>[1]) =>
      api.updateSchedule(schedule?.id ?? '', input),
    onSuccess: () => {
      toastSuccess('定时任务已更新');
      guard.finish();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        setConflict(true);
        toastError(new Error('定时任务已被修改；当前草稿已保留，请加载最新版本后重新编辑。'));
        return;
      }
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
      await client.refetchQueries({ queryKey: opsKeys.schedules }, { throwOnError: true });
      const latest = client
        .getQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules)
        ?.pages.flatMap((page) => page.items)
        .find((item) => item.id === schedule.id);
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
      setReloadError(null);
    } finally {
      setReloading(false);
    }
  };
  const guard = useDraftGuard(dirty, pending, onClose);

  const selectedAgent = agents.find((agent) => agent.id === watched.agentId);
  const timeZoneChoices =
    watched.timezone && !knownTimeZones.has(watched.timezone)
      ? [{ value: watched.timezone, label: watched.timezone }, ...timeZoneOptions]
      : timeZoneOptions;
  const agentOptions = [
    ...(schedule && !agents.some((agent) => agent.id === schedule.agentId)
      ? [{ value: schedule.agentId, label: schedule.agentName ?? '已删除的专家' }]
      : []),
    ...agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      agent,
    })),
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
        timezone: input.timezone,
        missedPolicy: input.missedPolicy,
        prompt: input.prompt,
        enabled: input.enabled,
        expectedUpdatedAt: baseline,
      });
    } else {
      create.mutate(input);
    }
  });

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
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={schedule ? '编辑定时任务' : '新建定时任务'}
        closeDisabled={pending}
        className="max-w-256 sm:max-w-256"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={guard.close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" form="schedule-form" aria-busy={pending} disabled={pending}>
              {primaryLabel}
            </Button>
          </div>
        }
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
                onClick={() => {
                  setConfirmReload(true);
                  setReloadError(null);
                }}
              >
                重新加载
              </Button>
            )}
          </div>
        ) : null}
        {agentsError ? (
          <div className="pb-4">
            <ErrorState error={agentsError} onRetry={onRetryAgents} title="专家列表没有加载出来" />
          </div>
        ) : null}
        <form id="schedule-form" onSubmit={submit} className="@container flex flex-col" noValidate>
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
                  className="-mx-2.5 w-[calc(100%+1.25rem)]! border-transparent text-base font-medium md:text-base"
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
                    className="-mx-2.5 min-h-40 w-[calc(100%+1.25rem)]! border-transparent"
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
                        <AgentPicker
                          triggerVariant="field"
                          agent={selectedAgent ?? null}
                          agentId={field.value}
                          agentOptions={agentOptions}
                          truncated={agentsTruncated}
                          onSwitchAgent={(id) => field.onChange(id)}
                          triggerRef={field.ref}
                          onBlur={field.onBlur}
                          placeholder="选择专家"
                          triggerId="schedule-agent"
                          triggerAriaLabel="执行专家"
                          triggerClassName="max-w-60 min-w-0"
                          disabled={pending || Boolean(schedule)}
                          ariaInvalid={Boolean(errors.agentId)}
                          ariaDescribedby={
                            [
                              schedule ? 'schedule-agent-hint' : null,
                              errors.agentId ? 'schedule-agent-error' : null,
                            ]
                              .filter(Boolean)
                              .join(' ') || undefined
                          }
                        />
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
              <FieldLegend className="mb-0 flex h-8 items-center text-base font-medium">
                执行计划
              </FieldLegend>
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
                        时间 <RequiredMark />
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

                <div className="grid grid-cols-2 gap-3">
                  <Field
                    className="min-w-0 gap-1.5"
                    data-disabled={pending}
                    data-invalid={Boolean(errors.timezone)}
                  >
                    <FieldLabel htmlFor="schedule-timezone">时区</FieldLabel>
                    <Controller
                      control={control}
                      name="timezone"
                      render={({ field }) => (
                        <Select
                          disabled={pending}
                          value={field.value}
                          items={timeZoneChoices}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger
                            id="schedule-timezone"
                            className="w-full min-w-0"
                            ref={field.ref}
                            onBlur={field.onBlur}
                            aria-invalid={Boolean(errors.timezone)}
                            aria-describedby={
                              errors.timezone ? 'schedule-timezone-error' : undefined
                            }
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {timeZoneChoices.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError id="schedule-timezone-error">{errors.timezone?.message}</FieldError>
                  </Field>

                  <Field className="min-w-0 gap-1.5" data-disabled={pending}>
                    <FieldLabel htmlFor="schedule-missed-policy">错过触发</FieldLabel>
                    <Controller
                      control={control}
                      name="missedPolicy"
                      render={({ field }) => (
                        <Select
                          disabled={pending}
                          value={field.value}
                          items={[...missedPolicyOptions]}
                          onValueChange={(next) => {
                            if (next === 'skip' || next === 'run_once') field.onChange(next);
                          }}
                        >
                          <SelectTrigger
                            id="schedule-missed-policy"
                            className="w-full min-w-0"
                            ref={field.ref}
                            onBlur={field.onBlur}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {missedPolicyOptions.map((option) => (
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
                      五段：分 时 日 月 周，按任务时区解析；切换频率会替换此表达式。
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
        </form>
        <ConfirmDialog
          open={confirmReload}
          onClose={() => {
            if (!pending) {
              setConfirmReload(false);
              setReloadError(null);
            }
          }}
          title="放弃草稿并加载最新版本？"
          description="当前未保存的更改会丢失。加载失败时会保留当前草稿。"
          confirmLabel="放弃并加载"
          confirmDisabled={pending}
          onConfirm={reload}
          onError={(error) => setReloadError(errorMessage(error))}
        >
          {reloadError ? <FieldError>{reloadError}</FieldError> : null}
        </ConfirmDialog>
        <DraftGuardDialogs guard={guard} draft="这次填写的定时任务内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
