import type { AccessScope, PermissionDefinition, PermissionGrant } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Page, PageHeader, PageNote, PageToolbar } from '../components/page.js';
import { SearchInput } from '../components/search-input.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { FieldError } from '../components/ui/field.js';
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
  groupState,
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

type DraftRole = {
  key: string;
  /** 已有角色的 id；新建角色为空，保存时由服务端生成。 */
  id?: string;
  name: string;
  systemKey: Role['systemKey'];
  /** 叶 permissionId -> 已选范围；空数组表示未授权。 */
  grants: Map<string, AccessScope[]>;
};

function grantsToMap(grants: readonly PermissionGrant[]): Map<string, AccessScope[]> {
  const map = new Map<string, AccessScope[]>();
  for (const grant of grants) {
    map.set(grant.permissionId, [...(map.get(grant.permissionId) ?? []), grant.scope]);
  }
  return map;
}

function rolesToDraft(roles: readonly Role[]): DraftRole[] {
  return roles.map((role) => ({
    key: role.id,
    id: role.id,
    name: role.name,
    systemKey: role.systemKey,
    grants: grantsToMap(role.grants),
  }));
}

function sortedScopes(scopes: readonly AccessScope[]): AccessScope[] {
  return SCOPE_ORDER.filter((scope) => scopes.includes(scope));
}

/** 非搜索时按未过滤的原始子树执行批量勾选，保证整棵子树一起变化。 */
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

function setLeafScopes(
  role: DraftRole,
  permissionId: string,
  scopes: readonly AccessScope[],
): DraftRole {
  const next = new Map(role.grants);
  if (scopes.length === 0) next.delete(permissionId);
  else next.set(permissionId, sortedScopes(scopes));
  return { ...role, grants: next };
}

function expandGrants(
  role: DraftRole,
  permissions: readonly PermissionDefinition[],
): PermissionGrant[] {
  // 管理员矩阵不可改；始终提交目录原值，避免客户端误改。
  return permissions.flatMap((permission) => {
    const scopes = role.grants.get(permission.id) ?? [];
    return sortedScopes(scopes)
      .filter((scope) => permission.scopes.includes(scope))
      .map((scope) => ({ permissionId: permission.id, scope }));
  });
}

function sameDraft(a: readonly DraftRole[], b: readonly DraftRole[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((role, index) => {
    const other = b[index];
    if (!other || role.id !== other.id || role.name !== other.name) return false;
    const aGrants = [...role.grants].sort(([x], [y]) => x.localeCompare(y));
    const bGrants = [...other.grants].sort(([x], [y]) => x.localeCompare(y));
    return JSON.stringify(aGrants) === JSON.stringify(bGrants);
  });
}

export function RolesPage() {
  const me = useQuery(meQuery);
  const matrix = useQuery(roleMatrixQuery);
  const save = useSaveRoleMatrix();
  const catalog = useQuery(permissionCatalogQuery);
  const canManage = can(me.data, 'roles.manage');
  const [draft, setDraft] = useState<DraftRole[] | null>(null);
  const [baseline, setBaseline] = useState<DraftRole[] | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<string | null>(null);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const loadedRevision = useRef<number | null>(null);
  const dirty = draft !== null && baseline !== null && !sameDraft(draft, baseline);

  /**
   * 后台刷新拿到新 revision 时，不能直接覆盖未保存的草稿；
   * 保留草稿并把冲突交给保存/重新加载动作处理。
   */
  useEffect(() => {
    const data = matrix.data;
    if (!data) return;
    if (loadedRevision.current === data.revision) return;
    if (dirty) {
      setConflict(
        '角色矩阵已在其他窗口更新。当前草稿已保留，保存时会再次校验版本；重新加载会放弃草稿。',
      );
      return;
    }
    loadedRevision.current = data.revision;
    const next = rolesToDraft(data.roles);
    setDraft(next);
    setBaseline(next);
    setRevision(data.revision);
  }, [matrix.data, dirty]);

  const permissions = catalog.data?.permissions ?? [];
  const tree = useMemo(() => buildPermissionTree(permissions), [permissions]);
  const visibleTree = useMemo(() => filterPermissionTree(tree, query), [tree, query]);
  const searching = query.trim().length > 0;
  const blocker = useFormBlocker(dirty, save.isPending);
  const sortedRoles = useMemo(() => [...(draft ?? [])], [draft]);

  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const role of draft ?? []) {
      const key = role.name.trim();
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    return duplicates;
  }, [draft]);

  const invalid =
    (draft ?? []).some((role) => role.name.trim().length === 0) || duplicateNames.size > 0;

  const updateRole = (key: string, update: (role: DraftRole) => DraftRole): void => {
    setDraft((current) =>
      current === null ? current : current.map((role) => (role.key === key ? update(role) : role)),
    );
    setConflict(null);
    setError(null);
  };

  const toggleLeaf = (role: DraftRole, leaf: PermissionDefinition): void => {
    const current = role.grants.get(leaf.id) ?? [];
    const fallback = leaf.scopes[0];
    updateRole(role.key, (target) =>
      setLeafScopes(
        target,
        leaf.id,
        current.length > 0 || fallback === undefined ? [] : [fallback],
      ),
    );
  };

  const toggleGroup = (role: DraftRole, group: PermissionTreeGroup): void => {
    // 搜索视图只显示命中叶，父级批量会波及隐藏子树，因此搜索期间拒绝父级更新。
    if (searching) return;
    const targetGroup = findGroup(tree, group.key) ?? group;
    const leaves = groupLeafIds(targetGroup)
      .map((id) => permissions.find((permission) => permission.id === id))
      .filter((leaf): leaf is PermissionDefinition => leaf !== undefined);
    const state = groupState(targetGroup, (id) => (role.grants.get(id) ?? []).length > 0);
    updateRole(role.key, (target) => {
      let next = target;
      for (const leaf of leaves) {
        if (state === 'checked') {
          next = setLeafScopes(next, leaf.id, []);
          continue;
        }
        // 已有授权保持原范围，父级全选不用默认 scope 覆盖。
        if ((next.grants.get(leaf.id) ?? []).length > 0) continue;
        const fallback = leaf.scopes[0];
        if (fallback !== undefined) next = setLeafScopes(next, leaf.id, [fallback]);
      }
      return next;
    });
  };

  const addRole = (): void => {
    const index = (draft?.length ?? 0) + 1;
    setDraft((current) => [
      ...(current ?? []),
      {
        key: `new-${Date.now()}-${index}`,
        name: `新角色 ${index}`,
        systemKey: null,
        grants: new Map(),
      },
    ]);
    setConflict(null);
  };

  const deleteRole = (role: DraftRole): void => {
    setDraft((current) => (current ?? []).filter((item) => item.key !== role.key));
    setDeleting(null);
    setConflict(null);
  };

  const reload = async (): Promise<void> => {
    setConflict(null);
    setError(null);
    // 显式重新加载是用户确认放弃草稿后的动作：等 refetch 返回后直接替换基线。
    const result = await matrix.refetch();
    const data = result.data;
    if (!data) return;
    loadedRevision.current = data.revision;
    const next = rolesToDraft(data.roles);
    setDraft(next);
    setBaseline(next);
    setRevision(data.revision);
    setReloadOpen(false);
  };

  const submit = (): void => {
    if (draft === null || revision === null || save.isPending) return;
    setError(null);
    if (invalid) return;
    save.mutate(
      {
        expectedRevision: revision,
        roles: draft.map((role) => ({
          ...(role.id === undefined ? {} : { id: role.id }),
          name: role.name.trim(),
          grants:
            role.systemKey === 'admin'
              ? (matrix.data?.roles.find((item) => item.systemKey === 'admin')?.grants ?? [])
              : expandGrants(role, permissions),
        })),
      },
      {
        onSuccess: (saved: RoleMatrix) => {
          const next = rolesToDraft(saved.roles);
          setDraft(next);
          setBaseline(next);
          setRevision(saved.revision);
          loadedRevision.current = saved.revision;
          setConflict(null);
          toastSuccess('角色矩阵已保存');
        },
        onError: (cause) => {
          if (cause instanceof ApiError && cause.status === 409) {
            setConflict(cause.message || '角色矩阵已被其他操作修改。重新加载会放弃当前草稿。');
            return;
          }
          setError(errorMessage(cause));
        },
      },
    );
  };

  if (matrix.isPending || catalog.isPending) {
    return (
      <Page>
        <PageHeader title="角色" />
        <LoadingState rows={5} />
      </Page>
    );
  }
  if (matrix.isError || catalog.isError || draft === null) {
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
              <Button variant="outline" onClick={addRole}>
                <Plus data-icon="inline-start" /> 新建角色
              </Button>
              <Button
                disabled={!dirty || save.isPending || invalid}
                aria-busy={save.isPending}
                onClick={submit}
              >
                <Save data-icon="inline-start" /> {save.isPending ? '正在保存…' : '保存更改'}
              </Button>
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
        <span className="ml-auto text-xs text-muted-foreground">
          {dirty ? '有未保存的更改' : '已保存'}
        </span>
      </PageToolbar>

      {conflict ? (
        <PageNote
          tone="danger"
          title="保存冲突"
          description={conflict}
          action={
            <Button variant="outline" size="sm" onClick={() => setReloadOpen(true)}>
              <RotateCcw data-icon="inline-start" /> 重新加载
            </Button>
          }
        />
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
      {!canManage ? (
        <TextNote>当前角色只有查看权限；修改角色矩阵需要 roles.manage。</TextNote>
      ) : null}

      <Table aria-label="角色权限矩阵">
        <TableHeader>
          <TableRow>
            <TableHead className="w-64">功能</TableHead>
            {sortedRoles.map((role) => {
              const admin = role.systemKey === 'admin';
              const nameError =
                role.name.trim().length === 0
                  ? '角色名称不能为空。'
                  : duplicateNames.has(role.name.trim())
                    ? '角色名称不能重复。'
                    : null;
              return (
                <TableHead key={role.key} className="min-w-40 align-top">
                  <div className="flex items-center gap-1">
                    <Input
                      aria-label={`角色名称：${role.name}`}
                      aria-invalid={nameError !== null}
                      aria-describedby={
                        nameError === null ? undefined : `role-name-error-${role.key}`
                      }
                      value={role.name}
                      disabled={!canManage || save.isPending}
                      onChange={(event) =>
                        updateRole(role.key, (target) => ({
                          ...target,
                          name: event.target.value,
                        }))
                      }
                      className="h-8 min-w-0 flex-1"
                    />
                    {!admin && canManage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除角色 ${role.name}`}
                        disabled={save.isPending}
                        onClick={() => setDeleting(role.key)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  {nameError === null ? null : (
                    <FieldError id={`role-name-error-${role.key}`}>{nameError}</FieldError>
                  )}
                  {admin ? (
                    <span className="mt-1 block text-2xs text-muted-foreground">
                      系统管理员权限不可修改
                    </span>
                  ) : null}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleTree.map((group) => (
            <GroupRows
              key={group.key}
              group={group}
              depth={0}
              roles={sortedRoles}
              canManage={canManage}
              disabled={save.isPending}
              searching={searching}
              collapsed={collapsed}
              onToggleCollapsed={(key) =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              onToggleLeaf={toggleLeaf}
              onToggleGroup={toggleGroup}
              onScopeChange={(role, leaf, scopes) =>
                updateRole(role.key, (target) => setLeafScopes(target, leaf.id, scopes))
              }
            />
          ))}
        </TableBody>
      </Table>

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
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="删除这个角色？"
        description="保存后该角色及其实例分配会一并移除。系统管理员角色不能删除。"
        onConfirm={async () => {
          const role = draft.find((item) => item.key === deleting);
          if (role) deleteRole(role);
        }}
      />
    </Page>
  );
}

function TextNote({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function GroupRows({
  group,
  depth,
  roles,
  canManage,
  disabled,
  searching,
  collapsed,
  onToggleCollapsed,
  onToggleLeaf,
  onToggleGroup,
  onScopeChange,
}: {
  group: PermissionTreeGroup;
  depth: number;
  roles: readonly DraftRole[];
  canManage: boolean;
  disabled: boolean;
  searching: boolean;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  onToggleLeaf: (role: DraftRole, leaf: PermissionDefinition) => void;
  onToggleGroup: (role: DraftRole, group: PermissionTreeGroup) => void;
  onScopeChange: (
    role: DraftRole,
    leaf: PermissionDefinition,
    scopes: readonly AccessScope[],
  ) => void;
}) {
  const open = searching || !collapsed.has(group.key);
  return (
    <>
      <TableRow data-group={group.key}>
        <TableCell>
          <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${open ? '收起' : '展开'} ${group.label}`}
              aria-expanded={open}
              onClick={() => onToggleCollapsed(group.key)}
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </Button>
            <span className="font-medium">{group.label}</span>
          </div>
        </TableCell>
        {roles.map((role) => {
          const admin = role.systemKey === 'admin';
          const state = groupState(group, (id) => (role.grants.get(id) ?? []).length > 0);
          return (
            <TableCell key={role.key}>
              <Checkbox
                aria-label={`${role.name}：${group.label}`}
                checked={state === 'checked'}
                indeterminate={state === 'indeterminate'}
                disabled={!canManage || disabled || admin || searching}
                onCheckedChange={() => onToggleGroup(role, group)}
              />
            </TableCell>
          );
        })}
      </TableRow>
      {open ? (
        <>
          {group.leaves.map((leaf) => (
            <TableRow key={leaf.id} data-permission={leaf.id}>
              <TableCell>
                <div className="flex items-center" style={{ paddingLeft: (depth + 1) * 16 + 4 }}>
                  <span className="text-sm">{leaf.label}</span>
                </div>
              </TableCell>
              {roles.map((role) => {
                const admin = role.systemKey === 'admin';
                const scopes = role.grants.get(leaf.id) ?? [];
                return (
                  <TableCell key={role.key}>
                    <div className="flex flex-col gap-1.5">
                      <Checkbox
                        aria-label={`${role.name}：${leaf.label}`}
                        checked={scopes.length > 0}
                        disabled={!canManage || disabled || admin}
                        onCheckedChange={() => onToggleLeaf(role, leaf)}
                      />
                      {scopes.length > 0 ? (
                        <ToggleGroup
                          multiple
                          size="sm"
                          variant="outline"
                          aria-label={`${role.name}：${leaf.label} 授权范围`}
                          value={scopes}
                          disabled={!canManage || disabled || admin}
                          onValueChange={(next) =>
                            onScopeChange(
                              role,
                              leaf,
                              (next as AccessScope[]).filter((scope) =>
                                leaf.scopes.includes(scope),
                              ),
                            )
                          }
                        >
                          {SCOPE_ORDER.filter((scope) => leaf.scopes.includes(scope)).map(
                            (scope) => (
                              <ToggleGroupItem
                                key={scope}
                                value={scope}
                                aria-label={`${SCOPE_LABELS[scope]}范围`}
                              >
                                {SCOPE_LABELS[scope]}
                              </ToggleGroupItem>
                            ),
                          )}
                        </ToggleGroup>
                      ) : null}
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          {group.children.map((child) => (
            <GroupRows
              key={child.key}
              group={child}
              depth={depth + 1}
              roles={roles}
              canManage={canManage}
              disabled={disabled}
              searching={searching}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              onToggleLeaf={onToggleLeaf}
              onToggleGroup={onToggleGroup}
              onScopeChange={onScopeChange}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
