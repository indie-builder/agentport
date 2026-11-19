import {
  type ApiToken,
  type ApiTokenCreateInput,
  type ApiTokenCreateResult,
  apiTokenCreateInputSchema,
  type IntegrationScope,
  type WebhookDirection,
  type WebhookEndpoint,
  type WebhookEndpointCreateInput,
  type WebhookEndpointCreateResult,
  type WebhookEventType,
  webhookDirectionSchema,
  webhookEndpointCreateInputSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, Plus, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CopyButton } from '../components/copy-button.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
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
import { ErrorState, LoadingState } from '../components/states.js';
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
import { Checkbox } from '../components/ui/checkbox.js';
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
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { formatDateTime } from '../lib/format.js';
import {
  meQuery,
  useAgents,
  useApiTokens,
  useCreateApiToken,
  useCreateWebhookEndpoint,
  useRemoveWebhookEndpoint,
  useRevokeApiToken,
  useWebhookEndpoints,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

const SCOPE_OPTIONS: readonly { value: IntegrationScope; label: string }[] = [
  { value: 'runs.create', label: '触发运行' },
  { value: 'runs.read', label: '读取运行' },
];

const DIRECTION_OPTIONS: readonly { value: WebhookDirection; label: string }[] = [
  { value: 'inbound', label: '入站' },
  { value: 'outbound', label: '出站' },
];

const EVENT_OPTIONS: readonly { value: WebhookEventType; label: string }[] = [
  { value: 'run.completed', label: '运行完成' },
  { value: 'run.failed', label: '运行失败' },
  { value: 'approval.requested', label: '请求审批' },
  { value: 'budget.alert', label: '预算告警' },
];

const SCOPE_LABEL = Object.fromEntries(
  SCOPE_OPTIONS.map((option) => [option.value, option.label]),
) as Record<IntegrationScope, string>;

const EVENT_LABEL = Object.fromEntries(
  EVENT_OPTIONS.map((option) => [option.value, option.label]),
) as Record<WebhookEventType, string>;

const DIRECTION_LABEL = Object.fromEntries(
  DIRECTION_OPTIONS.map((option) => [option.value, option.label]),
) as Record<WebhookDirection, string>;

function tokenStatus(token: ApiToken): { label: string; tone: 'default' | 'warn' | 'danger' } {
  if (token.revokedAt) return { label: '已撤销', tone: 'danger' };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    return { label: '已过期', tone: 'warn' };
  }
  return { label: '有效', tone: 'default' };
}

export function IntegrationsPage() {
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'integrations.manage');
  const search = useSearch({ from: '/_shell/integrations' });
  const navigate = useNavigate({ from: '/integrations' });
  const view = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({ to: '/integrations', search: { ...search, view: next }, replace: true });
  };
  const tokens = useApiTokens();
  const endpoints = useWebhookEndpoints();
  const hasRows = (tokens.data?.length ?? 0) + (endpoints.data?.length ?? 0) > 0;

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="集成"
          description="令牌用于外部系统调用开放 API，Webhook 端点接收签名触发并推送运行事件。"
          actions={hasRows ? <ViewToggle value={view} onChange={setView} /> : null}
        />
      </PageTopbar>
      <PageBody>
        <ApiTokensSection canManage={canManage} view={view} />
        <WebhookEndpointsSection canManage={canManage} view={view} />
      </PageBody>
    </Page>
  );
}

function ApiTokensSection({ canManage, view }: { canManage: boolean; view: ListView }) {
  const tokens = useApiTokens();
  const revoke = useRevokeApiToken();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const rows = tokens.data ?? [];

  const columns: DataColumn<ApiToken>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(160px,1.2fr)',
      cell: (token) => (
        <span className="block truncate text-fg" title={token.name}>
          {token.name}
        </span>
      ),
    },
    {
      id: 'prefix',
      header: '前缀',
      width: '120px',
      cell: (token) => (
        <span className="font-mono text-xs text-muted-foreground">{token.tokenPrefix}…</span>
      ),
    },
    {
      id: 'scopes',
      header: '权限范围',
      width: 'minmax(140px,1fr)',
      cell: (token) => token.scopes.map((scope) => SCOPE_LABEL[scope]).join('、'),
    },
    {
      id: 'lastUsedAt',
      header: '最近使用',
      width: '140px',
      cell: (token) => (
        <span className="text-xs text-muted-foreground">{formatDateTime(token.lastUsedAt)}</span>
      ),
    },
    {
      id: 'status',
      header: '状态',
      width: '96px',
      cell: (token) => {
        const status = tokenStatus(token);
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
    },
  ];
  if (canManage) {
    columns.push({
      id: 'actions',
      header: '操作',
      align: 'end',
      width: '88px',
      cell: (token) =>
        token.revokedAt ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`撤销令牌 ${token.name}`}
            onClick={() => setRevoking(token)}
          >
            撤销
          </Button>
        ),
    });
  }

  return (
    <PageSection
      title="API 令牌"
      actions={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 创建令牌
          </Button>
        ) : null
      }
    >
      {tokens.isPending ? <LoadingState rows={4} /> : null}
      {tokens.isError ? (
        <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : null}
      {tokens.data && rows.length === 0 ? (
        <PageNote
          icon={<KeyRound aria-hidden="true" />}
          title="还没有 API 令牌"
          description="创建后可用 Authorization: Bearer <token> 调用开放 API。"
        />
      ) : null}
      {rows.length > 0 && view === 'table' ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(token) => token.id}
          rowLabel={(token) => token.name}
          label="API 令牌"
        />
      ) : null}
      {rows.length > 0 && view === 'cards' ? (
        <ul
          aria-label="API 令牌"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4 pt-2"
        >
          {rows.map((token) => {
            const status = tokenStatus(token);
            return (
              <li key={token.id} className="min-w-0">
                <Card size="sm" className="h-full">
                  <CardHeader>
                    <CardTitle className="truncate" title={token.name}>
                      {token.name}
                    </CardTitle>
                    <CardAction>
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <RecordRows
                      rows={[
                        { label: '前缀', value: `${token.tokenPrefix}…`, mono: true },
                        {
                          label: '权限范围',
                          value: token.scopes.map((scope) => SCOPE_LABEL[scope]).join('、'),
                        },
                        { label: '最近使用', value: formatDateTime(token.lastUsedAt) },
                      ]}
                    />
                  </CardContent>
                  {canManage && !token.revokedAt ? (
                    <CardFooter className="justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`撤销令牌 ${token.name}`}
                        onClick={() => setRevoking(token)}
                      >
                        撤销
                      </Button>
                    </CardFooter>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {creating ? <ApiTokenDialog onClose={() => setCreating(false)} /> : null}
      {revoking ? (
        <ConfirmDialog
          open
          title="撤销令牌"
          description={`撤销后「${revoking.name}」立即失效，外部系统将无法继续调用。`}
          confirmLabel="撤销令牌"
          confirmDisabled={revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await revoke.mutateAsync(revoking.id);
            setRevoking(null);
            toastSuccess('令牌已撤销');
          }}
        />
      ) : null}
    </PageSection>
  );
}

const tokenFormSchema = z.object({
  name: apiTokenCreateInputSchema.shape.name,
  scopes: apiTokenCreateInputSchema.shape.scopes,
  expiresAt: z
    .string()
    .optional()
    .refine((value) => !value || !Number.isNaN(Date.parse(value)), '请输入合法的日期时间'),
});

type TokenFormValues = z.infer<typeof tokenFormSchema>;

function ApiTokenDialog({ onClose: onClosed }: { onClose: () => void }) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateApiToken();
  const defaults: TokenFormValues = { name: '', scopes: [], expiresAt: '' };
  const { register, control, handleSubmit, formState } = useZodForm(tokenFormSchema, {
    defaultValues: defaults,
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreateResult | null>(null);
  const pending = create.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);

  const submit = handleSubmit(
    async (values: TokenFormValues) => {
      if (pending) return;
      setError(null);
      try {
        const input: ApiTokenCreateInput = {
          name: values.name,
          scopes: values.scopes,
          ...(values.expiresAt ? { expiresAt: new Date(values.expiresAt).toISOString() } : {}),
        };
        const result = await create.mutateAsync(input);
        setSaved(true);
        setCreated(result);
        guard.blocker.reset?.();
        create.reset();
        toastSuccess('令牌已创建');
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
        title={created ? '复制令牌' : '创建令牌'}
        description={
          created ? '令牌只显示一次，关闭后无法再次查看。' : '令牌用于外部系统调用开放 API。'
        }
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        {created ? (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="api-token-value">令牌</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="api-token-value"
                  readOnly
                  autoComplete="off"
                  className="font-mono"
                  value={created.token}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyButton value={created.token} label="复制令牌" showLabel />
              </div>
            </Field>
            <div className="flex justify-end">
              <Button onClick={guard.finish}>完成</Button>
            </div>
          </FieldGroup>
        ) : (
          <>
            <form
              aria-label="创建令牌"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup className="gap-5">
                <Field data-invalid={Boolean(errors.name)} data-disabled={pending}>
                  <FieldLabel htmlFor="api-token-name">
                    名称 <RequiredMark />
                  </FieldLabel>
                  <Input
                    id="api-token-name"
                    autoComplete="off"
                    disabled={pending}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'api-token-name-error' : undefined}
                    {...register('name')}
                  />
                  <FieldError id="api-token-name-error">{errors.name?.message}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errors.scopes)} data-disabled={pending}>
                  <FieldLabel>
                    权限范围 <RequiredMark />
                  </FieldLabel>
                  <Controller
                    control={control}
                    name="scopes"
                    render={({ field }) => (
                      <div className="flex flex-col gap-2">
                        {SCOPE_OPTIONS.map((option, index) => (
                          <label
                            key={option.value}
                            htmlFor={`api-token-scope-${option.value}`}
                            className="flex items-center gap-2 text-sm text-fg"
                          >
                            <Checkbox
                              id={`api-token-scope-${option.value}`}
                              ref={index === 0 ? field.ref : undefined}
                              checked={field.value.includes(option.value)}
                              disabled={pending}
                              onBlur={field.onBlur}
                              aria-invalid={Boolean(errors.scopes)}
                              aria-describedby={
                                errors.scopes ? 'api-token-scopes-error' : undefined
                              }
                              onCheckedChange={(checked) =>
                                field.onChange(
                                  checked
                                    ? [...field.value, option.value]
                                    : field.value.filter((scope) => scope !== option.value),
                                )
                              }
                            />
                            {option.label}
                            <span className="font-mono text-xs text-muted-foreground">
                              {option.value}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  />
                  <FieldError id="api-token-scopes-error">{errors.scopes?.message}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errors.expiresAt)} data-disabled={pending}>
                  <FieldLabel htmlFor="api-token-expires">过期时间</FieldLabel>
                  <Input
                    id="api-token-expires"
                    type="datetime-local"
                    disabled={pending}
                    aria-invalid={Boolean(errors.expiresAt)}
                    aria-describedby={errors.expiresAt ? 'api-token-expires-error' : undefined}
                    {...register('expiresAt')}
                  />
                  <FieldDescription>留空表示长期有效。</FieldDescription>
                  <FieldError id="api-token-expires-error">{errors.expiresAt?.message}</FieldError>
                </Field>
                <FieldError>{error ?? undefined}</FieldError>
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                    取消
                  </Button>
                  <Button type="submit" disabled={pending} aria-busy={pending}>
                    {pending ? '正在创建…' : '创建令牌'}
                  </Button>
                </div>
              </FieldGroup>
            </form>
            <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
          </>
        )}
      </DialogShell>
    </Dialog>
  );
}

function WebhookEndpointsSection({ canManage, view }: { canManage: boolean; view: ListView }) {
  const endpoints = useWebhookEndpoints();
  const remove = useRemoveWebhookEndpoint();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const rows = endpoints.data ?? [];

  const columns: DataColumn<WebhookEndpoint>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(150px,1fr)',
      cell: (endpoint) => (
        <span className="block truncate text-fg" title={endpoint.name}>
          {endpoint.name}
        </span>
      ),
    },
    {
      id: 'direction',
      header: '方向',
      width: '72px',
      cell: (endpoint) => DIRECTION_LABEL[endpoint.direction],
    },
    {
      id: 'target',
      header: '目标',
      width: 'minmax(200px,1.6fr)',
      cell: (endpoint) =>
        endpoint.direction === 'inbound' ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-fg" title={endpoint.agentName ?? undefined}>
              {endpoint.agentName ?? endpoint.agentId ?? '—'}
            </span>
            <code className="break-all font-mono text-xs text-muted-foreground">
              POST /api/webhooks/inbound/{endpoint.id}
            </code>
          </div>
        ) : (
          <code className="break-all font-mono text-xs text-muted-foreground">
            {endpoint.url ?? '—'}
          </code>
        ),
    },
    {
      id: 'events',
      header: '订阅事件',
      width: 'minmax(160px,1.2fr)',
      cell: (endpoint) =>
        endpoint.direction === 'inbound'
          ? '触发运行'
          : endpoint.events.map((event) => EVENT_LABEL[event]).join('、'),
    },
    {
      id: 'status',
      header: '状态',
      width: '72px',
      cell: (endpoint) => <StatusBadge>{endpoint.enabled ? '启用' : '停用'}</StatusBadge>,
    },
  ];
  if (canManage) {
    columns.push({
      id: 'actions',
      header: '操作',
      align: 'end',
      width: '72px',
      cell: (endpoint) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`删除端点 ${endpoint.name}`}
          onClick={() => setDeleting(endpoint)}
        >
          <Trash2 />
        </Button>
      ),
    });
  }

  return (
    <PageSection
      title="Webhook 端点"
      actions={
        canManage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" /> 创建端点
          </Button>
        ) : null
      }
    >
      {endpoints.isPending ? <LoadingState rows={4} /> : null}
      {endpoints.isError ? (
        <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
      ) : null}
      {endpoints.data && rows.length === 0 ? (
        <PageNote
          icon={<Webhook aria-hidden="true" />}
          title="还没有 Webhook 端点"
          description="入站端点接收外部签名触发，出站端点推送运行完成、失败、审批与预算事件。"
        />
      ) : null}
      {rows.length > 0 && view === 'table' ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(endpoint) => endpoint.id}
          rowLabel={(endpoint) => endpoint.name}
          label="Webhook 端点"
        />
      ) : null}
      {rows.length > 0 && view === 'cards' ? (
        <ul
          aria-label="Webhook 端点"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4 pt-2"
        >
          {rows.map((endpoint) => (
            <li key={endpoint.id} className="min-w-0">
              <Card size="sm" className="h-full">
                <CardHeader>
                  <CardTitle className="truncate" title={endpoint.name}>
                    {endpoint.name}
                  </CardTitle>
                  <CardAction>
                    <StatusBadge>{endpoint.enabled ? '启用' : '停用'}</StatusBadge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <RecordRows
                    rows={[
                      { label: '方向', value: DIRECTION_LABEL[endpoint.direction] },
                      {
                        label: '目标',
                        value:
                          endpoint.direction === 'inbound' ? (
                            <span className="flex min-w-0 flex-col items-end gap-0.5">
                              <span className="break-words">
                                {endpoint.agentName ?? endpoint.agentId ?? '—'}
                              </span>
                              <code className="break-all font-mono text-xs text-muted-foreground">
                                POST /api/webhooks/inbound/{endpoint.id}
                              </code>
                            </span>
                          ) : (
                            (endpoint.url ?? '—')
                          ),
                        mono: endpoint.direction === 'outbound',
                      },
                      {
                        label: '订阅事件',
                        value:
                          endpoint.direction === 'inbound'
                            ? '触发运行'
                            : endpoint.events.map((event) => EVENT_LABEL[event]).join('、') || '—',
                      },
                    ]}
                  />
                </CardContent>
                {canManage ? (
                  <CardFooter className="justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`删除端点 ${endpoint.name}`}
                      onClick={() => setDeleting(endpoint)}
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

      <div className="flex min-w-0 flex-col gap-1.5 border-t pt-4 text-sm text-muted-foreground">
        <p className="text-fg">入站调用</p>
        <p className="break-words">
          向{' '}
          <code className="font-mono text-xs text-fg">
            POST /api/webhooks/inbound/&lt;端点 ID&gt;
          </code>{' '}
          发送 JSON{' '}
          <code className="font-mono text-xs text-fg">
            {'{ eventId, message, conversationId? }'}
          </code>
          。
        </p>
        <p className="break-words">
          签名头 <code className="font-mono text-xs text-fg">X-Agentport-Timestamp</code>
          （秒或毫秒，超出 5 分钟窗口拒绝）与{' '}
          <code className="font-mono text-xs text-fg">
            X-Agentport-Signature: sha256=&lt;hex&gt;
          </code>
          ，内容为{' '}
          <code className="font-mono text-xs text-fg">HMAC-SHA256(secret, timestamp.rawBody)</code>
          ；幂等键使用 body 的 <code className="font-mono text-xs text-fg">eventId</code>；如另带{' '}
          <code className="font-mono text-xs text-fg">X-Idempotency-Key</code>，必须与{' '}
          <code className="font-mono text-xs text-fg">eventId</code> 相同。
        </p>
      </div>

      {creating ? <WebhookDialog onClose={() => setCreating(false)} /> : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除端点"
          description={`删除「${deleting.name}」后，该端点上的调用与推送立即停止。`}
          confirmDisabled={remove.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            setDeleting(null);
            toastSuccess('端点已删除');
          }}
        />
      ) : null}
    </PageSection>
  );
}

type WebhookFormValues = z.infer<typeof webhookEndpointCreateInputSchema>;

function WebhookDialog({ onClose: onClosed }: { onClose: () => void }) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateWebhookEndpoint();
  const agents = useAgents();
  const defaults: WebhookFormValues = {
    name: '',
    direction: 'inbound',
    agentId: undefined,
    url: undefined,
    events: [],
  };
  const { register, control, handleSubmit, setValue, watch, formState } = useZodForm(
    webhookEndpointCreateInputSchema,
    { defaultValues: defaults },
  );
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [created, setCreated] = useState<WebhookEndpointCreateResult | null>(null);
  const pending = create.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const direction = watch('direction');
  const agentOptions = (agents.data ?? []).map((agent) => ({
    value: agent.id,
    label: agent.name,
  }));

  const submit = handleSubmit(
    async (values: WebhookFormValues) => {
      if (pending) return;
      setError(null);
      try {
        const input: WebhookEndpointCreateInput =
          values.direction === 'inbound'
            ? {
                name: values.name,
                direction: 'inbound',
                ...(values.agentId ? { agentId: values.agentId } : {}),
              }
            : {
                name: values.name,
                direction: 'outbound',
                ...(values.url ? { url: values.url } : {}),
                events: values.events ?? [],
              };
        const result = await create.mutateAsync(input);
        setSaved(true);
        setCreated(result);
        guard.blocker.reset?.();
        create.reset();
        toastSuccess('端点已创建');
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
        title={created ? '复制签名密钥' : '创建端点'}
        description={
          created
            ? '密钥只显示一次，关闭后无法再次查看。'
            : '入站端点接收外部触发，出站端点推送运行事件。'
        }
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        {created ? (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="webhook-secret-value">签名密钥</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="webhook-secret-value"
                  readOnly
                  autoComplete="off"
                  className="font-mono"
                  value={created.secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <CopyButton value={created.secret} label="复制密钥" showLabel />
              </div>
              <FieldDescription>入站验签与出站签名都使用这把密钥。</FieldDescription>
            </Field>
            <div className="flex justify-end">
              <Button onClick={guard.finish}>完成</Button>
            </div>
          </FieldGroup>
        ) : (
          <>
            <form
              aria-label="创建端点"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup className="gap-5">
                <Field data-invalid={Boolean(errors.name)} data-disabled={pending}>
                  <FieldLabel htmlFor="webhook-name">
                    名称 <RequiredMark />
                  </FieldLabel>
                  <Input
                    id="webhook-name"
                    autoComplete="off"
                    disabled={pending}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'webhook-name-error' : undefined}
                    {...register('name')}
                  />
                  <FieldError id="webhook-name-error">{errors.name?.message}</FieldError>
                </Field>
                <Field data-disabled={pending}>
                  <FieldLabel htmlFor="webhook-direction">方向</FieldLabel>
                  <Controller
                    control={control}
                    name="direction"
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        items={[...DIRECTION_OPTIONS]}
                        disabled={pending}
                        onValueChange={(next) => {
                          const parsed = webhookDirectionSchema.safeParse(next);
                          if (!parsed.success) return;
                          field.onChange(parsed.data);
                          setValue('agentId', undefined, { shouldDirty: true });
                          setValue('url', undefined, { shouldDirty: true });
                          setValue('events', [], { shouldDirty: true });
                        }}
                      >
                        <SelectTrigger
                          id="webhook-direction"
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
                </Field>

                {direction === 'inbound' ? (
                  <Field
                    data-invalid={Boolean(errors.agentId)}
                    data-disabled={pending || agents.isPending}
                  >
                    <FieldLabel htmlFor="webhook-agent">
                      专家 <RequiredMark />
                    </FieldLabel>
                    <Controller
                      control={control}
                      name="agentId"
                      render={({ field }) => (
                        <Select
                          value={field.value ?? ''}
                          items={agentOptions}
                          disabled={pending || agents.isPending}
                          onValueChange={(next) => field.onChange(next || undefined)}
                        >
                          <SelectTrigger
                            id="webhook-agent"
                            className="w-full min-w-0"
                            ref={field.ref}
                            onBlur={field.onBlur}
                            aria-invalid={Boolean(errors.agentId)}
                            aria-describedby={errors.agentId ? 'webhook-agent-error' : undefined}
                          >
                            <SelectValue placeholder={agents.isPending ? '加载中…' : '选择专家'} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {agentOptions.length === 0 ? (
                                <SelectItem value="__empty" disabled>
                                  {agents.isPending ? '加载中…' : '没有可选专家'}
                                </SelectItem>
                              ) : (
                                agentOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))
                              )}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError id="webhook-agent-error">{errors.agentId?.message}</FieldError>
                    {agents.isError ? <FieldError>{errorMessage(agents.error)}</FieldError> : null}
                  </Field>
                ) : (
                  <>
                    <Field data-invalid={Boolean(errors.url)} data-disabled={pending}>
                      <FieldLabel htmlFor="webhook-url">
                        目标 URL <RequiredMark />
                      </FieldLabel>
                      <Controller
                        control={control}
                        name="url"
                        render={({ field }) => (
                          <Input
                            id="webhook-url"
                            type="url"
                            placeholder="https://example.com/hooks/runs"
                            autoComplete="off"
                            disabled={pending}
                            ref={field.ref}
                            name={field.name}
                            value={field.value ?? ''}
                            onBlur={field.onBlur}
                            onChange={(event) => field.onChange(event.target.value || undefined)}
                            aria-invalid={Boolean(errors.url)}
                            aria-describedby={errors.url ? 'webhook-url-error' : undefined}
                          />
                        )}
                      />
                      <FieldError id="webhook-url-error">{errors.url?.message}</FieldError>
                    </Field>
                    <Field data-invalid={Boolean(errors.events)} data-disabled={pending}>
                      <FieldLabel>
                        订阅事件 <RequiredMark />
                      </FieldLabel>
                      <Controller
                        control={control}
                        name="events"
                        render={({ field }) => (
                          <div className="flex flex-col gap-2">
                            {EVENT_OPTIONS.map((option, index) => (
                              <label
                                key={option.value}
                                htmlFor={`webhook-event-${option.value}`}
                                className="flex items-center gap-2 text-sm text-fg"
                              >
                                <Checkbox
                                  id={`webhook-event-${option.value}`}
                                  ref={index === 0 ? field.ref : undefined}
                                  checked={(field.value ?? []).includes(option.value)}
                                  disabled={pending}
                                  onBlur={field.onBlur}
                                  aria-invalid={Boolean(errors.events)}
                                  aria-describedby={
                                    errors.events ? 'webhook-events-error' : undefined
                                  }
                                  onCheckedChange={(checked) => {
                                    const current = field.value ?? [];
                                    field.onChange(
                                      checked
                                        ? [...current, option.value]
                                        : current.filter((event) => event !== option.value),
                                    );
                                  }}
                                />
                                {option.label}
                                <span className="font-mono text-xs text-muted-foreground">
                                  {option.value}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      />
                      <FieldError id="webhook-events-error">{errors.events?.message}</FieldError>
                    </Field>
                  </>
                )}

                <FieldError>{error ?? undefined}</FieldError>
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                    取消
                  </Button>
                  <Button type="submit" disabled={pending} aria-busy={pending}>
                    {pending ? '正在创建…' : '创建端点'}
                  </Button>
                </div>
              </FieldGroup>
            </form>
            <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
          </>
        )}
      </DialogShell>
    </Dialog>
  );
}
