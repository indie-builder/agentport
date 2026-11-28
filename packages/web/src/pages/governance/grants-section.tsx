import {
  type GovernanceResource,
  type ResourceGrant,
  type ResourceGrantInput,
  type ResourceKind,
  resourceGrantInputSchema,
  resourceKindSchema,
} from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { RequiredMark } from '../../components/required-mark.js';
import { SearchInput } from '../../components/search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../../components/ui/field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import {
  useDeleteResourceGrant,
  useGovernanceResources,
  useResourceGrants,
  useUpsertResourceGrant,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { useOptimisticValue } from '../../lib/use-optimistic-value.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { AccountCombobox } from './account-combobox.js';

const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = {
  knowledge_base: '知识库',
  data_domain: '数据域',
  skill: '技能',
  server: '连接器',
  plugin: '插件',
  runtime_environment: '运行环境',
};

export function GrantsSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const resourceKind = search.resourceKind ?? 'knowledge_base';
  const [optimisticKind, commitKind] = useOptimisticValue(resourceKind);
  const query = search.resourceQ ?? '';
  const settled = useDebouncedValue(query.trim(), 300);
  const resources = useGovernanceResources(resourceKind, settled);
  const resourceId = search.resourceId ?? '';
  const grants = useResourceGrants(resourceKind, resourceId);
  const revoke = useDeleteResourceGrant();
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<ResourceGrant | null>(null);
  const resourceCache = useRef(new Map<string, GovernanceResource>());
  const items = resources.data ?? [];
  for (const item of items) {
    resourceCache.current.set(`${resourceKind}:${item.id}`, item);
  }
  const cacheKey = `${resourceKind}:${resourceId}`;
  const selected =
    items.find((item) => item.id === resourceId) ?? resourceCache.current.get(cacheKey) ?? null;
  const resourceNotFound =
    resources.isSuccess && !resources.hasNextPage && !settled && resourceId.length > 0 && !selected;
  const grantRows = grants.data ?? [];

  const columns = useMemo<DataColumn<ResourceGrant>[]>(() => {
    const base: DataColumn<ResourceGrant>[] = [
      {
        id: 'account',
        header: '账户',
        locked: true,
        width: 'minmax(180px,1.5fr)',
        sortValue: (grant) => grant.name,
        cell: (grant) => (
          <div className="min-w-0">
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
              title={grant.name}
            >
              {grant.name}
            </span>
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={grant.businessId}
            >
              {grant.businessId}
            </span>
          </div>
        ),
      },
      {
        id: 'permissions',
        header: '权限',
        width: 'minmax(160px,1.2fr)',
        sortValue: (grant) => (grant.canManage ? 2 : 0) + (grant.canUse ? 1 : 0),
        cell: (grant) => (
          <div className="flex flex-wrap items-center gap-1">
            {grant.canUse ? <StatusBadge>可使用</StatusBadge> : null}
            {grant.canManage ? <StatusBadge>可管理</StatusBadge> : null}
            {grant.accountActive ? null : <StatusBadge tone="danger">停用</StatusBadge>}
          </div>
        ),
      },
    ];

    if (canManage) {
      base.push({
        id: 'actions',
        header: '操作',
        locked: true,
        align: 'end',
        width: '72px',
        cell: (grant) => (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`撤销 ${grant.name} 的授权`}
            onClick={() => setRevoking(grant)}
          >
            撤销
          </Button>
        ),
      });
    }

    return base;
  }, [canManage]);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-3">
        <div className="flex min-w-0 flex-col gap-2">
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
            <SelectTrigger className="w-full min-w-0" aria-label="资源类型">
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
          />
        </div>

        <nav
          aria-label="资源列表"
          className="flex min-h-[260px] max-h-[calc(100vh-280px)] min-w-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
        >
          {resources.isPending ? <LoadingState rows={4} /> : null}
          {resources.isError ? (
            <ErrorState error={resources.error} onRetry={() => void resources.refetch()} />
          ) : null}
          {resources.data && items.length === 0 ? (
            <EmptyState variant="filter" scale="inline" title="没有匹配的资源" />
          ) : null}
          {items.map((item) => {
            const active = item.id === resourceId;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() =>
                  void navigate({
                    to: '/governance',
                    search: { ...search, resourceId: item.id },
                    replace: true,
                  })
                }
                className={cn(
                  'flex min-w-0 flex-col gap-0.5 rounded-item px-2.5 py-2 text-left transition-colors duration-150 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-selected text-fg' : 'text-fg hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm',
                    active && 'font-medium',
                  )}
                  title={item.name}
                >
                  {item.name}
                </span>
                {item.ownerName ? (
                  <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                    {item.ownerName}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <CursorListFooter query={resources} label="资源" />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {resourceId.length === 0 ? (
          <EmptyState
            variant="idle"
            scale="section"
            icon={<KeyRound className="size-5" aria-hidden="true" />}
            title="先选择一个资源"
            description="在左侧选择具体知识库、数据域、技能、连接器、插件或运行环境，查看并分配细粒度权限。"
          />
        ) : resourceNotFound ? (
          <EmptyState
            variant="idle"
            scale="section"
            icon={<KeyRound className="size-5" aria-hidden="true" />}
            title="未找到该资源"
            description="该资源可能已被删除，或当前账户无权查看，请在左侧重新选择。"
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-base font-medium text-fg"
                  title={selected?.name ?? resourceId}
                >
                  {selected?.name ?? resourceId}
                </span>
                <StatusBadge>{RESOURCE_KIND_LABEL[resourceKind]}</StatusBadge>
                {selected?.ownerName ? (
                  <span className="text-xs text-muted-foreground">
                    所有者：{selected.ownerName}
                  </span>
                ) : null}
              </div>
              {canManage ? (
                <Button disabled={grants.isPending} onClick={() => setAdding(true)}>
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新增授权
                </Button>
              ) : null}
            </div>

            {grants.isPending ? <LoadingState rows={3} /> : null}
            {grants.isError ? (
              <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />
            ) : null}
            {grants.data && grantRows.length === 0 ? (
              <EmptyState
                variant="clear"
                scale="section"
                icon={<ShieldCheck className="size-5" aria-hidden="true" />}
                title="暂未配置额外授权"
                description="当前仅资源所有者与平台管理员可访问。"
                action={
                  canManage ? (
                    <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                      新增授权
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            {grantRows.length > 0 ? (
              <DataTable
                rows={grantRows}
                columns={columns}
                rowKey={(grant) => `${grant.resourceKind}-${grant.resourceId}-${grant.businessId}`}
                rowLabel={(grant) => grant.name}
                label="资源授权列表"
                storageKey="pace.governance.grants-columns"
              />
            ) : null}
          </>
        )}
      </div>

      {adding && !resourceNotFound ? (
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
    </div>
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
        title="新增资源授权"
        description={`${RESOURCE_KIND_LABEL[resourceKind]} · ${resourceName}`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="新增资源授权"
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
                  <AccountCombobox
                    id="grant-account"
                    label="账户"
                    value={field.value}
                    onChange={(businessId) => field.onChange(businessId)}
                    disabled={pending}
                    excludeBusinessIds={existing.map((grant) => grant.businessId)}
                    inputRef={field.ref}
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
                        aria-invalid={Boolean(errors.canUse)}
                        aria-describedby={errors.canUse ? 'grant-permissions-error' : undefined}
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
                        aria-invalid={Boolean(errors.canUse)}
                        aria-describedby={errors.canUse ? 'grant-permissions-error' : undefined}
                        onCheckedChange={field.onChange}
                      />
                      可管理
                      <span className="text-xs text-muted-foreground">包含全部管理操作</span>
                    </label>
                  )}
                />
              </div>
              <FieldError id="grant-permissions-error">{errors.canUse?.message}</FieldError>
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
