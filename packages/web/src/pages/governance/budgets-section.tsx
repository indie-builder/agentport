import {
  type BudgetInput,
  type BudgetMetric,
  type BudgetScopeKind,
  type BudgetStatus,
  budgetInputSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { type RefObject, useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { RequiredMark } from '../../components/required-mark.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
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
import { Progress, ProgressIndicator, ProgressTrack } from '../../components/ui/progress.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatCost, formatDateTime, formatPercent } from '../../lib/format.js';
import {
  agentsQuery,
  useBudgets,
  useDeleteBudget,
  useDepartments,
  useGovernanceResources,
  useUpsertBudget,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { AccountCombobox } from './account-combobox.js';

const BUDGET_FORM_ID = 'governance-budget-form';

const SCOPE_KIND_LABEL: Record<BudgetScopeKind, string> = {
  user: '用户',
  department: '部门',
  agent: '专家',
  knowledge_base: '知识库',
  data_domain: '数据域',
};

const METRIC_LABEL: Record<BudgetMetric, string> = {
  cost_usd_month: '月度成本',
  documents: '文档数',
  queries_month: '月度查询',
};

const METRIC_BY_SCOPE: Record<BudgetScopeKind, BudgetMetric> = {
  user: 'cost_usd_month',
  department: 'cost_usd_month',
  agent: 'cost_usd_month',
  knowledge_base: 'documents',
  data_domain: 'queries_month',
};

const METRIC_HINT: Record<BudgetMetric, string> = {
  cost_usd_month: '按 UTC 自然月已结算成本统计，不预占在途成本。',
  documents: '按该知识库当前文档数统计。',
  queries_month: '按数据域当月查询日志条数统计。',
};

type ScopeOption = { value: string; label: string };

function formatMetric(metric: BudgetMetric, value: number): string {
  if (metric === 'cost_usd_month') return formatCost(value);
  if (metric === 'documents') return `${value} 篇`;
  return `${value} 次`;
}

export function BudgetsSection({
  canManage,
  creating,
  onCreatingChange,
  createButtonRef,
}: {
  canManage: boolean;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
  createButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
}) {
  const budgets = useBudgets();
  const remove = useDeleteBudget();
  const [editing, setEditing] = useState<BudgetStatus | null>(null);
  const [deleting, setDeleting] = useState<BudgetStatus | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const rows = budgets.data ?? [];

  const columns = useMemo<DataColumn<BudgetStatus>[]>(() => {
    const base: DataColumn<BudgetStatus>[] = [
      {
        id: 'scope',
        header: '范围',
        locked: true,
        width: 'minmax(180px,1.5fr)',
        sortValue: (budget) => budget.scopeName,
        cell: (budget) => (
          <div className="min-w-0">
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
              title={budget.scopeName}
            >
              {budget.scopeName}
            </span>
            <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
              {SCOPE_KIND_LABEL[budget.scopeKind]}
            </span>
          </div>
        ),
      },
      {
        id: 'metric',
        header: '指标',
        width: '104px',
        sortValue: (budget) => METRIC_LABEL[budget.metric],
        cell: (budget) => (
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
            {METRIC_LABEL[budget.metric]}
          </span>
        ),
      },
      {
        id: 'usage',
        header: '已用 / 上限',
        width: 'minmax(200px,1.5fr)',
        sortValue: (budget) =>
          budget.limitValue > 0 ? budget.used / budget.limitValue : budget.used > 0 ? 1 : 0,
        cell: (budget) => {
          const ratio = budget.limitValue > 0 ? budget.used / budget.limitValue : 1;
          const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
          const exceeded = budget.enabled && budget.used >= budget.limitValue;
          const near = budget.enabled && !exceeded && ratio >= budget.alertRatio;
          return (
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs tabular-nums text-fg">
                  {formatMetric(budget.metric, budget.used)} /{' '}
                  {formatMetric(budget.metric, budget.limitValue)}
                </span>
                {exceeded || near ? (
                  <StatusBadge tone={exceeded ? 'danger' : 'warn'} className="shrink-0">
                    {exceeded ? '已超限' : '接近阈值'}
                  </StatusBadge>
                ) : null}
              </div>
              <Progress
                value={percent}
                aria-label={`${budget.scopeName} 用量 ${percent}%`}
                className="gap-0"
              >
                <ProgressTrack>
                  <ProgressIndicator
                    className={cn(exceeded ? 'bg-danger' : near ? 'bg-warning' : 'bg-fg')}
                  />
                </ProgressTrack>
              </Progress>
            </div>
          );
        },
      },
      {
        id: 'alertRatio',
        header: '提醒阈值',
        numeric: true,
        width: '92px',
        sortValue: (budget) => budget.alertRatio,
        cell: (budget) => formatPercent(budget.alertRatio),
      },
      {
        id: 'enabled',
        header: '状态',
        width: '84px',
        sortValue: (budget) => (budget.enabled ? 1 : 0),
        cell: (budget) => (
          <StatusBadge tone={budget.enabled ? 'success' : 'default'}>
            {budget.enabled ? '启用' : '停用'}
          </StatusBadge>
        ),
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '128px',
        sortValue: (budget) => budget.updatedAt,
        cell: (budget) => (
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {formatDateTime(budget.updatedAt)}
          </span>
        ),
      },
    ];

    if (canManage) {
      base.push({
        id: 'actions',
        header: '操作',
        locked: true,
        align: 'end',
        width: '48px',
        cell: (budget) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="更多操作"
                  onFocus={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                  onPointerDown={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                  onClick={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                >
                  <EllipsisVertical aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(budget)}>
                <Pencil aria-hidden="true" />
                编辑
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(budget)}>
                <Trash2 aria-hidden="true" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      });
    }

    return base;
  }, [canManage]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {budgets.isPending ? <LoadingState rows={4} /> : null}
      {budgets.isError ? (
        <ErrorState error={budgets.error} onRetry={() => void budgets.refetch()} />
      ) : null}
      {budgets.data && rows.length === 0 ? (
        <EmptyState
          variant="stage"
          scale="section"
          specimen="governance"
          title="设置成本预算与提醒"
          description="为个人、部门、专家或知识库配置上限，接近阈值时自动通知。"
          action={
            canManage ? (
              <Button variant="outline" size="sm" onClick={() => onCreatingChange(true)}>
                新建预算
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(budget) => budget.id}
          rowLabel={(budget) => budget.scopeName}
          label="预算列表"
          storageKey="pace.governance.budgets-columns"
        />
      ) : null}
      <CursorListFooter className="pt-2" query={budgets} label="预算" />

      {creating ? (
        <BudgetSheet
          onClose={() => onCreatingChange(false)}
          {...(createButtonRef
            ? {
                finalFocus: () =>
                  createButtonRef.current?.isConnected ? createButtonRef.current : null,
              }
            : {})}
        />
      ) : null}
      {editing ? (
        <BudgetSheet
          budget={editing}
          onClose={() => setEditing(null)}
          finalFocus={() => (menuTriggerRef.current?.isConnected ? menuTriggerRef.current : null)}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除预算"
          description={`删除后「${deleting.scopeName}」不再按此上限提醒。`}
          finalFocus={() => (menuTriggerRef.current?.isConnected ? menuTriggerRef.current : null)}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('预算已删除');
          }}
        />
      ) : null}
    </div>
  );
}

const budgetFormSchema = budgetInputSchema
  .pick({ scopeKind: true, scopeId: true, limitValue: true, alertRatio: true, enabled: true })
  .extend({ scopeId: z.string().min(1, '请选择范围。') });

type BudgetFormValues = z.infer<typeof budgetFormSchema>;

function BudgetSheet({
  budget,
  onClose: onClosed,
  finalFocus,
}: {
  budget?: BudgetStatus | undefined;
  onClose: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const dialog = useDialogClose(onClosed);
  const upsert = useUpsertBudget();
  const defaults: BudgetFormValues = budget
    ? {
        scopeKind: budget.scopeKind,
        scopeId: budget.scopeId,
        limitValue: budget.limitValue,
        alertRatio: budget.alertRatio,
        enabled: budget.enabled,
      }
    : {
        scopeKind: 'user',
        scopeId: '',
        limitValue: 0,
        alertRatio: 0.8,
        enabled: true,
      };
  const { control, handleSubmit, watch, setValue, formState } = useZodForm(budgetFormSchema, {
    defaultValues: defaults,
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = upsert.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, dialog.close);
  const scopeKind = watch('scopeKind');
  const scopeId = watch('scopeId');
  const metric = METRIC_BY_SCOPE[scopeKind];

  const editable = !budget;
  const departments = useDepartments(editable && scopeKind === 'department');
  const agents = useQuery({ ...agentsQuery, enabled: editable && scopeKind === 'agent' });
  const knowledgeBases = useGovernanceResources(
    'knowledge_base',
    '',
    editable && scopeKind === 'knowledge_base',
  );
  const dataDomains = useGovernanceResources(
    'data_domain',
    '',
    editable && scopeKind === 'data_domain',
  );

  const options: ScopeOption[] =
    scopeKind === 'department'
      ? (departments.data ?? []).map((department) => ({
          value: department.id,
          label: department.name,
        }))
      : scopeKind === 'agent'
        ? (agents.data?.items ?? []).map((agent) => ({ value: agent.id, label: agent.name }))
        : scopeKind === 'knowledge_base'
          ? (knowledgeBases.data ?? []).map((base) => ({ value: base.id, label: base.name }))
          : (dataDomains.data ?? []).map((domain) => ({ value: domain.id, label: domain.name }));
  const missingScope =
    budget && scopeId === budget.scopeId && !options.some((option) => option.value === scopeId)
      ? [{ value: budget.scopeId, label: budget.scopeName }]
      : [];
  const selectOptions = [...missingScope, ...options];
  const candidateQuery =
    scopeKind === 'department'
      ? departments
      : scopeKind === 'agent'
        ? agents
        : scopeKind === 'knowledge_base'
          ? knowledgeBases
          : scopeKind === 'data_domain'
            ? dataDomains
            : null;
  const candidateError = candidateQuery?.isError ? candidateQuery.error : null;
  const candidateLoading = editable && (candidateQuery?.isPending ?? false);
  const candidateMore = !editable
    ? null
    : scopeKind === 'department'
      ? departments
      : scopeKind === 'knowledge_base'
        ? knowledgeBases
        : scopeKind === 'data_domain'
          ? dataDomains
          : null;

  const submit = handleSubmit(
    async (values: BudgetFormValues) => {
      if (pending) return;
      setError(null);
      try {
        const input: BudgetInput = { ...values, metric };
        await upsert.mutateAsync(input);
        setSaved(true);
        toastSuccess(budget ? '预算已更新' : '预算已创建');
        guard.finish();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    () => setError(null),
  );

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
        取消
      </Button>
      <Button type="submit" form={BUDGET_FORM_ID} disabled={pending} aria-busy={pending}>
        {pending ? '正在保存…' : budget ? '保存更改' : '创建预算'}
      </Button>
    </div>
  );

  return (
    <>
      <InspectorSheet
        size="sm"
        open={dialog.open}
        onOpenChange={(next) => {
          if (!next) guard.close();
        }}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        title={budget ? '编辑预算' : '新建预算'}
        description="上限达到提醒阈值后发送预算提醒。"
        closeDisabled={pending}
        footer={footer}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <form
          id={BUDGET_FORM_ID}
          aria-label={budget ? '编辑预算' : '新建预算'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-disabled={pending || Boolean(budget)}>
              <FieldLabel htmlFor="budget-scope-kind">范围类型</FieldLabel>
              <Controller
                control={control}
                name="scopeKind"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    items={Object.entries(SCOPE_KIND_LABEL).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onValueChange={(next) => {
                      field.onChange(next);
                      setValue('scopeId', '', { shouldDirty: true });
                    }}
                    disabled={pending || Boolean(budget)}
                  >
                    <SelectTrigger
                      id="budget-scope-kind"
                      className="w-full min-w-0"
                      ref={field.ref}
                      onBlur={field.onBlur}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(SCOPE_KIND_LABEL).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field
              data-invalid={Boolean(errors.scopeId)}
              data-disabled={pending || Boolean(budget)}
            >
              <FieldLabel htmlFor="budget-scope-id">
                范围 <RequiredMark />
              </FieldLabel>
              <Controller
                control={control}
                name="scopeId"
                render={({ field }) =>
                  scopeKind === 'user' ? (
                    <AccountCombobox
                      id="budget-scope-id"
                      label="用户"
                      value={field.value}
                      {...(budget?.scopeName ? { valueLabel: budget.scopeName } : {})}
                      onChange={(businessId) => field.onChange(businessId)}
                      disabled={pending || Boolean(budget)}
                      inputRef={field.ref}
                      onBlur={field.onBlur}
                      invalid={Boolean(errors.scopeId)}
                      describedBy={errors.scopeId ? 'budget-scope-id-error' : undefined}
                    />
                  ) : (
                    <Select
                      value={field.value || null}
                      items={selectOptions}
                      onValueChange={(next) => field.onChange(next ?? '')}
                      disabled={pending || Boolean(budget)}
                    >
                      <SelectTrigger
                        id="budget-scope-id"
                        className="w-full min-w-0"
                        ref={field.ref}
                        onBlur={field.onBlur}
                        aria-invalid={Boolean(errors.scopeId)}
                        aria-describedby={errors.scopeId ? 'budget-scope-id-error' : undefined}
                      >
                        <SelectValue placeholder={candidateLoading ? '加载中…' : '选择范围'} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {selectOptions.length === 0 ? (
                            <SelectItem value="__empty" disabled>
                              {candidateLoading ? '加载中…' : '没有可选范围'}
                            </SelectItem>
                          ) : (
                            selectOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )
                }
              />
              <FieldError id="budget-scope-id-error">{errors.scopeId?.message}</FieldError>
              {candidateError ? <FieldError>{errorMessage(candidateError)}</FieldError> : null}
              {candidateMore ? (
                <CursorListFooter className="pt-2" query={candidateMore} label="范围" />
              ) : null}
            </Field>

            <Field data-disabled>
              <FieldLabel>指标</FieldLabel>
              <p className="text-sm text-fg">{METRIC_LABEL[metric]}</p>
              <FieldDescription>{METRIC_HINT[metric]}</FieldDescription>
            </Field>

            <Field data-invalid={Boolean(errors.limitValue)} data-disabled={pending}>
              <FieldLabel htmlFor="budget-limit">
                上限 <RequiredMark />
              </FieldLabel>
              <Controller
                control={control}
                name="limitValue"
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
                    step={metric === 'cost_usd_month' ? 0.01 : 1}
                    disabled={pending}
                  >
                    <NumberInputGroup>
                      <NumberInputDecrement />
                      <NumberInputControl
                        ref={field.ref}
                        id="budget-limit"
                        inputMode={metric === 'cost_usd_month' ? 'decimal' : 'numeric'}
                        onBlur={field.onBlur}
                        aria-invalid={Boolean(errors.limitValue)}
                      />
                      <NumberInputIncrement />
                    </NumberInputGroup>
                  </NumberInput>
                )}
              />
              <FieldError id="budget-limit-error">{errors.limitValue?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.alertRatio)} data-disabled={pending}>
              <FieldLabel htmlFor="budget-alert-ratio">提醒阈值</FieldLabel>
              <Controller
                control={control}
                name="alertRatio"
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
                    step={0.01}
                    disabled={pending}
                  >
                    <NumberInputGroup>
                      <NumberInputDecrement />
                      <NumberInputControl
                        ref={field.ref}
                        id="budget-alert-ratio"
                        inputMode="decimal"
                        onBlur={field.onBlur}
                        aria-invalid={Boolean(errors.alertRatio)}
                      />
                      <NumberInputIncrement />
                    </NumberInputGroup>
                  </NumberInput>
                )}
              />
              <FieldDescription id="budget-alert-ratio-hint">
                达到上限的该比例时提醒，例如 0.8 表示 80%。
              </FieldDescription>
              <FieldError id="budget-alert-ratio-error">{errors.alertRatio?.message}</FieldError>
            </Field>

            <Field orientation="horizontal" className="items-center gap-3" data-disabled={pending}>
              <FieldLabel htmlFor="budget-enabled">启用</FieldLabel>
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="budget-enabled"
                    ref={field.ref}
                    checked={field.value ?? true}
                    disabled={pending}
                    onCheckedChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </Field>

            <FieldError>{error ?? undefined}</FieldError>
          </FieldGroup>
        </form>
      </InspectorSheet>
      <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
    </>
  );
}
