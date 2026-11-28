import {
  type AlertSettings,
  alertSettingsSchema,
  type BudgetInput,
  type BudgetMetric,
  type BudgetScopeKind,
  type BudgetStatus,
  budgetInputSchema,
  type CostGroupBy,
  type Department,
  departmentInputSchema,
  departmentMembersInputSchema,
  type GovernanceIdentity,
  type HandoverChecklist,
  type HandoverTransferResult,
  type ResourceGrant,
  type ResourceGrantInput,
  type ResourceKind,
  resourceGrantInputSchema,
  resourceKindSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRightLeft, Coins, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { type ComponentProps, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CursorListFooter } from '../components/cursor-list-footer.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { SegmentedToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { useFormBlocker } from '../lib/form.js';
import {
  formatCost,
  formatDate,
  formatDateTime,
  formatPercent,
  formatTokens,
} from '../lib/format.js';
import {
  agentsQuery,
  meQuery,
  useAlertSettings,
  useBudgets,
  useCostSummary,
  useCreateDepartment,
  useDeleteBudget,
  useDeleteDepartment,
  useDeleteResourceGrant,
  useDepartments,
  useGovernanceIdentities,
  useGovernanceResources,
  useHandover,
  useResourceGrants,
  useSetDepartmentMembers,
  useTransferHandover,
  useUpdateAlertSettings,
  useUpdateDepartment,
  useUpsertBudget,
  useUpsertResourceGrant,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { useOptimisticValue } from '../lib/use-optimistic-value.js';
import { useZodForm } from '../lib/use-zod-form.js';
import { governanceTabSchema } from '../routes/-search.js';

const TABS: readonly { value: z.infer<typeof governanceTabSchema>; label: string }[] = [
  { value: 'cost', label: '成本' },
  { value: 'budgets', label: '预算' },
  { value: 'departments', label: '部门' },
  { value: 'grants', label: '资源授权' },
  { value: 'handover', label: '交接' },
  { value: 'alerts', label: '告警' },
];

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

const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = {
  knowledge_base: '知识库',
  data_domain: '数据域',
  skill: '技能',
  server: '连接器',
  plugin: '插件',
  runtime_environment: '运行环境',
};

const COST_GROUPS: readonly { value: CostGroupBy; label: string }[] = [
  { value: 'user', label: '按人' },
  { value: 'department', label: '按部门' },
  { value: 'model', label: '按模型' },
];

const COST_WINDOWS = [7, 30, 90] as const;

type ScopeOption = { value: string; label: string };

function formatMetric(metric: BudgetMetric, value: number): string {
  if (metric === 'cost_usd_month') return formatCost(value);
  if (metric === 'documents') return `${value} 篇`;
  return `${value} 次`;
}

function metricHint(metric: BudgetMetric): string {
  return METRIC_HINT[metric];
}

export function GovernancePage() {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'governance.manage');
  const tab = search.tab ?? 'cost';

  return (
    <Page>
      <Tabs
        value={tab}
        onValueChange={(next, details) => {
          details.cancel();
          const parsed = governanceTabSchema.safeParse(next);
          if (!parsed.success || parsed.data === tab) return;
          void navigate({
            to: '/governance',
            search: { ...search, tab: parsed.data },
            replace: true,
          });
        }}
        className="min-h-0 flex-1"
      >
        <PageTopbar>
          <PageHeader title="治理" />
          <PageToolbar>
            <TabsList variant="line" aria-label="治理分区">
              {TABS.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </PageToolbar>
        </PageTopbar>

        <PageBody>
          <TabsContent value={tab} className="min-w-0">
            {tab === 'cost' ? <CostSection /> : null}
            {tab === 'budgets' ? <BudgetsSection canManage={canManage} /> : null}
            {tab === 'departments' ? <DepartmentsSection canManage={canManage} /> : null}
            {tab === 'grants' ? <GrantsSection canManage={canManage} /> : null}
            {tab === 'handover' ? <HandoverSection canManage={canManage} /> : null}
            {tab === 'alerts' ? <AlertsSection canManage={canManage} /> : null}
          </TabsContent>
        </PageBody>
      </Tabs>
    </Page>
  );
}

function CostSection() {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const days = search.days ?? 30;
  const [optimisticDays, commitDays] = useOptimisticValue(String(days));
  const groupBy = search.groupBy ?? 'user';
  const summary = useCostSummary(days, groupBy);
  const groups = summary.data?.groups ?? [];

  return (
    <PageSection
      divided={false}
      {...(summary.data
        ? {
            description: `${formatDate(summary.data.since)} 起`,
          }
        : {})}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={optimisticDays}
            items={COST_WINDOWS.map((value) => ({ value: String(value), label: `${value} 天` }))}
            onValueChange={(next, details) => {
              if (next === null) {
                details.cancel();
                return;
              }
              commitDays(next, () =>
                navigate({
                  to: '/governance',
                  search: { ...search, days: Number(next) as 7 | 30 | 90 },
                  replace: true,
                }),
              );
            }}
          >
            <SelectTrigger className="w-28" aria-label="统计窗口">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {COST_WINDOWS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value} 天
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <SegmentedToggle
            label="成本分组"
            value={groupBy}
            options={COST_GROUPS}
            onChange={(next) =>
              void navigate({
                to: '/governance',
                search: { ...search, groupBy: next },
                replace: true,
              })
            }
          />
        </div>
      }
    >
      {summary.isPending ? <LoadingState rows={4} /> : null}
      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : null}
      {summary.data && groups.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<Coins className="size-5" aria-hidden="true" />}
          title="当前窗口内没有产生运行成本"
          description="专家运行后将按所选维度自动汇总。"
        />
      ) : null}
      {groups.length > 0 ? (
        <Table aria-label="成本汇总">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">
                {groupBy === 'user' ? '用户' : groupBy === 'department' ? '部门' : '模型'}
              </TableHead>
              <TableHead scope="col" className="text-right">
                运行数
              </TableHead>
              <TableHead scope="col" className="text-right">
                成本
              </TableHead>
              <TableHead scope="col" className="text-right">
                输入 token
              </TableHead>
              <TableHead scope="col" className="text-right">
                输出 token
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={group.key}>
                <TableCell className="max-w-80 truncate" title={group.label || group.key}>
                  {group.label || '未记录'}
                </TableCell>
                <TableCell className="text-right tabular-nums">{group.runs}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCost(group.costUsd)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatTokens(group.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatTokens(group.outputTokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </PageSection>
  );
}

function BudgetsSection({ canManage }: { canManage: boolean }) {
  const budgets = useBudgets();
  const remove = useDeleteBudget();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BudgetStatus | null>(null);
  const [deleting, setDeleting] = useState<BudgetStatus | null>(null);
  const rows = budgets.data ?? [];

  return (
    <PageSection
      divided={false}
      actions={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建预算
          </Button>
        ) : null
      }
    >
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
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建预算
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <Table aria-label="预算列表">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">范围</TableHead>
              <TableHead scope="col">指标</TableHead>
              <TableHead scope="col">已用 / 上限</TableHead>
              <TableHead scope="col" className="text-right">
                提醒阈值
              </TableHead>
              <TableHead scope="col">状态</TableHead>
              <TableHead scope="col" className="hidden xl:table-cell">
                更新时间
              </TableHead>
              {canManage ? (
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((budget) => {
              const ratio = budget.limitValue > 0 ? budget.used / budget.limitValue : 1;
              const exceeded = budget.enabled && budget.used >= budget.limitValue;
              const near = budget.enabled && !exceeded && ratio >= budget.alertRatio;
              return (
                <TableRow key={budget.id}>
                  <TableCell className="min-w-0">
                    <span className="block max-w-64 truncate text-fg" title={budget.scopeName}>
                      {budget.scopeName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {SCOPE_KIND_LABEL[budget.scopeKind]}
                    </span>
                  </TableCell>
                  <TableCell>{METRIC_LABEL[budget.metric]}</TableCell>
                  <TableCell>
                    <span className="block tabular-nums">
                      {formatMetric(budget.metric, budget.used)} /{' '}
                      {formatMetric(budget.metric, budget.limitValue)}
                    </span>
                    {exceeded || near ? (
                      <StatusBadge tone={exceeded ? 'danger' : 'warn'} className="mt-1">
                        {exceeded ? '已超限' : '接近阈值'}
                      </StatusBadge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatPercent(budget.alertRatio)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge>{budget.enabled ? '启用' : '停用'}</StatusBadge>
                  </TableCell>
                  <TableCell className="hidden text-xs tabular-nums text-muted-foreground xl:table-cell">
                    {formatDateTime(budget.updatedAt)}
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(budget)}>
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`删除 ${budget.scopeName} 的预算`}
                          onClick={() => setDeleting(budget)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      <CursorListFooter className="pt-2" query={budgets} label="预算" />

      {creating ? <BudgetDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <BudgetDialog budget={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除预算"
          description={`删除后「${deleting.scopeName}」不再按此上限提醒。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('预算已删除');
          }}
        />
      ) : null}
    </PageSection>
  );
}

const budgetFormSchema = budgetInputSchema
  .pick({ scopeKind: true, scopeId: true, limitValue: true, alertRatio: true, enabled: true })
  .extend({ scopeId: z.string().min(1, '请选择范围。') });

type BudgetFormValues = z.infer<typeof budgetFormSchema>;

function BudgetDialog({
  budget,
  onClose: onClosed,
}: {
  budget?: BudgetStatus;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
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
  const { register, control, handleSubmit, watch, setValue, formState } = useZodForm(
    budgetFormSchema,
    { defaultValues: defaults },
  );
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = upsert.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const scopeKind = watch('scopeKind');
  const scopeId = watch('scopeId');
  const metric = METRIC_BY_SCOPE[scopeKind];

  const departments = useDepartments(scopeKind === 'department');
  const agents = useQuery({ ...agentsQuery, enabled: scopeKind === 'agent' });
  const knowledgeBases = useGovernanceResources(
    'knowledge_base',
    '',
    scopeKind === 'knowledge_base',
  );
  const dataDomains = useGovernanceResources('data_domain', '', scopeKind === 'data_domain');

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
  const candidateLoading = candidateQuery?.isPending ?? false;
  const candidateMore =
    scopeKind === 'department'
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

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={budget ? '编辑预算' : '新建预算'}
        description="上限达到提醒阈值后发送预算提醒。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label={budget ? '编辑预算' : '新建预算'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
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
                <FieldLabel htmlFor="budget-scope-id">范围</FieldLabel>
                <Controller
                  control={control}
                  name="scopeId"
                  render={({ field }) =>
                    scopeKind === 'user' ? (
                      <AccountSelect
                        id="budget-scope-id"
                        label="用户"
                        value={field.value}
                        {...(budget?.scopeName ? { valueLabel: budget.scopeName } : {})}
                        onChange={(businessId) => field.onChange(businessId)}
                        disabled={pending || Boolean(budget)}
                        triggerRef={field.ref}
                        onBlur={field.onBlur}
                        invalid={Boolean(errors.scopeId)}
                        describedBy={errors.scopeId ? 'budget-scope-id-error' : undefined}
                      />
                    ) : (
                      <Select
                        value={field.value}
                        items={selectOptions}
                        onValueChange={field.onChange}
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
            </div>

            <Field data-disabled>
              <FieldLabel>指标</FieldLabel>
              <p className="text-sm text-fg">{METRIC_LABEL[metric]}</p>
              <FieldDescription>{metricHint(metric)}</FieldDescription>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.limitValue)} data-disabled={pending}>
                <FieldLabel htmlFor="budget-limit">
                  上限 <RequiredMark />
                </FieldLabel>
                <Input
                  id="budget-limit"
                  type="number"
                  min={0}
                  step={metric === 'cost_usd_month' ? 0.01 : 1}
                  disabled={pending}
                  aria-invalid={Boolean(errors.limitValue)}
                  aria-describedby={errors.limitValue ? 'budget-limit-error' : undefined}
                  {...register('limitValue', { valueAsNumber: true })}
                />
                <FieldError id="budget-limit-error">{errors.limitValue?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.alertRatio)} data-disabled={pending}>
                <FieldLabel htmlFor="budget-alert-ratio">提醒阈值</FieldLabel>
                <Input
                  id="budget-alert-ratio"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={pending}
                  aria-invalid={Boolean(errors.alertRatio)}
                  aria-describedby={
                    errors.alertRatio ? 'budget-alert-ratio-error' : 'budget-alert-ratio-hint'
                  }
                  {...register('alertRatio', { valueAsNumber: true })}
                />
                <FieldDescription id="budget-alert-ratio-hint">
                  达到上限的该比例时提醒，例如 0.8 表示 80%。
                </FieldDescription>
                <FieldError id="budget-alert-ratio-error">{errors.alertRatio?.message}</FieldError>
              </Field>
            </div>

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
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : budget ? '保存更改' : '创建预算'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function DepartmentsSection({ canManage }: { canManage: boolean }) {
  const departments = useDepartments();
  const remove = useDeleteDepartment();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Department | null>(null);
  const [managing, setManaging] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const rows = departments.data ?? [];

  return (
    <PageSection
      divided={false}
      actions={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建部门
          </Button>
        ) : null
      }
    >
      {departments.isPending ? <LoadingState rows={4} /> : null}
      {departments.isError ? (
        <ErrorState error={departments.error} onRetry={() => void departments.refetch()} />
      ) : null}
      {departments.data && rows.length === 0 ? (
        <EmptyState
          variant="stage"
          scale="section"
          specimen="governance"
          title="创建组织部门"
          description="部门用于按组织汇总成本与设置预算。"
          action={
            canManage ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建部门
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <Table aria-label="部门列表">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">部门</TableHead>
              <TableHead scope="col" className="text-right">
                成员
              </TableHead>
              <TableHead scope="col">负责人</TableHead>
              <TableHead scope="col" className="hidden xl:table-cell">
                更新时间
              </TableHead>
              {canManage ? (
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((department) => (
              <TableRow key={department.id}>
                <TableCell className="max-w-72 truncate" title={department.name}>
                  {department.name}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {department.members.length}
                </TableCell>
                <TableCell className="max-w-64 truncate">
                  {department.members
                    .filter((member) => member.isManager)
                    .map((member) => member.name)
                    .join('、') || '—'}
                </TableCell>
                <TableCell className="hidden text-xs tabular-nums text-muted-foreground xl:table-cell">
                  {formatDateTime(department.updatedAt)}
                </TableCell>
                {canManage ? (
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`管理 ${department.name} 的成员`}
                        onClick={() => setManaging(department)}
                      >
                        成员
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRenaming(department)}>
                        改名
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除部门 ${department.name}`}
                        onClick={() => setDeleting(department)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <CursorListFooter className="pt-2" query={departments} label="部门" />

      {creating ? <DepartmentDialog onClose={() => setCreating(false)} /> : null}
      {renaming ? (
        <DepartmentDialog department={renaming} onClose={() => setRenaming(null)} />
      ) : null}
      {managing ? (
        <DepartmentMembersDialog department={managing} onClose={() => setManaging(null)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除部门"
          description={`删除「${deleting.name}」后，成员关系一并移除；已有预算保留但不再归属该部门。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('部门已删除');
          }}
        />
      ) : null}
    </PageSection>
  );
}

function DepartmentDialog({
  department,
  onClose: onClosed,
}: {
  department?: Department;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const { register, handleSubmit, formState } = useZodForm(departmentInputSchema, {
    defaultValues: { name: department?.name ?? '' },
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = (create.isPending || update.isPending) && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      try {
        if (department) {
          await update.mutateAsync({ id: department.id, name: values.name });
          toastSuccess('部门名称已更新');
        } else {
          await create.mutateAsync(values.name);
          toastSuccess('部门已创建');
        }
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
        title={department ? '部门改名' : '新建部门'}
        className="max-w-md sm:max-w-md"
        closeDisabled={pending}
      >
        <form
          aria-label={department ? '部门改名' : '新建部门'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(errors.name)} data-disabled={pending}>
              <FieldLabel htmlFor="department-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                id="department-name"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'department-name-error' : undefined}
                {...register('name')}
              />
              <FieldError id="department-name-error">{errors.name?.message}</FieldError>
            </Field>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : department ? '保存' : '创建部门'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function DepartmentMembersDialog({
  department,
  onClose: onClosed,
}: {
  department: Department;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const saveMembers = useSetDepartmentMembers();
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useGovernanceIdentities(settled);
  const { watch, setValue, handleSubmit, formState } = useZodForm(departmentMembersInputSchema, {
    defaultValues: {
      members: department.members.map((member) => ({
        businessId: member.businessId,
        isManager: member.isManager,
      })),
    },
  });
  const members = watch('members');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = saveMembers.isPending && !saved;
  const dirty = !saved && formState.isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const knownMembers = useRef(
    new Map(
      department.members.map((member) => [
        member.businessId,
        { name: member.name, accountActive: member.accountActive },
      ]),
    ),
  );
  for (const account of accounts.data ?? []) {
    knownMembers.current.set(account.businessId, {
      name: account.name,
      accountActive: account.accountActive,
    });
  }
  const selectedIds = new Set(members.map((member) => member.businessId));
  const rows = members.map((member) => ({
    ...member,
    ...(knownMembers.current.get(member.businessId) ?? {
      name: member.businessId,
      accountActive: true,
    }),
  }));
  const resultRows = (accounts.data ?? [])
    .filter((account) => !selectedIds.has(account.businessId))
    .map((account) => ({
      businessId: account.businessId,
      name: account.name,
      accountActive: account.accountActive,
      isManager: false,
    }));
  const allRows = [...rows, ...resultRows];

  const toggle = (businessId: string): void => {
    setValue(
      'members',
      selectedIds.has(businessId)
        ? members.filter((member) => member.businessId !== businessId)
        : [...members, { businessId, isManager: false }],
      { shouldDirty: true },
    );
  };
  const toggleManager = (businessId: string): void => {
    setValue(
      'members',
      members.map((member) =>
        member.businessId === businessId ? { ...member, isManager: !member.isManager } : member,
      ),
      { shouldDirty: true },
    );
  };

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      try {
        await saveMembers.mutateAsync({ id: department.id, members: values.members });
        setSaved(true);
        toastSuccess('部门成员已更新');
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
        title={`管理「${department.name}」的成员`}
        description="每位用户只能属于一个部门。"
        className="max-w-xl sm:max-w-xl"
        closeDisabled={pending}
      >
        <form
          aria-label="管理部门成员"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <SearchInput
              label="搜索账户"
              placeholder="搜索姓名或业务 ID…"
              value={query}
              onChange={setQuery}
            />
            {accounts.isError ? (
              <ErrorState
                error={accounts.error}
                title="账户列表没有加载出来"
                onRetry={() => void accounts.refetch()}
              />
            ) : null}
            <div className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto border-y">
              {allRows.length === 0 ? (
                <EmptyState variant="filter" scale="inline" title="没有匹配的账户" />
              ) : (
                allRows.map((row) => {
                  const selected = selectedIds.has(row.businessId);
                  return (
                    <div
                      key={row.businessId}
                      className="flex min-w-0 flex-wrap items-center gap-3 py-2"
                    >
                      <label
                        htmlFor={`member-${row.businessId}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={`member-${row.businessId}`}
                          checked={selected}
                          disabled={pending}
                          onCheckedChange={() => toggle(row.businessId)}
                        />
                        <span className="min-w-0 truncate">{row.name}</span>
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                          {row.businessId}
                        </span>
                        {row.accountActive ? null : <StatusBadge>停用</StatusBadge>}
                      </label>
                      {selected ? (
                        <label
                          htmlFor={`manager-${row.businessId}`}
                          className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
                        >
                          负责人
                          <Switch
                            id={`manager-${row.businessId}`}
                            size="sm"
                            checked={row.isManager}
                            disabled={pending}
                            onCheckedChange={() => toggleManager(row.businessId)}
                          />
                        </label>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <CursorListFooter className="pt-2" query={accounts} label="账户" />
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : '保存成员'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="成员改动会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function GrantsSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const resourceKind = search.resourceKind ?? 'knowledge_base';
  const [optimisticKind, commitKind] = useOptimisticValue(resourceKind);
  const query = search.resourceQ ?? '';
  const settled = useDebouncedValue(query.trim(), 300);
  const resources = useGovernanceResources(resourceKind, settled);
  const resourceId = search.resourceId ?? '';
  const [optimisticResourceId, commitResourceId] = useOptimisticValue(resourceId);
  const grants = useResourceGrants(resourceKind, resourceId);
  const revoke = useDeleteResourceGrant();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<ResourceGrant | null>(null);
  const items = resources.data ?? [];
  const selected = items.find((item) => item.id === resourceId) ?? null;
  const grantRows = grants.data ?? [];

  const resourceOptions =
    selected || resourceId.length === 0
      ? items.map((item) => ({
          value: item.id,
          label: `${item.name}${item.ownerName ? ` · ${item.ownerName}` : ''}`,
        }))
      : [
          { value: resourceId, label: resourceId },
          ...items.map((item) => ({
            value: item.id,
            label: `${item.name}${item.ownerName ? ` · ${item.ownerName}` : ''}`,
          })),
        ];

  return (
    <PageSection divided={false}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          value={optimisticKind}
          items={resourceKindSchema.options.map((value) => ({
            value,
            label: RESOURCE_KIND_LABEL[value],
          }))}
          onValueChange={(next, details) => {
            const parsed = resourceKindSchema.safeParse(next);
            if (!parsed.success) {
              details.cancel();
              return;
            }
            commitKind(parsed.data, () =>
              navigate({
                to: '/governance',
                search: {
                  ...search,
                  resourceKind: parsed.data,
                  resourceId: undefined,
                  resourceQ: undefined,
                },
                replace: true,
              }),
            );
          }}
        >
          <SelectTrigger className="w-32" aria-label="资源类型">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {resourceKindSchema.options.map((value) => (
                <SelectItem key={value} value={value}>
                  {RESOURCE_KIND_LABEL[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <SearchInput
          label="搜索资源"
          placeholder="搜索资源名称…"
          value={query}
          onChange={(next) =>
            void navigate({
              to: '/governance',
              search: { ...search, resourceQ: next || undefined },
              replace: true,
            })
          }
          className="w-56 min-w-0"
        />
        <Select
          value={optimisticResourceId}
          items={resourceOptions}
          onValueChange={(next, details) => {
            if (next === null) {
              details.cancel();
              return;
            }
            commitResourceId(next, () =>
              navigate({
                to: '/governance',
                search: { ...search, resourceId: next || undefined },
                replace: true,
              }),
            );
          }}
          disabled={resources.isPending}
        >
          <SelectTrigger className="w-64 min-w-0" aria-label="选择资源">
            <SelectValue placeholder={resources.isPending ? '加载中…' : '选择资源'} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {resourceOptions.length === 0 ? (
                <SelectItem value="__empty" disabled>
                  {resources.isPending ? '加载中…' : '没有匹配的资源'}
                </SelectItem>
              ) : (
                resourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="ml-auto">
          {canManage ? (
            <Button
              disabled={resourceId.length === 0 || grants.isPending}
              onClick={() => setAdding(true)}
            >
              <Plus data-icon="inline-start" aria-hidden="true" /> 添加授权
            </Button>
          ) : null}
        </div>
      </div>
      <CursorListFooter className="pt-2" query={resources} label="资源" />

      {resources.isError ? (
        <ErrorState error={resources.error} onRetry={() => void resources.refetch()} />
      ) : null}
      {resourceId.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<KeyRound className="size-5" aria-hidden="true" />}
          title="先选择一个资源"
          description="选择具体专家、知识库或连接器后，可查看并分配细粒度权限。"
        />
      ) : null}
      {resourceId.length > 0 && grants.isPending ? <LoadingState rows={3} /> : null}
      {resourceId.length > 0 && grants.isError ? (
        <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />
      ) : null}
      {resourceId.length > 0 && grants.data && grantRows.length === 0 ? (
        <EmptyState
          variant="clear"
          scale="section"
          icon={<ShieldCheck className="size-5" aria-hidden="true" />}
          title="暂未配置额外授权"
          description="当前仅资源所有者与平台管理员可访问。"
          action={
            canManage ? (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                添加授权
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {grantRows.length > 0 ? (
        <Table aria-label="资源授权列表">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">账户</TableHead>
              <TableHead scope="col">权限</TableHead>
              {canManage ? (
                <TableHead scope="col" className="text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grantRows.map((grant) => (
              <TableRow key={`${grant.resourceKind}-${grant.resourceId}-${grant.businessId}`}>
                <TableCell className="min-w-0">
                  <span className="block truncate text-fg">{grant.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {grant.businessId}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {grant.canUse ? <StatusBadge>可使用</StatusBadge> : null}
                    {grant.canManage ? <StatusBadge>可管理</StatusBadge> : null}
                    {grant.accountActive ? null : <StatusBadge tone="danger">停用</StatusBadge>}
                  </div>
                </TableCell>
                {canManage ? (
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`撤销 ${grant.name} 的授权`}
                        onClick={() => setRevoking(grant)}
                      >
                        撤销
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {adding ? (
        <GrantDialog
          resourceKind={resourceKind}
          resourceId={resourceId}
          resourceName={selected?.name ?? resourceId}
          existing={grantRows}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {revoking ? (
        <ConfirmDialog
          open
          title="撤销资源授权"
          description={`撤销后「${revoking.name}」将失去对该资源的${revoking.canManage ? '管理' : '使用'}权限。`}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await revoke.mutateAsync(revoking);
            toastSuccess('授权已撤销');
          }}
        />
      ) : null}
    </PageSection>
  );
}

const grantFormSchema = z
  .object({
    businessId: resourceGrantInputSchema.shape.businessId,
    canUse: resourceGrantInputSchema.shape.canUse,
    canManage: resourceGrantInputSchema.shape.canManage,
  })
  .refine((values) => values.canUse || values.canManage, {
    message: '至少选择「可使用」或「可管理」。',
    path: ['canUse'],
  });

function GrantDialog({
  resourceKind,
  resourceId,
  resourceName,
  existing,
  onClose: onClosed,
}: {
  resourceKind: ResourceKind;
  resourceId: string;
  resourceName: string;
  existing: ResourceGrant[];
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const upsert = useUpsertResourceGrant();
  const { control, handleSubmit, formState } = useZodForm(grantFormSchema, {
    defaultValues: { businessId: '', canUse: true, canManage: false },
  });
  const { errors } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = upsert.isPending && !saved;
  const dirty = !saved && formState.isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      try {
        const input: ResourceGrantInput = {
          resourceKind,
          resourceId,
          businessId: values.businessId,
          canUse: values.canUse,
          canManage: values.canManage,
        };
        await upsert.mutateAsync(input);
        setSaved(true);
        toastSuccess('授权已保存');
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
        title="添加资源授权"
        description={`${RESOURCE_KIND_LABEL[resourceKind]} · ${resourceName}`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="添加资源授权"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(errors.businessId)} data-disabled={pending}>
              <FieldLabel htmlFor="grant-account">
                账户 <RequiredMark />
              </FieldLabel>
              <Controller
                control={control}
                name="businessId"
                render={({ field }) => (
                  <AccountSelect
                    id="grant-account"
                    label="账户"
                    value={field.value}
                    onChange={(businessId) => field.onChange(businessId)}
                    disabled={pending}
                    excludeBusinessIds={existing.map((grant) => grant.businessId)}
                    triggerRef={field.ref}
                    onBlur={field.onBlur}
                    invalid={Boolean(errors.businessId)}
                    describedBy={errors.businessId ? 'grant-account-error' : undefined}
                  />
                )}
              />
              <FieldError id="grant-account-error">{errors.businessId?.message}</FieldError>
            </Field>
            <FieldSet className="gap-2">
              <FieldLegend variant="label" className="mb-2">
                权限
              </FieldLegend>
              <div className="flex flex-col gap-2">
                <Controller
                  control={control}
                  name="canUse"
                  render={({ field }) => (
                    <label
                      htmlFor="grant-can-use"
                      className="flex items-center gap-2 text-sm text-fg"
                    >
                      <Checkbox
                        id="grant-can-use"
                        checked={field.value}
                        disabled={pending}
                        onCheckedChange={field.onChange}
                      />
                      可使用
                      <span className="text-xs text-muted-foreground">读取与执行</span>
                    </label>
                  )}
                />
                <Controller
                  control={control}
                  name="canManage"
                  render={({ field }) => (
                    <label
                      htmlFor="grant-can-manage"
                      className="flex items-center gap-2 text-sm text-fg"
                    >
                      <Checkbox
                        id="grant-can-manage"
                        checked={field.value}
                        disabled={pending}
                        onCheckedChange={field.onChange}
                      />
                      可管理
                      <span className="text-xs text-muted-foreground">包含全部管理操作</span>
                    </label>
                  )}
                />
              </div>
              <FieldError>{errors.canUse?.message}</FieldError>
            </FieldSet>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : '保存授权'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function AccountSelect({
  id,
  value,
  onChange,
  label,
  valueLabel,
  disabled = false,
  activeOnly = false,
  excludeBusinessIds = [],
  triggerRef,
  onBlur,
  invalid = false,
  describedBy,
}: {
  id?: string;
  value: string;
  onChange: (businessId: string, account: GovernanceIdentity | null) => void;
  label: string;
  valueLabel?: string;
  disabled?: boolean;
  activeOnly?: boolean;
  excludeBusinessIds?: readonly string[];
  triggerRef?: ComponentProps<typeof SelectTrigger>['ref'];
  onBlur?: (() => void) | undefined;
  invalid?: boolean;
  describedBy?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useGovernanceIdentities(settled);
  const excluded = new Set(excludeBusinessIds);
  const items = (accounts.data ?? []).filter(
    (account) => !excluded.has(account.businessId) && (!activeOnly || account.accountActive),
  );
  const options = items.map((account) => ({
    value: account.businessId,
    label: `${account.name}（${account.businessId}）${account.accountActive ? '' : ' · 非活跃'}`,
  }));
  if (value.length > 0 && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: valueLabel ?? value });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SearchInput
        label={`搜索${label}`}
        placeholder="搜索姓名或业务 ID…"
        value={query}
        onChange={setQuery}
      />
      {accounts.isError ? <FieldError>{errorMessage(accounts.error)}</FieldError> : null}
      <Select
        value={value}
        items={options}
        disabled={disabled || accounts.isPending}
        onValueChange={(next) => {
          if (next === null) return;
          onChange(next, items.find((account) => account.businessId === next) ?? null);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full min-w-0"
          aria-label={label}
          ref={triggerRef}
          onBlur={onBlur}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder={accounts.isPending ? '加载中…' : '选择账户'} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.length === 0 ? (
              <SelectItem value="__empty" disabled>
                {accounts.isPending ? '加载中…' : '没有匹配的账户'}
              </SelectItem>
            ) : (
              options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))
            )}
          </SelectGroup>
        </SelectContent>
      </Select>
      <CursorListFooter className="pt-2" query={accounts} label="账户" />
    </div>
  );
}

const HANDOVER_GROUPS: readonly {
  key: keyof HandoverChecklist['items'] & keyof HandoverChecklist['counts'];
  label: string;
}[] = [
  { key: 'agents', label: '专家' },
  { key: 'knowledgeBases', label: '知识库' },
  { key: 'dataDomains', label: '数据域' },
  { key: 'skills', label: '技能' },
  { key: 'servers', label: '连接器' },
  { key: 'plugins', label: '插件' },
  { key: 'runtimeEnvironments', label: '运行环境' },
  { key: 'schedules', label: '定时任务' },
];

function HandoverSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const businessId = search.businessId ?? '';
  const [optimisticBusinessId, commitBusinessId] = useOptimisticValue(businessId);
  const checklist = useHandover(businessId);
  const transfer = useTransferHandover();
  const [receiver, setReceiver] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [result, setResult] = useState<HandoverTransferResult | null>(null);
  const data = checklist.data ?? null;
  const total = data ? Object.values(data.counts).reduce((sum, value) => sum + value, 0) : 0;

  return (
    <PageSection divided={false}>
      <div className="flex max-w-md min-w-0 flex-col gap-2">
        <p className="text-sm font-medium text-fg">离职账户</p>
        <AccountSelect
          label="离职账户"
          value={optimisticBusinessId}
          onChange={(next) => {
            setReceiver('');
            setReceiverName('');
            setResult(null);
            setTransferError(null);
            commitBusinessId(next, () =>
              navigate({
                to: '/governance',
                search: { ...search, businessId: next || undefined },
                replace: true,
              }),
            );
          }}
        />
      </div>

      {businessId.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<ArrowRightLeft className="size-5" aria-hidden="true" />}
          title="选择需要交接的账户"
          description="将汇总其名下的专家、资源与定时任务，支持一键整体转交。"
        />
      ) : null}
      {businessId.length > 0 && checklist.isPending ? <LoadingState rows={4} /> : null}
      {businessId.length > 0 && checklist.isError ? (
        <ErrorState error={checklist.error} onRetry={() => void checklist.refetch()} />
      ) : null}

      {data ? (
        <>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium text-fg">{data.name}</h2>
              <StatusBadge>
                {data.status === 'active' ? '启用' : data.status === 'deleted' ? '已删除' : '停用'}
              </StatusBadge>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 pt-2">
              {HANDOVER_GROUPS.map((group) => (
                <li key={group.key} className="min-w-0">
                  <Card size="sm">
                    <CardContent className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{group.label}</span>
                      <span className="text-lg font-medium tabular-nums text-fg">
                        {data.counts[group.key]}
                      </span>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </div>

          {data.departments.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              <h2 className="text-sm font-medium text-fg">部门</h2>
              <ul className="divide-y divide-line border-y">
                {data.departments.map((department) => (
                  <li
                    key={department.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{department.name}</span>
                    {department.isManager ? <StatusBadge>负责人</StatusBadge> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {HANDOVER_GROUPS.filter((group) => data.items[group.key].length > 0).length > 0 ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              {HANDOVER_GROUPS.filter((group) => data.items[group.key].length > 0).map((group) => (
                <div key={group.key} className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-sm font-medium text-fg">{group.label}</h2>
                  <ul className="divide-y divide-line border-y">
                    {data.items[group.key].map((item) => (
                      <li key={item.id} className="min-w-0 py-1.5 text-sm text-muted-foreground">
                        <span className="block truncate" title={item.name}>
                          {item.name}
                        </span>
                        {'agentName' in item ? (
                          <span className="block truncate text-xs">{item.agentName}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex min-w-0 flex-col gap-3">
            <h2 className="text-sm font-medium text-fg">接收人</h2>
            <div className="max-w-md">
              <AccountSelect
                label="接收人"
                value={receiver}
                activeOnly
                excludeBusinessIds={[data.businessId]}
                disabled={!canManage || total === 0}
                onChange={(next, account) => {
                  setReceiver(next);
                  setReceiverName(account?.name ?? '');
                  setResult(null);
                  setTransferError(null);
                }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {result ? (
                <span role="status" className="text-sm text-muted-foreground">
                  已转交 {result.total} 项
                </span>
              ) : null}
              <Button
                disabled={!canManage || total === 0 || receiver.length === 0}
                onClick={() => setConfirming(true)}
              >
                <ArrowRightLeft data-icon="inline-start" aria-hidden="true" /> 批量转交
              </Button>
            </div>
          </div>

          <ConfirmDialog
            open={confirming}
            title="确认批量转交？"
            description={`把「${data.name}」名下的 ${total} 项资源转交给${receiverName ? `「${receiverName}」` : '接收人'}；接收人必须对各类资源拥有管理权限，校验失败时不会部分转交。`}
            confirmLabel="确认转交"
            tone="default"
            confirmDisabled={transfer.isPending}
            onClose={() => {
              setConfirming(false);
              setTransferError(null);
            }}
            onConfirm={async () => {
              const transferred = await transfer.mutateAsync({
                businessId: data.businessId,
                toBusinessId: receiver,
              });
              setResult(transferred);
              setConfirming(false);
              setTransferError(null);
              toastSuccess(`已转交 ${transferred.total} 项资源`);
            }}
            onError={(error) => setTransferError(errorMessage(error))}
          >
            {transferError ? <FieldError>{transferError}</FieldError> : null}
          </ConfirmDialog>
        </>
      ) : null}
    </PageSection>
  );
}

const alertsFormSchema = alertSettingsSchema.omit({ updatedAt: true });

type AlertsFormValues = z.infer<typeof alertsFormSchema>;

function AlertsSection({ canManage }: { canManage: boolean }) {
  const alerts = useAlertSettings();
  return (
    <PageSection divided={false}>
      {alerts.isPending ? <LoadingState rows={3} /> : null}
      {alerts.isError ? (
        <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
      ) : null}
      {alerts.data ? <AlertsForm settings={alerts.data} canManage={canManage} /> : null}
    </PageSection>
  );
}

function AlertsForm({ settings, canManage }: { settings: AlertSettings; canManage: boolean }) {
  const update = useUpdateAlertSettings();
  const { register, control, handleSubmit, reset, formState } = useZodForm(alertsFormSchema, {
    defaultValues: {
      runFailures: settings.runFailures,
      queueFailed: settings.queueFailed,
      queueWaiting: settings.queueWaiting,
    },
  });
  const { errors } = formState;
  const [error, setError] = useState<string | null>(null);
  const pending = update.isPending;
  const blocker = useFormBlocker(formState.isDirty, pending);

  const submit = handleSubmit(async (values: AlertsFormValues) => {
    if (pending) return;
    setError(null);
    try {
      const saved = await update.mutateAsync({ ...values, updatedAt: settings.updatedAt });
      reset({
        runFailures: saved.runFailures,
        queueFailed: saved.queueFailed,
        queueWaiting: saved.queueWaiting,
      });
      toastSuccess('告警设置已保存');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  });

  return (
    <>
      <form
        aria-label="告警设置"
        noValidate
        className="flex min-w-0 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex min-w-0 flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-center gap-4 border-b pb-2 text-xs text-muted-foreground">
            <span>告警</span>
            <span>启用</span>
            <span>阈值</span>
            <span>窗口</span>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">运行失败</p>
              <p className="text-xs text-muted-foreground">窗口内失败运行数</p>
            </div>
            <Controller
              control={control}
              name="runFailures.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用运行失败告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  id="alerts-run-threshold"
                  type="number"
                  min={1}
                  step={1}
                  className="w-24"
                  disabled={!canManage || pending}
                  aria-label="运行失败阈值（次）"
                  aria-invalid={Boolean(errors.runFailures?.threshold)}
                  aria-describedby={
                    errors.runFailures?.threshold ? 'alerts-run-threshold-error' : undefined
                  }
                  {...register('runFailures.threshold', { valueAsNumber: true })}
                />
                <span className="text-xs text-muted-foreground">次</span>
              </div>
              <FieldError id="alerts-run-threshold-error">
                {errors.runFailures?.threshold?.message}
              </FieldError>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  id="alerts-run-window"
                  type="number"
                  min={1}
                  step={1}
                  className="w-24"
                  disabled={!canManage || pending}
                  aria-label="运行失败统计窗口（分钟）"
                  aria-invalid={Boolean(errors.runFailures?.windowMinutes)}
                  aria-describedby={
                    errors.runFailures?.windowMinutes ? 'alerts-run-window-error' : undefined
                  }
                  {...register('runFailures.windowMinutes', { valueAsNumber: true })}
                />
                <span className="text-xs text-muted-foreground">分钟</span>
              </div>
              <FieldError id="alerts-run-window-error">
                {errors.runFailures?.windowMinutes?.message}
              </FieldError>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">队列失败</p>
              <p className="text-xs text-muted-foreground">失败队列任务数</p>
            </div>
            <Controller
              control={control}
              name="queueFailed.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用队列失败告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  id="alerts-queue-failed-threshold"
                  type="number"
                  min={1}
                  step={1}
                  className="w-24"
                  disabled={!canManage || pending}
                  aria-label="队列失败阈值（个）"
                  aria-invalid={Boolean(errors.queueFailed?.threshold)}
                  aria-describedby={
                    errors.queueFailed?.threshold
                      ? 'alerts-queue-failed-threshold-error'
                      : undefined
                  }
                  {...register('queueFailed.threshold', { valueAsNumber: true })}
                />
                <span className="text-xs text-muted-foreground">个</span>
              </div>
              <FieldError id="alerts-queue-failed-threshold-error">
                {errors.queueFailed?.threshold?.message}
              </FieldError>
            </div>
            <span className="text-xs text-muted-foreground">—</span>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_72px_140px_140px] items-start gap-4 border-b py-4">
            <div className="min-w-0">
              <p className="text-sm text-fg">队列积压</p>
              <p className="text-xs text-muted-foreground">等待中的队列任务数</p>
            </div>
            <Controller
              control={control}
              name="queueWaiting.enabled"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  disabled={!canManage || pending}
                  aria-label="启用队列积压告警"
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <Input
                  id="alerts-queue-waiting-threshold"
                  type="number"
                  min={1}
                  step={1}
                  className="w-24"
                  disabled={!canManage || pending}
                  aria-label="队列积压阈值（个）"
                  aria-invalid={Boolean(errors.queueWaiting?.threshold)}
                  aria-describedby={
                    errors.queueWaiting?.threshold
                      ? 'alerts-queue-waiting-threshold-error'
                      : undefined
                  }
                  {...register('queueWaiting.threshold', { valueAsNumber: true })}
                />
                <span className="text-xs text-muted-foreground">个</span>
              </div>
              <FieldError id="alerts-queue-waiting-threshold-error">
                {errors.queueWaiting?.threshold?.message}
              </FieldError>
            </div>
            <span className="text-xs text-muted-foreground">—</span>
          </div>
        </div>

        <FieldError>{error ?? undefined}</FieldError>
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={!canManage || pending} aria-busy={pending}>
            {pending ? '正在保存…' : '保存设置'}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的告警设置？"
        description="离开后，本次修改不会保留。"
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => blocker.proceed()}
      />
    </>
  );
}
