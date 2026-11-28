import {
  accountNameSchema,
  isValidBusinessId,
  passwordSchema,
  usernameSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { createMenuController, type MenuController } from '@ui-sdk/react/menu';
import {
  CirclePause,
  CirclePlay,
  EllipsisVertical,
  KeyRound,
  Pencil,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CopyButton } from '../components/copy-button.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import { FilterSelect } from '../components/filter-select.js';
import { InspectorSheet } from '../components/inspector-sheet.js';
import { Page, PageBody, PageHeader, PageToolbar, PageTopbar } from '../components/page.js';
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
import { Avatar, AvatarFallback } from '../components/ui/avatar.js';
import { Badge } from '../components/ui/badge.js';
import { Button, buttonVariants } from '../components/ui/button.js';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from '../components/ui/password-input.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { type Account, ApiError, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { withFieldMessages } from '../lib/form.js';
import { formatDate, formatDateTime, formatRelative } from '../lib/format.js';
import {
  meQuery,
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useResetAccountPassword,
  useRoleMatrix,
  useSetAccountRoles,
  useSetAccountStatus,
  useUpdateAccount,
} from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { useDebouncedValue } from '../lib/use-debounced-value.js';
import { useZodForm } from '../lib/use-zod-form.js';

const PAGE_SIZE = 50;

type InspectorTab = 'profile' | 'roles' | 'security';
type AccountStatusFilter = 'all' | Account['status'];

const statusFilterOptions: ReadonlyArray<{ value: AccountStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '停用' },
];

const statusLabel: Record<Account['status'], string> = {
  active: '启用',
  disabled: '停用',
};

function accountInitial(name: string, username: string): string {
  const source = name.trim() || username.trim();
  const first = Array.from(source)[0];
  return first ? first.toLocaleUpperCase() : '?';
}

function validateBusinessId(value: string): string | null {
  const length = [...value].length;
  if (length === 0) return '请填写业务 ID。';
  if (length > 160) return '业务 ID 最多 160 个字符。';
  if (/\s/u.test(value)) return '业务 ID 不能包含空白字符。';
  if (!isValidBusinessId(value)) return '业务 ID 不能包含控制字符。';
  return null;
}

export function AccountsPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/accounts' });
  const navigate = useNavigate({ from: '/accounts' });
  const query = search.q ?? '';
  const trimmedQuery = query.trim();
  const statusFilter: AccountStatusFilter = search.status ?? 'all';
  const roleFilter = search.role ?? 'all';
  const page = search.page;
  const offset = (page - 1) * PAGE_SIZE;
  const settled = useDebouncedValue(trimmedQuery, 300);
  const searchPending = trimmedQuery !== settled;
  const accounts = useAccounts({
    q: settled,
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
    ...(roleFilter === 'all' ? {} : { roleId: roleFilter }),
    limit: PAGE_SIZE,
    offset,
  });
  const canManage = can(me.data, 'accounts.manage');
  const canReadRoles = can(me.data, 'roles.read');
  const canManageRoles = can(me.data, 'roles.manage');
  const selfBusinessId = me.data?.authenticated ? me.data.user.businessId : null;
  const view = search.view ?? 'table';
  const setView = (next: 'table' | 'cards'): void => {
    void navigate({
      to: '/accounts',
      search: (current) => ({ ...current, view: next }),
      replace: true,
    });
  };
  const roles = useRoleMatrix(canReadRoles);
  const roleDirectory: RoleDirectory = {
    roles: roles.data?.roles,
    loading: roles.isPending,
    error: roles.error,
    refetch: () => void roles.refetch(),
  };

  const [creating, setCreating] = useState(false);
  const [inspected, setInspected] = useState<{
    businessId: string;
    snapshot: Account;
    initialTab: InspectorTab;
  } | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [statusTarget, setStatusTarget] = useState<Account | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const statusSnapshotRef = useRef<Account | null>(null);
  if (statusTarget) statusSnapshotRef.current = statusTarget;
  const displayedStatusTarget = statusTarget ?? statusSnapshotRef.current;
  const deletingSnapshotRef = useRef<Account | null>(null);
  if (deleting) deletingSnapshotRef.current = deleting;
  const displayedDeleting = deleting ?? deletingSnapshotRef.current;
  const closeInspectedAfterDeleteRef = useRef<string | null>(null);
  const remove = useDeleteAccount();
  const setStatus = useSetAccountStatus();
  const [rowMenu] = useState(() => createMenuController<Account>());
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);

  const total = accounts.data?.total ?? 0;
  const items = accounts.data?.items ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (!accounts.data) return;
    if (page > pages) {
      void navigate({
        to: '/accounts',
        search: (current) => ({ ...current, page: pages }),
        replace: true,
      });
    }
  }, [accounts.data, page, pages, navigate]);

  const roleNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of roles.data?.roles ?? []) map.set(role.id, role.name);
    for (const account of items) {
      for (const role of account.roles) {
        if (!map.has(role.id)) map.set(role.id, role.name);
      }
    }
    return map;
  }, [roles.data?.roles, items]);

  const roleFilterOptions = useMemo(() => {
    const entries = [...roleNameMap.entries()].map(([value, label]) => ({ value, label }));
    if (roleFilter !== 'all' && !roleNameMap.has(roleFilter)) {
      entries.push({ value: roleFilter, label: roleFilter });
    }
    return [{ value: 'all', label: '全部角色' }, ...entries];
  }, [roleNameMap, roleFilter]);

  const hasFilter = Boolean(settled) || statusFilter !== 'all' || roleFilter !== 'all';

  const clearFilters = useCallback(() => {
    void navigate({
      to: '/accounts',
      search: (current) => ({
        ...current,
        q: undefined,
        status: undefined,
        role: undefined,
        page: 1,
      }),
      replace: true,
    });
  }, [navigate]);

  const activeFilters: EmptyFilterChip[] = [
    ...(trimmedQuery
      ? [
          {
            key: 'q',
            label: '关键词',
            value: trimmedQuery,
            onRemove: () => {
              void navigate({
                to: '/accounts',
                search: (current) => ({ ...current, q: undefined, page: 1 }),
                replace: true,
              });
            },
          },
        ]
      : []),
    ...(statusFilter !== 'all'
      ? [
          {
            key: 'status',
            label: '状态',
            value: statusLabel[statusFilter],
            onRemove: () => {
              void navigate({
                to: '/accounts',
                search: (current) => ({ ...current, status: undefined, page: 1 }),
                replace: true,
              });
            },
          },
        ]
      : []),
    ...(roleFilter !== 'all'
      ? [
          {
            key: 'role',
            label: '角色',
            value: roleNameMap.get(roleFilter) ?? roleFilter,
            onRemove: () => {
              void navigate({
                to: '/accounts',
                search: (current) => ({ ...current, role: undefined, page: 1 }),
                replace: true,
              });
            },
          },
        ]
      : []),
  ];

  const isStageEmpty = Boolean(accounts.data) && !searchPending && items.length === 0 && !hasFilter;
  const isFilteredEmpty =
    Boolean(accounts.data) && !searchPending && items.length === 0 && hasFilter;

  const openInspector = useCallback(
    (account: Account, initialTab: InspectorTab, trigger?: HTMLElement | null): void => {
      if (trigger) inspectorTriggerRef.current = trigger;
      setInspected({ businessId: account.businessId, snapshot: account, initialTab });
    },
    [],
  );

  const toggleStatus = useCallback(
    (account: Account, trigger?: HTMLElement | null): void => {
      if (account.status === 'active') {
        confirmTriggerRef.current = trigger ?? menuTriggerRef.current;
        setStatusTarget(account);
        return;
      }
      setStatus.mutate(
        { businessId: account.businessId, status: 'active' },
        {
          onSuccess: () => toastSuccess(`已启用 ${account.name}`),
          onError: toastError,
        },
      );
    },
    [setStatus],
  );

  const requestDelete = useCallback((account: Account, trigger?: HTMLElement | null): void => {
    confirmTriggerRef.current = trigger ?? menuTriggerRef.current;
    setDeleting(account);
  }, []);

  const liveInspectedAccount = inspected
    ? (items.find((item) => item.businessId === inspected.businessId) ?? inspected.snapshot)
    : null;

  const columns = useMemo<DataColumn<Account>[]>(
    () => [
      {
        id: 'account',
        header: '账户',
        locked: true,
        width: 'minmax(164px,1.5fr)',
        sortValue: (row) => row.name,
        cell: (row) => {
          const isSelf = selfBusinessId !== null && row.businessId === selfBusinessId;
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar aria-hidden="true" className="size-7 shrink-0 text-xs">
                <AvatarFallback>{accountInitial(row.name, row.username)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span
                    className="min-w-0 [overflow-wrap:anywhere] font-medium text-fg"
                    title={row.name}
                  >
                    {row.name}
                  </span>
                  {isSelf ? (
                    <StatusBadge tone="brand" className="shrink-0">
                      当前账户
                    </StatusBadge>
                  ) : null}
                </div>
                <span
                  className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-muted-foreground"
                  title={`@${row.username}`}
                >
                  @{row.username}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: 'businessId',
        header: '业务 ID',
        hiddenByDefault: true,
        width: 'minmax(120px,1fr)',
        sortValue: (row) => row.businessId,
        cell: (row) => (
          <span
            className="block min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-muted-foreground"
            title={row.businessId}
          >
            {row.businessId}
          </span>
        ),
      },
      {
        id: 'roles',
        header: '角色',
        width: 'minmax(112px,1fr)',
        sortValue: (row) => row.roles.map((role) => role.name).join('、') || null,
        cell: (row) => <RoleBadges roles={row.roles} limit={2} inTable />,
      },
      {
        id: 'status',
        header: '状态',
        width: '72px',
        sortValue: (row) => row.status,
        cell: (row) => (
          <StatusBadge tone={row.status === 'active' ? 'success' : 'default'}>
            {statusLabel[row.status]}
          </StatusBadge>
        ),
      },
      {
        id: 'createdAt',
        header: '创建时间',
        width: '100px',
        sortValue: (row) => Date.parse(row.createdAt),
        cell: (row) => (
          <span
            className="block min-w-0 [overflow-wrap:anywhere] font-mono tabular-nums text-muted-foreground"
            title={formatDateTime(row.createdAt)}
          >
            {formatDate(row.createdAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        locked: true,
        align: 'end',
        width: '96px',
        cell: (row) => (
          <AccountRowActions
            account={row}
            canManage={canManage}
            canManageRoles={canManageRoles}
            menu={rowMenu}
            onMenuTrigger={(trigger) => {
              menuTriggerRef.current = trigger;
            }}
            className="justify-end"
            onInspect={(account, trigger) => openInspector(account, 'profile', trigger)}
          />
        ),
      },
    ],
    [canManage, canManageRoles, openInspector, rowMenu, selfBusinessId],
  );

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="账户"
          actions={
            canManage && !isStageEmpty ? (
              <Button ref={createTriggerRef} onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" aria-hidden="true" /> 新建账户
              </Button>
            ) : null
          }
        />
        <PageToolbar>
          <SearchInput
            label="搜索账户"
            placeholder="搜索业务 ID、用户名或姓名…"
            value={query}
            onChange={(next) => {
              void navigate({
                to: '/accounts',
                search: (current) => ({ ...current, q: next || undefined, page: 1 }),
                replace: true,
              });
            }}
            className="w-56 min-w-0"
          />
          <FilterSelect
            value={statusFilter}
            onValueChange={(next) => {
              void navigate({
                to: '/accounts',
                search: (current) => ({
                  ...current,
                  status: next === 'all' ? undefined : (next as Account['status']),
                  page: 1,
                }),
                replace: true,
              });
            }}
            options={statusFilterOptions}
            label="按状态筛选"
            className="w-28"
          />
          <FilterSelect
            value={roleFilter}
            onValueChange={(next) => {
              void navigate({
                to: '/accounts',
                search: (current) => ({
                  ...current,
                  role: next === 'all' ? undefined : next,
                  page: 1,
                }),
                replace: true,
              });
            }}
            options={roleFilterOptions}
            label="按角色筛选"
            className="w-36"
          />
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {accounts.isPending || searchPending
                ? '加载中…'
                : accounts.isError
                  ? '数量不可用'
                  : `共 ${total} 个账户`}
            </span>
            <ViewToggle value={view} onChange={setView} />
          </div>
        </PageToolbar>
        {!isFilteredEmpty && activeFilters.length > 0 ? (
          <ActiveFilterChips filters={activeFilters} onClearAll={clearFilters} />
        ) : null}
      </PageTopbar>

      <PageBody>
        {accounts.isPending ? (
          <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
        ) : null}
        {accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : null}
        {isFilteredEmpty ? (
          <EmptyState
            variant="filter"
            scale="section"
            title="没有匹配的账户"
            activeFilters={activeFilters}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                清除全部筛选
              </Button>
            }
          />
        ) : null}
        {isStageEmpty ? (
          <EmptyState
            variant="stage"
            scale="page"
            specimen="accounts"
            title="创建工作区账户"
            description="添加成员并分配角色，按权限控制对专家与资源的访问。"
            action={
              canManage ? (
                <Button ref={createTriggerRef} onClick={() => setCreating(true)}>
                  <Plus data-icon="inline-start" aria-hidden="true" /> 新建账户
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {items.length > 0 && view === 'table' ? (
          <DataTable
            rows={items}
            columns={columns}
            rowKey={(account) => account.businessId}
            rowLabel={(account) => account.name}
            label="账户列表"
            storageKey="pace.accounts.columns"
            hideRowCount
            onRowClick={(account, trigger) => openInspector(account, 'profile', trigger)}
          />
        ) : null}

        {items.length > 0 && view === 'cards' ? (
          <ul
            aria-label="账户列表"
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4 pt-2"
          >
            {items.map((account) => {
              const isSelf = selfBusinessId !== null && account.businessId === selfBusinessId;
              return (
                <li key={account.businessId} className="min-w-0">
                  <Card size="sm" hover="shadow" className="h-full">
                    <CardHeader className="grid-cols-[minmax(0,1fr)_auto]! items-start">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar aria-hidden="true" className="size-8">
                          <AvatarFallback>
                            {accountInitial(account.name, account.username)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-col">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <CardTitle
                              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                              title={account.name}
                            >
                              {account.name}
                            </CardTitle>
                            {isSelf ? (
                              <StatusBadge tone="brand" className="shrink-0">
                                当前账户
                              </StatusBadge>
                            ) : null}
                          </div>
                          <span
                            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
                            title={`@${account.username}`}
                          >
                            @{account.username}
                          </span>
                        </div>
                      </div>
                      <CardAction className="col-start-2 row-start-1 self-start">
                        <StatusBadge tone={account.status === 'active' ? 'success' : 'default'}>
                          {statusLabel[account.status]}
                        </StatusBadge>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col justify-between gap-2.5">
                      <RoleBadges roles={account.roles} limit={3} />
                      <span
                        className="text-xs text-muted-foreground"
                        title={formatDateTime(account.createdAt)}
                      >
                        创建于 {formatRelative(account.createdAt)}
                      </span>
                    </CardContent>
                    <CardFooter className="justify-between gap-2">
                      <span
                        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground"
                        title={account.businessId}
                      >
                        {account.businessId}
                      </span>
                      <AccountRowActions
                        account={account}
                        canManage={canManage}
                        canManageRoles={canManageRoles}
                        menu={rowMenu}
                        onMenuTrigger={(trigger) => {
                          menuTriggerRef.current = trigger;
                        }}
                        onInspect={(item, trigger) => openInspector(item, 'profile', trigger)}
                      />
                    </CardFooter>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : null}

        {pages > 1 ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || accounts.isFetching}
              onClick={() =>
                void navigate({
                  to: '/accounts',
                  search: (current) => ({ ...current, page: page - 1 }),
                  replace: true,
                })
              }
            >
              上一页
            </Button>
            <span className="text-muted-foreground">
              {page} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages || accounts.isFetching}
              onClick={() =>
                void navigate({
                  to: '/accounts',
                  search: (current) => ({ ...current, page: page + 1 }),
                  replace: true,
                })
              }
            >
              下一页
            </Button>
          </div>
        ) : null}
      </PageBody>

      {creating ? (
        <CreateAccountDialog
          canAssignRoles={canManageRoles}
          roleDirectory={roleDirectory}
          finalFocus={() =>
            createTriggerRef.current?.isConnected ? createTriggerRef.current : null
          }
          onClose={() => setCreating(false)}
        />
      ) : null}

      {inspected && liveInspectedAccount ? (
        <AccountInspectorSheet
          key={inspected.businessId}
          account={liveInspectedAccount}
          initialTab={inspected.initialTab}
          isSelf={selfBusinessId !== null && liveInspectedAccount.businessId === selfBusinessId}
          canManage={canManage}
          canManageRoles={canManageRoles}
          roleDirectory={roleDirectory}
          finalFocus={() =>
            inspectorTriggerRef.current?.isConnected ? inspectorTriggerRef.current : null
          }
          onRequestToggleStatus={(account, trigger) => toggleStatus(account, trigger)}
          onRequestDelete={(account, trigger) => requestDelete(account, trigger)}
          onClosed={() => setInspected(null)}
        />
      ) : null}

      <ConfirmDialog
        open={statusTarget !== null}
        finalFocus={() =>
          confirmTriggerRef.current?.isConnected
            ? confirmTriggerRef.current
            : inspectorTriggerRef.current?.isConnected
              ? inspectorTriggerRef.current
              : null
        }
        onClose={() => {
          setStatusTarget(null);
          setConfirmError(null);
        }}
        title={`停用账户「${displayedStatusTarget?.name ?? ''}」`}
        description="停用会立即撤销全部会话；业务数据、角色与授权保留。重新启用后需要重新登录。"
        confirmLabel="停用"
        onConfirm={async () => {
          if (!statusTarget) return;
          await setStatus.mutateAsync({
            businessId: statusTarget.businessId,
            status: 'disabled',
          });
          toastSuccess(`已停用 ${statusTarget.name}`);
        }}
        onError={(error) => setConfirmError(errorMessage(error))}
      >
        {confirmError ? <FieldError>{confirmError}</FieldError> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        finalFocus={() =>
          confirmTriggerRef.current?.isConnected
            ? confirmTriggerRef.current
            : inspectorTriggerRef.current?.isConnected
              ? inspectorTriggerRef.current
              : null
        }
        onClose={() => {
          const deletedId = closeInspectedAfterDeleteRef.current;
          closeInspectedAfterDeleteRef.current = null;
          if (deletedId !== null && inspected?.businessId === deletedId) {
            setInspected(null);
          }
          setDeleting(null);
          setConfirmError(null);
        }}
        title={`删除「${displayedDeleting?.name ?? ''}」的登录认证`}
        description="只删除登录资料，业务内容、角色、专家归属与个人记忆都会保留；之后可用同一业务 ID 恢复原身份和授权。"
        onConfirm={async () => {
          if (!deleting) return;
          const deletedId = deleting.businessId;
          await remove.mutateAsync(deletedId);
          toastSuccess('已删除登录认证，业务授权仍保留');
          closeInspectedAfterDeleteRef.current = deletedId;
        }}
        onError={(error) => setConfirmError(errorMessage(error))}
      >
        {confirmError ? <FieldError>{confirmError}</FieldError> : null}
      </ConfirmDialog>

      <DropdownMenu controller={rowMenu}>
        <DropdownMenuContent align="end" sideOffset={4} className="w-40">
          {(state) => {
            const account = state.payload as Account | undefined;
            if (!account) return null;
            return (
              <>
                <DropdownMenuGroup>
                  {canManage ? (
                    <DropdownMenuItem
                      onSelect={() => openInspector(account, 'profile', menuTriggerRef.current)}
                    >
                      <Pencil aria-hidden="true" /> 编辑资料
                    </DropdownMenuItem>
                  ) : null}
                  {canManageRoles ? (
                    <DropdownMenuItem
                      onSelect={() => openInspector(account, 'roles', menuTriggerRef.current)}
                    >
                      <ShieldCheck aria-hidden="true" /> 分配角色
                    </DropdownMenuItem>
                  ) : null}
                  {canManage ? (
                    <>
                      <DropdownMenuItem
                        onSelect={() => openInspector(account, 'security', menuTriggerRef.current)}
                      >
                        <KeyRound aria-hidden="true" /> 重置密码
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => toggleStatus(account, menuTriggerRef.current)}
                      >
                        {account.status === 'active' ? (
                          <CirclePause aria-hidden="true" />
                        ) : (
                          <CirclePlay aria-hidden="true" />
                        )}
                        {account.status === 'active' ? '停用' : '启用'}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuGroup>
                {canManage ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => requestDelete(account, menuTriggerRef.current)}
                    >
                      <Trash2 aria-hidden="true" /> 删除认证
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            );
          }}
        </DropdownMenuContent>
      </DropdownMenu>
    </Page>
  );
}

type RoleDirectory = {
  roles: Array<{ id: string; name: string }> | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => void;
};

function RoleBadges({
  roles,
  limit,
  inTable = false,
}: {
  roles: Account['roles'];
  limit: number;
  inTable?: boolean;
}) {
  if (roles.length === 0) {
    return (
      <span className={cn('text-muted-foreground', !inTable && 'text-xs')}>
        {inTable ? '—' : '未分配角色'}
      </span>
    );
  }
  const visible = roles.slice(0, limit);
  const rest = roles.length - visible.length;
  const allNames = roles.map((role) => role.name).join('、');
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center', inTable ? 'gap-1' : 'gap-1.5')}
      title={allNames}
    >
      {visible.map((role) => (
        <Badge
          key={role.id}
          variant="secondary"
          className={inTable ? 'h-auto max-w-full' : 'max-w-[120px]'}
        >
          <span
            className={
              inTable
                ? 'min-w-0 whitespace-normal [overflow-wrap:anywhere]'
                : 'overflow-hidden text-ellipsis whitespace-nowrap'
            }
          >
            {role.name}
          </span>
        </Badge>
      ))}
      {rest > 0 ? (
        <Badge variant="outline" className="shrink-0">
          <span className="font-mono tabular-nums">+{rest}</span>
        </Badge>
      ) : null}
    </div>
  );
}

function AccountRowMenu({
  account,
  canManage,
  canManageRoles,
  menu,
  onTrigger,
}: {
  account: Account;
  canManage: boolean;
  canManageRoles: boolean;
  menu: MenuController<Account>;
  onTrigger: (trigger: HTMLElement) => void;
}) {
  if (!canManage && !canManageRoles) return null;
  return (
    <DropdownMenuTrigger
      controller={menu}
      payload={account}
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`操作 ${account.name}`}
          onFocus={(event) => onTrigger(event.currentTarget)}
          onPointerDown={(event) => onTrigger(event.currentTarget)}
          onClick={(event) => {
            event.stopPropagation();
            onTrigger(event.currentTarget);
          }}
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      }
    />
  );
}

function AccountRowActions({
  account,
  canManage,
  canManageRoles,
  menu,
  onMenuTrigger,
  className,
  onInspect,
}: {
  account: Account;
  canManage: boolean;
  canManageRoles: boolean;
  menu: MenuController<Account>;
  onMenuTrigger: (trigger: HTMLElement) => void;
  className?: string | undefined;
  onInspect: (account: Account, trigger: HTMLElement) => void;
}) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`查看 ${account.name} 详情`}
        onClick={(event) => {
          event.stopPropagation();
          onInspect(account, event.currentTarget);
        }}
      >
        详情
      </Button>
      <AccountRowMenu
        account={account}
        canManage={canManage}
        canManageRoles={canManageRoles}
        menu={menu}
        onTrigger={onMenuTrigger}
      />
    </div>
  );
}

function RoleChecks({
  directory,
  selected,
  onToggle,
  disabled = false,
}: {
  directory: RoleDirectory;
  selected: readonly string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const roles = directory.roles;
  return (
    <div className="flex flex-col gap-3">
      {directory.error ? (
        <ErrorState
          error={directory.error}
          title="角色目录没有加载出来"
          onRetry={directory.refetch}
        />
      ) : null}
      {directory.loading && !roles ? <LoadingState rows={2} /> : null}
      {roles ? (
        roles.length === 0 ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<Shield aria-hidden="true" />}
            title="还没有可分配的角色"
            action={
              <Link to="/roles" className={buttonVariants({ variant: 'link', size: 'sm' })}>
                前往角色管理
              </Link>
            }
          />
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-2.5">
            {roles.map((role) => (
              <label
                key={role.id}
                htmlFor={`role-${role.id}`}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={`role-${role.id}`}
                  checked={selected.includes(role.id)}
                  disabled={disabled}
                  onCheckedChange={() => onToggle(role.id)}
                />
                {role.name}
              </label>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

const usernameField = withFieldMessages(z.string(), usernameSchema, {
  tooSmall: '请填写用户名。',
});

const nameField = z.string().superRefine((value, ctx) => {
  const parsed = accountNameSchema.safeParse(value.trim().length === 0 ? '' : value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: 'custom',
      message: issue.code === 'too_small' ? '请填写姓名。' : issue.message,
    });
  }
});

const passwordField = withFieldMessages(z.string(), passwordSchema, {
  tooSmall: '密码至少 8 个字符。',
});

const accountFormSchema = z.object({
  businessId: z.string().superRefine((value, ctx) => {
    const message = validateBusinessId(value);
    if (message) ctx.addIssue({ code: 'custom', message });
  }),
  username: usernameField,
  name: nameField,
  password: passwordField,
  roleIds: z.array(z.string()),
});
type AccountFormValues = z.infer<typeof accountFormSchema>;

const accountEditFormSchema = z.object({
  username: usernameField,
  name: nameField,
});
type AccountEditFormValues = z.infer<typeof accountEditFormSchema>;

const resetPasswordFormSchema = z
  .object({
    password: passwordField,
    confirm: z.string(),
  })
  .refine((values) => values.confirm === values.password, {
    message: '两次输入的密码不一致。',
    path: ['confirm'],
  });
type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

const PROFILE_FORM_ID = 'account-inspector-profile-form';
const ROLES_FORM_ID = 'account-inspector-roles-form';

function AccountInspectorSheet({
  account,
  initialTab,
  isSelf,
  canManage,
  canManageRoles,
  roleDirectory,
  finalFocus,
  onRequestToggleStatus,
  onRequestDelete,
  onClosed,
}: {
  account: Account;
  initialTab: InspectorTab;
  isSelf: boolean;
  canManage: boolean;
  canManageRoles: boolean;
  roleDirectory: RoleDirectory;
  finalFocus?: (() => HTMLElement | null) | undefined;
  onRequestToggleStatus: (account: Account, trigger: HTMLElement) => void;
  onRequestDelete: (account: Account, trigger: HTMLElement) => void;
  onClosed: () => void;
}) {
  const snapshotRef = useRef(account);
  snapshotRef.current = account;
  const displayedAccount = snapshotRef.current;

  const resolvedInitialTab: InspectorTab =
    initialTab === 'security' && !canManage ? 'profile' : initialTab;
  const [activeTab, setActiveTab] = useState<InspectorTab>(resolvedInitialTab);
  const [pendingTab, setPendingTab] = useState<InspectorTab | null>(null);

  const dialog = useDialogClose(onClosed);
  const updateAccount = useUpdateAccount();
  const saveRoles = useSetAccountRoles();
  const resetPassword = useResetAccountPassword();

  const profileForm = useZodForm(accountEditFormSchema, {
    defaultValues: { username: displayedAccount.username, name: displayedAccount.name },
  });
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const initialRoleIds = useMemo(
    () => displayedAccount.roles.map((role) => role.id),
    [displayedAccount.roles],
  );
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(initialRoleIds);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesSaved, setRolesSaved] = useState(false);

  const passwordForm = useZodForm(resetPasswordFormSchema, {
    defaultValues: { password: '', confirm: '' },
  });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  const profileDirty = canManage && !profileSaved && profileForm.formState.isDirty;
  const rolesDirty =
    canManageRoles &&
    !rolesSaved &&
    [...selectedRoleIds].sort().join('\u0000') !== [...initialRoleIds].sort().join('\u0000');
  const passwordDirty = canManage && !passwordSaved && passwordForm.formState.isDirty;

  const profilePending = updateAccount.isPending && !profileSaved;
  const rolesPending = saveRoles.isPending && !rolesSaved;
  const passwordPending = resetPassword.isPending && !passwordSaved;

  const activeDirty =
    activeTab === 'profile' ? profileDirty : activeTab === 'roles' ? rolesDirty : passwordDirty;
  const pending = profilePending || rolesPending || passwordPending;
  const guard = useDraftGuard(activeDirty, pending, dialog.close);

  const prevAccountRef = useRef(displayedAccount);
  useEffect(() => {
    const prev = prevAccountRef.current;
    if (prev === displayedAccount) return;
    prevAccountRef.current = displayedAccount;
    if (!profileForm.formState.isDirty) {
      profileForm.reset({ username: displayedAccount.username, name: displayedAccount.name });
    }
    const prevRolesKey = prev.roles
      .map((role) => role.id)
      .sort()
      .join('\u0000');
    const nextRolesKey = displayedAccount.roles
      .map((role) => role.id)
      .sort()
      .join('\u0000');
    if (prevRolesKey !== nextRolesKey) {
      setSelectedRoleIds((current) => {
        const currentKey = [...current].sort().join('\u0000');
        return currentKey === prevRolesKey
          ? displayedAccount.roles.map((role) => role.id)
          : current;
      });
    }
  }, [displayedAccount, profileForm]);

  const discardActiveDraft = (tab: InspectorTab): void => {
    if (tab === 'profile') {
      profileForm.reset({ username: displayedAccount.username, name: displayedAccount.name });
      setProfileError(null);
      setProfileSaved(false);
    } else if (tab === 'roles') {
      setSelectedRoleIds(initialRoleIds);
      setRolesError(null);
      setRolesSaved(false);
    } else {
      passwordForm.reset({ password: '', confirm: '' });
      setPasswordError(null);
      setPasswordSaved(false);
    }
  };

  const handleTabChange = (next: InspectorTab): void => {
    if (pending || next === activeTab) return;
    if (activeDirty) {
      setPendingTab(next);
      return;
    }
    setActiveTab(next);
  };

  const usernameError = profileForm.formState.errors.username?.message;
  const nameError = profileForm.formState.errors.name?.message;

  const submitProfile = profileForm.handleSubmit(
    async (values: AccountEditFormValues) => {
      if (pending) return;
      setProfileError(null);
      try {
        await updateAccount.mutateAsync({
          businessId: displayedAccount.businessId,
          input: {
            ...(values.username === displayedAccount.username ? {} : { username: values.username }),
            ...(values.name === displayedAccount.name ? {} : { name: values.name }),
          },
        });
        setProfileSaved(true);
        toastSuccess('账户资料已更新');
        guard.finish();
      } catch (cause) {
        setProfileError(errorMessage(cause));
      }
    },
    () => setProfileError(null),
  );

  const rolesUnavailable = roleDirectory.roles === undefined;
  const submitRoles = async (): Promise<void> => {
    if (pending) return;
    setRolesError(null);
    if (rolesUnavailable) {
      setRolesError('角色目录没有加载出来，请重试后再保存。');
      return;
    }
    try {
      await saveRoles.mutateAsync({
        businessId: displayedAccount.businessId,
        roleIds: selectedRoleIds,
      });
      setRolesSaved(true);
      toastSuccess('角色已更新');
      guard.finish();
    } catch (cause) {
      setRolesError(errorMessage(cause));
    }
  };

  const resetPasswordError = passwordForm.formState.errors.password?.message;
  const resetConfirmError = passwordForm.formState.errors.confirm?.message;
  const {
    name: resetPasswordName,
    ref: resetPasswordRef,
    onChange: onResetPasswordChange,
    onBlur: onResetPasswordBlur,
  } = passwordForm.register('password', { deps: ['confirm'] });
  const {
    name: resetConfirmName,
    ref: resetConfirmRef,
    onChange: onResetConfirmChange,
    onBlur: onResetConfirmBlur,
  } = passwordForm.register('confirm');

  const submitPassword = passwordForm.handleSubmit(
    async (values: ResetPasswordFormValues) => {
      if (pending) return;
      setPasswordError(null);
      try {
        await resetPassword.mutateAsync({
          businessId: displayedAccount.businessId,
          password: values.password,
        });
        setPasswordSaved(true);
        toastSuccess('密码已重置');
        guard.finish();
      } catch (cause) {
        setPasswordError(errorMessage(cause));
      }
    },
    () => setPasswordError(null),
  );

  const footer =
    activeTab === 'profile' && canManage ? (
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
          取消
        </Button>
        <Button type="submit" form={PROFILE_FORM_ID} disabled={pending} aria-busy={profilePending}>
          {profilePending ? '正在保存…' : '保存'}
        </Button>
      </div>
    ) : activeTab === 'roles' && canManageRoles ? (
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
          取消
        </Button>
        <Button
          type="submit"
          form={ROLES_FORM_ID}
          disabled={pending || rolesUnavailable}
          aria-busy={rolesPending}
        >
          {rolesPending ? '正在保存…' : '保存'}
        </Button>
      </div>
    ) : undefined;

  return (
    <>
      <InspectorSheet
        size="md"
        open={dialog.open}
        onOpenChange={(next) => {
          if (!next) guard.close();
        }}
        onOpenChangeComplete={dialog.onOpenChangeComplete}
        title={displayedAccount.name}
        eyebrow={
          <div className="flex items-center gap-1.5">
            <StatusBadge tone={displayedAccount.status === 'active' ? 'success' : 'default'}>
              {statusLabel[displayedAccount.status]}
            </StatusBadge>
            {isSelf ? <StatusBadge tone="brand">当前账户</StatusBadge> : null}
          </div>
        }
        description={`@${displayedAccount.username} · ${displayedAccount.businessId}`}
        closeDisabled={pending}
        {...(finalFocus === undefined ? {} : { finalFocus })}
        {...(footer === undefined ? {} : { footer })}
      >
        <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-5">
          <div className="border-b border-line pb-1">
            <TabsList variant="line" aria-label="账户详情分区">
              <TabsTrigger value="profile" disabled={pending}>
                资料
              </TabsTrigger>
              <TabsTrigger value="roles" disabled={pending}>
                角色
              </TabsTrigger>
              {canManage ? (
                <TabsTrigger value="security" disabled={pending}>
                  安全
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>

          <TabsContent value="profile" className="flex flex-col gap-5">
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-xs">
              <dt className="text-muted-foreground">业务 ID</dt>
              <dd className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-fg">
                  {displayedAccount.businessId}
                </span>
                <CopyButton
                  value={displayedAccount.businessId}
                  label="复制业务 ID"
                  className="-my-1 -mr-1.5 shrink-0"
                />
              </dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd className="min-w-0 font-mono tabular-nums text-fg">
                {formatDateTime(displayedAccount.createdAt)}
              </dd>
              {!canManage ? (
                <>
                  <dt className="text-muted-foreground">用户名</dt>
                  <dd className="min-w-0 font-mono text-fg">@{displayedAccount.username}</dd>
                  <dt className="text-muted-foreground">姓名</dt>
                  <dd className="min-w-0 text-fg">{displayedAccount.name}</dd>
                </>
              ) : null}
            </dl>

            {canManage ? (
              <form
                id={PROFILE_FORM_ID}
                aria-label="编辑账户"
                noValidate
                className="border-t border-line pt-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitProfile();
                }}
              >
                <FieldGroup className="gap-5">
                  <Field>
                    <FieldLabel htmlFor="account-edit-business-id">业务 ID</FieldLabel>
                    <Input
                      id="account-edit-business-id"
                      readOnly
                      value={displayedAccount.businessId}
                    />
                  </Field>
                  <Field data-invalid={Boolean(usernameError)} data-disabled={pending}>
                    <FieldLabel htmlFor="account-edit-username">用户名</FieldLabel>
                    <Input
                      id="account-edit-username"
                      autoComplete="off"
                      disabled={pending}
                      aria-invalid={Boolean(usernameError)}
                      {...profileForm.register('username')}
                    />
                    <FieldError id="account-edit-username-error">
                      {usernameError ?? undefined}
                    </FieldError>
                  </Field>
                  <Field data-invalid={Boolean(nameError)} data-disabled={pending}>
                    <FieldLabel htmlFor="account-edit-name">姓名</FieldLabel>
                    <Input
                      id="account-edit-name"
                      autoComplete="off"
                      disabled={pending}
                      aria-invalid={Boolean(nameError)}
                      {...profileForm.register('name')}
                    />
                    <FieldError id="account-edit-name-error">{nameError ?? undefined}</FieldError>
                  </Field>
                  <FieldError>{profileError ?? undefined}</FieldError>
                </FieldGroup>
              </form>
            ) : null}
          </TabsContent>

          <TabsContent value="roles" className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">角色决定该账户的页面与操作权限。</p>
            {canManageRoles ? (
              <form
                id={ROLES_FORM_ID}
                aria-label="分配角色"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitRoles();
                }}
              >
                <FieldGroup className="gap-5">
                  <FieldSet className="gap-2" disabled={pending}>
                    <FieldLegend variant="label" className="mb-2 data-disabled:opacity-50">
                      角色
                    </FieldLegend>
                    <RoleChecks
                      directory={roleDirectory}
                      selected={selectedRoleIds}
                      disabled={pending}
                      onToggle={(id) =>
                        setSelectedRoleIds((current) =>
                          current.includes(id)
                            ? current.filter((item) => item !== id)
                            : [...current, id],
                        )
                      }
                    />
                  </FieldSet>
                  <FieldError>{rolesError ?? undefined}</FieldError>
                </FieldGroup>
              </form>
            ) : displayedAccount.roles.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {displayedAccount.roles.map((role) => (
                  <Badge key={role.id} variant="secondary">
                    {role.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <EmptyState
                variant="idle"
                scale="inline"
                icon={<Shield aria-hidden="true" />}
                title="暂未分配角色"
              />
            )}
          </TabsContent>

          {canManage ? (
            <TabsContent value="security" className="flex flex-col gap-6">
              <section className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium text-fg">重置密码</h3>
                  <p className="text-xs text-muted-foreground">
                    重置会立即撤销该账户的全部旧会话。
                  </p>
                </div>
                <form
                  aria-label="重置密码"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitPassword();
                  }}
                >
                  <FieldGroup className="gap-4">
                    <Field data-invalid={Boolean(resetPasswordError)} data-disabled={pending}>
                      <FieldLabel htmlFor="account-reset-password">新密码</FieldLabel>
                      <PasswordInput
                        name={resetPasswordName}
                        autoComplete="new-password"
                        disabled={pending}
                      >
                        <PasswordInputControl
                          id="account-reset-password"
                          ref={resetPasswordRef}
                          onChange={onResetPasswordChange}
                          onBlur={onResetPasswordBlur}
                          aria-invalid={Boolean(resetPasswordError)}
                        />
                        <PasswordInputToggle />
                      </PasswordInput>
                      <FieldError id="account-reset-password-error">
                        {resetPasswordError ?? undefined}
                      </FieldError>
                    </Field>
                    <Field data-invalid={Boolean(resetConfirmError)} data-disabled={pending}>
                      <FieldLabel htmlFor="account-reset-confirm">确认新密码</FieldLabel>
                      <PasswordInput
                        name={resetConfirmName}
                        autoComplete="new-password"
                        disabled={pending}
                      >
                        <PasswordInputControl
                          id="account-reset-confirm"
                          ref={resetConfirmRef}
                          onChange={onResetConfirmChange}
                          onBlur={onResetConfirmBlur}
                          aria-invalid={Boolean(resetConfirmError)}
                        />
                        <PasswordInputToggle />
                      </PasswordInput>
                      <FieldError id="account-reset-confirm-error">
                        {resetConfirmError ?? undefined}
                      </FieldError>
                    </Field>
                    <FieldError>{passwordError ?? undefined}</FieldError>
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={guard.close}
                      >
                        取消
                      </Button>
                      <Button
                        type="submit"
                        disabled={pending}
                        aria-busy={passwordPending}
                        data-agent-confirm={`重置「${displayedAccount.name}」的密码并立即撤销全部旧会话`}
                      >
                        {passwordPending ? '正在重置…' : '重置密码'}
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
              </section>

              <section className="flex flex-col gap-3 border-t border-line pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium text-fg">
                      {displayedAccount.status === 'active' ? '停用账户' : '启用账户'}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {displayedAccount.status === 'active'
                        ? '停用会立即撤销全部会话；业务数据、角色与授权保留。重新启用后需要重新登录。'
                        : '重新启用后该账户可再次登录，原有角色与业务授权继续生效。'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    className="shrink-0"
                    onClick={(event) =>
                      onRequestToggleStatus(displayedAccount, event.currentTarget)
                    }
                  >
                    {displayedAccount.status === 'active' ? (
                      <CirclePause data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <CirclePlay data-icon="inline-start" aria-hidden="true" />
                    )}
                    {displayedAccount.status === 'active' ? '停用' : '启用'}
                  </Button>
                </div>
              </section>

              <section className="flex flex-col gap-3 border-t border-line pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium text-fg">删除登录认证</h3>
                    <p className="text-xs text-muted-foreground">
                      只删除登录资料，业务内容、角色、专家归属与个人记忆都会保留；之后可用同一业务
                      ID 恢复原身份和授权。
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    className="shrink-0"
                    onClick={(event) => onRequestDelete(displayedAccount, event.currentTarget)}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    删除认证
                  </Button>
                </div>
              </section>
            </TabsContent>
          ) : null}
        </Tabs>
      </InspectorSheet>

      <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />

      <ConfirmDialog
        open={pendingTab !== null}
        onClose={() => setPendingTab(null)}
        title="放弃未保存的更改？"
        description="切换标签页后填写的内容会丢失。"
        confirmLabel="放弃并切换"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (pending || pendingTab === null) return;
          discardActiveDraft(activeTab);
          setActiveTab(pendingTab);
        }}
      />
    </>
  );
}

function CreateAccountDialog({
  canAssignRoles,
  roleDirectory,
  finalFocus,
  onClose: onClosed,
}: {
  canAssignRoles: boolean;
  roleDirectory: RoleDirectory;
  finalFocus?: (() => HTMLElement | null) | undefined;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const create = useCreateAccount();
  const { register, handleSubmit, watch, setValue, formState } = useZodForm(accountFormSchema, {
    defaultValues: { businessId: '', username: '', name: '', password: '', roleIds: [] },
  });
  const { errors, isDirty } = formState;
  const roleIds = watch('roleIds');
  const [restorePrompt, setRestorePrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = create.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const rolesUnavailable = canAssignRoles && roleDirectory.roles === undefined;
  const businessError = errors.businessId?.message;
  const usernameError = errors.username?.message;
  const nameError = errors.name?.message;
  const passwordError = errors.password?.message;
  const {
    name: createPasswordName,
    ref: createPasswordRef,
    onChange: onCreatePasswordChange,
    onBlur: onCreatePasswordBlur,
  } = register('password');

  const doCreate = async (values: AccountFormValues, asRestore: boolean): Promise<void> => {
    if (pending) return;
    setError(null);
    if (!asRestore) setRestorePrompt(null);
    if (rolesUnavailable) {
      setError('角色目录没有加载出来，请重试后再创建。');
      return;
    }
    try {
      await create.mutateAsync({
        businessId: values.businessId,
        username: values.username,
        name: values.name,
        password: values.password,
        restore: asRestore,
        ...(canAssignRoles && values.roleIds.length > 0 ? { roleIds: values.roleIds } : {}),
      });
      setSaved(true);
      toastSuccess(`已创建账户 ${values.name}`);
      guard.finish();
    } catch (cause) {
      if (!asRestore && cause instanceof ApiError && cause.status === 409) {
        setRestorePrompt(cause.message || '该业务 ID 存在历史记录。');
        return;
      }
      setError(errorMessage(cause));
    }
  };
  const submitForm = handleSubmit(
    (values) => doCreate(values, false),
    () => setError(null),
  );

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title="新建账户"
        description="业务 ID 创建后不可修改，也不会回收给其他人。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <form
          aria-label="新建账户"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(businessError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-business-id">
                业务 ID <RequiredMark />
              </FieldLabel>
              <Input
                id="account-business-id"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(businessError)}
                {...register('businessId')}
              />
              <FieldError id="account-business-id-error">{businessError ?? undefined}</FieldError>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(usernameError)} data-disabled={pending}>
                <FieldLabel htmlFor="account-username">
                  用户名 <RequiredMark />
                </FieldLabel>
                <Input
                  id="account-username"
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={Boolean(usernameError)}
                  {...register('username')}
                />
                <FieldError id="account-username-error">{usernameError ?? undefined}</FieldError>
              </Field>
              <Field data-invalid={Boolean(nameError)} data-disabled={pending}>
                <FieldLabel htmlFor="account-name">
                  姓名 <RequiredMark />
                </FieldLabel>
                <Input
                  id="account-name"
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={Boolean(nameError)}
                  {...register('name')}
                />
                <FieldError id="account-name-error">{nameError ?? undefined}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(passwordError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-password">
                初始密码 <RequiredMark />
              </FieldLabel>
              <PasswordInput
                name={createPasswordName}
                autoComplete="new-password"
                disabled={pending}
              >
                <PasswordInputControl
                  id="account-password"
                  ref={createPasswordRef}
                  onChange={onCreatePasswordChange}
                  onBlur={onCreatePasswordBlur}
                  aria-invalid={Boolean(passwordError)}
                />
                <PasswordInputToggle />
              </PasswordInput>
              <FieldError id="account-password-error">{passwordError ?? undefined}</FieldError>
            </Field>
            {canAssignRoles ? (
              <FieldSet className="gap-2" disabled={pending}>
                <FieldLegend variant="label" className="mb-2 data-disabled:opacity-50">
                  角色
                </FieldLegend>
                <RoleChecks
                  directory={roleDirectory}
                  selected={roleIds}
                  disabled={pending}
                  onToggle={(id) =>
                    setValue(
                      'roleIds',
                      roleIds.includes(id)
                        ? roleIds.filter((item) => item !== id)
                        : [...roleIds, id],
                      { shouldDirty: true },
                    )
                  }
                />
              </FieldSet>
            ) : null}
            {restorePrompt ? (
              <div className="flex flex-col gap-3 rounded-card border p-3 text-sm">
                <p className="whitespace-pre-wrap text-fg">
                  {restorePrompt ||
                    '该业务 ID 已有历史记录。恢复会新建登录资料，并保留原角色与业务授权。'}
                </p>
                <p className="text-xs text-muted-foreground">
                  恢复只使用当前填写的业务 ID，不需要其他技术 ID。
                </p>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setRestorePrompt(null)}
                  >
                    取消恢复
                  </Button>
                  <Button
                    type="button"
                    disabled={pending || rolesUnavailable}
                    onClick={() => {
                      void handleSubmit(
                        (values) => doCreate(values, true),
                        () => setError(null),
                      )();
                    }}
                  >
                    <ShieldCheck data-icon="inline-start" aria-hidden="true" /> 恢复原身份和授权
                  </Button>
                </div>
              </div>
            ) : null}
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending || rolesUnavailable} aria-busy={pending}>
                {pending ? '正在创建…' : '创建账户'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
