import { isValidBusinessId } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  CirclePause,
  CirclePlay,
  KeyRound,
  MoreHorizontal,
  Plus,
  SearchX,
  ShieldCheck,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/draft-guard.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
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
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { type Account, ApiError, errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { guardedOpenChange, useDialogClose } from '../lib/dialog-guard.js';
import { formatDate } from '../lib/format.js';
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
  const [offset, setOffset] = useState(0);
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useAccounts({ q: settled, limit: PAGE_SIZE, offset });
  const canManage = can(me.data, 'accounts.manage');
  const canManageRoles = can(me.data, 'roles.manage');
  const view = search.view ?? 'cards';
  const setView = (next: 'table' | 'cards'): void => {
    void navigate({
      to: '/accounts',
      search: (current) => ({ ...current, view: next }),
      replace: true,
    });
  };
  const roles = useRoleMatrix(canManageRoles);
  // 角色目录的加载与失败要原样交给弹窗处理，不能在这里抹成空数组。
  const roleDirectory: RoleDirectory = {
    roles: roles.data?.roles,
    loading: roles.isPending,
    error: roles.error,
    refetch: () => void roles.refetch(),
  };
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [resetting, setResetting] = useState<Account | null>(null);
  const [assigningRoles, setAssigningRoles] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [statusTarget, setStatusTarget] = useState<Account | null>(null);
  const remove = useDeleteAccount();
  const setStatus = useSetAccountStatus();

  const total = accounts.data?.total ?? 0;
  const items = accounts.data?.items ?? [];
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const toggleStatus = (account: Account): void => {
    if (account.status === 'active') {
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
  };

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="账户"
          actions={
            canManage && !(accounts.data && items.length === 0 && !settled) ? (
              <Button onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" /> 新建账户
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
              setOffset(0);
              void navigate({
                to: '/accounts',
                search: { ...search, q: next || undefined },
                replace: true,
              });
            }}
            className="w-56 min-w-0"
          />
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span role="status" className="text-xs text-muted-foreground">
              {accounts.isPending
                ? '加载中…'
                : accounts.isError
                  ? '数量不可用'
                  : `共 ${total} 个账户`}
            </span>
            <ViewToggle value={view} onChange={setView} />
          </div>
        </PageToolbar>
      </PageTopbar>

      <PageBody>
        {accounts.isPending ? (
          <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
        ) : null}
        {accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : null}
        {accounts.data && items.length === 0 ? (
          <PageNote
            icon={settled ? <SearchX /> : <UsersRound />}
            title={settled ? '没有匹配的账户' : '还没有账户'}
            description={settled ? undefined : '创建后即可分配角色；删除认证资料不会移除业务授权。'}
            action={
              settled ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOffset(0);
                    void navigate({
                      to: '/accounts',
                      search: { ...search, q: undefined },
                      replace: true,
                    });
                  }}
                >
                  清除筛选
                </Button>
              ) : canManage ? (
                <Button onClick={() => setCreating(true)}>新建账户</Button>
              ) : undefined
            }
          />
        ) : null}

        {items.length > 0 && view === 'table' ? (
          <Table aria-label="账户列表">
            <TableHeader>
              <TableRow>
                <TableHead>业务 ID</TableHead>
                <TableHead>姓名</TableHead>
                <TableHead>用户名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((account) => (
                <TableRow key={account.businessId}>
                  <TableCell className="font-mono text-xs">{account.businessId}</TableCell>
                  <TableCell>{account.name}</TableCell>
                  <TableCell>{account.username}</TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    {account.roles.map((role) => role.name).join('、') || '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge>{account.status === 'active' ? '启用' : '停用'}</StatusBadge>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-muted-foreground">
                    {formatDate(account.createdAt)}
                  </TableCell>
                  <TableCell>
                    <AccountRowActions
                      account={account}
                      canManage={canManage}
                      canManageRoles={canManageRoles}
                      className="justify-end"
                      onEdit={setEditing}
                      onResetPassword={setResetting}
                      onAssignRoles={setAssigningRoles}
                      onToggleStatus={toggleStatus}
                      onDelete={setDeleting}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {items.length > 0 && view === 'cards' ? (
          <ul
            aria-label="账户列表"
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-2"
          >
            {items.map((account) => (
              <li key={account.businessId} className="min-w-0">
                <Card size="sm" className="h-full">
                  <CardHeader className="grid-cols-[minmax(0,1fr)_auto]! items-center">
                    <CardTitle className="flex min-w-0 items-center gap-2">
                      <span className="truncate" title={account.name}>
                        {account.name}
                      </span>
                      <StatusBadge>{account.status === 'active' ? '启用' : '停用'}</StatusBadge>
                    </CardTitle>
                    <CardAction className="col-start-2 row-start-1">
                      <AccountRowActions
                        account={account}
                        canManage={canManage}
                        canManageRoles={canManageRoles}
                        onEdit={setEditing}
                        onResetPassword={setResetting}
                        onAssignRoles={setAssigningRoles}
                        onToggleStatus={toggleStatus}
                        onDelete={setDeleting}
                      />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-xs text-muted-foreground">业务 ID</span>
                      <span
                        className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                        title={account.businessId}
                      >
                        {account.businessId}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-xs text-muted-foreground">用户名</span>
                      <span className="min-w-0 break-words text-right text-sm text-fg">
                        {account.username}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">角色</span>
                      <span className="whitespace-normal text-sm text-fg">
                        {account.roles.map((role) => role.name).join('、') || '—'}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-xs text-muted-foreground">创建时间</span>
                      <span className="text-sm text-muted-foreground">
                        {formatDate(account.createdAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : null}

        {pages > 1 ? (
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || accounts.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </Button>
            <span className="text-muted-foreground">
              {page} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || accounts.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
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
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? <EditAccountDialog account={editing} onClose={() => setEditing(null)} /> : null}

      {resetting ? (
        <ResetPasswordDialog account={resetting} onClose={() => setResetting(null)} />
      ) : null}

      {assigningRoles ? (
        <AssignRolesDialog
          account={assigningRoles}
          roleDirectory={roleDirectory}
          onClose={() => setAssigningRoles(null)}
        />
      ) : null}

      <ConfirmDialog
        open={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        title={`停用账户「${statusTarget?.name ?? ''}」`}
        description="停用会立即撤销全部会话；业务数据、角色与授权保留。重新启用后需要重新登录。"
        confirmLabel={statusTarget?.status === 'active' ? '停用' : '启用'}
        onConfirm={async () => {
          if (!statusTarget) return;
          try {
            await setStatus.mutateAsync({
              businessId: statusTarget.businessId,
              status: 'disabled',
            });
            toastSuccess(`已停用 ${statusTarget.name}`);
            setStatusTarget(null);
          } catch (error) {
            toastError(error);
          }
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除「${deleting?.name ?? ''}」的登录认证`}
        description="只删除登录资料，业务内容、角色、专家归属与个人记忆都会保留；之后可用同一业务 ID 恢复原身份和授权。"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.businessId);
            toastSuccess('已删除登录认证，业务授权仍保留');
            setDeleting(null);
          } catch (error) {
            toastError(error);
          }
        }}
      />
    </Page>
  );
}

type RoleDirectory = {
  roles: Array<{ id: string; name: string }> | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => void;
};

function AccountRowActions({
  account,
  canManage,
  canManageRoles,
  className,
  onEdit,
  onResetPassword,
  onAssignRoles,
  onToggleStatus,
  onDelete,
}: {
  account: Account;
  canManage: boolean;
  canManageRoles: boolean;
  className?: string;
  onEdit: (account: Account) => void;
  onResetPassword: (account: Account) => void;
  onAssignRoles: (account: Account) => void;
  onToggleStatus: (account: Account) => void;
  onDelete: (account: Account) => void;
}) {
  if (!canManage && !canManageRoles) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {canManage ? (
        <Button variant="ghost" size="sm" onClick={() => onEdit(account)}>
          编辑
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`操作 ${account.name}`}>
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" sideOffset={4} className="w-40">
          <DropdownMenuGroup>
            {canManageRoles ? (
              <DropdownMenuItem onSelect={() => onAssignRoles(account)}>
                <ShieldCheck /> 分配角色
              </DropdownMenuItem>
            ) : null}
            {canManage ? (
              <>
                <DropdownMenuItem onSelect={() => onResetPassword(account)}>
                  <KeyRound /> 重置密码
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onToggleStatus(account)}>
                  {account.status === 'active' ? <CirclePause /> : <CirclePlay />}
                  {account.status === 'active' ? '停用' : '启用'}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuGroup>
          {canManage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(account)}>
                <Trash2 /> 删除认证
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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
          <p className="text-sm text-muted-foreground">没有可分配的角色。</p>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
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

const accountFormSchema = z.object({
  businessId: z.string().superRefine((value, ctx) => {
    const message = validateBusinessId(value);
    if (message) ctx.addIssue({ code: 'custom', message });
  }),
  username: z.string().min(1, '请填写用户名。'),
  name: z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) ctx.addIssue({ code: 'custom', message: '请填写姓名。' });
  }),
  password: z.string().min(8, '密码至少 8 个字符。'),
  roleIds: z.array(z.string()),
});
type AccountFormValues = z.infer<typeof accountFormSchema>;

function CreateAccountDialog({
  canAssignRoles,
  roleDirectory,
  onClose: onClosed,
}: {
  canAssignRoles: boolean;
  roleDirectory: RoleDirectory;
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
  const [restore, setRestore] = useState(false);
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

  const doCreate = async (values: AccountFormValues, asRestore: boolean): Promise<void> => {
    if (pending) return;
    setError(null);
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
    (values) => doCreate(values, restore),
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
                aria-describedby={businessError ? 'account-business-id-error' : undefined}
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
                  aria-describedby={usernameError ? 'account-username-error' : undefined}
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
                  aria-describedby={nameError ? 'account-name-error' : undefined}
                  {...register('name')}
                />
                <FieldError id="account-name-error">{nameError ?? undefined}</FieldError>
              </Field>
            </div>
            <Field data-invalid={Boolean(passwordError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-password">
                初始密码 <RequiredMark />
              </FieldLabel>
              <Input
                id="account-password"
                type="password"
                autoComplete="new-password"
                disabled={pending}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? 'account-password-error' : undefined}
                {...register('password')}
              />
              <FieldError id="account-password-error">{passwordError ?? undefined}</FieldError>
            </Field>
            {canAssignRoles ? (
              <Field data-disabled={pending}>
                <FieldLabel>角色</FieldLabel>
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
              </Field>
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
                      setRestore(true);
                      void handleSubmit(
                        (values) => doCreate(values, true),
                        () => setError(null),
                      )();
                    }}
                  >
                    <ShieldCheck data-icon="inline-start" /> 恢复原身份和授权
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

const accountEditFormSchema = z.object({
  username: z.string().min(1, '请填写用户名。'),
  name: z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) ctx.addIssue({ code: 'custom', message: '请填写姓名。' });
  }),
});
type AccountEditFormValues = z.infer<typeof accountEditFormSchema>;

function EditAccountDialog({
  account,
  onClose: onClosed,
}: {
  account: Account;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const update = useUpdateAccount();
  const { register, handleSubmit, formState } = useZodForm(accountEditFormSchema, {
    defaultValues: { username: account.username, name: account.name },
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = update.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const usernameError = errors.username?.message;
  const nameError = errors.name?.message;

  const submit = handleSubmit(
    async (values: AccountEditFormValues) => {
      if (pending) return;
      setError(null);
      try {
        await update.mutateAsync({
          businessId: account.businessId,
          input: {
            ...(values.username === account.username ? {} : { username: values.username }),
            ...(values.name === account.name ? {} : { name: values.name }),
          },
        });
        setSaved(true);
        toastSuccess('账户资料已更新');
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
        title={`编辑账户「${account.name}」`}
        description={`业务 ID ${account.businessId} 创建后不可修改。`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form aria-label="编辑账户" noValidate onSubmit={submit}>
          <FieldGroup className="gap-5">
            <Field data-disabled>
              <FieldLabel htmlFor="account-edit-business-id">业务 ID</FieldLabel>
              <Input id="account-edit-business-id" readOnly value={account.businessId} />
            </Field>
            <Field data-invalid={Boolean(usernameError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-edit-username">用户名</FieldLabel>
              <Input
                id="account-edit-username"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(usernameError)}
                aria-describedby={usernameError ? 'account-edit-username-error' : undefined}
                {...register('username')}
              />
              <FieldError id="account-edit-username-error">{usernameError ?? undefined}</FieldError>
            </Field>
            <Field data-invalid={Boolean(nameError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-edit-name">姓名</FieldLabel>
              <Input
                id="account-edit-name"
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? 'account-edit-name-error' : undefined}
                {...register('name')}
              />
              <FieldError id="account-edit-name-error">{nameError ?? undefined}</FieldError>
            </Field>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在保存…' : '保存'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

const resetPasswordFormSchema = z
  .object({
    password: z.string().min(8, '密码至少 8 个字符。'),
    confirm: z.string(),
  })
  .refine((values) => values.confirm === values.password, {
    message: '两次输入的密码不一致。',
    path: ['confirm'],
  });
type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

function ResetPasswordDialog({
  account,
  onClose: onClosed,
}: {
  account: Account;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const reset = useResetAccountPassword();
  const { register, handleSubmit, formState } = useZodForm(resetPasswordFormSchema, {
    defaultValues: { password: '', confirm: '' },
  });
  const { errors, isDirty } = formState;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = reset.isPending && !saved;
  const dirty = !saved && isDirty;
  const guard = useDraftGuard(dirty, pending, onClose);
  const passwordError = errors.password?.message;
  const confirmError = errors.confirm?.message;

  const submit = handleSubmit(
    async (values: ResetPasswordFormValues) => {
      if (pending) return;
      setError(null);
      try {
        await reset.mutateAsync({ businessId: account.businessId, password: values.password });
        setSaved(true);
        toastSuccess('密码已重置');
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
        title={`重置「${account.name}」的密码`}
        description="重置会立即撤销该账户的全部旧会话。"
        className="max-w-md sm:max-w-md"
        closeDisabled={pending}
      >
        <form aria-label="重置密码" noValidate onSubmit={submit}>
          <FieldGroup className="gap-5">
            <Field data-invalid={Boolean(passwordError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-reset-password">新密码</FieldLabel>
              <Input
                id="account-reset-password"
                type="password"
                autoComplete="new-password"
                disabled={pending}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? 'account-reset-password-error' : undefined}
                {...register('password', { deps: ['confirm'] })}
              />
              <FieldError id="account-reset-password-error">
                {passwordError ?? undefined}
              </FieldError>
            </Field>
            <Field data-invalid={Boolean(confirmError)} data-disabled={pending}>
              <FieldLabel htmlFor="account-reset-confirm">确认新密码</FieldLabel>
              <Input
                id="account-reset-confirm"
                type="password"
                autoComplete="new-password"
                disabled={pending}
                aria-invalid={Boolean(confirmError)}
                aria-describedby={confirmError ? 'account-reset-confirm-error' : undefined}
                {...register('confirm')}
              />
              <FieldError id="account-reset-confirm-error">{confirmError ?? undefined}</FieldError>
            </Field>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending} aria-busy={pending}>
                {pending ? '正在重置…' : '重置密码'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function AssignRolesDialog({
  account,
  roleDirectory,
  onClose: onClosed,
}: {
  account: Account;
  roleDirectory: RoleDirectory;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const save = useSetAccountRoles();
  const initialRoleIds = account.roles.map((role) => role.id);
  const [selected, setSelected] = useState<string[]>(initialRoleIds);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = save.isPending && !saved;
  const dirty =
    !saved && [...selected].sort().join('\u0000') !== [...initialRoleIds].sort().join('\u0000');
  const guard = useDraftGuard(dirty, pending, onClose);
  const rolesUnavailable = roleDirectory.roles === undefined;

  const submit = async (): Promise<void> => {
    if (pending) return;
    setError(null);
    if (rolesUnavailable) {
      setError('角色目录没有加载出来，请重试后再保存。');
      return;
    }
    try {
      await save.mutateAsync({ businessId: account.businessId, roleIds: selected });
      setSaved(true);
      toastSuccess('角色已更新');
      guard.finish();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(pending, guard.close)}
    >
      <DialogShell
        title={`分配「${account.name}」的角色`}
        description="角色决定该账户的页面与操作权限。"
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="分配角色"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-disabled={pending}>
              <FieldLabel>角色</FieldLabel>
              <RoleChecks
                directory={roleDirectory}
                selected={selected}
                disabled={pending}
                onToggle={(id) =>
                  setSelected((current) =>
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
                  )
                }
              />
            </Field>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
                取消
              </Button>
              <Button type="submit" disabled={pending || rolesUnavailable} aria-busy={pending}>
                {pending ? '正在保存…' : '保存'}
              </Button>
            </div>
          </FieldGroup>
        </form>
        <DraftGuardDialogs guard={guard} draft="填写的内容会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
