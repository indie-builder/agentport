import {
  ACCESS_SCOPES,
  type AccessScope,
  type AuthMe,
  type PermissionDefinition,
  type PermissionId,
} from '@agentport/shared';

export type AuthenticatedMe = Extract<AuthMe, { authenticated: true }>;

export const SCOPE_LABELS = Object.fromEntries(
  ACCESS_SCOPES.map((scope) => [scope.id, scope.label]),
) as Record<AccessScope, string>;

export const SCOPE_ORDER: readonly AccessScope[] = ACCESS_SCOPES.map((scope) => scope.id);

export function authenticated(me: AuthMe | undefined): AuthenticatedMe | null {
  return me?.authenticated ? me : null;
}

/** 同一 permissionId 的多角色授权只合并范围；判定仍以单条 grant 为准。 */
export function grantScopes(
  me: AuthMe | undefined,
  permissionId: PermissionId,
): readonly AccessScope[] {
  const user = authenticated(me);
  if (!user) return [];
  const scopes = new Set<AccessScope>();
  for (const grant of user.grants) {
    if (grant.permissionId === permissionId) scopes.add(grant.scope);
  }
  return SCOPE_ORDER.filter((scope) => scopes.has(scope));
}

export function can(me: AuthMe | undefined, permissionId: PermissionId): boolean {
  return grantScopes(me, permissionId).length > 0;
}

export function canAny(me: AuthMe | undefined, permissionIds: readonly PermissionId[]): boolean {
  return permissionIds.some((id) => can(me, id));
}

export function hasAnyGrant(grantIds: readonly PermissionId[], permissionId: PermissionId): boolean {
  return grantIds.includes(permissionId);
}

export type MenuItem = {
  to: string;
  label: string;
  permissionIds: readonly PermissionId[];
};

/** 工作区入口；同一顺序也用于登录后的首页选择。 */
export const WORK_MENU: readonly MenuItem[] = [
  { to: '/agents', label: '找专家', permissionIds: ['agents.read'] },
  { to: '/chat', label: '对话', permissionIds: ['conversations.read'] },
  { to: '/memory', label: '记忆', permissionIds: ['personal_memory.read'] },
  { to: '/schedules', label: '定时任务', permissionIds: ['schedules.read'] },
];

export const RESOURCE_MENU: readonly MenuItem[] = [
  { to: '/skills', label: '技能', permissionIds: ['skills.read'] },
  { to: '/servers', label: '连接器', permissionIds: ['servers.read'] },
  { to: '/plugins', label: '插件', permissionIds: ['plugins.read'] },
  { to: '/knowledge', label: '知识库', permissionIds: ['knowledge.read'] },
];

export const BUILD_MENU: readonly MenuItem[] = [
  { to: '/skills', label: '资源', permissionIds: RESOURCE_MENU.map((item) => item.permissionIds[0]!) },
  { to: '/eval', label: '评估', permissionIds: ['eval.read'] },
];

export const OPERATIONS_MENU: readonly MenuItem[] = [
  { to: '/operations', label: '概况', permissionIds: ['operations.read'] },
  { to: '/runs', label: '运行', permissionIds: ['runs.read'] },
  { to: '/runtime-environments', label: '运行环境', permissionIds: ['runtime_environments.read'] },
  { to: '/status', label: '健康', permissionIds: ['operations.read'] },
  { to: '/audit', label: '审计', permissionIds: ['audit.read'] },
];

export const PLATFORM_MENU: readonly MenuItem[] = [
  { to: '/accounts', label: '账户', permissionIds: ['accounts.read'] },
  { to: '/roles', label: '角色', permissionIds: ['roles.read'] },
];

const HOME_ORDER: readonly MenuItem[] = [
  ...WORK_MENU,
  ...RESOURCE_MENU,
  ...BUILD_MENU.filter((item) => item.to === '/eval'),
  ...OPERATIONS_MENU.filter((item) => item.to !== '/status'),
  ...PLATFORM_MENU,
];

/** 登录后与「返回工作区」的落点；没有任何权限时返回 null。 */
export function homePath(me: AuthMe | undefined): string | null {
  return HOME_ORDER.find((item) => canAny(me, item.permissionIds))?.to ?? null;
}

/** 路由到所需叶的映射；任一命中即可进入。未知路由不做页面级拦截。 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, readonly PermissionId[]>> = {
  '/_shell/agents/': ['agents.read'],
  '/_shell/agents/$agentId': ['agents.read'],
  '/_shell/chat': ['conversations.read'],
  '/_shell/memory': ['personal_memory.read'],
  '/_shell/schedules': ['schedules.read'],
  '/_shell/skills': ['skills.read', 'market.read'],
  '/_shell/servers': ['servers.read'],
  '/_shell/plugins/': ['plugins.read'],
  '/_shell/plugins/$pluginId': ['plugins.read'],
  '/_shell/knowledge/': ['knowledge.read'],
  '/_shell/knowledge/$baseId': ['knowledge.read'],
  '/_shell/eval': ['eval.read'],
  '/_shell/operations': ['operations.read'],
  '/_shell/runs/': ['runs.read'],
  '/_shell/runs/$runId': ['runs.read'],
  '/_shell/runtime-environments/': ['runtime_environments.read'],
  '/_shell/runtime-environments/$environmentId': ['runtime_environments.read'],
  '/_shell/status': ['operations.read'],
  '/_shell/audit': ['audit.read'],
  '/_shell/accounts': ['accounts.read'],
  '/_shell/roles': ['roles.read'],
};

export function requiredPermissions(routeId: string | undefined): readonly PermissionId[] | null {
  return routeId ? (ROUTE_PERMISSIONS[routeId] ?? null) : null;
}

// ---- 角色矩阵：功能树 -------------------------------------------------------

export type PermissionTreeLeaf = PermissionDefinition;

export type PermissionTreeGroup = {
  key: string;
  /** 树的完整路径；用于展开状态与测试定位。 */
  path: readonly string[];
  label: string;
  children: PermissionTreeGroup[];
  leaves: PermissionTreeLeaf[];
};

/**
 * 由 shared 目录的 treePath 构建任意深度树。父节点只做展示和批量勾选，
 * 不进入 grants；叶子动作才是可保存的权限。
 */
export function buildPermissionTree(
  permissions: readonly PermissionDefinition[],
): PermissionTreeGroup[] {
  const root: PermissionTreeGroup = { key: '', path: [], label: '', children: [], leaves: [] };
  const byKey = new Map<string, PermissionTreeGroup>([['', root]]);
  for (const permission of permissions) {
    const path = permission.treePath;
    if (path.length === 0) continue;
    let parent = root;
    for (const [index, label] of path.entries()) {
      const prefix = path.slice(0, index + 1);
      const key = prefix.join('/');
      let node = byKey.get(key);
      if (!node) {
        node = { key, path: prefix, label, children: [], leaves: [] };
        byKey.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.leaves.push(permission);
  }
  return root.children;
}

export function groupLeafIds(group: PermissionTreeGroup): PermissionId[] {
  return [...group.leaves.map((leaf) => leaf.id), ...group.children.flatMap(groupLeafIds)];
}

/** 父级三态：全部叶有授权、部分有授权、全空。 */
export function groupState(
  group: PermissionTreeGroup,
  hasLeaf: (id: PermissionId) => boolean,
): 'checked' | 'indeterminate' | 'unchecked' {
  const ids = groupLeafIds(group);
  const granted = ids.filter(hasLeaf).length;
  if (granted === 0) return 'unchecked';
  return granted === ids.length ? 'checked' : 'indeterminate';
}

/** 矩阵搜索：命中叶标签或 permissionId；父链只要含命中叶就保留。 */
export function filterPermissionTree(
  groups: readonly PermissionTreeGroup[],
  query: string,
): PermissionTreeGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  const matches = (leaf: PermissionTreeLeaf): boolean =>
    leaf.id.toLowerCase().includes(needle) || leaf.label.toLowerCase().includes(needle);
  const filterGroup = (group: PermissionTreeGroup): PermissionTreeGroup | null => {
    const leaves = group.leaves.filter(matches);
    const children = group.children
      .map(filterGroup)
      .filter((child): child is PermissionTreeGroup => child !== null);
    if (leaves.length === 0 && children.length === 0) return null;
    return { ...group, leaves, children };
  };
  return groups
    .map(filterGroup)
    .filter((group): group is PermissionTreeGroup => group !== null);
}
