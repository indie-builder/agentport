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
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CopyButton } from '../components/copy-button.js';
import { CursorListFooter } from '../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterSelect } from '../components/filter-select.js';
import { InspectorSheet } from '../components/inspector-sheet.js';
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
  ActiveFilterChips,
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
import { Checkbox } from '../components/ui/checkbox.js';
import { createDateInputController, DateInput } from '../components/ui/date-input.js';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
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
import { useOptimisticValue } from '../lib/use-optimistic-value.js';
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

const TABS = [
  { value: 'tokens', label: 'API 令牌' },
  { value: 'webhooks', label: 'Webhook 端点' },
] as const;

const TOKEN_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '有效' },
  { value: 'revoked', label: '已撤销' },
] as const;

const WEBHOOK_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已停用' },
] as const;

const WEBHOOK_DIRECTION_FILTER_OPTIONS = [
  { value: 'all', label: '全部方向' },
  { value: 'inbound', label: '入站' },
  { value: 'outbound', label: '出站' },
] as const;

const TOKEN_STATUS_FILTER_LABEL = {
  active: '有效',
  revoked: '已撤销',
} as const;

const WEBHOOK_STATUS_FILTER_LABEL = {
  enabled: '已启用',
  disabled: '已停用',
} as const;

const INBOUND_PAYLOAD_EXAMPLE = `{
  "eventId": "evt_20261128_001",
  "message": "请汇总今日巡检异常",
  "conversationId": "conv_optional"
}`;

type TokenStatusFilter = 'all' | 'active' | 'revoked';
type WebhookStatusFilter = 'all' | 'enabled' | 'disabled';
type WebhookDirectionFilter = 'all' | 'outbound' | 'inbound';

type IntegrationsSearchPatch = {
  q?: string | undefined;
  tokenStatus?: TokenStatusFilter | undefined;
  webhookStatus?: WebhookStatusFilter | undefined;
  direction?: WebhookDirectionFilter | undefined;
  view?: ListView | undefined;
};

function tokenStatus(token: ApiToken): {
  label: string;
  tone: 'success' | 'warn' | 'danger';
  rank: number;
} {
  if (token.revokedAt) return { label: '已撤销', tone: 'danger', rank: 2 };
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    return { label: '已过期', tone: 'warn', rank: 1 };
  }
  return { label: '有效', tone: 'success', rank: 0 };
}

function isTokenActive(token: ApiToken): boolean {
  return !token.revokedAt && !(token.expiresAt && Date.parse(token.expiresAt) <= Date.now());
}

function formatTokenExpiry(expiresAt: string | null): string {
  return expiresAt ? formatDateTime(expiresAt) : '永不过期';
}

function inboundWebhookPath(id: string): string {
  return `/api/webhooks/inbound/${id}`;
}

function inboundWebhookUrl(id: string): string {
  const path = inboundWebhookPath(id);
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function endpointEventsLabel(endpoint: WebhookEndpoint): string {
  return endpoint.direction === 'inbound'
    ? '触发运行'
    : endpoint.events.map((event) => EVENT_LABEL[event]).join('、') || '—';
}

export function IntegrationsPage() {
  const me = useQuery(meQuery);
  const canManage = can(me.data, 'integrations.manage');
  const search = useSearch({ from: '/_shell/integrations' });
  const navigate = useNavigate({ from: '/integrations' });
  const tab = search.tab ?? 'tokens';
  const [optimisticTab, commitTab] = useOptimisticValue(tab);
  const view = search.view ?? 'cards';
  const [creating, setCreating] = useState<'token' | 'webhook' | null>(null);
  const [inboundDocOpen, setInboundDocOpen] = useState(false);
  const inboundDocTriggerRef = useRef<HTMLElement | null>(null);

  const updateSearch = (patch: IntegrationsSearchPatch): void => {
    void navigate({
      to: '/integrations',
      search: { ...search, ...patch },
      replace: true,
    });
  };

  const setView = (next: ListView): void => {
    updateSearch({ view: next });
  };

  return (
    <Page>
      <Tabs
        value={optimisticTab}
        onValueChange={(next, details) => {
          if (next === optimisticTab || !TABS.some((item) => item.value === next)) {
            details.cancel();
            return;
          }
          const nextTab = next as (typeof TABS)[number]['value'];
          commitTab(nextTab, () =>
            navigate({
              to: '/integrations',
              search: {
                tab: nextTab,
                ...(search.view === undefined ? {} : { view: search.view }),
              },
              replace: true,
            }),
          );
        }}
        className="min-h-0 flex-1 gap-4"
      >
        <PageTopbar>
          <PageHeader
            title="集成"
            actions={
              optimisticTab === 'tokens' ? (
                canManage ? (
                  <Button onClick={() => setCreating('token')}>
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新建令牌
                  </Button>
                ) : null
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      inboundDocTriggerRef.current = event.currentTarget;
                      setInboundDocOpen(true);
                    }}
                  >
                    <BookOpen data-icon="inline-start" aria-hidden="true" /> 入站签名说明
                  </Button>
                  {canManage ? (
                    <Button onClick={() => setCreating('webhook')}>
                      <Plus data-icon="inline-start" aria-hidden="true" /> 新建 Webhook
                    </Button>
                  ) : null}
                </>
              )
            }
          />
          <TabsList variant="line" aria-label="集成分区">
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </PageTopbar>

        <TabsContent
          value="tokens"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 data-hidden:hidden"
        >
          {optimisticTab === 'tokens' ? (
            <ApiTokensSection
              canManage={canManage}
              view={view}
              query={tab === 'tokens' ? (search.q ?? '') : ''}
              statusFilter={search.tokenStatus ?? 'all'}
              onUpdateSearch={updateSearch}
              onChangeView={setView}
              onCreate={() => setCreating('token')}
            />
          ) : null}
        </TabsContent>

        <TabsContent
          value="webhooks"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 data-hidden:hidden"
        >
          {optimisticTab === 'webhooks' ? (
            <WebhookEndpointsSection
              canManage={canManage}
              view={view}
              query={tab === 'webhooks' ? (search.q ?? '') : ''}
              directionFilter={search.direction ?? 'all'}
              statusFilter={search.webhookStatus ?? 'all'}
              onUpdateSearch={updateSearch}
              onChangeView={setView}
              onCreate={() => setCreating('webhook')}
              onOpenInboundDoc={(trigger) => {
                if (trigger) inboundDocTriggerRef.current = trigger;
                setInboundDocOpen(true);
              }}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      <InboundSignatureSheet
        open={inboundDocOpen}
        onClose={() => setInboundDocOpen(false)}
        finalFocus={() =>
          inboundDocTriggerRef.current?.isConnected ? inboundDocTriggerRef.current : null
        }
      />

      {creating === 'token' ? <ApiTokenDialog onClose={() => setCreating(null)} /> : null}
      {creating === 'webhook' ? <WebhookDialog onClose={() => setCreating(null)} /> : null}
    </Page>
  );
}

function ApiTokensSection({
  canManage,
  view,
  query,
  statusFilter,
  onUpdateSearch,
  onChangeView,
  onCreate,
}: {
  canManage: boolean;
  view: ListView;
  query: string;
  statusFilter: TokenStatusFilter;
  onUpdateSearch: (patch: IntegrationsSearchPatch) => void;
  onChangeView: (next: ListView) => void;
  onCreate: () => void;
}) {
  const tokens = useApiTokens();
  const revoke = useRevokeApiToken();
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastTokenRef = useRef<ApiToken | null>(null);

  const rows = tokens.data ?? [];
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  const filteredRows = useMemo(
    () =>
      rows.filter((token) => {
        if (statusFilter === 'active' && !isTokenActive(token)) return false;
        if (statusFilter === 'revoked' && !token.revokedAt) return false;
        if (!normalizedQuery) return true;
        return (
          token.name.toLowerCase().includes(normalizedQuery) ||
          token.tokenPrefix.toLowerCase().includes(normalizedQuery) ||
          token.id.toLowerCase().includes(normalizedQuery) ||
          token.scopes.some(
            (scope) =>
              scope.toLowerCase().includes(normalizedQuery) ||
              SCOPE_LABEL[scope].toLowerCase().includes(normalizedQuery),
          )
        );
      }),
    [rows, statusFilter, normalizedQuery],
  );

  const clearFilters = (): void => {
    onUpdateSearch({ q: undefined, tokenStatus: undefined });
  };

  const activeFilters: EmptyFilterChip[] = [
    ...(trimmedQuery
      ? [
          {
            key: 'q',
            label: '关键词',
            value: trimmedQuery,
            onRemove: () => onUpdateSearch({ q: undefined }),
          },
        ]
      : []),
    ...(statusFilter !== 'all'
      ? [
          {
            key: 'tokenStatus',
            label: '状态',
            value: TOKEN_STATUS_FILTER_LABEL[statusFilter],
            onRemove: () => onUpdateSearch({ tokenStatus: undefined }),
          },
        ]
      : []),
  ];

  const isFiltered = activeFilters.length > 0;
  const isFilteredEmpty =
    isFiltered && !tokens.isPending && rows.length > 0 && filteredRows.length === 0;
  const fullyLoaded = tokens.data !== undefined && !tokens.hasNextPage;

  const selectedToken = selectedId ? (rows.find((item) => item.id === selectedId) ?? null) : null;
  if (selectedToken) lastTokenRef.current = selectedToken;
  const displayedToken = selectedToken ?? lastTokenRef.current;
  const sheet = useDialogClose(() => setSelectedId(null), selectedId !== null);
  const displayedStatus = displayedToken ? tokenStatus(displayedToken) : null;

  const columns: DataColumn<ApiToken>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(160px,1.2fr)',
      sortValue: (token) => token.name,
      cell: (token) => (
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
          title={token.name}
        >
          {token.name}
        </span>
      ),
    },
    {
      id: 'prefix',
      header: '前缀',
      width: '124px',
      sortValue: (token) => token.tokenPrefix,
      cell: (token) => (
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
          title={token.tokenPrefix}
        >
          {token.tokenPrefix}…
        </span>
      ),
    },
    {
      id: 'scopes',
      header: '权限范围',
      width: 'minmax(140px,1fr)',
      sortValue: (token) => token.scopes.map((scope) => SCOPE_LABEL[scope]).join('、'),
      cell: (token) => {
        const text = token.scopes.map((scope) => SCOPE_LABEL[scope]).join('、');
        return (
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: 'expiresAt',
      header: '过期时间',
      width: '132px',
      sortValue: (token) => token.expiresAt,
      cell: (token) => {
        const label = formatTokenExpiry(token.expiresAt);
        return (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            title={label}
          >
            {label}
          </span>
        );
      },
    },
    {
      id: 'lastUsedAt',
      header: '最近使用',
      width: '132px',
      sortValue: (token) => token.lastUsedAt,
      cell: (token) => {
        const label = formatDateTime(token.lastUsedAt);
        return (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            title={label}
          >
            {label}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: '状态',
      width: '92px',
      sortValue: (token) => tokenStatus(token).rank,
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
      width: '84px',
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
    <>
      <div className="flex min-w-0 shrink-0 flex-col gap-3">
        <PageToolbar>
          <SearchInput
            label="搜索令牌"
            placeholder="搜索名称、前缀或权限…"
            value={query}
            onChange={(next) => onUpdateSearch({ q: next || undefined })}
            className="w-56 min-w-0"
          />
          <FilterSelect
            value={statusFilter}
            onValueChange={(next) =>
              onUpdateSearch({
                tokenStatus:
                  next === 'all' ? undefined : (next as Exclude<TokenStatusFilter, 'all'>),
              })
            }
            options={TOKEN_STATUS_OPTIONS}
            label="按令牌状态筛选"
            className="w-32"
          />
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {tokens.isPending
                ? '加载中…'
                : tokens.isError
                  ? '数量不可用'
                  : isFiltered
                    ? `显示 ${filteredRows.length} / ${rows.length}${fullyLoaded ? '' : '+'} 个令牌`
                    : `${fullyLoaded ? '共' : '已加载'} ${rows.length} 个令牌`}
            </span>
            <ViewToggle value={view} onChange={onChangeView} />
          </div>
        </PageToolbar>
        {!isFilteredEmpty && activeFilters.length > 0 ? (
          <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
        ) : null}
      </div>

      <PageBody>
        <PageSection divided={false}>
          {tokens.isPending ? (
            <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
          ) : null}
          {tokens.isError ? (
            <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
          ) : null}
          {tokens.data && rows.length === 0 ? (
            <EmptyState
              variant="stage"
              scale="section"
              specimen="integrations"
              title="新建开放 API 令牌"
              description="通过 Authorization: Bearer 从外部系统安全调用 PACE。"
              action={
                canManage ? (
                  <Button onClick={onCreate}>
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新建令牌
                  </Button>
                ) : undefined
              }
              footer={canManage ? undefined : '当前账户没有管理集成的权限。'}
            />
          ) : null}
          {isFilteredEmpty ? (
            <EmptyState
              variant="filter"
              scale="section"
              title="没有符合条件的 API 令牌"
              activeFilters={activeFilters}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  清除全部筛选
                </Button>
              }
            />
          ) : null}
          {filteredRows.length > 0 && view === 'table' ? (
            <DataTable
              rows={filteredRows}
              columns={columns}
              rowKey={(token) => token.id}
              rowLabel={(token) => token.name}
              label="API 令牌"
              storageKey="pace.integrations.tokens-columns"
              hideRowCount
              onRowClick={(token, trigger) => {
                triggerRef.current = trigger;
                lastTokenRef.current = token;
                setSelectedId(token.id);
              }}
            />
          ) : null}
          {filteredRows.length > 0 && view === 'cards' ? (
            <ul
              aria-label="API 令牌"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4 pb-2 pt-2"
            >
              {filteredRows.map((token) => {
                const status = tokenStatus(token);
                return (
                  <li key={token.id} className="min-w-0">
                    <Card size="sm" className="h-full">
                      <CardHeader className="grid-cols-[minmax(0,1fr)_auto]! items-center">
                        <CardTitle className="min-w-0 truncate" title={token.name}>
                          {token.name}
                        </CardTitle>
                        <CardAction className="col-start-2 row-start-1 self-center">
                          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex-1">
                        <RecordRows
                          rows={[
                            { label: '前缀', value: `${token.tokenPrefix}…`, mono: true },
                            {
                              label: '权限范围',
                              value: token.scopes.map((scope) => SCOPE_LABEL[scope]).join('、'),
                            },
                            { label: '过期时间', value: formatTokenExpiry(token.expiresAt) },
                            { label: '最近使用', value: formatDateTime(token.lastUsedAt) },
                          ]}
                        />
                      </CardContent>
                      <CardFooter className="justify-between gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`查看令牌 ${token.name}`}
                          onClick={(event) => {
                            triggerRef.current = event.currentTarget;
                            lastTokenRef.current = token;
                            setSelectedId(token.id);
                          }}
                        >
                          详情
                        </Button>
                        {canManage && !token.revokedAt ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`撤销令牌 ${token.name}`}
                            onClick={() => setRevoking(token)}
                          >
                            撤销
                          </Button>
                        ) : null}
                      </CardFooter>
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <CursorListFooter
            className="pt-2"
            query={tokens}
            errorVariant="note"
            errorTitle="更多令牌没有加载出来"
          />
        </PageSection>
      </PageBody>

      <InspectorSheet
        open={sheet.open}
        onOpenChange={(next) => {
          if (!next) sheet.close();
        }}
        onOpenChangeComplete={(next) => {
          sheet.onOpenChangeComplete(next);
          if (!next) lastTokenRef.current = null;
        }}
        size="md"
        title={displayedToken?.name ?? '令牌详情'}
        eyebrow={
          displayedStatus ? (
            <StatusBadge tone={displayedStatus.tone}>{displayedStatus.label}</StatusBadge>
          ) : null
        }
        description={
          displayedToken ? `创建于 ${formatDateTime(displayedToken.createdAt)}` : undefined
        }
        finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
        footer={
          canManage && displayedToken && !displayedToken.revokedAt ? (
            <div className="flex items-center justify-end gap-2">
              <Button variant="destructive" size="sm" onClick={() => setRevoking(displayedToken)}>
                撤销令牌
              </Button>
            </div>
          ) : undefined
        }
      >
        {displayedToken ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg">基本信息</h2>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">令牌 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                    {displayedToken.id}
                  </span>
                  <CopyButton
                    value={displayedToken.id}
                    label="复制令牌 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </dd>
                <dt className="text-muted-foreground">前缀</dt>
                <dd className="min-w-0 font-mono text-fg">{displayedToken.tokenPrefix}…</dd>
                <dt className="text-muted-foreground">请求头</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                  Authorization: Bearer &lt;token&gt;
                </dd>
                <dt className="text-muted-foreground">过期时间</dt>
                <dd className="min-w-0 tabular-nums text-fg">
                  {formatTokenExpiry(displayedToken.expiresAt)}
                </dd>
                <dt className="text-muted-foreground">最近使用</dt>
                <dd className="min-w-0 tabular-nums text-fg">
                  {formatDateTime(displayedToken.lastUsedAt)}
                </dd>
                <dt className="text-muted-foreground">创建时间</dt>
                <dd className="min-w-0 tabular-nums text-fg">
                  {formatDateTime(displayedToken.createdAt)}
                </dd>
                {displayedToken.revokedAt ? (
                  <>
                    <dt className="text-muted-foreground">撤销时间</dt>
                    <dd className="min-w-0 tabular-nums text-danger">
                      {formatDateTime(displayedToken.revokedAt)}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>

            <section className="flex flex-col gap-3 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">权限范围</h2>
              <ul className="flex flex-col gap-2">
                {displayedToken.scopes.map((scope) => (
                  <li key={scope} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-fg">{SCOPE_LABEL[scope]}</span>
                    <StatusBadge tone="mono">{scope}</StatusBadge>
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">密钥策略</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                完整令牌仅在创建完成时展示一次，系统不保存明文。如密钥遗失或怀疑泄漏，请立即撤销当前令牌并重新创建。
              </p>
            </section>
          </div>
        ) : null}
      </InspectorSheet>

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
            toastSuccess('令牌已撤销');
          }}
        />
      ) : null}
    </>
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
  const [expiresController] = useState(createDateInputController);
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
        title={created ? '复制令牌' : '新建令牌'}
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
                  data-agent-secret
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
              aria-label="新建令牌"
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
                <FieldSet className="gap-2" disabled={pending}>
                  <FieldLegend
                    variant="label"
                    inline
                    tone={errors.scopes ? 'danger' : 'default'}
                    className="mb-2"
                  >
                    权限范围 <RequiredMark />
                  </FieldLegend>
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
                </FieldSet>
                <Field data-invalid={Boolean(errors.expiresAt)} data-disabled={pending}>
                  <FieldLabel htmlFor="api-token-expires">过期时间</FieldLabel>
                  <Controller
                    control={control}
                    name="expiresAt"
                    render={({ field }) => (
                      <DateInput
                        controller={expiresController}
                        ref={(node) => {
                          field.ref(node ? { focus: () => expiresController.focus() } : null);
                        }}
                        id="api-token-expires"
                        granularity="minute"
                        hourCycle={24}
                        value={field.value || null}
                        onValueChange={(next) => field.onChange(next ?? '')}
                        onBlur={(event) => {
                          if (
                            !(
                              event.relatedTarget instanceof Node &&
                              event.currentTarget.contains(event.relatedTarget)
                            )
                          ) {
                            field.onBlur();
                          }
                        }}
                        disabled={pending}
                        aria-invalid={Boolean(errors.expiresAt)}
                        aria-describedby={errors.expiresAt ? 'api-token-expires-error' : undefined}
                      />
                    )}
                  />
                  <FieldDescription>留空表示永不过期。</FieldDescription>
                  <FieldError id="api-token-expires-error">{errors.expiresAt?.message}</FieldError>
                </Field>
                <FieldError>{error ?? undefined}</FieldError>
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                    取消
                  </Button>
                  <Button type="submit" disabled={pending} aria-busy={pending}>
                    {pending ? '正在创建…' : '新建令牌'}
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

function WebhookEndpointsSection({
  canManage,
  view,
  query,
  directionFilter,
  statusFilter,
  onUpdateSearch,
  onChangeView,
  onCreate,
  onOpenInboundDoc,
}: {
  canManage: boolean;
  view: ListView;
  query: string;
  directionFilter: WebhookDirectionFilter;
  statusFilter: WebhookStatusFilter;
  onUpdateSearch: (patch: IntegrationsSearchPatch) => void;
  onChangeView: (next: ListView) => void;
  onCreate: () => void;
  onOpenInboundDoc: (trigger?: HTMLElement | null) => void;
}) {
  const endpoints = useWebhookEndpoints();
  const remove = useRemoveWebhookEndpoint();
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastEndpointRef = useRef<WebhookEndpoint | null>(null);

  const rows = endpoints.data ?? [];
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  const filteredRows = useMemo(
    () =>
      rows.filter((endpoint) => {
        if (directionFilter !== 'all' && endpoint.direction !== directionFilter) return false;
        if (statusFilter === 'enabled' && !endpoint.enabled) return false;
        if (statusFilter === 'disabled' && endpoint.enabled) return false;
        if (!normalizedQuery) return true;
        return (
          endpoint.name.toLowerCase().includes(normalizedQuery) ||
          endpoint.id.toLowerCase().includes(normalizedQuery) ||
          (endpoint.url ?? '').toLowerCase().includes(normalizedQuery) ||
          (endpoint.agentName ?? '').toLowerCase().includes(normalizedQuery) ||
          (endpoint.agentId ?? '').toLowerCase().includes(normalizedQuery) ||
          inboundWebhookPath(endpoint.id).toLowerCase().includes(normalizedQuery) ||
          endpoint.events.some(
            (event) =>
              event.toLowerCase().includes(normalizedQuery) ||
              EVENT_LABEL[event].toLowerCase().includes(normalizedQuery),
          )
        );
      }),
    [rows, directionFilter, statusFilter, normalizedQuery],
  );

  const clearFilters = (): void => {
    onUpdateSearch({ q: undefined, direction: undefined, webhookStatus: undefined });
  };

  const activeFilters: EmptyFilterChip[] = [
    ...(trimmedQuery
      ? [
          {
            key: 'q',
            label: '关键词',
            value: trimmedQuery,
            onRemove: () => onUpdateSearch({ q: undefined }),
          },
        ]
      : []),
    ...(directionFilter !== 'all'
      ? [
          {
            key: 'direction',
            label: '方向',
            value: DIRECTION_LABEL[directionFilter],
            onRemove: () => onUpdateSearch({ direction: undefined }),
          },
        ]
      : []),
    ...(statusFilter !== 'all'
      ? [
          {
            key: 'webhookStatus',
            label: '状态',
            value: WEBHOOK_STATUS_FILTER_LABEL[statusFilter],
            onRemove: () => onUpdateSearch({ webhookStatus: undefined }),
          },
        ]
      : []),
  ];

  const isFiltered = activeFilters.length > 0;
  const isFilteredEmpty =
    isFiltered && !endpoints.isPending && rows.length > 0 && filteredRows.length === 0;
  const fullyLoaded = endpoints.data !== undefined && !endpoints.hasNextPage;

  const selectedEndpoint = selectedId
    ? (rows.find((item) => item.id === selectedId) ?? null)
    : null;
  if (selectedEndpoint) lastEndpointRef.current = selectedEndpoint;
  const displayedEndpoint = selectedEndpoint ?? lastEndpointRef.current;
  const sheet = useDialogClose(() => setSelectedId(null), selectedId !== null);

  const columns: DataColumn<WebhookEndpoint>[] = [
    {
      id: 'name',
      header: '名称',
      locked: true,
      width: 'minmax(150px,1fr)',
      sortValue: (endpoint) => endpoint.name,
      cell: (endpoint) => (
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
          title={endpoint.name}
        >
          {endpoint.name}
        </span>
      ),
    },
    {
      id: 'direction',
      header: '方向',
      width: '76px',
      sortValue: (endpoint) => DIRECTION_LABEL[endpoint.direction],
      cell: (endpoint) => DIRECTION_LABEL[endpoint.direction],
    },
    {
      id: 'target',
      header: '目标',
      width: 'minmax(220px,1.6fr)',
      sortValue: (endpoint) =>
        endpoint.direction === 'inbound'
          ? (endpoint.agentName ?? endpoint.agentId ?? endpoint.id)
          : (endpoint.url ?? ''),
      cell: (endpoint) => {
        if (endpoint.direction === 'inbound') {
          const fullUrl = inboundWebhookUrl(endpoint.id);
          const agentLabel = endpoint.agentName ?? endpoint.agentId ?? '—';
          return (
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className="block overflow-hidden text-ellipsis whitespace-nowrap text-fg"
                  title={agentLabel}
                >
                  {agentLabel}
                </span>
                <code
                  className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
                  title={fullUrl}
                >
                  POST {inboundWebhookPath(endpoint.id)}
                </code>
              </div>
              <CopyButton
                value={fullUrl}
                label={`复制入站 URL ${endpoint.name}`}
                className="shrink-0"
              />
            </div>
          );
        }
        return (
          <div className="flex min-w-0 items-center gap-1.5">
            <code
              className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
              {...(endpoint.url ? { title: endpoint.url } : {})}
            >
              {endpoint.url ?? '—'}
            </code>
            {endpoint.url ? (
              <CopyButton
                value={endpoint.url}
                label={`复制目标 URL ${endpoint.name}`}
                className="shrink-0"
              />
            ) : null}
          </div>
        );
      },
    },
    {
      id: 'events',
      header: '订阅事件',
      width: 'minmax(150px,1.1fr)',
      sortValue: (endpoint) => endpointEventsLabel(endpoint),
      cell: (endpoint) => {
        const text = endpointEventsLabel(endpoint);
        return (
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: 'updatedAt',
      header: '更新时间',
      width: '128px',
      hiddenByDefault: true,
      sortValue: (endpoint) => endpoint.updatedAt,
      cell: (endpoint) => {
        const label = formatDateTime(endpoint.updatedAt);
        return (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            title={label}
          >
            {label}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: '状态',
      width: '80px',
      sortValue: (endpoint) => (endpoint.enabled ? 0 : 1),
      cell: (endpoint) => (
        <StatusBadge tone={endpoint.enabled ? 'success' : 'default'}>
          {endpoint.enabled ? '已启用' : '已停用'}
        </StatusBadge>
      ),
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
          size="icon-sm"
          aria-label={`删除端点 ${endpoint.name}`}
          onClick={() => setDeleting(endpoint)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      ),
    });
  }

  return (
    <>
      <div className="flex min-w-0 shrink-0 flex-col gap-3">
        <PageToolbar>
          <SearchInput
            label="搜索 Webhook"
            placeholder="搜索名称、URL 或专家…"
            value={query}
            onChange={(next) => onUpdateSearch({ q: next || undefined })}
            className="w-56 min-w-0"
          />
          <FilterSelect
            value={directionFilter}
            onValueChange={(next) =>
              onUpdateSearch({
                direction:
                  next === 'all' ? undefined : (next as Exclude<WebhookDirectionFilter, 'all'>),
              })
            }
            options={WEBHOOK_DIRECTION_FILTER_OPTIONS}
            label="按方向筛选"
            className="w-28"
          />
          <FilterSelect
            value={statusFilter}
            onValueChange={(next) =>
              onUpdateSearch({
                webhookStatus:
                  next === 'all' ? undefined : (next as Exclude<WebhookStatusFilter, 'all'>),
              })
            }
            options={WEBHOOK_STATUS_OPTIONS}
            label="按端点状态筛选"
            className="w-28"
          />
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {endpoints.isPending
                ? '加载中…'
                : endpoints.isError
                  ? '数量不可用'
                  : isFiltered
                    ? `显示 ${filteredRows.length} / ${rows.length}${fullyLoaded ? '' : '+'} 个端点`
                    : `${fullyLoaded ? '共' : '已加载'} ${rows.length} 个端点`}
            </span>
            <ViewToggle value={view} onChange={onChangeView} />
          </div>
        </PageToolbar>
        {!isFilteredEmpty && activeFilters.length > 0 ? (
          <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
        ) : null}
      </div>

      <PageBody>
        <PageSection divided={false}>
          {endpoints.isPending ? (
            <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
          ) : null}
          {endpoints.isError ? (
            <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
          ) : null}
          {endpoints.data && rows.length === 0 ? (
            <EmptyState
              variant="stage"
              scale="section"
              specimen="integrations"
              title="配置 Webhook 端点"
              description="接收外部签名触发，或将运行事件实时推送到你的服务。"
              action={
                canManage ? (
                  <Button onClick={onCreate}>
                    <Plus data-icon="inline-start" aria-hidden="true" /> 新建 Webhook
                  </Button>
                ) : undefined
              }
              footer={canManage ? undefined : '当前账户没有管理集成的权限。'}
            />
          ) : null}
          {isFilteredEmpty ? (
            <EmptyState
              variant="filter"
              scale="section"
              title="没有符合条件的 Webhook 端点"
              activeFilters={activeFilters}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  清除全部筛选
                </Button>
              }
            />
          ) : null}
          {filteredRows.length > 0 && view === 'table' ? (
            <DataTable
              rows={filteredRows}
              columns={columns}
              rowKey={(endpoint) => endpoint.id}
              rowLabel={(endpoint) => endpoint.name}
              label="Webhook 端点"
              storageKey="pace.integrations.webhooks-columns"
              hideRowCount
              onRowClick={(endpoint, trigger) => {
                triggerRef.current = trigger;
                lastEndpointRef.current = endpoint;
                setSelectedId(endpoint.id);
              }}
            />
          ) : null}
          {filteredRows.length > 0 && view === 'cards' ? (
            <ul
              aria-label="Webhook 端点"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4 pb-2 pt-2"
            >
              {filteredRows.map((endpoint) => {
                const inboundUrl =
                  endpoint.direction === 'inbound' ? inboundWebhookUrl(endpoint.id) : null;
                return (
                  <li key={endpoint.id} className="min-w-0">
                    <Card size="sm" className="h-full">
                      <CardHeader className="grid-cols-[minmax(0,1fr)_auto]! items-center">
                        <CardTitle className="min-w-0 truncate" title={endpoint.name}>
                          {endpoint.name}
                        </CardTitle>
                        <CardAction className="col-start-2 row-start-1 self-center">
                          <StatusBadge tone={endpoint.enabled ? 'success' : 'default'}>
                            {endpoint.enabled ? '已启用' : '已停用'}
                          </StatusBadge>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="flex-1">
                        <RecordRows
                          rows={[
                            { label: '方向', value: DIRECTION_LABEL[endpoint.direction] },
                            {
                              label: '目标',
                              value:
                                endpoint.direction === 'inbound' && inboundUrl ? (
                                  <span className="flex min-w-0 flex-col items-end gap-1">
                                    <span className="break-words">
                                      {endpoint.agentName ?? endpoint.agentId ?? '—'}
                                    </span>
                                    <span className="inline-flex max-w-full items-center gap-1">
                                      <code
                                        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
                                        title={inboundUrl}
                                      >
                                        {inboundWebhookPath(endpoint.id)}
                                      </code>
                                      <CopyButton
                                        value={inboundUrl}
                                        label={`复制入站 URL ${endpoint.name}`}
                                        className="-my-1 -mr-1.5 shrink-0"
                                      />
                                    </span>
                                  </span>
                                ) : endpoint.url ? (
                                  <span className="inline-flex max-w-full items-center justify-end gap-1">
                                    <code
                                      className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg"
                                      title={endpoint.url}
                                    >
                                      {endpoint.url}
                                    </code>
                                    <CopyButton
                                      value={endpoint.url}
                                      label={`复制目标 URL ${endpoint.name}`}
                                      className="-my-1 -mr-1.5 shrink-0"
                                    />
                                  </span>
                                ) : (
                                  '—'
                                ),
                            },
                            { label: '订阅事件', value: endpointEventsLabel(endpoint) },
                          ]}
                        />
                      </CardContent>
                      <CardFooter className="justify-between gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`查看端点 ${endpoint.name}`}
                          onClick={(event) => {
                            triggerRef.current = event.currentTarget;
                            lastEndpointRef.current = endpoint;
                            setSelectedId(endpoint.id);
                          }}
                        >
                          详情
                        </Button>
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除端点 ${endpoint.name}`}
                            onClick={() => setDeleting(endpoint)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        ) : null}
                      </CardFooter>
                    </Card>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <CursorListFooter
            className="pt-2"
            query={endpoints}
            errorVariant="note"
            errorTitle="更多端点没有加载出来"
          />
        </PageSection>
      </PageBody>

      <InspectorSheet
        open={sheet.open}
        onOpenChange={(next) => {
          if (!next) sheet.close();
        }}
        onOpenChangeComplete={(next) => {
          sheet.onOpenChangeComplete(next);
          if (!next) lastEndpointRef.current = null;
        }}
        size="md"
        title={displayedEndpoint?.name ?? '端点详情'}
        eyebrow={
          displayedEndpoint ? (
            <>
              <StatusBadge tone={displayedEndpoint.enabled ? 'success' : 'default'}>
                {displayedEndpoint.enabled ? '已启用' : '已停用'}
              </StatusBadge>
              <StatusBadge tone="outline">
                {DIRECTION_LABEL[displayedEndpoint.direction]}
              </StatusBadge>
            </>
          ) : null
        }
        description={
          displayedEndpoint ? `更新于 ${formatDateTime(displayedEndpoint.updatedAt)}` : undefined
        }
        finalFocus={() => (triggerRef.current?.isConnected ? triggerRef.current : null)}
        footer={
          displayedEndpoint && (displayedEndpoint.direction === 'inbound' || canManage) ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {displayedEndpoint.direction === 'inbound' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    sheet.finish(() => {
                      setSelectedId(null);
                      onOpenInboundDoc(triggerRef.current);
                    });
                  }}
                >
                  查看入站签名协议
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleting(displayedEndpoint)}
                >
                  删除端点
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {displayedEndpoint ? (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-fg">端点配置</h2>
              <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="text-muted-foreground">端点 ID</dt>
                <dd className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                    {displayedEndpoint.id}
                  </span>
                  <CopyButton
                    value={displayedEndpoint.id}
                    label="复制端点 ID"
                    className="-my-1 -mr-1.5 shrink-0"
                  />
                </dd>
                <dt className="text-muted-foreground">方向</dt>
                <dd className="min-w-0 text-fg">{DIRECTION_LABEL[displayedEndpoint.direction]}</dd>
                {displayedEndpoint.direction === 'inbound' ? (
                  <>
                    <dt className="text-muted-foreground">目标专家</dt>
                    <dd className="min-w-0 break-words text-fg">
                      {displayedEndpoint.agentName ?? displayedEndpoint.agentId ?? '—'}
                    </dd>
                    <dt className="text-muted-foreground">入站 URL</dt>
                    <dd className="flex min-w-0 items-start justify-between gap-2">
                      <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                        {inboundWebhookUrl(displayedEndpoint.id)}
                      </span>
                      <CopyButton
                        value={inboundWebhookUrl(displayedEndpoint.id)}
                        label="复制入站 URL"
                        className="-my-1 -mr-1.5 shrink-0"
                      />
                    </dd>
                    <dt className="text-muted-foreground">请求方法</dt>
                    <dd className="min-w-0 font-mono text-fg">POST</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted-foreground">目标 URL</dt>
                    <dd className="flex min-w-0 items-start justify-between gap-2">
                      {displayedEndpoint.url ? (
                        <>
                          <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                            {displayedEndpoint.url}
                          </span>
                          <CopyButton
                            value={displayedEndpoint.url}
                            label="复制目标 URL"
                            className="-my-1 -mr-1.5 shrink-0"
                          />
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">创建时间</dt>
                <dd className="min-w-0 tabular-nums text-fg">
                  {formatDateTime(displayedEndpoint.createdAt)}
                </dd>
                <dt className="text-muted-foreground">更新时间</dt>
                <dd className="min-w-0 tabular-nums text-fg">
                  {formatDateTime(displayedEndpoint.updatedAt)}
                </dd>
              </dl>
            </section>

            <section className="flex flex-col gap-3 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">订阅事件</h2>
              {displayedEndpoint.direction === 'inbound' ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  入站端点收到合法签名请求后自动触发绑定专家运行。
                </p>
              ) : displayedEndpoint.events.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {displayedEndpoint.events.map((event) => (
                    <li key={event} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-fg">{EVENT_LABEL[event]}</span>
                      <StatusBadge tone="mono">{event}</StatusBadge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">未订阅事件</p>
              )}
            </section>

            <section className="flex flex-col gap-3 border-t border-line pt-5">
              <h2 className="text-sm font-medium text-fg">签名与请求头</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                签名密钥仅在创建端点时展示一次，不回显明文。
              </p>
              <dl className="grid grid-cols-[148px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
                <dt className="font-mono text-muted-foreground">X-Agentport-Timestamp</dt>
                <dd className="min-w-0 text-fg">秒或毫秒时间戳（超出 5 分钟窗口拒绝）</dd>
                <dt className="font-mono text-muted-foreground">X-Agentport-Signature</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                  sha256=HMAC-SHA256(secret, timestamp.rawBody)
                </dd>
                {displayedEndpoint.direction === 'inbound' ? (
                  <>
                    <dt className="font-mono text-muted-foreground">X-Idempotency-Key</dt>
                    <dd className="min-w-0 text-fg">可选，如提供须与 body.eventId 一致</dd>
                  </>
                ) : null}
              </dl>
            </section>
          </div>
        ) : null}
      </InspectorSheet>

      {deleting ? (
        <ConfirmDialog
          open
          title="删除端点"
          description={`删除「${deleting.name}」后，该端点上的调用与推送立即停止。`}
          confirmDisabled={remove.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const removedId = deleting.id;
            await remove.mutateAsync(removedId);
            toastSuccess('端点已删除');
            if (selectedId === removedId) sheet.close();
          }}
        />
      ) : null}
    </>
  );
}

function InboundSignatureSheet({
  open,
  onClose,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const sheet = useDialogClose(onClose, open);
  const endpointTemplate = inboundWebhookUrl('<endpointId>');

  return (
    <InspectorSheet
      open={sheet.open}
      onOpenChange={(next) => {
        if (!next) sheet.close();
      }}
      onOpenChangeComplete={sheet.onOpenChangeComplete}
      size="md"
      title="入站签名协议"
      description="外部系统向入站 Webhook 端点发起触发请求时须遵循以下签名与幂等约定。"
      finalFocus={finalFocus}
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-fg">请求端点</h2>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-code-line bg-code px-3 py-2">
            <code className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-fg">
              POST {endpointTemplate}
            </code>
            <CopyButton value={endpointTemplate} label="复制入站端点模板" className="shrink-0" />
          </div>
        </section>

        <section className="flex flex-col gap-3 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-fg">请求体 (JSON)</h2>
            <CopyButton value={INBOUND_PAYLOAD_EXAMPLE} label="复制请求体示例" showLabel />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-code-line bg-code p-3 font-mono text-xs leading-relaxed text-fg">
            <code>{INBOUND_PAYLOAD_EXAMPLE}</code>
          </pre>
        </section>

        <section className="flex flex-col gap-3 border-t border-line pt-5">
          <h2 className="text-sm font-medium text-fg">签名头与幂等键</h2>
          <dl className="grid grid-cols-[152px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
            <dt className="font-mono text-muted-foreground">X-Agentport-Timestamp</dt>
            <dd className="min-w-0 text-fg">
              请求时间戳（秒或毫秒），超出 5 分钟时间窗口将被拒绝。
            </dd>
            <dt className="font-mono text-muted-foreground">X-Agentport-Signature</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] text-fg">
              格式为 <code className="font-mono">sha256=&lt;hex&gt;</code>，签名为{' '}
              <code className="font-mono">HMAC-SHA256(secret, timestamp.rawBody)</code>。
            </dd>
            <dt className="font-mono text-muted-foreground">eventId</dt>
            <dd className="min-w-0 text-fg">请求体内的必填幂等键，重复事件不会重复触发运行。</dd>
            <dt className="font-mono text-muted-foreground">X-Idempotency-Key</dt>
            <dd className="min-w-0 text-fg">
              可选请求头；若携带，必须与请求体中的 <code className="font-mono">eventId</code> 相同。
            </dd>
          </dl>
        </section>

        <section className="flex flex-col gap-2 border-t border-line pt-5">
          <h2 className="text-sm font-medium text-fg">校验注意事项</h2>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>使用原始请求体字节串（rawBody）参与签名，避免重新序列化 JSON 导致验签失败。</li>
            <li>签名密钥仅在创建端点时展示一次；需要轮换密钥时请新建端点并删除旧端点。</li>
          </ul>
        </section>
      </div>
    </InspectorSheet>
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
        title={created ? '复制签名密钥' : '新建 Webhook'}
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
            {created.direction === 'inbound' ? (
              <Field>
                <FieldLabel htmlFor="webhook-inbound-url">入站 URL</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="webhook-inbound-url"
                    readOnly
                    autoComplete="off"
                    className="font-mono"
                    value={inboundWebhookUrl(created.id)}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <CopyButton value={inboundWebhookUrl(created.id)} label="复制 URL" showLabel />
                </div>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="webhook-secret-value">签名密钥</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="webhook-secret-value"
                  readOnly
                  autoComplete="off"
                  data-agent-secret
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
              aria-label="新建 Webhook"
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
                    <FieldSet className="gap-2" disabled={pending}>
                      <FieldLegend
                        variant="label"
                        inline
                        tone={errors.events ? 'danger' : 'default'}
                        className="mb-2"
                      >
                        订阅事件 <RequiredMark />
                      </FieldLegend>
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
                    </FieldSet>
                  </>
                )}

                <FieldError>{error ?? undefined}</FieldError>
                <div className="flex items-center justify-end gap-2">
                  <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                    取消
                  </Button>
                  <Button type="submit" disabled={pending} aria-busy={pending}>
                    {pending ? '正在创建…' : '新建 Webhook'}
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
