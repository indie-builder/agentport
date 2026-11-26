import {
  type ContentPolicy,
  type ContentPolicyAction,
  type ContentPolicyDirection,
  type ContentPolicyMatchType,
  contentPolicyCreateSchema,
  type PolicyApproval,
  type PolicyApprovalStatus,
  type PolicyEvent,
  type PolicySourceKind,
  type ViolationCase,
  type ViolationCaseStatus,
  type ViolationSeverity,
  violationCaseStatusSchema,
  violationCaseUpdateSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterSelect } from '../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { Textarea } from '../components/ui/textarea.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { formatDateTime, formatRelative, shortId } from '../lib/format.js';
import {
  meQuery,
  useCreateSecurityPolicy,
  useDecideSecurityApproval,
  useDeleteSecurityPolicy,
  useSecurityApprovals,
  useSecurityEvents,
  useSecurityPolicies,
  useSecurityViolations,
  useUpdateSecurityPolicy,
  useUpdateSecurityViolation,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const DIRECTION_LABEL: Record<ContentPolicyDirection, string> = {
  inbound: '入站',
  outbound: '出站',
};

const ACTION_LABEL: Record<ContentPolicyAction, string> = {
  block: '拦截',
  redact: '脱敏',
  require_approval: '人工审批',
};

const MATCH_LABEL: Record<ContentPolicyMatchType, string> = {
  keyword: '关键词',
  regex: '正则',
  secret: '密钥',
  pii: 'PII',
};

const SOURCE_LABEL: Record<PolicySourceKind, string> = {
  run_prompt: '运行输入',
  channel_message: '频道消息',
  model_request: '模型请求',
  assistant_output: '助手输出',
};

const APPROVAL_STATUS_LABEL: Record<PolicyApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
};

const VIOLATION_STATUS_LABEL: Record<ViolationCaseStatus, string> = {
  open: '待处理',
  investigating: '调查中',
  resolved: '已解决',
  dismissed: '已忽略',
};

const SEVERITY_LABEL: Record<ViolationSeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

const SUBJECT_LABEL: Record<ViolationCase['subjectKind'], string> = {
  user: '用户',
  agent: '专家',
  channel: '频道',
};

const TABS = [
  { value: 'policies', label: '策略' },
  { value: 'approvals', label: '外发审批' },
  { value: 'events', label: '事件' },
  { value: 'violations', label: '违规处置' },
] as const;

const DIRECTION_OPTIONS = Object.entries(DIRECTION_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const ACTION_OPTIONS = Object.entries(ACTION_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const OUTBOUND_ACTION_OPTIONS = ACTION_OPTIONS.filter(({ value }) => value !== 'require_approval');

const MATCH_OPTIONS = Object.entries(MATCH_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const APPROVAL_STATUS_OPTIONS = Object.entries(APPROVAL_STATUS_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const EVENT_ACTION_OPTIONS = [{ value: 'all', label: '全部动作' }, ...ACTION_OPTIONS];

const EVENT_SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
];

const VIOLATION_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...Object.entries(VIOLATION_STATUS_LABEL).map(([value, label]) => ({ value, label })),
];

function InfiniteFooter({
  query,
}: {
  query: {
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    isFetchNextPageError: boolean;
    error: unknown;
    fetchNextPage: () => Promise<unknown>;
  };
}) {
  if (query.isFetchNextPageError) {
    return (
      <div className="flex justify-center">
        <ErrorState
          error={query.error}
          onRetry={() => void query.fetchNextPage()}
          title="下一页加载失败，保留已加载的记录"
        />
      </div>
    );
  }
  if (query.hasNextPage) {
    return (
      <div className="flex justify-center">
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '加载中…' : '加载更多'}
        </Button>
      </div>
    );
  }
  return <div className="text-center text-xs text-muted-foreground">已到末尾</div>;
}

export function SecurityPage() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const tab = search.tab ?? 'policies';

  return (
    <Page>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === tab) return;
          if (!TABS.some((item) => item.value === next)) return;
          void navigate({
            to: '/security',
            search: { ...search, tab: next as (typeof TABS)[number]['value'] },
            replace: true,
          });
        }}
        className="min-h-0 flex-1"
      >
        <PageTopbar>
          <PageHeader title="安全运营" />
          <PageToolbar>
            <TabsList variant="line" aria-label="安全运营分区">
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
            {tab === 'policies' ? <PoliciesSection /> : null}
            {tab === 'approvals' ? <ApprovalsSection /> : null}
            {tab === 'events' ? <EventsSection /> : null}
            {tab === 'violations' ? <ViolationsSection /> : null}
          </TabsContent>
        </PageBody>
      </Tabs>
    </Page>
  );
}

function PoliciesSection() {
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'security.manage');
  const policies = useSecurityPolicies();
  const remove = useDeleteSecurityPolicy();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContentPolicy | null>(null);
  const [deleting, setDeleting] = useState<ContentPolicy | null>(null);
  const rows = policies.data ?? [];

  const columns = useMemo<DataColumn<ContentPolicy>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        locked: true,
        width: 'minmax(150px,1.2fr)',
        sortValue: (policy) => policy.name,
        cell: (policy) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-fg [overflow-wrap:anywhere]">{policy.name}</span>
            {policy.agentId ? (
              <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {policy.agentId}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'direction',
        header: '方向',
        width: '72px',
        cell: (policy) => DIRECTION_LABEL[policy.direction],
      },
      {
        id: 'action',
        header: '动作',
        width: '96px',
        cell: (policy) => (
          <StatusBadge
            tone={
              policy.action === 'block'
                ? 'danger'
                : policy.action === 'require_approval'
                  ? 'warn'
                  : 'default'
            }
          >
            {ACTION_LABEL[policy.action]}
          </StatusBadge>
        ),
      },
      {
        id: 'matchType',
        header: '匹配类型',
        width: '96px',
        cell: (policy) => MATCH_LABEL[policy.matchType],
      },
      {
        id: 'pattern',
        header: 'pattern',
        width: 'minmax(140px,1fr)',
        cell: (policy) => (
          <span
            className="block max-w-64 truncate font-mono text-xs text-muted-foreground"
            title={policy.pattern}
          >
            {policy.pattern}
          </span>
        ),
      },
      {
        id: 'priority',
        header: '优先级',
        numeric: true,
        width: '76px',
        sortValue: (policy) => policy.priority,
        cell: (policy) => policy.priority,
      },
      {
        id: 'enabled',
        header: '启用',
        width: '72px',
        cell: (policy) => (
          <StatusBadge tone={policy.enabled ? 'success' : 'default'}>
            {policy.enabled ? '启用' : '停用'}
          </StatusBadge>
        ),
      },
      {
        id: 'version',
        header: '版本',
        numeric: true,
        width: '64px',
        sortValue: (policy) => policy.version,
        cell: (policy) => `v${policy.version}`,
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '108px',
        sortValue: (policy) => policy.updatedAt,
        cell: (policy) => (
          <span className="text-xs text-muted-foreground" title={formatDateTime(policy.updatedAt)}>
            {formatRelative(policy.updatedAt)}
          </span>
        ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: '操作',
              width: '120px',
              align: 'end' as const,
              cell: (policy: ContentPolicy) => (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(policy)}>
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除策略 ${policy.name}`}
                    onClick={() => setDeleting(policy)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ),
            },
          ]
        : []),
    ],
    [canManage],
  );

  return (
    <PageSection
      divided={false}
      title="内容策略"
      actions={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 新建策略
          </Button>
        ) : null
      }
    >
      {policies.isPending ? <LoadingState rows={4} /> : null}
      {policies.isError ? (
        <ErrorState
          error={policies.error}
          onRetry={() => void policies.refetch()}
          title="内容策略没有加载出来"
        />
      ) : null}
      {policies.data && rows.length === 0 ? (
        <EmptyState
          variant="stage"
          scale="section"
          specimen="security"
          title="建立内容安全策略"
          description="定义入站与出站检测规则，支持拦截、脱敏或转交人工审批。"
          action={
            canManage ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                新建策略
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(policy) => policy.id}
          rowLabel={(policy) => policy.name}
          label="内容策略"
          storageKey="pace.security.policy-columns"
        />
      ) : null}

      {creating ? <PolicyDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <PolicyDialog policy={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除内容策略"
          description={`删除「${deleting.name}」后，新请求不再按此策略检查；已有事件记录保留。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('策略已删除');
          }}
        />
      ) : null}
    </PageSection>
  );
}

const policyFormSchema = contentPolicyCreateSchema
  .pick({
    name: true,
    description: true,
    direction: true,
    action: true,
    matchType: true,
    pattern: true,
    priority: true,
    enabled: true,
  })
  .extend({
    caseSensitive: z.boolean(),
    agentId: z.string().max(160),
  });

type PolicyFormValues = z.infer<typeof policyFormSchema>;

function PolicyDialog({
  policy,
  onClose: onClosed,
}: {
  policy?: ContentPolicy;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateSecurityPolicy();
  const update = useUpdateSecurityPolicy();
  const defaults: PolicyFormValues = {
    name: policy?.name ?? '',
    description: policy?.description ?? '',
    direction: policy?.direction ?? 'inbound',
    action:
      policy?.direction === 'outbound' && policy.action === 'require_approval'
        ? 'block'
        : (policy?.action ?? 'block'),
    matchType: policy?.matchType ?? 'keyword',
    pattern: policy?.pattern ?? '',
    caseSensitive: policy?.caseSensitive ?? false,
    agentId: policy?.agentId ?? '',
    priority: policy?.priority ?? 100,
    enabled: policy?.enabled ?? true,
  };
  const { register, control, getValues, setValue, handleSubmit, formState } = useZodForm(
    policyFormSchema,
    { defaultValues: defaults },
  );
  const direction = useWatch({ control, name: 'direction' });
  const actionOptions = direction === 'outbound' ? OUTBOUND_ACTION_OPTIONS : ACTION_OPTIONS;
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
      const input = {
        ...values,
        agentId: values.agentId.trim() || null,
      };
      try {
        if (policy) {
          await update.mutateAsync({ id: policy.id, input });
          toastSuccess('策略已更新');
        } else {
          await create.mutateAsync(input);
          toastSuccess('策略已创建');
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
        title={policy ? '编辑策略' : '新建策略'}
        description="策略按优先级从高到低匹配，命中后执行所选动作。"
        className="max-w-xl sm:max-w-xl"
        closeDisabled={pending}
      >
        <form
          aria-label={policy ? '编辑策略' : '新建策略'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.name)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-name">
                  名称 <RequiredMark />
                </FieldLabel>
                <Input
                  id="policy-name"
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'policy-name-error' : undefined}
                  {...register('name')}
                />
                <FieldError id="policy-name-error">{errors.name?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.priority)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-priority">优先级</FieldLabel>
                <Input
                  id="policy-priority"
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  disabled={pending}
                  aria-invalid={Boolean(errors.priority)}
                  aria-describedby={errors.priority ? 'policy-priority-error' : undefined}
                  {...register('priority', { valueAsNumber: true })}
                />
                <FieldError id="policy-priority-error">{errors.priority?.message}</FieldError>
              </Field>
            </div>

            <Field data-invalid={Boolean(errors.description)} data-disabled={pending}>
              <FieldLabel htmlFor="policy-description">描述</FieldLabel>
              <Textarea
                id="policy-description"
                rows={2}
                disabled={pending}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={errors.description ? 'policy-description-error' : undefined}
                {...register('description')}
              />
              <FieldError id="policy-description-error">{errors.description?.message}</FieldError>
            </Field>

            <div className="grid gap-5 sm:grid-cols-3">
              <Field data-invalid={Boolean(errors.direction)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-direction">方向</FieldLabel>
                <Controller
                  control={control}
                  name="direction"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={DIRECTION_OPTIONS}
                      onValueChange={(next) => {
                        field.onChange(next);
                        if (next === 'outbound' && getValues('action') === 'require_approval') {
                          setValue('action', 'block', { shouldDirty: true, shouldValidate: true });
                        }
                      }}
                      disabled={pending}
                    >
                      <SelectTrigger
                        id="policy-direction"
                        className="w-full min-w-0"
                        ref={field.ref}
                        onBlur={field.onBlur}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {DIRECTION_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError>{errors.direction?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.action)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-action">动作</FieldLabel>
                <Controller
                  control={control}
                  name="action"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={actionOptions}
                      onValueChange={field.onChange}
                      disabled={pending}
                    >
                      <SelectTrigger
                        id="policy-action"
                        className="w-full min-w-0"
                        ref={field.ref}
                        onBlur={field.onBlur}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {actionOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError>{errors.action?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.matchType)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-match-type">匹配类型</FieldLabel>
                <Controller
                  control={control}
                  name="matchType"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={MATCH_OPTIONS}
                      onValueChange={field.onChange}
                      disabled={pending}
                    >
                      <SelectTrigger
                        id="policy-match-type"
                        className="w-full min-w-0"
                        ref={field.ref}
                        onBlur={field.onBlur}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {MATCH_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError>{errors.matchType?.message}</FieldError>
              </Field>
            </div>

            <Field data-invalid={Boolean(errors.pattern)} data-disabled={pending}>
              <FieldLabel htmlFor="policy-pattern">
                pattern <RequiredMark />
              </FieldLabel>
              <Input
                id="policy-pattern"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(errors.pattern)}
                aria-describedby={errors.pattern ? 'policy-pattern-error' : 'policy-pattern-hint'}
                {...register('pattern')}
              />
              <FieldDescription id="policy-pattern-hint">
                关键词用原文，正则或密钥按所选匹配类型填写。
              </FieldDescription>
              <FieldError id="policy-pattern-error">{errors.pattern?.message}</FieldError>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.agentId)} data-disabled={pending}>
                <FieldLabel htmlFor="policy-agent">专家范围</FieldLabel>
                <Input
                  id="policy-agent"
                  autoComplete="off"
                  placeholder="全部专家"
                  disabled={pending}
                  aria-invalid={Boolean(errors.agentId)}
                  aria-describedby={errors.agentId ? 'policy-agent-error' : 'policy-agent-hint'}
                  {...register('agentId')}
                />
                <FieldDescription id="policy-agent-hint">
                  填写专家 ID 时只作用于该专家，留空表示全部专家。
                </FieldDescription>
                <FieldError id="policy-agent-error">{errors.agentId?.message}</FieldError>
              </Field>
              <div className="flex flex-col gap-5">
                <Field
                  orientation="horizontal"
                  className="items-center gap-3"
                  data-disabled={pending}
                >
                  <FieldLabel htmlFor="policy-case-sensitive">区分大小写</FieldLabel>
                  <Controller
                    control={control}
                    name="caseSensitive"
                    render={({ field }) => (
                      <Switch
                        id="policy-case-sensitive"
                        ref={field.ref}
                        checked={field.value ?? false}
                        disabled={pending}
                        onCheckedChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    )}
                  />
                </Field>
                <Field
                  orientation="horizontal"
                  className="items-center gap-3"
                  data-disabled={pending}
                >
                  <FieldLabel htmlFor="policy-enabled">启用</FieldLabel>
                  <Controller
                    control={control}
                    name="enabled"
                    render={({ field }) => (
                      <Switch
                        id="policy-enabled"
                        ref={field.ref}
                        checked={field.value ?? true}
                        disabled={pending}
                        onCheckedChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    )}
                  />
                </Field>
              </div>
            </div>

            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : policy ? '保存更改' : '创建策略'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function ApprovalsSection() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'security.manage');
  const status = search.approvalStatus ?? 'pending';
  const approvals = useSecurityApprovals(status);
  const [deciding, setDeciding] = useState<PolicyApproval | null>(null);
  const rows = approvals.data?.pages.flatMap((page) => page.items) ?? [];

  const columns = useMemo<DataColumn<PolicyApproval>[]>(
    () => [
      {
        id: 'requestedAt',
        header: '请求时间',
        locked: true,
        width: '116px',
        sortValue: (approval) => approval.requestedAt,
        cell: (approval) => (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(approval.requestedAt)}
          >
            {formatRelative(approval.requestedAt)}
          </span>
        ),
      },
      {
        id: 'policy',
        header: '策略',
        width: 'minmax(140px,1.2fr)',
        sortValue: (approval) => approval.policyName,
        cell: (approval) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg [overflow-wrap:anywhere]">{approval.policyName}</span>
            <span className="text-xs text-muted-foreground">v{approval.policyVersion}</span>
          </span>
        ),
      },
      {
        id: 'requestedBy',
        header: '申请人',
        width: 'minmax(110px,1fr)',
        cell: (approval) => (
          <span className="font-mono text-xs text-fg [overflow-wrap:anywhere]">
            {approval.requestedBy}
          </span>
        ),
      },
      {
        id: 'destination',
        header: '目标',
        width: 'minmax(110px,1fr)',
        cell: (approval) =>
          approval.destination ? (
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {approval.destination}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'status',
        header: '状态',
        width: '88px',
        cell: (approval) => (
          <StatusBadge
            tone={
              approval.status === 'approved'
                ? 'success'
                : approval.status === 'rejected'
                  ? 'danger'
                  : approval.status === 'pending'
                    ? 'warn'
                    : 'default'
            }
          >
            {APPROVAL_STATUS_LABEL[approval.status]}
          </StatusBadge>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        width: '88px',
        align: 'end',
        cell: (approval) => (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setDeciding(approval)}>
              {canManage && approval.status === 'pending' ? '决策' : '查看'}
            </Button>
          </div>
        ),
      },
    ],
    [canManage],
  );

  return (
    <PageSection
      divided={false}
      title="外发审批"
      actions={
        <FilterSelect
          value={status}
          onValueChange={(next) =>
            void navigate({
              to: '/security',
              search: {
                ...search,
                approvalStatus: next === 'pending' ? undefined : (next as PolicyApprovalStatus),
              },
              replace: true,
            })
          }
          options={APPROVAL_STATUS_OPTIONS}
          label="按审批状态筛选"
          className="w-36"
        />
      }
    >
      {approvals.isPending ? <LoadingState rows={4} /> : null}
      {approvals.isError ? (
        <ErrorState
          error={approvals.error}
          onRetry={() => void approvals.refetch()}
          title="审批列表没有加载出来"
        />
      ) : null}
      {approvals.data && rows.length === 0 ? (
        status === 'pending' ? (
          <EmptyState
            variant="clear"
            scale="section"
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="没有待审批的外发内容"
            description="命中人工审批策略的请求会在此排队。"
          />
        ) : (
          <EmptyState
            variant="filter"
            scale="section"
            title={`没有${APPROVAL_STATUS_LABEL[status]}的外发审批`}
            activeFilters={[
              {
                key: 'approvalStatus',
                label: '审批状态',
                value: APPROVAL_STATUS_LABEL[status],
                onRemove: () =>
                  void navigate({
                    to: '/security',
                    search: { ...search, approvalStatus: undefined },
                    replace: true,
                  }),
              },
            ]}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/security',
                    search: { ...search, approvalStatus: undefined },
                    replace: true,
                  })
                }
              >
                查看待审批
              </Button>
            }
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(approval) => approval.id}
          rowLabel={(approval) => `${approval.policyName} · ${approval.requestedBy}`}
          label="外发审批"
          storageKey="pace.security.approval-columns"
        />
      ) : null}
      {rows.length > 0 ? <InfiniteFooter query={approvals} /> : null}

      {deciding ? (
        <ApprovalDialog
          approval={deciding}
          canManage={canManage}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </PageSection>
  );
}

function ApprovalDialog({
  approval,
  canManage,
  onClose: onClosed,
}: {
  approval: PolicyApproval;
  canManage: boolean;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const decide = useDecideSecurityApproval();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = decide.isPending;
  const actionable = canManage && approval.status === 'pending';

  const submit = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (pending) return;
    setError(null);
    try {
      await decide.mutateAsync({
        id: approval.id,
        input: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      toastSuccess(decision === 'approve' ? '已批准' : '已拒绝');
      dialog.close();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, dialog.close)}
    >
      <DialogShell
        title="外发审批"
        description={`${approval.policyName} · v${approval.policyVersion}`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">状态</dt>
            <dd>
              <StatusBadge
                tone={
                  approval.status === 'approved'
                    ? 'success'
                    : approval.status === 'rejected'
                      ? 'danger'
                      : approval.status === 'pending'
                        ? 'warn'
                        : 'default'
                }
              >
                {APPROVAL_STATUS_LABEL[approval.status]}
              </StatusBadge>
            </dd>
            <dt className="text-muted-foreground">来源</dt>
            <dd className="text-fg">
              {SOURCE_LABEL[approval.sourceKind]}
              <span className="ml-2 font-mono text-muted-foreground">{approval.sourceId}</span>
            </dd>
            <dt className="text-muted-foreground">目标</dt>
            <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
              {approval.destination ?? '—'}
            </dd>
            <dt className="text-muted-foreground">申请人</dt>
            <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
              {approval.requestedBy}
            </dd>
            <dt className="text-muted-foreground">请求时间</dt>
            <dd className="text-fg">{formatDateTime(approval.requestedAt)}</dd>
            <dt className="text-muted-foreground">到期时间</dt>
            <dd className="text-fg">{formatDateTime(approval.expiresAt)}</dd>
            <dt className="text-muted-foreground">载荷哈希</dt>
            <dd className="min-w-0 font-mono text-muted-foreground [overflow-wrap:anywhere]">
              {approval.payloadHash}
            </dd>
            {approval.decidedBy ? (
              <>
                <dt className="text-muted-foreground">决策人</dt>
                <dd className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                  {approval.decidedBy}
                </dd>
              </>
            ) : null}
            {approval.decidedAt ? (
              <>
                <dt className="text-muted-foreground">决策时间</dt>
                <dd className="text-fg">{formatDateTime(approval.decidedAt)}</dd>
              </>
            ) : null}
            {approval.note ? (
              <>
                <dt className="text-muted-foreground">备注</dt>
                <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{approval.note}</dd>
              </>
            ) : null}
          </dl>

          {actionable ? (
            <Field data-invalid={Boolean(error)} data-disabled={pending}>
              <FieldLabel htmlFor="approval-note">备注</FieldLabel>
              <Textarea
                id="approval-note"
                rows={3}
                maxLength={500}
                disabled={pending}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <FieldError>{error ?? undefined}</FieldError>
            </Field>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={dialog.close}>
              关闭
            </Button>
            {actionable ? (
              <>
                <Button
                  variant="destructive"
                  disabled={pending}
                  aria-busy={pending}
                  onClick={() => void submit('reject')}
                >
                  拒绝
                </Button>
                <Button
                  disabled={pending}
                  aria-busy={pending}
                  onClick={() => void submit('approve')}
                >
                  批准
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}

function EventsSection() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const action = search.eventAction;
  const sourceKind = search.eventSource;
  const events = useSecurityEvents({
    ...(action ? { action } : {}),
    ...(sourceKind ? { sourceKind } : {}),
  });
  const rows = events.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(action) || Boolean(sourceKind);

  const columns = useMemo<DataColumn<PolicyEvent>[]>(
    () => [
      {
        id: 'createdAt',
        header: '时间',
        locked: true,
        width: '116px',
        sortValue: (event) => event.createdAt,
        cell: (event) => (
          <span
            className="font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(event.createdAt)}
          >
            {formatRelative(event.createdAt)}
          </span>
        ),
      },
      {
        id: 'policy',
        header: '策略',
        width: 'minmax(130px,1.2fr)',
        sortValue: (event) => event.policyName,
        cell: (event) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg [overflow-wrap:anywhere]">{event.policyName}</span>
            <span className="text-xs text-muted-foreground">v{event.policyVersion}</span>
          </span>
        ),
      },
      {
        id: 'direction',
        header: '方向',
        width: '64px',
        cell: (event) => DIRECTION_LABEL[event.direction],
      },
      {
        id: 'action',
        header: '动作',
        width: '92px',
        cell: (event) => (
          <StatusBadge
            tone={
              event.action === 'block'
                ? 'danger'
                : event.action === 'require_approval'
                  ? 'warn'
                  : 'default'
            }
          >
            {ACTION_LABEL[event.action]}
          </StatusBadge>
        ),
      },
      {
        id: 'source',
        header: '来源',
        width: '96px',
        cell: (event) => SOURCE_LABEL[event.sourceKind],
      },
      {
        id: 'snippet',
        header: '摘要',
        width: 'minmax(160px,1.4fr)',
        cell: (event) => (
          <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
            {event.snippet}
          </span>
        ),
      },
      {
        id: 'runId',
        header: '运行',
        width: '92px',
        cell: (event) =>
          event.runId ? (
            <code className="font-mono text-xs text-muted-foreground" title={event.runId}>
              {shortId(event.runId)}
            </code>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'destination',
        header: '目标',
        width: 'minmax(100px,1fr)',
        cell: (event) =>
          event.destination ? (
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {event.destination}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <PageSection
      divided={false}
      title="策略事件"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            value={action ?? 'all'}
            onValueChange={(next) =>
              void navigate({
                to: '/security',
                search: {
                  ...search,
                  eventAction: next === 'all' ? undefined : (next as ContentPolicyAction),
                },
                replace: true,
              })
            }
            options={EVENT_ACTION_OPTIONS}
            label="按动作筛选"
            className="w-32"
          />
          <FilterSelect
            value={sourceKind ?? 'all'}
            onValueChange={(next) =>
              void navigate({
                to: '/security',
                search: {
                  ...search,
                  eventSource: next === 'all' ? undefined : (next as PolicySourceKind),
                },
                replace: true,
              })
            }
            options={EVENT_SOURCE_OPTIONS}
            label="按来源筛选"
            className="w-32"
          />
        </div>
      }
    >
      {events.isPending ? <LoadingState rows={4} /> : null}
      {events.isError ? (
        <ErrorState
          error={events.error}
          onRetry={() => void events.refetch()}
          title="策略事件没有加载出来"
        />
      ) : null}
      {events.data && rows.length === 0 ? (
        filtered ? (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配的策略事件"
            activeFilters={
              [
                ...(action
                  ? [
                      {
                        key: 'eventAction',
                        label: '动作',
                        value: ACTION_LABEL[action],
                        onRemove: () =>
                          void navigate({
                            to: '/security',
                            search: { ...search, eventAction: undefined },
                            replace: true,
                          }),
                      },
                    ]
                  : []),
                ...(sourceKind
                  ? [
                      {
                        key: 'eventSource',
                        label: '来源',
                        value: SOURCE_LABEL[sourceKind],
                        onRemove: () =>
                          void navigate({
                            to: '/security',
                            search: { ...search, eventSource: undefined },
                            replace: true,
                          }),
                      },
                    ]
                  : []),
              ] satisfies EmptyFilterChip[]
            }
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/security',
                    search: { ...search, eventAction: undefined, eventSource: undefined },
                    replace: true,
                  })
                }
              >
                清除全部筛选
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="clear"
            scale="section"
            icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            title="还没有触发策略事件"
            description="命中策略的请求会记录脱敏摘要。"
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(event) => event.id}
          rowLabel={(event) => `${event.policyName} · ${formatDateTime(event.createdAt)}`}
          label="策略事件"
          storageKey="pace.security.event-columns"
        />
      ) : null}
      {rows.length > 0 ? <InfiniteFooter query={events} /> : null}
    </PageSection>
  );
}

function ViolationsSection() {
  const search = useSearch({ from: '/_shell/security' });
  const navigate = useNavigate({ from: '/security' });
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'security.manage');
  const status = search.violationStatus ?? 'all';
  const violations = useSecurityViolations(status);
  const [editing, setEditing] = useState<ViolationCase | null>(null);
  const rows = violations.data?.pages.flatMap((page) => page.items) ?? [];

  const columns = useMemo<DataColumn<ViolationCase>[]>(
    () => [
      {
        id: 'createdAt',
        header: '时间',
        locked: true,
        width: '116px',
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
        width: 'minmax(130px,1.2fr)',
        sortValue: (violation) => violation.policyName,
        cell: (violation) => (
          <span className="text-fg [overflow-wrap:anywhere]">{violation.policyName}</span>
        ),
      },
      {
        id: 'subject',
        header: '主体',
        width: 'minmax(120px,1fr)',
        cell: (violation) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{SUBJECT_LABEL[violation.subjectKind]}</span>
            <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
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
          <StatusBadge
            tone={
              violation.severity === 'high'
                ? 'danger'
                : violation.severity === 'medium'
                  ? 'warn'
                  : 'default'
            }
          >
            {SEVERITY_LABEL[violation.severity]}
          </StatusBadge>
        ),
      },
      {
        id: 'status',
        header: '状态',
        width: '88px',
        cell: (violation) => (
          <StatusBadge
            tone={
              violation.status === 'resolved'
                ? 'success'
                : violation.status === 'investigating'
                  ? 'brand'
                  : violation.status === 'open'
                    ? 'warn'
                    : 'default'
            }
          >
            {VIOLATION_STATUS_LABEL[violation.status]}
          </StatusBadge>
        ),
      },
      {
        id: 'assignee',
        header: '负责人',
        width: 'minmax(100px,1fr)',
        cell: (violation) =>
          violation.assigneeBusinessId ? (
            <span className="font-mono text-xs text-fg [overflow-wrap:anywhere]">
              {violation.assigneeBusinessId}
            </span>
          ) : (
            <span className="text-muted-foreground">未指派</span>
          ),
      },
      {
        id: 'summary',
        header: '摘要',
        width: 'minmax(150px,1.4fr)',
        cell: (violation) => (
          <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
            {violation.summary}
          </span>
        ),
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '108px',
        sortValue: (violation) => violation.updatedAt,
        cell: (violation) => (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(violation.updatedAt)}
          >
            {formatRelative(violation.updatedAt)}
          </span>
        ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: '操作',
              width: '80px',
              align: 'end' as const,
              cell: (violation: ViolationCase) => (
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(violation)}>
                    处置
                  </Button>
                </div>
              ),
            },
          ]
        : []),
    ],
    [canManage],
  );

  return (
    <PageSection
      divided={false}
      title="违规处置"
      actions={
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
      }
    >
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
            activeFilters={[
              {
                key: 'violationStatus',
                label: '处置状态',
                value: VIOLATION_STATUS_LABEL[status],
                onRemove: () =>
                  void navigate({
                    to: '/security',
                    search: { ...search, violationStatus: undefined },
                    replace: true,
                  }),
              },
            ]}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/security',
                    search: { ...search, violationStatus: undefined },
                    replace: true,
                  })
                }
              >
                清除全部筛选
              </Button>
            }
          />
        )
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(violation) => violation.id}
          rowLabel={(violation) => `${violation.policyName} · ${violation.subjectId}`}
          label="违规处置"
          storageKey="pace.security.violation-columns"
        />
      ) : null}
      {rows.length > 0 ? <InfiniteFooter query={violations} /> : null}

      {editing ? <ViolationDialog violation={editing} onClose={() => setEditing(null)} /> : null}
    </PageSection>
  );
}

const violationFormSchema = violationCaseUpdateSchema.pick({ resolution: true }).extend({
  status: violationCaseStatusSchema,
  assigneeBusinessId: z.string().max(160),
  resolution: z.string().max(1000),
});

type ViolationFormValues = z.infer<typeof violationFormSchema>;

const VIOLATION_STATUS_ITEMS = Object.entries(VIOLATION_STATUS_LABEL).map(([value, label]) => ({
  value,
  label,
}));

function ViolationDialog({
  violation,
  onClose: onClosed,
}: {
  violation: ViolationCase;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
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
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
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
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title="违规处置"
        description={`${violation.policyName} · ${violation.subjectId}`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="违规处置"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel>摘要</FieldLabel>
              <p className="text-sm text-fg [overflow-wrap:anywhere]">{violation.summary}</p>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
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
              <Field data-invalid={Boolean(errors.assigneeBusinessId)} data-disabled={pending}>
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
                disabled={pending}
                aria-invalid={Boolean(errors.resolution)}
                aria-describedby={errors.resolution ? 'violation-resolution-error' : undefined}
                {...register('resolution')}
              />
              <FieldError id="violation-resolution-error">{errors.resolution?.message}</FieldError>
            </Field>

            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : '保存处置'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的处置内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
