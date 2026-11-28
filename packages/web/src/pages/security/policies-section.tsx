import { type ContentPolicy, contentPolicyCreateSchema } from '@agentport/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Controller, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CopyButton } from '../../components/copy-button.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { RequiredMark } from '../../components/required-mark.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../../components/ui/number-input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { errorMessage } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import {
  useCreateSecurityPolicy,
  useDeleteSecurityPolicy,
  useSecurityPolicies,
  useUpdateSecurityPolicy,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import {
  ACTION_LABEL,
  ACTION_OPTIONS,
  DIRECTION_LABEL,
  DIRECTION_OPTIONS,
  MATCH_LABEL,
  MATCH_OPTIONS,
  OUTBOUND_ACTION_OPTIONS,
  policyActionTone,
} from './shared.js';

export function PoliciesSection({
  canManage,
  creating,
  onCreatingChange,
}: {
  canManage: boolean;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const policies = useSecurityPolicies();
  const update = useUpdateSecurityPolicy();
  const remove = useDeleteSecurityPolicy();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ContentPolicy | null>(null);
  const [deleting, setDeleting] = useState<ContentPolicy | null>(null);
  const [toggling, setToggling] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastRowRef = useRef<ContentPolicy | null>(null);
  const rows = policies.data ?? [];

  const selectedRow = selectedId ? (rows.find((row) => row.id === selectedId) ?? null) : null;
  if (selectedRow) lastRowRef.current = selectedRow;
  const displayedRow = selectedRow ?? lastRowRef.current;
  const sheet = useDialogClose(() => setSelectedId(null), selectedId !== null);

  const openInspector = useCallback((policy: ContentPolicy, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    lastRowRef.current = policy;
    setSelectedId(policy.id);
  }, []);

  const toggleEnabled = async (policy: ContentPolicy): Promise<void> => {
    if (toggling) return;
    setToggling(true);
    try {
      await update.mutateAsync({ id: policy.id, input: { enabled: !policy.enabled } });
      toastSuccess(policy.enabled ? '策略已停用' : '策略已启用');
    } catch (cause) {
      toastError(cause);
    } finally {
      setToggling(false);
    }
  };

  const columns = useMemo<DataColumn<ContentPolicy>[]>(
    () => [
      {
        id: 'name',
        header: '名称',
        locked: true,
        width: 'minmax(180px,1.5fr)',
        sortValue: (policy) => policy.name,
        cell: (policy) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
            title={policy.name}
          >
            {policy.name}
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
          <StatusBadge tone={policyActionTone(policy.action)}>
            {ACTION_LABEL[policy.action]}
          </StatusBadge>
        ),
      },
      {
        id: 'matchType',
        header: '匹配类型',
        width: '88px',
        cell: (policy) => MATCH_LABEL[policy.matchType],
      },
      {
        id: 'enabled',
        header: '状态',
        width: '76px',
        cell: (policy) => (
          <StatusBadge tone={policy.enabled ? 'success' : 'default'}>
            {policy.enabled ? '启用' : '停用'}
          </StatusBadge>
        ),
      },
      {
        id: 'pattern',
        header: '匹配规则',
        width: 'minmax(160px,1.2fr)',
        hiddenByDefault: true,
        cell: (policy) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
            title={policy.pattern}
          >
            {policy.pattern}
          </span>
        ),
      },
      {
        id: 'agentId',
        header: '专家范围',
        width: 'minmax(120px,1fr)',
        hiddenByDefault: true,
        cell: (policy) =>
          policy.agentId ? (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={policy.agentId}
            >
              {policy.agentId}
            </span>
          ) : (
            <span className="text-muted-foreground">全部专家</span>
          ),
      },
      {
        id: 'priority',
        header: '优先级',
        numeric: true,
        width: '76px',
        hiddenByDefault: true,
        sortValue: (policy) => policy.priority,
        cell: (policy) => policy.priority,
      },
      {
        id: 'version',
        header: '版本',
        numeric: true,
        width: '64px',
        hiddenByDefault: true,
        sortValue: (policy) => policy.version,
        cell: (policy) => `v${policy.version}`,
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '112px',
        hiddenByDefault: true,
        sortValue: (policy) => policy.updatedAt,
        cell: (policy) => (
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            title={formatDateTime(policy.updatedAt)}
          >
            {formatRelative(policy.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        width: '80px',
        align: 'end',
        cell: (policy) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`查看策略 ${policy.name} 详情`}
              onClick={(event) => openInspector(policy, event.currentTarget)}
            >
              详情
            </Button>
          </div>
        ),
      },
    ],
    [openInspector],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
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
              <Button variant="outline" size="sm" onClick={() => onCreatingChange(true)}>
                新建策略
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <>
          <div className="flex items-center justify-end">
            <span role="status" className="text-xs tabular-nums text-muted-foreground">
              共 {rows.length} 条策略
            </span>
          </div>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(policy) => policy.id}
            rowLabel={(policy) => policy.name}
            label="内容策略"
            storageKey="pace.security.policies-columns"
            hideRowCount
            onRowClick={openInspector}
          />
        </>
      ) : null}

      <InspectorSheet
        open={sheet.open}
        onOpenChange={(next) => {
          if (!next && !toggling) sheet.close();
        }}
        onOpenChangeComplete={(next) => {
          sheet.onOpenChangeComplete(next);
          if (!next) lastRowRef.current = null;
        }}
        size="md"
        title={displayedRow?.name ?? '策略详情'}
        eyebrow={
          displayedRow ? (
            <StatusBadge tone={displayedRow.enabled ? 'success' : 'default'}>
              {displayedRow.enabled ? '启用' : '停用'}
            </StatusBadge>
          ) : null
        }
        description={
          displayedRow
            ? `v${displayedRow.version} · 更新于 ${formatDateTime(displayedRow.updatedAt)}`
            : undefined
        }
        closeDisabled={toggling}
        finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
        footer={
          canManage && displayedRow ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={toggling}
                onClick={() => setDeleting(displayedRow)}
              >
                删除
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggling}
                  aria-busy={toggling}
                  onClick={() => void toggleEnabled(displayedRow)}
                >
                  {displayedRow.enabled ? '停用' : '启用'}
                </Button>
                <Button size="sm" disabled={toggling} onClick={() => setEditing(displayedRow)}>
                  编辑
                </Button>
              </div>
            </div>
          ) : undefined
        }
      >
        {displayedRow ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg">基础信息</h2>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">方向</dt>
                <dd className="min-w-0 text-fg">{DIRECTION_LABEL[displayedRow.direction]}</dd>
                <dt className="text-muted-foreground">动作</dt>
                <dd>
                  <StatusBadge tone={policyActionTone(displayedRow.action)}>
                    {ACTION_LABEL[displayedRow.action]}
                  </StatusBadge>
                </dd>
                <dt className="text-muted-foreground">匹配类型</dt>
                <dd className="min-w-0 text-fg">{MATCH_LABEL[displayedRow.matchType]}</dd>
                <dt className="text-muted-foreground">优先级</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">{displayedRow.priority}</dd>
                <dt className="text-muted-foreground">区分大小写</dt>
                <dd className="min-w-0 text-fg">{displayedRow.caseSensitive ? '是' : '否'}</dd>
                <dt className="text-muted-foreground">专家范围</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  {displayedRow.agentId ? (
                    <>
                      <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                        {displayedRow.agentId}
                      </span>
                      <CopyButton
                        value={displayedRow.agentId}
                        label="复制专家 ID"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </>
                  ) : (
                    <span className="text-fg">全部专家</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">策略 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 font-mono text-fg [overflow-wrap:anywhere]">
                    {displayedRow.id}
                  </span>
                  <CopyButton
                    value={displayedRow.id}
                    label="复制策略 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </dd>
                <dt className="text-muted-foreground">创建时间</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">
                  {formatDateTime(displayedRow.createdAt)}
                </dd>
                <dt className="text-muted-foreground">更新时间</dt>
                <dd className="min-w-0 font-mono tabular-nums text-fg">
                  {formatDateTime(displayedRow.updatedAt)}
                </dd>
              </dl>
            </section>

            <section className="flex flex-col gap-2 border-t border-line pt-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-fg">匹配规则</h2>
                <CopyButton
                  value={displayedRow.pattern}
                  label="复制规则"
                  className="-my-1 -mr-1.5 shrink-0"
                />
              </div>
              <pre className="overflow-x-auto rounded-item border border-code-line bg-code p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                {displayedRow.pattern}
              </pre>
            </section>

            {displayedRow.description ? (
              <section className="flex flex-col gap-2 border-t border-line pt-5">
                <h2 className="text-sm font-medium text-fg">描述</h2>
                <p className="text-sm leading-6 text-fg [overflow-wrap:anywhere]">
                  {displayedRow.description}
                </p>
              </section>
            ) : null}
          </div>
        ) : null}
      </InspectorSheet>

      {creating ? <PolicyDialog onClose={() => onCreatingChange(false)} /> : null}
      {editing ? <PolicyDialog policy={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除内容策略"
          description={`删除「${deleting.name}」后，新请求不再按此策略检查；已有事件记录保留。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const deletedId = deleting.id;
            await remove.mutateAsync(deletedId);
            toastSuccess('策略已删除');
            if (selectedId === deletedId) sheet.close();
          }}
        />
      ) : null}
    </div>
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
                <Controller
                  control={control}
                  name="priority"
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
                          id="policy-priority"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.priority)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
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
                匹配规则 <RequiredMark />
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
