import {
  type Department,
  departmentInputSchema,
  departmentMembersInputSchema,
} from '@agentport/shared';
import { EllipsisVertical, Pencil, Trash2, Users } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CursorListFooter } from '../../components/cursor-list-footer.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../../components/draft-guard.js';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { RequiredMark } from '../../components/required-mark.js';
import { SearchInput } from '../../components/search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { Field, FieldError, FieldGroup, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { errorMessage } from '../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime } from '../../lib/format.js';
import {
  useCreateDepartment,
  useDeleteDepartment,
  useDepartments,
  useGovernanceIdentities,
  useSetDepartmentMembers,
  useUpdateDepartment,
} from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { useZodForm } from '../../lib/use-zod-form.js';

const DEPARTMENT_MEMBERS_FORM_ID = 'governance-department-members-form';

function managerNames(department: Department): string {
  return department.members
    .filter((member) => member.isManager)
    .map((member) => member.name)
    .join('、');
}

export function DepartmentsSection({
  canManage,
  creating,
  onCreatingChange,
}: {
  canManage: boolean;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const departments = useDepartments();
  const remove = useDeleteDepartment();
  const [renaming, setRenaming] = useState<Department | null>(null);
  const [managing, setManaging] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const manageTriggerRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const rows = departments.data ?? [];

  const activeDepartment = managing
    ? (rows.find((item) => item.id === managing.id) ?? managing)
    : null;

  const columns = useMemo<DataColumn<Department>[]>(() => {
    const base: DataColumn<Department>[] = [
      {
        id: 'name',
        header: '部门',
        locked: true,
        width: 'minmax(180px,1.5fr)',
        sortValue: (department) => department.name,
        cell: (department) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
            title={department.name}
          >
            {department.name}
          </span>
        ),
      },
      {
        id: 'members',
        header: '成员',
        numeric: true,
        width: '88px',
        sortValue: (department) => department.members.length,
        cell: (department) => department.members.length,
      },
      {
        id: 'managers',
        header: '负责人',
        width: 'minmax(160px,1.3fr)',
        sortValue: (department) => managerNames(department),
        cell: (department) => {
          const names = managerNames(department);
          return (
            <span
              className="block overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
              {...(names ? { title: names } : {})}
            >
              {names || '—'}
            </span>
          );
        },
      },
      {
        id: 'updatedAt',
        header: '更新时间',
        width: '128px',
        sortValue: (department) => department.updatedAt,
        cell: (department) => (
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
            {formatDateTime(department.updatedAt)}
          </span>
        ),
      },
    ];

    if (canManage) {
      base.push({
        id: 'actions',
        header: '操作',
        locked: true,
        align: 'end',
        width: '48px',
        cell: (department) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="更多操作"
                  onFocus={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                  onPointerDown={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                  onClick={(event) => {
                    menuTriggerRef.current = event.currentTarget;
                  }}
                >
                  <EllipsisVertical aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  manageTriggerRef.current = menuTriggerRef.current;
                  setManaging(department);
                }}
              >
                <Users aria-hidden="true" />
                管理成员
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenaming(department)}>
                <Pencil aria-hidden="true" />
                改名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(department)}>
                <Trash2 aria-hidden="true" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      });
    }

    return base;
  }, [canManage]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
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
              <Button variant="outline" size="sm" onClick={() => onCreatingChange(true)}>
                新建部门
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(department) => department.id}
          rowLabel={(department) => department.name}
          label="部门列表"
          storageKey="pace.governance.departments-columns"
          onRowClick={(department, trigger) => {
            manageTriggerRef.current = trigger;
            setManaging(department);
          }}
        />
      ) : null}
      <CursorListFooter className="pt-2" query={departments} label="部门" />

      {creating ? <DepartmentDialog onClose={() => onCreatingChange(false)} /> : null}
      {renaming ? (
        <DepartmentDialog
          department={renaming}
          onClose={() => setRenaming(null)}
          finalFocus={() => (menuTriggerRef.current?.isConnected ? menuTriggerRef.current : null)}
        />
      ) : null}
      {activeDepartment ? (
        <DepartmentMembersSheet
          key={activeDepartment.id}
          department={activeDepartment}
          canManage={canManage}
          onClose={() => setManaging(null)}
          finalFocus={() =>
            manageTriggerRef.current?.isConnected ? manageTriggerRef.current : null
          }
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="删除部门"
          description={`删除「${deleting.name}」后，成员关系一并移除；已有预算保留但不再归属该部门。`}
          finalFocus={() => (menuTriggerRef.current?.isConnected ? menuTriggerRef.current : null)}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            toastSuccess('部门已删除');
          }}
        />
      ) : null}
    </div>
  );
}

function DepartmentDialog({
  department,
  onClose: onClosed,
  finalFocus,
}: {
  department?: Department | undefined;
  onClose: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
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
        {...(finalFocus === undefined ? {} : { finalFocus })}
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

function DepartmentMembersSheet({
  department,
  canManage,
  onClose: onClosed,
  finalFocus,
}: {
  department: Department;
  canManage: boolean;
  onClose: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const dialog = useDialogClose(onClosed);
  const saveMembers = useSetDepartmentMembers();
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query.trim(), 300);
  const accounts = useGovernanceIdentities(canManage ? settled : '', canManage);
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
  const dirty = !saved && canManage && formState.isDirty;
  const guard = useDraftGuard(dirty, pending, dialog.close);
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
  const selectedRows = members.map((member) => ({
    ...member,
    ...(knownMembers.current.get(member.businessId) ?? {
      name: member.businessId,
      accountActive: true,
    }),
  }));
  const resultRows = canManage
    ? (accounts.data ?? [])
        .filter((account) => !selectedIds.has(account.businessId))
        .map((account) => ({
          businessId: account.businessId,
          name: account.name,
          accountActive: account.accountActive,
          isManager: false,
        }))
    : [];
  const allRows = [...selectedRows, ...resultRows];

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

  const footer = canManage ? (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
        取消
      </Button>
      <Button
        type="submit"
        form={DEPARTMENT_MEMBERS_FORM_ID}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? '正在保存…' : '保存成员'}
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
        title={department.name}
        eyebrow={<StatusBadge>{members.length} 人</StatusBadge>}
        description="每位用户只能属于一个部门。"
        closeDisabled={pending}
        {...(footer === undefined ? {} : { footer })}
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        {canManage ? (
          <form
            id={DEPARTMENT_MEMBERS_FORM_ID}
            aria-label="管理部门成员"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup className="gap-4">
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
              <div className="flex flex-col divide-y divide-line border-y">
                {allRows.length === 0 ? (
                  <EmptyState variant="filter" scale="inline" title="没有匹配的账户" />
                ) : (
                  allRows.map((row) => {
                    const selected = selectedIds.has(row.businessId);
                    return (
                      <div
                        key={row.businessId}
                        className="flex min-w-0 flex-wrap items-center gap-3 py-2.5"
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
                          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg">
                            {row.name}
                          </span>
                          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground">
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
              <CursorListFooter query={accounts} label="账户" />
              <FieldError>{error ?? undefined}</FieldError>
            </FieldGroup>
          </form>
        ) : selectedRows.length === 0 ? (
          <EmptyState variant="idle" scale="inline" title="暂无部门成员" />
        ) : (
          <ul className="divide-y divide-line border-y">
            {selectedRows.map((row) => (
              <li
                key={row.businessId}
                className="flex min-w-0 items-center justify-between gap-3 py-2.5 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg">
                    {row.name}
                  </span>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {row.businessId}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {row.isManager ? <StatusBadge>负责人</StatusBadge> : null}
                  {row.accountActive ? null : <StatusBadge>停用</StatusBadge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </InspectorSheet>
      <DraftGuardDialogs guard={guard} draft="成员改动会丢失。" pending={pending} />
    </>
  );
}
