import {
  type AccessScope,
  PERMISSION_IDS,
  type PermissionDefinition,
  type PermissionGrant,
  roleMatrixInputSchema,
} from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  createExpandedRowModel,
  type ExpandedState,
  type Row,
  rowExpandingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ChevronDown, ChevronRight, Plus, RotateCcw, Save, Settings, Trash2 } from 'lucide-react';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Control,
  type DeepPartial,
  type FieldArrayWithId,
  useController,
  useFieldArray,
  useFormState,
  useWatch,
} from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group.js';
import {
  buildPermissionTree,
  can,
  filterPermissionTree,
  groupLeafIds,
  type PermissionTreeGroup,
  SCOPE_LABELS,
  SCOPE_ORDER,
} from '../lib/access.js';
import { ApiError, errorMessage, type Role, type RoleMatrix } from '../lib/api.js';
import { useFormBlocker } from '../lib/form.js';
import {
  meQuery,
  permissionCatalogQuery,
  roleMatrixQuery,
  useSaveRoleMatrix,
} from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';
import { rolesSearchSchema } from '../routes/-search.js';

const formSchema = z
  .object({
    expectedRevision: roleMatrixInputSchema.shape.expectedRevision,
    roles: z.array(
      z.object({
        roleId: z.string().nullable(),
        systemKey: z.enum(['admin', 'user', 'owner', 'maintainer']).nullable(),
        name: z.string().trim().pipe(roleMatrixInputSchema.shape.roles.element.shape.name),
        scopes: z.custom<AccessScope[][]>(() => true),
      }),
    ),
  })
  .superRefine(({ roles }, ctx) => {
    const names = new Map<string, number[]>();
    roles.forEach((role, index) => {
      const indices = names.get(role.name) ?? [];
      indices.push(index);
      names.set(role.name, indices);
    });
    for (const indices of names.values()) {
      if (indices.length < 2) continue;
      for (const index of indices) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles', index, 'name'],
          message: '角色名称不能重复。',
        });
      }
    }
  });

type FormValues = z.input<typeof formSchema>;
type FormRole = FormValues['roles'][number];
type RoleField = FieldArrayWithId<FormValues, 'roles'>;
type Baseline = ReadonlyMap<string, DeepPartial<FormRole>>;
type ScopePath = `roles.${number}.scopes.${number}`;
type RecentAction = { roleName: string; label: string; action: string };

const permissionIndex = new Map<string, number>(PERMISSION_IDS.map((id, index) => [id, index]));

function indexOfPermission(id: string): number {
  const index = permissionIndex.get(id);
  if (index === undefined) throw new Error(`未知权限 ${id}`);
  return index;
}
const features = tableFeatures({
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
});
type MatrixRow =
  | { kind: 'group'; id: string; group: PermissionTreeGroup; children: MatrixRow[] }
  | { kind: 'leaf'; id: string; leaf: PermissionDefinition };
const columns = [{ id: 'permission' }];
const EMPTY_PERMISSIONS: PermissionDefinition[] = [];
const EMPTY_SCOPES: AccessScope[] = [];

function treeRows(groups: readonly PermissionTreeGroup[]): MatrixRow[] {
  return groups.map((group) => ({
    kind: 'group',
    id: group.key,
    group,
    children: [
      ...group.leaves.map((leaf): MatrixRow => ({ kind: 'leaf', id: leaf.id, leaf })),
      ...treeRows(group.children),
    ],
  }));
}

function sortedScopes(scopes: readonly AccessScope[]): AccessScope[] {
  return SCOPE_ORDER.filter((scope) => scopes.includes(scope));
}

function matrixValues(matrix: RoleMatrix): FormValues {
  return {
    expectedRevision: matrix.revision,
    roles: matrix.roles.map((role) => ({
      roleId: role.id,
      name: role.name,
      systemKey: role.systemKey,
      scopes: PERMISSION_IDS.map((id) =>
        sortedScopes(role.grants.filter((grant) => grant.permissionId === id).map((g) => g.scope)),
      ),
    })),
  };
}

function roleKey(role: RoleField): string {
  return role.roleId ?? role.id;
}

function roleDisplayName(name: string): string {
  return name.trim() || '未命名角色';
}

type ChangeKind = 'added' | 'removed' | 'scopes';
const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: '新增',
  removed: '撤销',
  scopes: '范围调整',
};

function changeKind(
  before: readonly (AccessScope | undefined)[],
  after: readonly (AccessScope | undefined)[],
): ChangeKind | null {
  if (before.length === after.length && before.every((scope) => after.includes(scope))) return null;
  if (before.length === 0) return 'added';
  if (after.length === 0) return 'removed';
  return 'scopes';
}

function baselineScopes(baseline: Baseline, roleId: string | null, index: number) {
  return (roleId === null ? undefined : baseline.get(roleId)?.scopes?.[index]) ?? EMPTY_SCOPES;
}

function savedRoleName(roleId: string | null, baseline: Baseline): string | undefined {
  return roleId === null ? undefined : baseline.get(roleId)?.name;
}

function useRoleName(
  control: Control<FormValues>,
  index: number,
  roleId: string | null,
  baseline: Baseline,
) {
  const path = `roles.${index}.name` as const;
  const name = useWatch({ control, name: path, exact: true });
  const { errors } = useFormState({ control, name: path, exact: true });
  const message = errors.roles?.[index]?.name?.message;
  const error = message === '请输入角色名称' ? '角色名称不能为空。' : message;
  const saved = savedRoleName(roleId, baseline);
  return { name, error, displayName: roleDisplayName(error && saved !== undefined ? saved : name) };
}

// 单元格不订阅 errors：RHF exact 订阅仍匹配父路径广播，父级 trigger 会唤醒全部 556 个格子。
function useRoleDisplayName(
  control: Control<FormValues>,
  index: number,
  roleId: string | null,
  baseline: Baseline,
): string {
  const name = useWatch({ control, name: `roles.${index}.name` as const, exact: true });
  const saved = savedRoleName(roleId, baseline);
  return roleDisplayName(name.trim() === '' && saved !== undefined ? saved : name);
}

export function RolesPage() {
  const me = useQuery(meQuery);
  const matrix = useQuery(roleMatrixQuery);
  const save = useSaveRoleMatrix();
  const catalog = useQuery(permissionCatalogQuery);
  const canManage = can(me.data, 'roles.manage');
  const navigate = useNavigate();
  const search = rolesSearchSchema.parse(useSearch({ strict: false }) ?? {});
  const form = useZodForm(formSchema, {
    defaultValues: { expectedRevision: 0, roles: [] },
    mode: 'onChange',
    shouldUnregister: false,
  });
  const { control, getValues, setValue, reset, trigger } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'roles' });
  const { isDirty: dirty, isSubmitting, defaultValues } = useFormState({ control });
  const pending = save.isPending || isSubmitting;
  const baseline = useMemo<Baseline>(
    () =>
      new Map(
        (defaultValues?.roles ?? []).flatMap((role) =>
          role?.roleId == null ? [] : [[role.roleId, role]],
        ),
      ),
    [defaultValues],
  );
  // 管理员按服务端原授权提交，不受界面展示的权限目录裁剪。
  const adminGrants = useRef<Role['grants']>([]);
  const loadedRevision = useRef<number | null>(null);
  const recentAction = useRef<RecentAction | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const [conflict, setConflict] = useState<string | null>(null);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [addingRole, setAddingRole] = useState(false);
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const newRoleButton = useRef<HTMLButtonElement | null>(null);
  const query = search.q ?? '';
  const permissions = catalog.data?.permissions ?? EMPTY_PERMISSIONS;
  const tree = useMemo(() => buildPermissionTree(permissions), [permissions]);
  const visibleTree = useMemo(() => filterPermissionTree(tree, query), [tree, query]);
  const rows = useMemo(() => treeRows(visibleTree), [visibleTree]);
  const searching = query.trim().length > 0;
  const table = useTable<typeof features, MatrixRow>({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    getSubRows: (row) => (row.kind === 'group' ? row.children : undefined),
    state: { expanded: searching ? true : expanded },
    onExpandedChange: setExpanded,
    autoResetExpanded: false,
  });

  const resetMatrix = useCallback(
    (data: RoleMatrix): void => {
      adminGrants.current = data.roles.find((role) => role.systemKey === 'admin')?.grants ?? [];
      loadedRevision.current = data.revision;
      recentAction.current = null;
      reset(matrixValues(data));
      setConflict(null);
    },
    [reset],
  );

  useEffect(() => {
    const data = matrix.data;
    if (!data || loadedRevision.current === data.revision) return;
    if (dirty) {
      setConflict(
        '角色矩阵已在其他窗口更新。当前草稿已保留，保存时会再次校验版本；重新加载会放弃草稿。',
      );
      return;
    }
    resetMatrix(data);
  }, [matrix.data, dirty, resetMatrix]);

  const closeSettings = useCallback((): void => {
    void navigate({
      to: '/roles',
      search: (previous) => ({ ...previous, role: undefined }),
      replace: true,
    });
  }, [navigate]);

  const openSettings = useCallback(
    (key: string, source: HTMLElement | null): void => {
      settingsTrigger.current = source;
      void navigate({ to: '/roles', search: (previous) => ({ ...previous, role: key }) });
    },
    [navigate],
  );

  // append 生成的 field.id 是新角色的 URL 身份，等字段数组更新后再打开设置。
  useEffect(() => {
    if (!addingRole) return;
    const role = fields.at(-1);
    if (!role) return;
    setAddingRole(false);
    openSettings(roleKey(role), newRoleButton.current);
  }, [addingRole, fields, openSettings]);

  const blocker = useFormBlocker(dirty, pending, { ignoreSamePath: true });
  const settingsIndex = fields.findIndex((role) => roleKey(role) === search.role);
  const settingsRole = fields[settingsIndex];
  const roleSettingsFinalFocus = (): HTMLElement | null =>
    settingsTrigger.current?.isConnected ? settingsTrigger.current : newRoleButton.current;

  const setQuery = (next: string): void => {
    void navigate({
      to: '/roles',
      search: (previous) => ({ ...previous, q: next || undefined }),
      replace: true,
    });
  };

  const toggleLeaf = useCallback(
    (roleIndex: number, leaf: PermissionDefinition): void => {
      const index = indexOfPermission(leaf.id);
      const path: ScopePath = `roles.${roleIndex}.scopes.${index}`;
      const current = getValues(path);
      recentAction.current = {
        roleName: roleDisplayName(getValues(`roles.${roleIndex}.name`)),
        label: leaf.label,
        action: current.length > 0 ? '撤销' : '授权',
      };
      setValue(path, current.length > 0 || leaf.scopes[0] === undefined ? [] : [leaf.scopes[0]], {
        shouldDirty: true,
      });
      setConflict(null);
      setError(null);
    },
    [getValues, setValue],
  );

  const toggleGroup = useCallback(
    (roleIndex: number, group: PermissionTreeGroup): void => {
      if (searching) return;
      const ids = groupLeafIds(group);
      const checked = ids.every(
        (id) => getValues(`roles.${roleIndex}.scopes.${indexOfPermission(id)}`).length > 0,
      );
      recentAction.current = {
        roleName: roleDisplayName(getValues(`roles.${roleIndex}.name`)),
        label: group.label,
        action: checked ? '撤销' : '授权',
      };
      for (const id of ids) {
        const path: ScopePath = `roles.${roleIndex}.scopes.${indexOfPermission(id)}`;
        const scopes = getValues(path);
        const fallback = permissions.find((leaf) => leaf.id === id)?.scopes[0];
        if (checked) setValue(path, [], { shouldDirty: true });
        else if (scopes.length === 0 && fallback !== undefined)
          setValue(path, [fallback], { shouldDirty: true });
      }
      setConflict(null);
      setError(null);
    },
    [getValues, setValue, permissions, searching],
  );

  const changeScopes = useCallback(
    (roleIndex: number, leaf: PermissionDefinition, next: AccessScope[]): void => {
      const scopes = sortedScopes(next.filter((scope) => leaf.scopes.includes(scope)));
      recentAction.current = {
        roleName: roleDisplayName(getValues(`roles.${roleIndex}.name`)),
        label: leaf.label,
        action: scopes.length === 0 ? '撤销' : '范围调整',
      };
      setValue(`roles.${roleIndex}.scopes.${indexOfPermission(leaf.id)}`, scopes, {
        shouldDirty: true,
      });
      setConflict(null);
      setError(null);
    },
    [getValues, setValue],
  );

  const changeName = useCallback(
    (index: number, name: string): void => {
      setValue(`roles.${index}.name`, name, { shouldDirty: true });
      // 重复名称涉及两列，整组触发 resolver 才能同时设置/清除两端字段错误。
      void trigger('roles');
      setConflict(null);
      setError(null);
    },
    [setValue, trigger],
  );

  const addRole = (): void => {
    append(
      {
        roleId: null,
        systemKey: null,
        name: `新角色 ${fields.length + 1}`,
        scopes: PERMISSION_IDS.map(() => []),
      },
      { shouldFocus: false },
    );
    setAddingRole(true);
    setConflict(null);
  };

  const reload = async (): Promise<void> => {
    setError(null);
    const result = await matrix.refetch({ throwOnError: true });
    if (!result.data) return;
    resetMatrix(result.data);
    setReloadOpen(false);
  };

  const submit = form.handleSubmit(async (values) => {
    if (save.isPending) return;
    setError(null);
    const input = roleMatrixInputSchema.safeParse({
      expectedRevision: values.expectedRevision,
      roles: values.roles.map((role) => ({
        ...(role.roleId === null ? {} : { id: role.roleId }),
        name: role.name,
        grants:
          role.systemKey === 'admin'
            ? adminGrants.current
            : permissions.flatMap((leaf): PermissionGrant[] =>
                (role.scopes[indexOfPermission(leaf.id)] ?? EMPTY_SCOPES)
                  .filter((scope) => leaf.scopes.includes(scope))
                  .map((scope) => ({ permissionId: leaf.id, scope })),
              ),
      })),
    });
    if (!input.success) {
      setError(input.error.issues.map((issue) => issue.message).join('；'));
      return;
    }
    try {
      const saved = await save.mutateAsync({
        ...input.data,
        roles: input.data.roles.map(({ id, ...role }) => ({
          ...role,
          ...(id === undefined ? {} : { id }),
        })),
      });
      resetMatrix(saved);
      toastSuccess('角色矩阵已保存');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(cause.message || '角色矩阵已被其他操作修改。重新加载会放弃当前草稿。');
      } else setError(errorMessage(cause));
    }
  });

  if (matrix.isPending || catalog.isPending) {
    return (
      <Page>
        <PageHeader title="角色" />
        <LoadingState rows={5} />
      </Page>
    );
  }
  if ((matrix.isError && !matrix.data) || catalog.isError || loadedRevision.current === null) {
    return (
      <Page>
        <PageHeader title="角色" />
        <ErrorState
          error={matrix.error ?? catalog.error ?? new Error('角色矩阵不可用')}
          onRetry={() => {
            void matrix.refetch();
            void catalog.refetch();
          }}
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="角色"
        actions={
          canManage ? (
            <>
              <Button ref={newRoleButton} variant="outline" onClick={addRole} disabled={pending}>
                <Plus data-icon="inline-start" /> 新建角色
              </Button>
              <SaveButton control={control} dirty={dirty} pending={pending} onSubmit={submit} />
            </>
          ) : null
        }
      />
      <PageToolbar>
        <SearchInput
          label="搜索权限"
          placeholder="搜索功能或权限…"
          value={query}
          onChange={setQuery}
          className="w-64 min-w-0"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={searching}
            title={searching ? '搜索期间自动展开匹配路径，清空搜索后可恢复折叠' : undefined}
            onClick={() => table.toggleAllRowsExpanded(true)}
          >
            全部展开
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={searching}
            title={searching ? '搜索期间自动展开匹配路径，清空搜索后可恢复折叠' : undefined}
            onClick={() => table.toggleAllRowsExpanded(false)}
          >
            全部收起
          </Button>
        </div>
        <MatrixFeedback
          control={control}
          baseline={baseline}
          permissions={permissions}
          recentAction={recentAction}
        />
      </PageToolbar>
      {conflict ? (
        <PageNote
          tone="danger"
          title="保存冲突"
          description={conflict}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setReloadOpen(true)}
            >
              <RotateCcw data-icon="inline-start" /> 重新加载
            </Button>
          }
        />
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          当前角色只有查看权限；修改角色矩阵需要 roles.manage。
        </p>
      ) : null}
      {searching && visibleTree.length === 0 ? (
        <PageNote
          title="没有匹配的权限"
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery('')}>
              清除搜索
            </Button>
          }
        />
      ) : (
        <PermissionMatrix
          rows={table.getRowModel().rows}
          fields={fields}
          control={control}
          baseline={baseline}
          tree={tree}
          canManage={canManage}
          pending={pending}
          searching={searching}
          onOpenSettings={openSettings}
          onToggleLeaf={toggleLeaf}
          onToggleGroup={toggleGroup}
        />
      )}
      <Dialog
        open={settingsRole !== undefined && deleteTarget === null}
        onOpenChange={(next, details) => {
          if (next) return;
          if (pending) {
            details.cancel();
            return;
          }
          closeSettings();
        }}
      >
        {settingsRole === undefined ? null : (
          <RoleSettings
            key={settingsRole.id}
            role={settingsRole}
            index={settingsIndex}
            control={control}
            baseline={baseline}
            permissions={permissions}
            canManage={canManage}
            pending={pending}
            finalFocus={roleSettingsFinalFocus}
            onClose={closeSettings}
            onDelete={setDeleteTarget}
            onChangeName={changeName}
            onChangeScopes={changeScopes}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={reloadOpen}
        onClose={() => setReloadOpen(false)}
        title="放弃当前草稿并重新加载？"
        description="重新加载会丢弃本次未保存的修改，并采用服务端最新的角色矩阵。"
        confirmLabel="重新加载"
        onConfirm={reload}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的角色矩阵？"
        description="离开后本次修改不会保存。"
        onConfirm={async () => blocker.proceed()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除这个角色？"
        description="保存后该角色及其实例分配会一并移除。系统管理员角色不能删除。"
        finalFocus={roleSettingsFinalFocus}
        onConfirm={async () => {
          const index = fields.findIndex((role) => roleKey(role) === deleteTarget);
          if (index !== -1) remove(index);
          void trigger('roles');
          setDeleteTarget(null);
          setConflict(null);
          closeSettings();
        }}
      />
    </Page>
  );
}

function SaveButton({
  control,
  dirty,
  pending,
  onSubmit,
}: {
  control: Control<FormValues>;
  dirty: boolean;
  pending: boolean;
  onSubmit: () => Promise<void>;
}) {
  const { errors } = useFormState({ control });
  return (
    <Button
      disabled={!dirty || pending || Boolean(errors.roles)}
      aria-busy={pending}
      onClick={() => void onSubmit()}
    >
      <Save data-icon="inline-start" /> {pending ? '正在保存…' : '保存更改'}
    </Button>
  );
}

function MatrixFeedback({
  control,
  baseline,
  permissions,
  recentAction,
}: {
  control: Control<FormValues>;
  baseline: Baseline;
  permissions: readonly PermissionDefinition[];
  recentAction: RefObject<RecentAction | null>;
}) {
  const roles = useWatch({ control, name: 'roles' });
  const { isDirty } = useFormState({ control });
  let changedLeafCount = 0;
  for (const role of roles) {
    for (const leaf of permissions) {
      const permission = indexOfPermission(leaf.id);
      if (
        changeKind(
          baselineScopes(baseline, role.roleId, permission),
          role.scopes[permission] ?? EMPTY_SCOPES,
        ) !== null
      )
        changedLeafCount += 1;
    }
  }
  const recent = changedLeafCount > 0 ? recentAction.current : null;
  return (
    <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
      <span role="status">
        {recent === null ? '' : `${recent.roleName}：${recent.label} ${recent.action}`}
      </span>
      {changedLeafCount > 0 ? (
        <span role="note" aria-label="未保存权限变更">
          {changedLeafCount} 项权限未保存
        </span>
      ) : null}
      <span>{isDirty ? '有未保存的更改' : '已保存'}</span>
    </span>
  );
}

const PermissionMatrix = memo(function PermissionMatrix({
  rows,
  fields,
  control,
  baseline,
  tree,
  canManage,
  pending,
  searching,
  onOpenSettings,
  onToggleLeaf,
  onToggleGroup,
}: {
  rows: Row<typeof features, MatrixRow>[];
  fields: RoleField[];
  control: Control<FormValues>;
  baseline: Baseline;
  tree: PermissionTreeGroup[];
  canManage: boolean;
  pending: boolean;
  searching: boolean;
  onOpenSettings: (key: string, source: HTMLElement | null) => void;
  onToggleLeaf: (index: number, leaf: PermissionDefinition) => void;
  onToggleGroup: (index: number, group: PermissionTreeGroup) => void;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-card ring-1 ring-line">
      <Table aria-label="角色权限矩阵">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="sticky left-0 z-20 border-r border-line bg-sunken">
              功能
            </TableHead>
            {fields.map((role, index) => (
              <RoleHeader
                key={role.id}
                role={role}
                index={index}
                control={control}
                baseline={baseline}
                pending={pending}
                onOpen={onOpenSettings}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const data = row.original;
            const open = row.getIsExpanded();
            return (
              <TableRow
                key={row.id}
                data-group={data.kind === 'group' ? data.group.key : undefined}
                data-permission={data.kind === 'leaf' ? data.leaf.id : undefined}
                className="hover:bg-transparent"
              >
                <TableHead
                  scope="row"
                  className={
                    data.kind === 'group'
                      ? 'sticky left-0 z-10 h-10 border-r border-line bg-surface text-sm font-medium text-fg'
                      : 'sticky left-0 z-10 h-10 border-r border-line bg-surface text-sm font-normal text-fg'
                  }
                >
                  {data.kind === 'group' ? (
                    <div className="flex items-center" style={{ paddingLeft: row.depth * 16 }}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${open ? '收起' : '展开'} ${data.group.label}`}
                        aria-expanded={open}
                        disabled={searching}
                        title={
                          searching ? '搜索期间自动展开匹配路径，清空搜索后可恢复折叠' : undefined
                        }
                        onClick={() => row.toggleExpanded()}
                      >
                        {open ? <ChevronDown /> : <ChevronRight />}
                      </Button>
                      <span className="pl-1">{data.group.label}</span>
                    </div>
                  ) : (
                    <div style={{ paddingLeft: (row.depth - 1) * 16 + 32 }}>{data.leaf.label}</div>
                  )}
                </TableHead>
                {fields.map((role, index) =>
                  data.kind === 'leaf' ? (
                    <LeafCell
                      key={role.id}
                      control={control}
                      baseline={baseline}
                      role={role}
                      index={index}
                      leaf={data.leaf}
                      disabled={!canManage || pending || role.systemKey === 'admin'}
                      onToggle={onToggleLeaf}
                    />
                  ) : (
                    <GroupCell
                      key={role.id}
                      control={control}
                      baseline={baseline}
                      role={role}
                      index={index}
                      group={data.group}
                      fullGroup={findGroup(tree, data.group.key) ?? data.group}
                      aggregate={row.depth === 0 || !open || searching}
                      disabled={!canManage || pending || role.systemKey === 'admin' || searching}
                      onToggle={onToggleGroup}
                    />
                  ),
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
});

function findGroup(
  groups: readonly PermissionTreeGroup[],
  key: string,
): PermissionTreeGroup | undefined {
  for (const group of groups) {
    if (group.key === key) return group;
    const child = findGroup(group.children, key);
    if (child) return child;
  }
  return undefined;
}

function RoleHeader({
  role,
  index,
  control,
  baseline,
  pending,
  onOpen,
}: {
  role: RoleField;
  index: number;
  control: Control<FormValues>;
  baseline: Baseline;
  pending: boolean;
  onOpen: (key: string, source: HTMLElement | null) => void;
}) {
  const { displayName, error } = useRoleName(control, index, role.roleId, baseline);
  return (
    <TableHead scope="col" className="min-w-32 bg-sunken text-center align-middle">
      <div className="flex flex-col items-center gap-0.5">
        <div className="flex items-center gap-1">
          <span className="max-w-40 truncate font-medium text-fg">{displayName}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`设置角色 ${displayName}`}
            disabled={pending}
            onClick={(event) => onOpen(roleKey(role), event.currentTarget)}
          >
            <Settings />
          </Button>
        </div>
        {error ? <span className="text-2xs font-normal text-danger">{error}</span> : null}
      </div>
    </TableHead>
  );
}

const LeafCell = memo(function LeafCell({
  control,
  baseline,
  role,
  index,
  leaf,
  disabled,
  onToggle,
}: {
  control: Control<FormValues>;
  baseline: Baseline;
  role: RoleField;
  index: number;
  leaf: PermissionDefinition;
  disabled: boolean;
  onToggle: (index: number, leaf: PermissionDefinition) => void;
}) {
  const permission = indexOfPermission(leaf.id);
  const { field } = useController({ control, name: `roles.${index}.scopes.${permission}` });
  const displayName = useRoleDisplayName(control, index, role.roleId, baseline);
  const kind = changeKind(baselineScopes(baseline, role.roleId, permission), field.value);
  const description =
    kind === null ? undefined : `${displayName}：${leaf.label} 未保存，${CHANGE_LABELS[kind]}`;
  return (
    <MatrixCell
      roleName={displayName}
      label={leaf.label}
      checked={field.value.length > 0}
      indeterminate={false}
      disabled={disabled}
      changed={kind !== null}
      description={description}
      inputRef={field.ref}
      onBlur={field.onBlur}
      onToggle={() => onToggle(index, leaf)}
    />
  );
});

const GroupCell = memo(function GroupCell({
  control,
  baseline,
  role,
  index,
  group,
  fullGroup,
  aggregate,
  disabled,
  onToggle,
}: {
  control: Control<FormValues>;
  baseline: Baseline;
  role: RoleField;
  index: number;
  group: PermissionTreeGroup;
  fullGroup: PermissionTreeGroup;
  aggregate: boolean;
  disabled: boolean;
  onToggle: (index: number, group: PermissionTreeGroup) => void;
}) {
  const ids = useMemo(() => groupLeafIds(fullGroup), [fullGroup]);
  const names = useMemo(
    () => ids.map((id): ScopePath => `roles.${index}.scopes.${indexOfPermission(id)}`),
    [ids, index],
  );
  const scopes = useWatch({ control, name: names, exact: true });
  const displayName = useRoleDisplayName(control, index, role.roleId, baseline);
  const visibleIds = groupLeafIds(group);
  const grantedCount = visibleIds.filter((id) => (scopes[ids.indexOf(id)]?.length ?? 0) > 0).length;
  const changedCount = ids.filter(
    (id, position) =>
      changeKind(
        baselineScopes(baseline, role.roleId, indexOfPermission(id)),
        scopes[position] ?? EMPTY_SCOPES,
      ) !== null,
  ).length;
  const changed = aggregate && changedCount > 0;
  return (
    <MatrixCell
      roleName={displayName}
      label={group.label}
      checked={visibleIds.length > 0 && grantedCount === visibleIds.length}
      indeterminate={grantedCount > 0 && grantedCount < visibleIds.length}
      disabled={disabled}
      changed={changed}
      description={
        changed
          ? `${displayName}：${group.label} 未保存：本组 ${changedCount} 项权限变化`
          : undefined
      }
      onToggle={() => onToggle(index, fullGroup)}
    />
  );
});

function MatrixCell({
  roleName,
  label,
  checked,
  indeterminate,
  disabled,
  changed,
  description,
  inputRef,
  onBlur,
  onToggle,
}: {
  roleName: string;
  label: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  changed: boolean;
  description: string | undefined;
  inputRef?: (element: HTMLElement | null) => void;
  onBlur?: () => void;
  onToggle: () => void;
}) {
  return (
    <TableCell
      data-changed={changed}
      title={description}
      className={changed ? 'relative bg-selected text-center' : 'bg-surface text-center'}
    >
      {changed ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-fg"
        />
      ) : null}
      <div className="flex justify-center">
        <Checkbox
          ref={inputRef}
          onBlur={onBlur}
          aria-label={`${roleName}：${label}`}
          aria-description={description}
          checked={checked}
          indeterminate={indeterminate}
          disabled={disabled}
          onCheckedChange={onToggle}
        />
      </div>
    </TableCell>
  );
}

function RoleSettings({
  role,
  index,
  control,
  baseline,
  permissions,
  canManage,
  pending,
  finalFocus,
  onClose,
  onDelete,
  onChangeName,
  onChangeScopes,
}: {
  role: RoleField;
  index: number;
  control: Control<FormValues>;
  baseline: Baseline;
  permissions: readonly PermissionDefinition[];
  canManage: boolean;
  pending: boolean;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onDelete: (key: string) => void;
  onChangeName: (index: number, name: string) => void;
  onChangeScopes: (index: number, leaf: PermissionDefinition, scopes: AccessScope[]) => void;
}) {
  const { field } = useController({ control, name: `roles.${index}.name` });
  const { name, displayName, error } = useRoleName(control, index, role.roleId, baseline);
  const scopes = useWatch({ control, name: `roles.${index}.scopes`, exact: false });
  const granted = permissions.filter(
    (leaf) => (scopes[indexOfPermission(leaf.id)]?.length ?? 0) > 0,
  );
  const disabled = !canManage || pending;
  return (
    <DialogShell title={`角色设置：${displayName}`} closeDisabled={pending} finalFocus={finalFocus}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Field
            orientation="horizontal"
            data-invalid={Boolean(error)}
            data-disabled={disabled ? true : undefined}
            className="gap-3"
          >
            <FieldLabel
              htmlFor={`role-name-${roleKey(role)}`}
              className="w-20 shrink-0 text-muted-foreground"
            >
              角色名称
            </FieldLabel>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                ref={field.ref}
                name={field.name}
                onBlur={field.onBlur}
                id={`role-name-${roleKey(role)}`}
                aria-label="角色名称"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `role-name-error-${roleKey(role)}` : undefined}
                value={name}
                disabled={disabled}
                onChange={(event) => onChangeName(index, event.target.value)}
                className="min-w-0 flex-1"
              />
              {role.systemKey !== 'admin' && canManage ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除角色 ${displayName}`}
                  disabled={pending}
                  onClick={() => onDelete(roleKey(role))}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          </Field>
          {error ? <FieldError id={`role-name-error-${roleKey(role)}`}>{error}</FieldError> : null}
          {role.systemKey === 'admin' ? (
            <p className="text-2xs text-muted-foreground">系统管理员权限不可修改</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-fg">授权范围</h2>
          {granted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              在矩阵中勾选功能后，可在这里调整授权范围。
            </p>
          ) : (
            granted.map((leaf) => (
              <div key={leaf.id} className="flex flex-wrap items-center gap-2">
                <span className="w-28 shrink-0 text-sm text-fg">{leaf.label}</span>
                <ToggleGroup
                  multiple
                  size="sm"
                  variant="outline"
                  className="flex-wrap"
                  aria-label={`${displayName}：${leaf.label} 授权范围`}
                  value={(scopes[indexOfPermission(leaf.id)] ?? EMPTY_SCOPES).filter((scope) =>
                    leaf.scopes.includes(scope),
                  )}
                  disabled={disabled || role.systemKey === 'admin'}
                  onValueChange={(next) => onChangeScopes(index, leaf, next as AccessScope[])}
                >
                  {SCOPE_ORDER.filter((scope) => leaf.scopes.includes(scope)).map((scope) => (
                    <ToggleGroupItem
                      key={scope}
                      value={scope}
                      aria-label={`${SCOPE_LABELS[scope]}范围`}
                    >
                      {SCOPE_LABELS[scope]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ))
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-2xs text-muted-foreground">修改将在保存更改后生效。</p>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
