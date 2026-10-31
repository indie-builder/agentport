import { isValidBusinessId } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, SearchX, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { RequiredMark } from '../components/required-mark.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Dialog } from '../components/ui/dialog.js';
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
import { can } from '../lib/access.js';
import { type Account, ApiError, errorMessage } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
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
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useAccounts({ q: settled, limit: PAGE_SIZE, offset });
  const canManage = can(me.data, 'accounts.manage');
  const canManageRoles = can(me.data, 'roles.manage');
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

  return (
    <Page>
      <PageHeader
        title="账户"
        actions={
          canManage ? (
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
            setQuery(next);
            setOffset(0);
          }}
          className="w-72 min-w-0"
        />
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {accounts.isPending ? '加载中…' : accounts.isError ? '数量不可用' : `共 ${total} 个账户`}
        </span>
      </PageToolbar>

      {accounts.isPending ? <LoadingState rows={4} /> : null}
      {accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : null}
      {accounts.data && items.length === 0 ? (
        <PageNote
          icon={<SearchX />}
          title={settled ? '没有匹配的账户' : '还没有账户'}
          description={settled ? undefined : '创建后即可分配角色；删除认证资料不会移除业务授权。'}
          action={
            canManage && !settled ? (
              <Button onClick={() => setCreating(true)}>新建账户</Button>
            ) : undefined
          }
        />
      ) : null}

      {items.length > 0 ? (
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
                <TableCell className="text-muted-foreground">
                  {new Date(account.createdAt).toLocaleDateString('zh-CN')}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {canManage ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(account)}>
                          编辑
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setResetting(account)}>
                          重置密码
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            account.status === 'active'
                              ? setStatusTarget(account)
                              : setStatus.mutate(
                                  { businessId: account.businessId, status: 'active' },
                                  {
                                    onSuccess: () => toastSuccess(`已启用 ${account.name}`),
                                    onError: toastError,
                                  },
                                )
                          }
                        >
                          {account.status === 'active' ? '停用' : '启用'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger"
                          onClick={() => setDeleting(account)}
                        >
                          删除认证
                        </Button>
                      </>
                    ) : null}
                    {canManageRoles ? (
                      <Button variant="ghost" size="sm" onClick={() => setAssigningRoles(account)}>
                        分配角色
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

/** 关闭弹层与路由离开共用同一份放弃确认；请求中先取消关闭，成功关闭前结算被拦下的导航。 */
function useDiscardGuard(dirty: boolean, pending: boolean, onClose: () => void) {
  const blocker = useFormBlocker(dirty, pending);
  const blockerRef = useRef(blocker);
  useEffect(() => {
    blockerRef.current = blocker;
  }, [blocker]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const finish = (): void => {
    blockerRef.current.reset?.();
    onClose();
  };
  const close = (): void => {
    if (pending) return;
    if (dirty) setConfirmDiscard(true);
    else finish();
  };
  return { blocker, confirmDiscard, setConfirmDiscard, finish, close };
}

function DiscardGuards({
  guard,
  pending,
}: {
  guard: ReturnType<typeof useDiscardGuard>;
  pending: boolean;
}) {
  return (
    <>
      <ConfirmDialog
        open={guard.confirmDiscard}
        onClose={() => guard.setConfirmDiscard(false)}
        title="放弃未保存的更改？"
        description="关闭后填写的内容会丢失。"
        confirmLabel="放弃并关闭"
        confirmDisabled={pending}
        onConfirm={async () => {
          if (!pending) guard.finish();
        }}
      />
      <ConfirmDialog
        open={guard.blocker.status === 'blocked'}
        onClose={() => guard.blocker.reset?.()}
        title="放弃未保存的更改？"
        description={pending ? '正在保存，请等待请求完成。' : '离开后填写的内容会丢失。'}
        confirmLabel="放弃并离开"
        confirmDisabled={pending}
        onConfirm={async () => guard.blocker.proceed()}
      />
    </>
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

function CreateAccountDialog({
  canAssignRoles,
  roleDirectory,
  onClose,
}: {
  canAssignRoles: boolean;
  roleDirectory: RoleDirectory;
  onClose: () => void;
}) {
  const create = useCreateAccount();
  const [businessId, setBusinessId] = useState('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setpassword] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [restore, setRestore] = useState(false);
  const [restorePrompt, setRestorePrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = create.isPending && !saved;
  const dirty =
    !saved &&
    (businessId !== '' || username !== '' || name !== '' || password !== '' || roleIds.length > 0);
  const guard = useDiscardGuard(dirty, pending, onClose);
  const rolesUnavailable = canAssignRoles && roleDirectory.roles === undefined;
  const businessError = submitted ? validateBusinessId(businessId) : null;
  const usernameError = submitted && username.length === 0 ? '请填写用户名。' : null;
  const nameError = submitted && name.trim().length === 0 ? '请填写姓名。' : null;
  const passwordError = submitted && password.length < 8 ? '密码至少 8 个字符。' : null;

  const submit = async (asRestore: boolean): Promise<void> => {
    if (pending) return;
    setSubmitted(true);
    setError(null);
    if (
      validateBusinessId(businessId) ||
      username.length === 0 ||
      name.trim().length === 0 ||
      password.length < 8
    ) {
      return;
    }
    // 角色目录没有结果时不能创建，也不允许走恢复流程兜底。
    if (rolesUnavailable) {
      setError('角色目录没有加载出来，请重试后再创建。');
      return;
    }
    try {
      await create.mutateAsync({
        businessId,
        username,
        name,
        password,
        restore: asRestore,
        ...(canAssignRoles && roleIds.length > 0 ? { roleIds } : {}),
      });
      setSaved(true);
      toastSuccess(`已创建账户 ${name}`);
      guard.finish();
    } catch (cause) {
      if (!asRestore && cause instanceof ApiError && cause.status === 409) {
        setRestorePrompt(cause.message || '该业务 ID 存在历史记录。');
        return;
      }
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
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
            void submit(restore);
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
                value={businessId}
                onChange={(event) => setBusinessId(event.target.value)}
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
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
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
                  value={name}
                  onChange={(event) => setName(event.target.value)}
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
                value={password}
                onChange={(event) => setpassword(event.target.value)}
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
                    setRoleIds((current) =>
                      current.includes(id)
                        ? current.filter((item) => item !== id)
                        : [...current, id],
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
                      void submit(true);
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
        <DiscardGuards guard={guard} pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function EditAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const update = useUpdateAccount();
  const [username, setUsername] = useState(account.username);
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = update.isPending && !saved;
  const dirty = !saved && (username !== account.username || name !== account.name);
  const guard = useDiscardGuard(dirty, pending, onClose);
  const usernameError = submitted && username.length === 0 ? '请填写用户名。' : null;
  const nameError = submitted && name.trim().length === 0 ? '请填写姓名。' : null;

  const submit = async (): Promise<void> => {
    if (pending) return;
    setSubmitted(true);
    setError(null);
    if (username.length === 0 || name.trim().length === 0) return;
    try {
      await update.mutateAsync({
        businessId: account.businessId,
        input: {
          ...(username === account.username ? {} : { username }),
          ...(name === account.name ? {} : { name }),
        },
      });
      setSaved(true);
      toastSuccess('账户资料已更新');
      guard.finish();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell
        title={`编辑账户「${account.name}」`}
        description={`业务 ID ${account.businessId} 创建后不可修改。`}
        className="max-w-lg sm:max-w-lg"
        closeDisabled={pending}
      >
        <form
          aria-label="编辑账户"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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
                value={username}
                onChange={(event) => setUsername(event.target.value)}
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
                value={name}
                onChange={(event) => setName(event.target.value)}
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
        <DiscardGuards guard={guard} pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function ResetPasswordDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const reset = useResetAccountPassword();
  const [password, setpassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = reset.isPending && !saved;
  const dirty = !saved && (password !== '' || confirm !== '');
  const guard = useDiscardGuard(dirty, pending, onClose);
  const passwordError = submitted && password.length < 8 ? '密码至少 8 个字符。' : null;
  const confirmError = submitted && confirm !== password ? '两次输入的密码不一致。' : null;

  const submit = async (): Promise<void> => {
    if (pending) return;
    setSubmitted(true);
    setError(null);
    if (password.length < 8 || password !== confirm) return;
    try {
      await reset.mutateAsync({ businessId: account.businessId, password });
      setSaved(true);
      toastSuccess('密码已重置');
      guard.finish();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell
        title={`重置「${account.name}」的密码`}
        description="重置会立即撤销该账户的全部旧会话。"
        className="max-w-md sm:max-w-md"
        closeDisabled={pending}
      >
        <form
          aria-label="重置密码"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
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
                value={password}
                onChange={(event) => setpassword(event.target.value)}
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
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
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
        <DiscardGuards guard={guard} pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function AssignRolesDialog({
  account,
  roleDirectory,
  onClose,
}: {
  account: Account;
  roleDirectory: RoleDirectory;
  onClose: () => void;
}) {
  const save = useSetAccountRoles();
  const initialRoleIds = account.roles.map((role) => role.id);
  const [selected, setSelected] = useState<string[]>(initialRoleIds);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = save.isPending && !saved;
  const dirty =
    !saved && [...selected].sort().join('\u0000') !== [...initialRoleIds].sort().join('\u0000');
  const guard = useDiscardGuard(dirty, pending, onClose);
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
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
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
        <DiscardGuards guard={guard} pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
