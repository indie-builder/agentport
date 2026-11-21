import {
  ACCESS_SCOPES,
  type AccessScope,
  type AuthMe,
  type PermissionDefinition,
  type PermissionId,
} from '@agentport/shared';
import {
  Activity,
  Bell,
  Brain,
  Cable,
  CalendarClock,
  Container,
  Cpu,
  Database,
  FlaskConical,
  Hash,
  HeartPulse,
  History,
  KeyRound,
  LayoutDashboard,
  LibraryBig,
  MessagesSquare,
  Plug,
  Puzzle,
  Radar,
  Scale,
  ScrollText,
  Search,
  Share2,
  ShieldAlert,
  Sparkles,
  User,
  Users,
} from 'lucide-react';

export type AuthenticatedMe = Extract<AuthMe, { authenticated: true }>;

export const SCOPE_LABELS = Object.fromEntries(
  ACCESS_SCOPES.map((scope) => [scope.id, scope.label]),
) as Record<AccessScope, string>;

export const SCOPE_ORDER: readonly AccessScope[] = ACCESS_SCOPES.map((scope) => scope.id);

export function authenticated(me: AuthMe | undefined): AuthenticatedMe | null {
  return me?.authenticated ? me : null;
}

function grantScopes(me: AuthMe | undefined, permissionId: PermissionId): readonly AccessScope[] {
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

export function hasAnyGrant(
  grantIds: readonly PermissionId[],
  permissionId: PermissionId,
): boolean {
  return grantIds.includes(permissionId);
}

export type MenuItem = {
  to: string;
  label: string;
  icon: typeof Cable;
  permissionIds: readonly PermissionId[];
};

const pages = {
  agents: { to: '/agents', label: '找专家', icon: Users, permissionIds: ['agents.read'] },
  chat: { to: '/chat', label: '对话', icon: MessagesSquare, permissionIds: ['conversations.read'] },
  channels: { to: '/channels', label: '频道', icon: Hash, permissionIds: ['conversations.read'] },
  schedules: {
    to: '/schedules',
    label: '定时任务',
    icon: CalendarClock,
    permissionIds: ['schedules.read'],
  },
  skills: {
    to: '/skills',
    label: '技能',
    icon: Sparkles,
    permissionIds: ['skills.read', 'market.read'],
  },
  servers: { to: '/servers', label: '连接器', icon: Cable, permissionIds: ['servers.read'] },
  plugins: { to: '/plugins', label: '插件', icon: Puzzle, permissionIds: ['plugins.read'] },
  knowledge: {
    to: '/knowledge',
    label: '知识库',
    icon: LibraryBig,
    permissionIds: ['knowledge.read'],
  },
  eval: { to: '/eval', label: '评估', icon: FlaskConical, permissionIds: ['eval.read'] },
  operations: {
    to: '/operations',
    label: '概况',
    icon: LayoutDashboard,
    permissionIds: ['operations.read'],
  },
  observability: {
    to: '/observability',
    label: '观测',
    icon: Radar,
    permissionIds: ['operations.read'],
  },
  runs: { to: '/runs', label: '运行', icon: Activity, permissionIds: ['runs.read'] },
  dataDomains: {
    to: '/data-domains',
    label: '数据域',
    icon: Database,
    permissionIds: ['data_domains.read'],
  },
  runtimeEnvironments: {
    to: '/runtime-environments',
    label: '运行环境',
    icon: Container,
    permissionIds: ['runtime_environments.read'],
  },
  status: { to: '/status', label: '健康', icon: HeartPulse, permissionIds: ['operations.read'] },
  audit: { to: '/audit', label: '审计', icon: ScrollText, permissionIds: ['audit.read'] },
  accounts: { to: '/accounts', label: '账户', icon: KeyRound, permissionIds: ['accounts.read'] },
  roles: { to: '/roles', label: '角色', icon: Users, permissionIds: ['roles.read'] },
  governance: {
    to: '/governance',
    label: '治理',
    icon: Scale,
    permissionIds: ['governance.read'],
  },
  integrations: {
    to: '/integrations',
    label: '集成',
    icon: Plug,
    permissionIds: ['integrations.read'],
  },
  models: {
    to: '/models',
    label: '模型供应商',
    icon: Cpu,
    permissionIds: ['models.read'],
  },
  securityOps: {
    to: '/security',
    label: '安全运营',
    icon: ShieldAlert,
    permissionIds: ['security.read'],
  },
  notifications: { to: '/notifications', label: '通知与待办', icon: Bell, permissionIds: [] },
  search: { to: '/search', label: '搜索', icon: Search, permissionIds: [] },
  work: {
    to: '/personal/work',
    label: '会话与成果',
    icon: History,
    permissionIds: ['conversations.read'],
  },
  profile: { to: '/personal/profile', label: '个人资料', icon: User, permissionIds: [] },
  memory: {
    to: '/personal/memory',
    label: '个人记忆',
    icon: Brain,
    permissionIds: ['personal_memory.read'],
  },
  reviews: {
    to: '/personal/reviews',
    label: '记忆提案',
    icon: History,
    permissionIds: ['personal_memory.read'],
  },
  security: { to: '/personal/security', label: '账号安全', icon: KeyRound, permissionIds: [] },
  shares: {
    to: '/personal/shares',
    label: '我的分享',
    icon: Share2,
    permissionIds: ['conversations.share'],
  },
  usage: {
    to: '/personal/usage',
    label: '使用记录',
    icon: Activity,
    permissionIds: ['overview.read', 'runs.read'],
  },
} as const satisfies Record<string, MenuItem>;

export const WORK_MENU: readonly MenuItem[] = [
  pages.agents,
  pages.chat,
  pages.channels,
  pages.schedules,
];

export const PERSONAL_NAV_GROUPS: readonly {
  label: string;
  items: readonly MenuItem[];
}[] = [
  {
    label: '与专家协作',
    items: [pages.memory, pages.reviews],
  },
  {
    label: '工作记录',
    items: [pages.work, pages.shares, pages.usage],
  },
  {
    label: '账号',
    items: [pages.profile, pages.security],
  },
];

export function isPersonalPath(pathname: string): boolean {
  return /^\/personal(?:\/|$)/.test(pathname);
}

export const RESOURCE_SECTIONS = {
  skills: pages.skills,
  servers: pages.servers,
  plugins: pages.plugins,
  knowledge: pages.knowledge,
  dataDomains: pages.dataDomains,
};

export const RESOURCE_MENU = Object.values(RESOURCE_SECTIONS);

export const BUILD_MENU: readonly MenuItem[] = [
  {
    to: '/skills',
    label: '资源',
    icon: Cable,
    permissionIds: RESOURCE_MENU.flatMap((item) => [...item.permissionIds]),
  },
  pages.eval,
];

export const OPERATIONS_MENU: readonly MenuItem[] = [
  pages.operations,
  pages.observability,
  pages.runs,
  pages.runtimeEnvironments,
  pages.status,
  pages.audit,
];

export const PLATFORM_MENU: readonly MenuItem[] = [
  pages.accounts,
  pages.roles,
  pages.governance,
  pages.models,
  pages.securityOps,
  pages.integrations,
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

export const ROUTE_META: Readonly<Record<string, MenuItem>> = {
  '/_shell/agents/': pages.agents,
  '/_shell/agents/$agentId': pages.agents,
  '/_shell/chat': pages.chat,
  '/_shell/notifications': pages.notifications,
  '/_shell/search': pages.search,
  '/_shell/channels/': pages.channels,
  '/_shell/channels/$channelId': pages.channels,
  '/_shell/personal/': pages.profile,
  '/_shell/personal/profile': pages.profile,
  '/_shell/personal/work': pages.work,
  '/_shell/personal/memory': pages.memory,
  '/_shell/personal/reviews': pages.reviews,
  '/_shell/personal/security': pages.security,
  '/_shell/personal/shares': pages.shares,
  '/_shell/personal/usage': pages.usage,
  '/_shell/schedules': pages.schedules,
  '/_shell/skills': { ...pages.skills, label: '资源' },
  '/_shell/servers': pages.servers,
  '/_shell/plugins/': pages.plugins,
  '/_shell/plugins/$pluginId': pages.plugins,
  '/_shell/knowledge/': pages.knowledge,
  '/_shell/knowledge/$baseId': pages.knowledge,
  '/_shell/data-domains/': pages.dataDomains,
  '/_shell/data-domains/$dataDomainId': pages.dataDomains,
  '/_shell/eval': pages.eval,
  '/_shell/operations': pages.operations,
  '/_shell/observability': pages.observability,
  '/_shell/runs/': pages.runs,
  '/_shell/runs/$runId': pages.runs,
  '/_shell/runtime-environments/': pages.runtimeEnvironments,
  '/_shell/runtime-environments/$environmentId': pages.runtimeEnvironments,
  '/_shell/status': pages.status,
  '/_shell/audit': pages.audit,
  '/_shell/accounts': pages.accounts,
  '/_shell/roles': pages.roles,
  '/_shell/governance': pages.governance,
  '/_shell/models': pages.models,
  '/_shell/security': pages.securityOps,
  '/_shell/integrations': pages.integrations,
};

export function requiredPermissions(routeId: string | undefined): readonly PermissionId[] | null {
  const permissions = routeId ? ROUTE_META[routeId]?.permissionIds : undefined;
  return permissions?.length ? permissions : null;
}

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
  return groups.map(filterGroup).filter((group): group is PermissionTreeGroup => group !== null);
}
