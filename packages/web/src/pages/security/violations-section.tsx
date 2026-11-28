import {
  type ViolationCase,
  type ViolationCaseStatus,
  violationCaseStatusSchema,
  violationCaseUpdateSchema,
} from '@agentport/shared';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { type ComponentProps, useCallback, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { CopyButton } from '../../components/copy-button.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { FilterSelect } from '../../components/filter-select.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import {
  ActiveFilterChips,
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { errorMessage } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { useSecurityViolations, useUpdateSecurityViolation } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import {
  SEVERITY_LABEL,
  SUBJECT_LABEL,
  VIOLATION_STATUS_ITEMS,
  VIOLATION_STATUS_LABEL,
  VIOLATION_STATUS_OPTIONS,
  violationSeverityTone,
  violationStatusTone,
} from './shared.js';

const VIOLATION_FORM_ID = 'security-violation-form';

const violationFormSchema = z.object({
  status: violationCaseStatusSchema,
  assigneeBusinessId: z.string().max(160),
  resolution: violationCaseUpdateSchema.shape.resolution.unwrap().unwrap(),
});

type ViolationFormValues = z.infer<typeof violationFormSchema>;

export function ViolationsSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const location = useLocation();
  const status = search.violationStatus ?? 'all';
  const violations = useSecurityViolations(status);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const snapshotRef = useRef<ViolationCase | null>(null);
  const rows = violations.data?.pages.flatMap((page) => page.items) ?? [];

  const liveViolation = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  if (liveViolation) snapshotRef.current = liveViolation;
  const activeViolation = liveViolation ?? snapshotRef.current;

  const backTo = `${location.pathname}${location.searchStr}`;

  const clearFilters = () => {
    void navigate({
      to: '/security',
      search: { ...search, violationStatus: undefined },
      replace: true,
    });
  };

  const activeFilters: EmptyFilterChip[] =
    status === 'all'
      ? []
      : [
          {
            key: 'violationStatus',
            label: '处置状态',
            value: VIOLATION_STATUS_LABEL[status],
            onRemove: clearFilters,
          },
        ];

  const isFilteredEmpty = Boolean(violations.data) && rows.length === 0 && activeFilters.length > 0;

  const openInspector = useCallback((violation: ViolationCase, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    snapshotRef.current = violation;
    setSelectedId(violation.id);
  }, []);

  const columns = useMemo<DataColumn<ViolationCase>[]>(
    () => [
      {
        id: 'createdAt',
        header: '时间',
        locked: true,
        width: '112px',
        sortValue: (violation) => violation.createdAt,
        cell: (violation) => (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(violation.createdAt)}
          >
            {formatRelative(violation.createdAt)}
          </span>
        ),
      },
      {
        id: 'policy',
        header: '策略',
        width: 'minmax(140px,1.2fr)',
        sortValue: (violation) => violation.policyName,
        cell: (violation) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
            title={violation.policyName}
          >
            {violation.policyName}
          </span>
        ),
      },
      {
        id: 'subject',
        header: '主体',
        width: 'minmax(120px,1fr)',
        cell: (violation) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{SUBJECT_LABEL[violation.subjectKind]}</span>
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={violation.subjectId}
            >
              {violation.subjectId}
            </span>
          </span>
        ),
      },
      {
        id: 'severity',
        header: '严重度',
        width: '76px',
        sortValue: (violation) => violation.severity,
        cell: (violation) => (
          <StatusBadge tone={violationSeverityTone(violation.severity)}>
            {SEVERITY_LABEL[violation.severity]}
          </StatusBadge>
        ),
      },
      {
        id: 'status',
        header: '状态',
        width: '88px',
        cell: (violation) => (
          <StatusBadge tone={violationStatusTone(violation.status)}>
            {VIOLATION_STATUS_LABEL[violation.status]}
          </StatusBadge>
        ),
      },
      {
        id: 'assignee',
        header: '负责人',
        width: 'minmax(100px,1fr)',
        hiddenByDefault: true,
        cell: (violation) =>
          violation.assigneeBusinessId ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg"
              title={violation.assigneeBusinessId}
            >
              {violation.assigneeBusinessId}
            </span>
          ) : (
            <span className="text-muted-foreground">未指派</span>
          ),
      },
      {
        id: 'summary',
        header: '摘要',
        width: 'minmax(160px,1.4fr)',
        hiddenByDefault: true,
        cell: (violation) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
            title={violation.summary}
          >
            {violation.summary}
          </span>
        ),
      },
      {
        id: 'resolution',
        header: '处置说明',
        width: 'minmax(160px,1.4fr)',
        hiddenByDefault: true,
        cell: (violation) =>
          violation.resolution ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
              title={violation.resolution}
            >
              {violation.resolution}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'runId',
        header: '运行',
        width: '96px',
        hiddenByDefault: true,
        cell: (violation) =>
          violation.runId ? (
            <code className="font-mono text-xs text-muted-foreground" title={violation.runId}>
              {shortId(violation.runId)}
            </code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '112px',
        hiddenByDefault: true,
        sortValue: (violation) => violation.updatedAt,
        cell: (violation) => (
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            title={formatDateTime(violation.updatedAt)}
          >
            {formatRelative(violation.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        width: '80px',
        align: 'end',
        cell: (violation) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`查看违规 ${violation.policyName} · ${violation.subjectId}`}
              onClick={(event) => openInspector(violation, event.currentTarget)}
            >
              查看
            </Button>
          </div>
        ),
      },
    ],
    [openInspector],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={status}
          onValueChange={(next) =>
            void navigate({
              to: '/security',
              search: {
                ...search,
                violationStatus: next === 'all' ? undefined : (next as ViolationCaseStatus),
              },
              replace: true,
            })
          }
          options={VIOLATION_STATUS_OPTIONS}
          label="按处置状态筛选"
          className="w-36"
        />
        <span role="status" className="ml-auto text-xs tabular-nums text-muted-foreground">
          {violations.isPending
            ? '加载中…'
            : violations.isError
              ? '数量不可用'
              : violations.hasNextPage
                ? `已加载 ${rows.length} 条违规`
                : `共 ${rows.length} 条违规`}
        </span>
      </div>

      {!isFilteredEmpty && activeFilters.length > 0 ? (
        <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
      ) : null}

      {violations.isPending ? <LoadingState rows={4} /> : null}
      {violations.isError ? (
        <ErrorState
          error={violations.error}
          onRetry={() => void violations.refetch()}
          title="违规记录没有加载出来"
        />
      ) : null}
      {violations.data && rows.length === 0 ? (
        status === 'all' ? (
          <EmptyState
            variant="clear"
            scale="section"
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="当前没有违规记录"
            description="严重违规会生成处置记录并跟踪处理结论。"
          />
        ) : (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配该状态的违规记录"
            activeFilters={activeFilters}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                清除全部筛选
              </Button>
            }
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(violation) => violation.id}
            rowLabel={(violation) => `${violation.policyName} · ${violation.subjectId}`}
            label="违规处置"
            storageKey="pace.security.violations-columns"
            hideRowCount
            onRowClick={openInspector}
          />
          <CursorListFooter
            query={violations}
            errorTitle="下一页加载失败，保留已加载的记录"
            showEndLabel
          />
        </>
      ) : null}

      {selectedId && activeViolation ? (
        <ViolationInspectorSheet
          key={selectedId}
          violation={activeViolation}
          canManage={canManage}
          backTo={backTo}
          finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
          onClosed={() => {
            setSelectedId(null);
            snapshotRef.current = null;
          }}
        />
      ) : null}
    </div>
  );
}

function ViolationInspectorSheet({
  violation,
  canManage,
  backTo,
  finalFocus,
  onClosed,
}: {
  violation: ViolationCase;
  canManage: boolean;
  backTo: string;
  finalFocus: ComponentProps<typeof InspectorSheet>['finalFocus'];
  onClosed: () => void;
}) {
  const sheet = useDialogClose(onClosed);
  const update = useUpdateSecurityViolation();
  const defaults: ViolationFormValues = {
    status: violation.status,
    assigneeBusinessId: violation.assigneeBusinessId ?? '',
    resolution: violation.resolution ?? '',
  };
  const { register, control, handleSubmit, formState } = useZodForm(violationFormSchema, {
    defaultValues: defaults,
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = update.isPending && !saved;
  const dirty = canManage && !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, sheet.close);

  const submit = handleSubmit(
    async (values) => {
      if (!canManage || pending) return;
      setError(null);
      try {
        await update.mutateAsync({
          id: violation.id,
          input: {
            status: values.status,
            assigneeBusinessId: values.assigneeBusinessId.trim() || null,
            resolution: values.resolution.trim() || null,
          },
        });
        toastSuccess('处置已保存');
        setSaved(true);
        guard.finish();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    () => setError(null),
  );

  return (
    <>
      <InspectorSheet
        open={sheet.open}
        onOpenChange={(next) => {
          if (!next) guard.close();
        }}
        onOpenChangeComplete={sheet.onOpenChangeComplete}
        size="md"
        title={violation.policyName}
        eyebrow={
          <div className="flex items-center gap-1.5">
            <StatusBadge tone={violationSeverityTone(violation.severity)}>
              {SEVERITY_LABEL[violation.severity]}
            </StatusBadge>
            <StatusBadge tone={violationStatusTone(violation.status)}>
              {VIOLATION_STATUS_LABEL[violation.status]}
            </StatusBadge>
          </div>
        }
        description={`${SUBJECT_LABEL[violation.subjectKind]} · ${violation.subjectId}`}
        closeDisabled={pending}
        finalFocus={finalFocus}
        footer={
          canManage ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={guard.close}
              >
                取消
              </Button>
              <Button
                type="submit"
                form={VIOLATION_FORM_ID}
                size="sm"
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? '正在保存…' : '保存处置'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-fg">违规信息</h2>
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
              <dt className="text-muted-foreground">状态</dt>
              <dd>
                <StatusBadge tone={violationStatusTone(violation.status)}>
                  {VIOLATION_STATUS_LABEL[violation.status]}
                </StatusBadge>
              </dd>
              <dt className="text-muted-foreground">严重度</dt>
              <dd>
                <StatusBadge tone={violationSeverityTone(violation.severity)}>
                  {SEVERITY_LABEL[violation.severity]}
                </StatusBadge>
              </dd>
              <dt className="text-muted-foreground">主体</dt>
              <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                {SUBJECT_LABEL[violation.subjectKind]}
                <span className="ml-2 font-mono text-muted-foreground">{violation.subjectId}</span>
              </dd>
              <dt className="text-muted-foreground">负责人</dt>
              <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
                {violation.assigneeBusinessId ? (
                  <span className="font-mono">{violation.assigneeBusinessId}</span>
                ) : (
                  <span className="text-muted-foreground">未指派</span>
                )}
              </dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd className="min-w-0 font-mono tabular-nums text-fg">
                {formatDateTime(violation.createdAt)}
              </dd>
              <dt className="text-muted-foreground">更新时间</dt>
              <dd className="min-w-0 font-mono tabular-nums text-fg">
                {formatDateTime(violation.updatedAt)}
              </dd>
              <dt className="text-muted-foreground">记录 ID</dt>
              <dd className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                  {violation.id}
                </span>
                <CopyButton
                  value={violation.id}
                  label="复制记录 ID"
                  className="-my-1 -mr-1.5 shrink-0"
                />
              </dd>
              {violation.eventId ? (
                <>
                  <dt className="text-muted-foreground">关联事件</dt>
                  <dd className="flex min-w-0 items-start justify-between gap-2">
                    <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                      {violation.eventId}
                    </span>
                    <CopyButton
                      value={violation.eventId}
                      label="复制事件 ID"
                      className="-my-1 -mr-1.5 shrink-0"
                    />
                  </dd>
                </>
              ) : null}
              {violation.runId ? (
                <>
                  <dt className="text-muted-foreground">关联运行</dt>
                  <dd className="flex min-w-0 items-start justify-between gap-2">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: violation.runId }}
                      search={{ backTo }}
                      className="inline-flex min-w-0 items-center gap-1 font-mono text-link underline underline-offset-4 hover:text-fg"
                    >
                      <span className="[overflow-wrap:anywhere]">{violation.runId}</span>
                      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
                    </Link>
                    <CopyButton
                      value={violation.runId}
                      label="复制运行 ID"
                      className="-my-1 -mr-1.5 shrink-0"
                    />
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          <section className="flex flex-col gap-2 border-t border-line pt-5">
            <h2 className="text-sm font-medium text-fg">违规摘要</h2>
            <p className="rounded-item border border-line bg-sunken p-3 text-sm leading-6 text-fg [overflow-wrap:anywhere]">
              {violation.summary}
            </p>
          </section>

          {canManage ? (
            <section className="flex flex-col gap-3 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">处置更新</h2>
              <form
                id={VIOLATION_FORM_ID}
                aria-label="违规处置"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <FieldGroup className="gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field data-invalid={Boolean(errors.status)} data-disabled={pending}>
                      <FieldLabel htmlFor="violation-status">状态</FieldLabel>
                      <Controller
                        control={control}
                        name="status"
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            items={VIOLATION_STATUS_ITEMS}
                            onValueChange={field.onChange}
                            disabled={pending}
                          >
                            <SelectTrigger
                              id="violation-status"
                              className="w-full min-w-0"
                              ref={field.ref}
                              onBlur={field.onBlur}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {VIOLATION_STATUS_ITEMS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <FieldError>{errors.status?.message}</FieldError>
                    </Field>
                    <Field
                      data-invalid={Boolean(errors.assigneeBusinessId)}
                      data-disabled={pending}
                    >
                      <FieldLabel htmlFor="violation-assignee">负责人</FieldLabel>
                      <Input
                        id="violation-assignee"
                        autoComplete="off"
                        placeholder="业务 ID"
                        disabled={pending}
                        aria-invalid={Boolean(errors.assigneeBusinessId)}
                        aria-describedby={
                          errors.assigneeBusinessId ? 'violation-assignee-error' : undefined
                        }
                        {...register('assigneeBusinessId')}
                      />
                      <FieldError id="violation-assignee-error">
                        {errors.assigneeBusinessId?.message}
                      </FieldError>
                    </Field>
                  </div>
                  <Field data-invalid={Boolean(errors.resolution)} data-disabled={pending}>
                    <FieldLabel htmlFor="violation-resolution">处置说明</FieldLabel>
                    <Textarea
                      id="violation-resolution"
                      rows={4}
                      maxLength={1000}
                      placeholder="记录核查过程与最终处理结论…"
                      disabled={pending}
                      aria-invalid={Boolean(errors.resolution)}
                      aria-describedby={
                        errors.resolution ? 'violation-resolution-error' : undefined
                      }
                      {...register('resolution')}
                    />
                    <FieldError id="violation-resolution-error">
                      {errors.resolution?.message}
                    </FieldError>
                  </Field>
                  <FieldError>{error ?? undefined}</FieldError>
                </FieldGroup>
              </form>
            </section>
          ) : (
            <section className="flex flex-col gap-2 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">处置说明</h2>
              {violation.resolution ? (
                <p className="rounded-item border border-line bg-sunken p-3 text-sm leading-6 text-fg [overflow-wrap:anywhere]">
                  {violation.resolution}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">暂无处置说明</p>
              )}
            </section>
          )}
        </div>
      </InspectorSheet>
      <DraftGuardDialogs guard={guard} draft="填写的处置内容会丢失。" pending={pending} />
    </>
  );
}
