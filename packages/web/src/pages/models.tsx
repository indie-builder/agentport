import { type ModelProvider, modelProviderCreateSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterPopover } from '../components/filter-popover.js';
import { FilterSelect } from '../components/filter-select.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageSection,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RecordRows } from '../components/record-rows.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import {
  type EmptyFilterChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
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
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  NumberInput,
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
} from '../components/ui/number-input.js';
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from '../components/ui/password-input.js';
import { Switch } from '../components/ui/switch.js';
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { formatCost, formatDateTime, formatRelative, formatTokens } from '../lib/format.js';
import {
  meQuery,
  useCreateModelProvider,
  useDeleteModelProvider,
  useModelProviders,
  useTestModelProvider,
  useUpdateModelProvider,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const HEALTH_LABEL: Record<ModelProvider['health']['state'], string> = {
  unknown: '未检测',
  healthy: '正常',
  unhealthy: '异常',
};

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已停用' },
];

function baseHost(value: string): string {
  return URL.canParse(value) ? new URL(value).host : value;
}

export function ModelsPage() {
  const search = useSearch({ from: '/_shell/models' });
  const navigate = useNavigate({ from: '/models' });
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'models.manage');
  const providers = useModelProviders();
  const remove = useDeleteModelProvider();
  const test = useTestModelProvider();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [deleting, setDeleting] = useState<ModelProvider | null>(null);

  const rows = providers.data ?? [];
  const q = (search.q ?? '').trim().toLowerCase();
  const status = search.status ?? 'all';
  const view: ListView = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({
      to: '/models',
      search: { ...search, view: next === 'cards' ? undefined : next },
    });
  };
  const filtered = rows.filter((provider) => {
    if (status === 'enabled' && !provider.enabled) return false;
    if (status === 'disabled' && provider.enabled) return false;
    if (!q) return true;
    return (
      provider.name.toLowerCase().includes(q) ||
      provider.baseUrl.toLowerCase().includes(q) ||
      provider.models.some((model) => model.toLowerCase().includes(q))
    );
  });
  const totalCost = rows.reduce((sum, provider) => sum + provider.usage.costUsd, 0);
  const budgets = rows.flatMap((provider) =>
    provider.monthlyBudgetUsd === null ? [] : [provider.monthlyBudgetUsd],
  );
  const totalBudget = budgets.reduce((sum, value) => sum + value, 0);

  const runTest = (provider: ModelProvider): void => {
    test.mutate(provider.id, {
      onSuccess: (result) => {
        if (result.ok) {
          toastSuccess(`连接正常${result.latencyMs === null ? '' : ` · ${result.latencyMs} ms`}`);
        } else {
          toastError(new Error(result.message));
        }
      },
      onError: toastError,
    });
  };

  const columns: DataColumn<ModelProvider>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(150px,1.2fr)',
      sortValue: (provider) => provider.name,
      cell: (provider) => (
        <span className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">
          {provider.name}
        </span>
      ),
    },
    {
      id: 'protocol',
      header: '协议',
      width: '112px',
      cell: () => 'Anthropic',
    },
    {
      id: 'baseUrl',
      header: 'Base URL',
      width: 'minmax(140px,1fr)',
      cell: (provider) => (
        <span className="min-w-0 font-mono text-xs text-muted-foreground">
          {baseHost(provider.baseUrl)}
        </span>
      ),
    },
    {
      id: 'models',
      header: '模型',
      width: 'minmax(160px,1fr)',
      cell: (provider) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {provider.models.slice(0, 2).map((model) => (
            <StatusBadge key={model} tone="mono">
              {model}
            </StatusBadge>
          ))}
          {provider.models.length > 2 ? (
            <span className="text-xs text-muted-foreground">+{provider.models.length - 2}</span>
          ) : null}
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
      id: 'health',
      header: '健康',
      width: '116px',
      sortValue: (provider) => provider.health.state,
      cell: (provider) => (
        <span className="flex min-w-0 flex-col gap-1">
          <StatusBadge
            tone={
              provider.health.state === 'healthy'
                ? 'success'
                : provider.health.state === 'unhealthy'
                  ? 'danger'
                  : 'default'
            }
          >
            {HEALTH_LABEL[provider.health.state]}
          </StatusBadge>
          {provider.health.message ? (
            <span
              className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
              title={provider.health.message}
            >
              {provider.health.message}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'usage',
      header: '本月成本 / 预算',
      numeric: true,
      width: '132px',
      sortValue: (provider) => provider.usage.costUsd,
      cell: (provider) => (
        <span className="tabular-nums">
          {formatCost(provider.usage.costUsd)}
          <span className="text-muted-foreground">
            {' / '}
            {provider.monthlyBudgetUsd === null
              ? '未设预算'
              : formatCost(provider.monthlyBudgetUsd)}
          </span>
        </span>
      ),
    },
    {
      id: 'enabled',
      header: '启用',
      width: '76px',
      cell: (provider) => (
        <StatusBadge tone={provider.enabled ? 'success' : 'default'}>
          {provider.enabled ? '启用' : '停用'}
        </StatusBadge>
      ),
    },
    {
      id: 'updatedAt',
      header: '更新时间',
      width: '108px',
      sortValue: (provider) => provider.updatedAt,
      cell: (provider) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(provider.updatedAt)}>
          {formatRelative(provider.updatedAt)}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '操作',
            width: '196px',
            align: 'end' as const,
            cell: (provider: ModelProvider) => (
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`编辑供应商 ${provider.name}`}
                  onClick={() => setEditing(provider)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`测试供应商 ${provider.name} 连接`}
                  disabled={test.isPending && test.variables === provider.id}
                  onClick={() => runTest(provider)}
                >
                  测试连接
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除供应商 ${provider.name}`}
                  onClick={() => setDeleting(provider)}
                >
                  <Trash2 />
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  const expanded = (provider: ModelProvider) => (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        {provider.models.map((model) => (
          <StatusBadge key={model} tone="mono">
            {model}
          </StatusBadge>
        ))}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted-foreground">凭证</dt>
        <dd className="text-fg">{provider.hasCredential ? '已配置' : '未配置'}</dd>
        <dt className="text-muted-foreground">最近成功</dt>
        <dd className="text-fg">{formatDateTime(provider.lastSuccessAt)}</dd>
        <dt className="text-muted-foreground">最近错误</dt>
        <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
          {provider.lastError ?? <span className="text-muted-foreground">无</span>}
          {provider.lastErrorAt ? (
            <span className="text-muted-foreground"> · {formatDateTime(provider.lastErrorAt)}</span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">健康详情</dt>
        <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">
          {provider.health.message ?? '—'}
          {provider.health.checkedAt ? (
            <span className="text-muted-foreground">
              {' '}
              · {formatDateTime(provider.health.checkedAt)}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">本月请求</dt>
        <dd className="text-fg tabular-nums">{provider.usage.requests}</dd>
        <dt className="text-muted-foreground">本月 token</dt>
        <dd className="text-fg tabular-nums">
          {formatTokens(provider.usage.inputTokens)} 输入 /{' '}
          {formatTokens(provider.usage.outputTokens)} 输出
        </dd>
      </dl>
    </div>
  );

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="模型供应商"
          {...(rows.length > 0
            ? {
                description: `本月成本 ${formatCost(totalCost)}${
                  budgets.length > 0 ? ` / 预算 ${formatCost(totalBudget)}` : ''
                }`,
              }
            : {})}
          actions={
            canManage ? (
              <Button onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" aria-hidden="true" /> 新建供应商
              </Button>
            ) : undefined
          }
        />
        <PageToolbar>
          <SearchInput
            label="搜索模型供应商"
            placeholder="名称、地址或模型…"
            value={search.q ?? ''}
            onChange={(value) =>
              void navigate({
                to: '/models',
                search: { ...search, q: value || undefined },
                replace: true,
              })
            }
            className="w-full sm:w-56"
          />
          <FilterPopover activeCount={status === 'all' ? 0 : 1}>
            <FilterSelect
              value={status}
              onValueChange={(next) =>
                void navigate({
                  to: '/models',
                  search: {
                    ...search,
                    status: next === 'all' ? undefined : (next as 'enabled' | 'disabled'),
                  },
                  replace: true,
                })
              }
              options={statusOptions}
              label="按启用状态筛选"
              className="w-full"
            />
          </FilterPopover>
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            {filtered.length > 0 ? (
              <>
                <span role="status" className="text-xs text-muted-foreground">
                  共 {filtered.length} 个供应商
                </span>
                <ViewToggle value={view} onChange={setView} />
              </>
            ) : null}
          </div>
        </PageToolbar>
      </PageTopbar>

      <PageBody>
        <PageSection divided={false} className="min-w-0">
          {providers.isPending ? <LoadingState rows={4} /> : null}
          {providers.isError ? (
            <ErrorState
              error={providers.error}
              onRetry={() => void providers.refetch()}
              title="模型供应商没有加载出来"
            />
          ) : null}
          {providers.data && rows.length === 0 ? (
            <EmptyState
              variant="stage"
              scale="page"
              specimen="models"
              title="配置模型供应商"
              description="接入 LLM 与向量模型端点后，专家运行与知识库检索即可生效。"
              action={
                canManage ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新建供应商
                  </Button>
                ) : undefined
              }
              footer={canManage ? undefined : '当前账户没有管理模型供应商的权限。'}
            />
          ) : null}
          {rows.length > 0 && filtered.length === 0 ? (
            <EmptyState
              variant="filter"
              scale="section"
              title="没有匹配的模型供应商"
              activeFilters={
                [
                  ...(search.q?.trim()
                    ? [
                        {
                          key: 'q',
                          label: '关键词',
                          value: search.q.trim(),
                          onRemove: () =>
                            void navigate({
                              to: '/models',
                              search: { ...search, q: undefined },
                              replace: true,
                            }),
                        },
                      ]
                    : []),
                  ...(status !== 'all'
                    ? [
                        {
                          key: 'status',
                          label: '状态',
                          value: status === 'enabled' ? '已启用' : '已停用',
                          onRemove: () =>
                            void navigate({
                              to: '/models',
                              search: { ...search, status: undefined },
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
                  onClick={() => void navigate({ to: '/models', search: {} })}
                >
                  清除全部筛选
                </Button>
              }
            />
          ) : null}
          {filtered.length > 0 && view !== 'cards' ? (
            <DataTable
              rows={filtered}
              columns={columns}
              rowKey={(provider) => provider.id}
              rowLabel={(provider) => provider.name}
              label="模型供应商"
              storageKey="pace.models.provider-columns"
              renderExpanded={expanded}
              hideRowCount
            />
          ) : null}
          {filtered.length > 0 && view === 'cards' ? (
            <ul
              aria-label="模型供应商列表"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4 pt-2"
            >
              {filtered.map((provider) => (
                <li key={provider.id} className="min-w-0">
                  <Card size="sm" className="h-full">
                    <CardHeader className="grid-cols-[minmax(0,1fr)_auto]! items-center">
                      <CardTitle className="min-w-0 truncate" title={provider.name}>
                        {provider.name}
                      </CardTitle>
                      <CardAction className="col-start-2 row-start-1 flex items-center gap-1 self-center">
                        <StatusBadge tone={provider.enabled ? 'success' : 'default'}>
                          {provider.enabled ? '启用' : '停用'}
                        </StatusBadge>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col gap-3">
                      <RecordRows
                        rows={[
                          {
                            label: '模型',
                            value: provider.models.length
                              ? `${provider.models.length} 个：${provider.models.slice(0, 2).join('、')}${provider.models.length > 2 ? ' 等' : ''}`
                              : '—',
                          },
                          {
                            label: '健康',
                            value: (
                              <StatusBadge
                                tone={
                                  provider.health.state === 'healthy'
                                    ? 'success'
                                    : provider.health.state === 'unhealthy'
                                      ? 'danger'
                                      : 'default'
                                }
                              >
                                {HEALTH_LABEL[provider.health.state]}
                              </StatusBadge>
                            ),
                          },
                          {
                            label: '本月成本 / 预算',
                            value: (
                              <span className="tabular-nums">
                                {formatCost(provider.usage.costUsd)}
                                <span className="text-muted-foreground">
                                  {' / '}
                                  {provider.monthlyBudgetUsd === null
                                    ? '未设预算'
                                    : formatCost(provider.monthlyBudgetUsd)}
                                </span>
                              </span>
                            ),
                          },
                        ]}
                      />
                    </CardContent>
                    {canManage ? (
                      <CardFooter className="justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`编辑供应商 ${provider.name}`}
                          onClick={() => setEditing(provider)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`测试供应商 ${provider.name} 连接`}
                          disabled={test.isPending && test.variables === provider.id}
                          onClick={() => runTest(provider)}
                        >
                          测试连接
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除供应商 ${provider.name}`}
                          onClick={() => setDeleting(provider)}
                        >
                          <Trash2 />
                        </Button>
                      </CardFooter>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          ) : null}
        </PageSection>
      </PageBody>

      {creating ? <ProviderDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <ProviderDialog provider={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除模型供应商"
          description={`只有未产生请求日志、也未被运行或审批引用的供应商才能删除。如果「${deleting.name}」已有历史记录，请停用。`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('供应商已删除');
          }}
        />
      ) : null}
    </Page>
  );
}

const providerFormSchema = modelProviderCreateSchema
  .pick({
    name: true,
    baseUrl: true,
    priority: true,
    enabled: true,
    monthlyBudgetUsd: true,
  })
  .extend({
    models: z.string().min(1, '至少填写一个模型。'),
    credential: z
      .string()
      .max(4096)
      .regex(/^[\x21-\x7E]*$/, '只能包含可见 ASCII 字符'),
    alertRatio: z.number().min(0, '不能小于 0。').max(1, '不能大于 1。'),
  });

type ProviderFormValues = z.infer<typeof providerFormSchema>;

function ProviderDialog({
  provider,
  onClose: onClosed,
}: {
  provider?: ModelProvider;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateModelProvider();
  const update = useUpdateModelProvider();
  const defaults: ProviderFormValues = {
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? '',
    models: provider?.models.join(', ') ?? '',
    credential: '',
    priority: provider?.priority ?? 100,
    enabled: provider?.enabled ?? true,
    monthlyBudgetUsd: provider?.monthlyBudgetUsd ?? null,
    alertRatio: provider?.alertRatio ?? 0.8,
  };
  const {
    register,
    control,
    handleSubmit,
    setError: setFieldError,
    formState,
  } = useZodForm(providerFormSchema, { defaultValues: defaults });
  const { errors, isDirty } = formState;
  const {
    name: credentialName,
    ref: credentialRef,
    onChange: onCredentialChange,
    onBlur: onCredentialBlur,
  } = register('credential');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = (create.isPending || update.isPending) && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values) => {
      if (pending) return;
      setError(null);
      const models = values.models
        .split(/[,，\n]/)
        .map((model) => model.trim())
        .filter(Boolean);
      if (models.length === 0) {
        setFieldError('models', { message: '至少填写一个模型。' });
        return;
      }
      const credential = values.credential.trim();
      if (!provider && !credential) {
        setFieldError('credential', { message: '请填写凭证。' });
        return;
      }
      try {
        const base = {
          name: values.name,
          baseUrl: values.baseUrl,
          models,
          priority: values.priority,
          enabled: values.enabled,
          monthlyBudgetUsd: values.monthlyBudgetUsd,
          alertRatio: values.alertRatio,
        };
        if (provider) {
          await update.mutateAsync({
            id: provider.id,
            input: { ...base, ...(credential ? { credential } : {}) },
          });
          toastSuccess('供应商已更新');
        } else {
          await create.mutateAsync({ ...base, protocol: 'anthropic', credential });
          toastSuccess('供应商已创建');
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
        title={provider ? '编辑供应商' : '新建供应商'}
        description={provider ? '凭证留空时保留现有配置。' : '凭证只保存到服务端，不会回显。'}
        className="max-w-xl sm:max-w-xl"
        closeDisabled={pending}
      >
        <form
          aria-label={provider ? '编辑供应商' : '新建供应商'}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(errors.name)} data-disabled={pending}>
              <FieldLabel htmlFor="provider-name">
                名称 <RequiredMark />
              </FieldLabel>
              <Input
                id="provider-name"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'provider-name-error' : undefined}
                {...register('name')}
              />
              <FieldError id="provider-name-error">{errors.name?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.baseUrl)} data-disabled={pending}>
              <FieldLabel htmlFor="provider-base-url">
                Base URL <RequiredMark />
              </FieldLabel>
              <Input
                id="provider-base-url"
                type="url"
                autoComplete="off"
                placeholder="https://api.example.com"
                disabled={pending}
                aria-invalid={Boolean(errors.baseUrl)}
                aria-describedby={errors.baseUrl ? 'provider-base-url-error' : undefined}
                {...register('baseUrl')}
              />
              <FieldError id="provider-base-url-error">{errors.baseUrl?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.credential)} data-disabled={pending}>
              <FieldLabel htmlFor="provider-credential">
                凭证 {provider ? null : <RequiredMark />}
              </FieldLabel>
              <PasswordInput name={credentialName} autoComplete="new-password" disabled={pending}>
                <PasswordInputControl
                  id="provider-credential"
                  ref={credentialRef}
                  onChange={onCredentialChange}
                  onBlur={onCredentialBlur}
                  aria-invalid={Boolean(errors.credential)}
                  aria-describedby={
                    errors.credential ? 'provider-credential-error' : 'provider-credential-hint'
                  }
                />
                <PasswordInputToggle />
              </PasswordInput>
              <FieldDescription id="provider-credential-hint">
                {provider ? '留空保留当前凭证。' : '不会在界面回显。'}
              </FieldDescription>
              <FieldError id="provider-credential-error">{errors.credential?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.models)} data-disabled={pending}>
              <FieldLabel htmlFor="provider-models">
                模型 <RequiredMark />
              </FieldLabel>
              <Input
                id="provider-models"
                autoComplete="off"
                placeholder="claude-sonnet-4-5, claude-haiku-4-5"
                disabled={pending}
                aria-invalid={Boolean(errors.models)}
                aria-describedby={errors.models ? 'provider-models-error' : 'provider-models-hint'}
                {...register('models')}
              />
              <FieldDescription id="provider-models-hint">用逗号分隔多个模型 ID。</FieldDescription>
              <FieldError id="provider-models-error">{errors.models?.message}</FieldError>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.priority)} data-disabled={pending}>
                <FieldLabel htmlFor="provider-priority">优先级</FieldLabel>
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
                          id="provider-priority"
                          inputMode="numeric"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.priority)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldError id="provider-priority-error">{errors.priority?.message}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.monthlyBudgetUsd)} data-disabled={pending}>
                <FieldLabel htmlFor="provider-budget">月预算（USD）</FieldLabel>
                <Controller
                  control={control}
                  name="monthlyBudgetUsd"
                  render={({ field }) => (
                    <NumberInput
                      name={field.name}
                      value={
                        field.value !== null && Number.isFinite(field.value) ? field.value : null
                      }
                      onValueChange={(next, details) => {
                        if (details?.reason === 'input-commit') {
                          details.cancel();
                          return;
                        }
                        field.onChange(next);
                      }}
                      step={0.01}
                      disabled={pending}
                    >
                      <NumberInputGroup>
                        <NumberInputDecrement />
                        <NumberInputControl
                          ref={field.ref}
                          id="provider-budget"
                          inputMode="decimal"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.monthlyBudgetUsd)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldDescription id="provider-budget-hint">留空表示不设预算。</FieldDescription>
                <FieldError id="provider-budget-error">
                  {errors.monthlyBudgetUsd?.message}
                </FieldError>
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.alertRatio)} data-disabled={pending}>
                <FieldLabel htmlFor="provider-alert-ratio">告警比例</FieldLabel>
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
                          id="provider-alert-ratio"
                          inputMode="decimal"
                          onBlur={field.onBlur}
                          aria-invalid={Boolean(errors.alertRatio)}
                        />
                        <NumberInputIncrement />
                      </NumberInputGroup>
                    </NumberInput>
                  )}
                />
                <FieldDescription id="provider-alert-ratio-hint">
                  达到预算的该比例时告警，例如 0.8 表示 80%。
                </FieldDescription>
                <FieldError id="provider-alert-ratio-error">
                  {errors.alertRatio?.message}
                </FieldError>
              </Field>
              <Field
                orientation="horizontal"
                className="items-center gap-3 self-end pb-1"
                data-disabled={pending}
              >
                <FieldLabel htmlFor="provider-enabled">启用</FieldLabel>
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <Switch
                      id="provider-enabled"
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

            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : provider ? '保存更改' : '创建供应商'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
