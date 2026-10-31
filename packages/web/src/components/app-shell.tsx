import type { PermissionId } from '@agentport/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeft,
  Brain,
  Cable,
  CalendarClock,
  Container,
  FlaskConical,
  HeartPulse,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  User,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import {
  type AuthenticatedMe,
  authenticated,
  can,
  canAny,
  homePath,
  OPERATIONS_MENU,
  PLATFORM_MENU,
  RESOURCE_MENU,
  requiredPermissions,
  WORK_MENU,
} from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { clearSessionQueries, logoutAccount, meQuery, useChangePassword } from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';
import { animateBrand, Brand, BrandMark } from './brand.js';
import { DialogShell } from './dialog-shell.js';
import { Page, PageHeader, PageNote } from './page.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Field, FieldError, FieldGroup, FieldLabel } from './ui/field.js';
import { Input } from './ui/input.js';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet.js';
import { Skeleton } from './ui/skeleton.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.js';

type NavItem = {
  to: string;
  label: string;
  icon: typeof Cable;
  permissionIds: readonly PermissionId[];
  navGroup?: 'resources';
};

const iconFor: Record<string, typeof Cable> = {
  '/agents': Users,
  '/chat': MessagesSquare,
  '/memory': Brain,
  '/schedules': CalendarClock,
  '/skills': Cable,
  '/eval': FlaskConical,
  '/operations': LayoutDashboard,
  '/runs': Activity,
  '/runtime-environments': Container,
  '/status': HeartPulse,
  '/audit': ScrollText,
  '/accounts': KeyRound,
  '/roles': Users,
};

function menuItems(
  items: readonly { to: string; label: string; permissionIds: readonly PermissionId[] }[],
): NavItem[] {
  return items.map((item) => ({ ...item, icon: iconFor[item.to] ?? Cable }));
}

const workItems = menuItems(WORK_MENU);
const resourceItems = menuItems(RESOURCE_MENU);
const operationsItems = menuItems(OPERATIONS_MENU);
const platformItems = menuItems(PLATFORM_MENU);

/** 资源入口落到第一个可读资源分类，避免只有连接器权限的人被带到技能页 403。 */
function resourceHome(me: AuthenticatedMe): string | null {
  return resourceItems.find((item) => canAny(me, item.permissionIds))?.to ?? null;
}

const operationsNavTargets = new Set(operationsItems.map((item) => item.to));
const resourceNavTargets = new Set(resourceItems.map((item) => item.to));

/**
 * 路由归属与文档标题的唯一来源。未列出的路由（`/_shell/$`）既不选中导航，
 * 也不会被当成某个已知分区。
 */
const routeMeta: Record<string, { nav: string; title: string }> = {
  '/_shell/agents/': { nav: '/agents', title: '找专家' },
  '/_shell/agents/$agentId': { nav: '/agents', title: '找专家' },
  '/_shell/chat': { nav: '/chat', title: '对话' },
  '/_shell/memory': { nav: '/memory', title: '记忆' },
  '/_shell/schedules': { nav: '/schedules', title: '定时任务' },
  '/_shell/skills': { nav: '/skills', title: '资源' },
  '/_shell/servers': { nav: '/servers', title: '连接器' },
  '/_shell/plugins/': { nav: '/plugins', title: '插件' },
  '/_shell/plugins/$pluginId': { nav: '/plugins', title: '插件' },
  '/_shell/knowledge/': { nav: '/knowledge', title: '知识库' },
  '/_shell/knowledge/$baseId': { nav: '/knowledge', title: '知识库' },
  '/_shell/eval': { nav: '/eval', title: '评估' },
  '/_shell/operations': { nav: '/operations', title: '概况' },
  '/_shell/runs/': { nav: '/runs', title: '运行' },
  '/_shell/runs/$runId': { nav: '/runs', title: '运行' },
  '/_shell/runtime-environments/': { nav: '/runtime-environments', title: '运行环境' },
  '/_shell/runtime-environments/$environmentId': {
    nav: '/runtime-environments',
    title: '运行环境',
  },
  '/_shell/status': { nav: '/status', title: '健康' },
  '/_shell/audit': { nav: '/audit', title: '审计' },
  '/_shell/accounts': { nav: '/accounts', title: '账户' },
  '/_shell/roles': { nav: '/roles', title: '角色' },
};

const COLLAPSE_KEY = 'agentport:nav-collapsed';

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const update = (next: boolean): void => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };
  return [collapsed, update];
}

/** 展开时 Logo 可点击切图；收起时保留原悬停展开侧栏的行为。 */
function SidebarBrand({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <div className="relative size-8 shrink-0">
        <Link
          to="/"
          aria-label="返回首页"
          className="group/logo absolute left-0 top-0 flex size-8 items-center justify-center rounded-icon transition-opacity duration-[140ms] ease-out-soft focus-visible:opacity-100 group-hover/nav:opacity-0 group-has-[button:focus-visible]/nav:opacity-0"
        >
          <BrandMark />
        </Link>
        <Button
          variant="ghost"
          aria-label="展开侧栏"
          aria-expanded={!collapsed}
          onClick={onToggle}
          // Keep 7px corners and the translucent hover; ghost defaults to 9px and opaque muted.
          className="absolute left-0 top-0 size-8 rounded-icon p-0 opacity-0 transition-opacity duration-[140ms] ease-out-soft hover:bg-hover focus-visible:opacity-100 group-hover/nav:opacity-100"
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2">
      <Button
        type="button"
        variant="plain"
        aria-label="切换 PACE Logo"
        onClick={animateBrand}
        className="h-8 min-w-0 flex-1 justify-start rounded-icon p-0"
      >
        <Brand className="h-8 self-center" />
      </Button>
      <Button
        variant="ghost"
        aria-label="收起侧栏"
        aria-expanded={!collapsed}
        onClick={onToggle}
        // Keep 7px corners and the translucent hover instead of the regular ghost defaults.
        className="size-8 rounded-icon p-0 hover:bg-hover"
      >
        <PanelLeftClose className="size-4" />
      </Button>
    </div>
  );
}

function SidebarLink({
  to,
  label,
  icon: Icon,
  collapsed,
  navGroup,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof Cable;
  collapsed: boolean;
  navGroup?: 'resources' | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const activeRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const activeNav = routeMeta[activeRoute ?? '']?.nav;
  // 资源入口指向首个可读资源，任一资源路由都算命中这一项；未知路由不命中。
  const active =
    navGroup === 'resources'
      ? activeNav !== undefined && resourceNavTargets.has(activeNav)
      : activeNav === to;
  // 收起态按参考页：整行透明，状态落在 32×32、radius 6 的图标块上。
  const link = (
    <Link
      to={to}
      onClick={onNavigate}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // 归属由 routeMeta 判定；Link 自带的路径前缀匹配会把未知路由误判为 active。
      activeOptions={{ exact: true, includeSearch: false }}
      className={cn(
        'relative flex h-8 items-center text-sm transition-colors duration-150',
        collapsed ? 'w-8 justify-center' : 'gap-2.5 rounded-item px-2.5',
        collapsed
          ? ''
          : active
            ? 'bg-selected font-medium text-selected-foreground'
            : 'text-fg hover:bg-hover',
        collapsed && (active ? 'text-selected-foreground' : 'text-fg'),
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center transition-colors duration-150',
          collapsed
            ? cn('size-8 rounded-tag', active ? 'bg-selected' : 'hover:bg-hover')
            : 'size-4',
        )}
      >
        <Icon aria-hidden="true" />
      </span>
      {/*
        收起与展开共用同一文本节点。收起时标签脱离流、保留自身宽度，只让占位收为 0、
        opacity 走 90ms，避免宽度即时裁掉文字让过渡不可见；收起瞬间链接仍在展开态
        起点，left-9 让文字从原 48px 起画，不跳位。
      */}
      <span
        className={cn(
          'whitespace-nowrap transition-opacity duration-[90ms] ease-out-soft',
          collapsed ? 'absolute inset-y-0 left-9 flex items-center opacity-0' : 'truncate',
        )}
      >
        {label}
      </span>
    </Link>
  );
  return (
    <Tooltip disabled={!collapsed}>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function UserMenu({ me, onChangePassword }: { me: AuthenticatedMe; onChangePassword: () => void }) {
  const navigate = useNavigate();
  const label = me.user.name || me.user.username;

  const logout = async (): Promise<void> => {
    await logoutAccount();
    await navigate({ to: '/login' });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aria-label={`账户 ${label}`}
            // Keep the compact 12px account label, 7px corners, and opaque open-state surface.
            className="gap-2 rounded-icon px-2 text-xs data-[popup-open]:bg-sunken"
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted-foreground">
              <User className="size-3" />
            </span>
            <span className="hidden max-w-32 truncate sm:block">{label}</span>
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        // Keep the 7px menu corners, explicit border, and project overlay shadow.
        className="w-56 rounded-icon border p-1 shadow-overlay"
      >
        <div className="border-b px-2.5 py-2">
          <div className="truncate text-xs text-fg">{label}</div>
          <div className="truncate text-2xs text-muted-foreground">
            {me.user.username} · {me.roles.map((role) => role.name).join('、') || '无角色'}
          </div>
        </div>
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="mt-1 flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-fg transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={onChangePassword}
          >
            <KeyRound className="size-3.5" />
            修改密码
          </DropdownMenuItem>
          <DropdownMenuItem
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-fg transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => void logout()}
          >
            <LogOut className="size-3.5" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const change = useChangePassword();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;

  const submit = async (): Promise<void> => {
    if (change.isPending) return;
    setError(null);
    if (newPassword.length < 8) {
      setError('新密码至少 8 个字符。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    try {
      await change.mutateAsync({ currentPassword, newPassword });
      toastSuccess('密码已修改，请重新登录。');
      clearSessionQueries();
      await navigate({ to: '/login', search: { returnTo: '/' } });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message ? cause.message : '修改密码没有完成，请重试。',
      );
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogShell
        title="修改密码"
        description="修改后会撤销所有已登录会话，需要用新密码重新登录。"
        className="max-w-md sm:max-w-md"
      >
        <form
          aria-label="修改密码"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup className="gap-5">
            <Field data-disabled={change.isPending}>
              <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                disabled={change.isPending}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field data-disabled={change.isPending} data-invalid={tooShort}>
              <FieldLabel htmlFor="new-password">新密码</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                disabled={change.isPending}
                aria-invalid={tooShort}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <FieldError>{tooShort ? '新密码至少 8 个字符。' : undefined}</FieldError>
            </Field>
            <Field data-disabled={change.isPending} data-invalid={mismatch}>
              <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                disabled={change.isPending}
                aria-invalid={mismatch}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <FieldError>{mismatch ? '两次输入的新密码不一致。' : undefined}</FieldError>
            </Field>
            <FieldError>{error ?? undefined}</FieldError>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={change.isPending} onClick={onClose}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={change.isPending || currentPassword.length === 0}
                aria-busy={change.isPending}
              >
                {change.isPending ? '正在保存…' : '修改密码'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogShell>
    </Dialog>
  );
}

export function AccessDenied({
  home,
  noPermissions,
  onLogout,
}: {
  home: string | null;
  noPermissions: boolean;
  onLogout: () => void;
}) {
  const client = useQueryClient();
  // 权限每次请求都从数据库重读，刷新 me 即可生效，不需要重新登录。
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: meQuery.queryKey });
  };
  return (
    <Page className="pt-6">
      <PageHeader title={noPermissions ? '没有可用权限' : '无权访问'} />
      <PageNote
        title={
          noPermissions ? '当前账户还没有分配任何业务权限。' : '当前账户没有访问这个页面的权限。'
        }
        description={
          noPermissions
            ? '请联系管理员分配角色，然后点「刷新权限」即可生效。'
            : '如果这是刚调整过的权限，点「刷新权限」即可生效。'
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {home ? (
              <a href={home} className="text-sm text-primary underline underline-offset-4">
                返回可用页面
              </a>
            ) : null}
            <Button variant="outline" size="sm" onClick={refresh}>
              刷新权限
            </Button>
            <Button variant="outline" size="sm" onClick={onLogout}>
              退出登录
            </Button>
          </div>
        }
      />
    </Page>
  );
}

export function AppShell() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const matchedRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const meta = matchedRoute ? routeMeta[matchedRoute] : undefined;
  const pageTitle = meta?.title ?? '页面不存在';
  const baseTitle = `${pageTitle} · PACE`;
  // 详情页共用同一个路由模板，固定名称无法区分实体（WCAG 2.4.2），改由页面实际 h1 命名。
  const isDetailRoute = Boolean(meta && matchedRoute?.includes('$'));
  const user = authenticated(me.data);
  const home = homePath(me.data);
  const firstOperations = [...operationsItems, ...platformItems].find((item) =>
    canAny(me.data, item.permissionIds),
  );
  const isOperationsContext = meta
    ? operationsNavTargets.has(meta.nav) || platformItems.some((item) => item.to === meta.nav)
    : false;
  const visibleWork = workItems.filter((item) => canAny(me.data, item.permissionIds));
  const visibleOperations = operationsItems.filter((item) => canAny(me.data, item.permissionIds));
  const visiblePlatform = platformItems.filter((item) => canAny(me.data, item.permissionIds));
  const resourceTarget = user ? resourceHome(user) : null;
  const buildItems: NavItem[] = [];
  if (resourceTarget) {
    buildItems.push({
      to: resourceTarget,
      label: '资源',
      icon: Cable,
      permissionIds: [] as readonly PermissionId[],
      navGroup: 'resources',
    });
  }
  if (can(me.data, 'eval.read')) {
    buildItems.push({
      to: '/eval',
      label: '评估',
      icon: FlaskConical,
      permissionIds: ['eval.read'] as readonly PermissionId[],
    });
  }
  const navGroups = isOperationsContext
    ? [
        ...(visibleOperations.length > 0 ? [{ label: '运维', items: visibleOperations }] : []),
        ...(visiblePlatform.length > 0 ? [{ label: '平台', items: visiblePlatform }] : []),
      ]
    : [
        ...(visibleWork.length > 0 ? [{ label: '工作', items: visibleWork }] : []),
        ...(buildItems.length > 0 ? [{ label: '构建', items: buildItems }] : []),
      ];
  const bottomEntry = isOperationsContext
    ? home !== null &&
      !operationsNavTargets.has(home) &&
      !platformItems.some((item) => item.to === home)
      ? { to: home, label: '返回工作区', icon: ArrowLeft }
      : null
    : firstOperations
      ? { to: firstOperations.to, label: '运维', icon: Wrench }
      : null;
  const required = requiredPermissions(matchedRoute);
  const allowed = required === null || canAny(me.data, required);
  const [collapsed, setCollapsed] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const locationHref = useRouterState({ select: (state) => state.location.href });

  const logout = async (): Promise<void> => {
    await logoutAccount();
    await navigate({ to: '/login' });
  };

  useEffect(() => {
    if (!me.data || me.data.authenticated) return;
    // 路由切换的瞬间可能已经到达登录地址；只跳过真正的 /login，避免把 /login-other 卡住或形成循环。
    if (/^\/login(?:[?#]|$)/.test(locationHref)) return;
    // 未登录也保留原目标；replace 避免后退回到受保护页面再被弹回。
    void navigate({
      to: '/login',
      search: { returnTo: locationHref },
      replace: true,
    });
  }, [me.data, navigate, locationHref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 变化要重置基础标题并重接观察；认证就绪后主内容才挂载。
  useEffect(() => {
    const apply = (heading?: string): void => {
      const next = heading ? `${heading} · PACE` : baseTitle;
      if (document.title !== next) document.title = next;
    };
    apply();
    if (!isDetailRoute) return;
    // 认证未就绪时主内容还没挂载，me.isPending 变化后 effect 会重跑并接上观察。
    const main = document.getElementById('main-content');
    if (!main) return;
    const sync = (): void => {
      apply(main.querySelector('h1')?.textContent?.trim() || undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    // 只跟主内容的标题节点，不观察 document.title 自身，避免自触发。
    observer.observe(main, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [baseTitle, isDetailRoute, pathname, me.isPending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次路径变化都要把焦点移入新页面，即使标题相同。
  useEffect(() => {
    document.getElementById('main-content')?.focus();
  }, [pathname]);

  if (me.isPending) {
    return (
      <div
        className="flex min-h-screen bg-shell"
        aria-busy="true"
        role="status"
        aria-label="加载中"
      >
        <PageHeader title={pageTitle} className="sr-only" />
        <div className="hidden w-56 shrink-0 border-r p-3 sm:block">
          <Skeleton className="mb-3 h-8 w-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-8">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (me.isError || !me.data?.authenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-shell text-sm text-muted-foreground">
        <PageHeader title={pageTitle} className="sr-only" />
        {me.isError ? (
          <>
            <span>无法验证登录状态</span>
            <Button variant="outline" size="sm" onClick={() => void me.refetch()}>
              重试
            </Button>
          </>
        ) : (
          '正在跳转登录…'
        )}
      </div>
    );
  }

  if (!user) return null;

  const rail = collapsed
    ? { width: 'var(--sidebar-collapsed)', padding: 'var(--sidebar-pad-collapsed)' }
    : { width: 'var(--sidebar-width)', padding: 'var(--sidebar-pad)' };
  const sidebar = (drawer: boolean) => (
    <motion.aside
      className={cn(
        'group/nav flex h-full shrink-0 flex-col overflow-hidden',
        drawer && 'px-3 py-4',
      )}
      initial={false}
      animate={drawer ? { width: '100%' } : rail}
      transition={reduce ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      {drawer ? (
        <Link
          to="/"
          aria-label="返回首页"
          onClick={() => setMobileOpen(false)}
          className="flex h-8 items-center rounded-icon"
        >
          <Brand className="h-8 self-center" />
        </Link>
      ) : (
        <SidebarBrand collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      )}
      {/* 收起态标签会横向溢出链接，导航不提供横向滚动。 */}
      <nav aria-label="主导航" className="mt-[18px] flex-1 overflow-y-auto overflow-x-hidden">
        {navGroups.map((group) => (
          <div key={group.label} className="mt-3 first:mt-3">
            {drawer || !collapsed ? (
              <div className="px-2.5 pb-1.5 pt-4 text-xs text-muted-foreground">{group.label}</div>
            ) : (
              <div className="mx-auto mb-1 h-px w-6" aria-hidden="true" />
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <SidebarLink
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  icon={item.icon}
                  navGroup={item.navGroup}
                  collapsed={drawer ? false : collapsed}
                  onNavigate={drawer ? () => setMobileOpen(false) : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      {/* 底部：次级运维入口（或返回工作区）与用户信息。 */}
      <div className={cn('flex flex-col gap-1 pt-[18px]', collapsed && !drawer && 'items-center')}>
        {bottomEntry ? (
          <SidebarLink
            to={bottomEntry.to}
            label={bottomEntry.label}
            icon={bottomEntry.icon}
            collapsed={drawer ? false : collapsed}
            onNavigate={drawer ? () => setMobileOpen(false) : undefined}
          />
        ) : null}
        {drawer || !collapsed ? (
          <UserMenu me={user} onChangePassword={() => setChangePasswordOpen(true)} />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={`账户 ${user.user.name || user.user.username}`}
                  onClick={() => setCollapsed(false)}
                  // Keep the circular account surface and translucent hover instead of the ghost defaults.
                  className="size-8 rounded-full bg-sunken p-0 hover:bg-hover"
                >
                  <User className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="right">{user.user.name || user.user.username}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </motion.aside>
  );

  const denied = home === null || !allowed;
  const content = denied ? (
    <AccessDenied home={home} noPermissions={home === null} onLogout={() => void logout()} />
  ) : (
    <Outlet />
  );

  return (
    <TooltipProvider delay={400}>
      {/*
       * 实测结构：侧栏在外、白壳在内。壳的下/右留 4px，左侧紧贴侧栏。
       * 壳用 1px outline（.04）而不是 border，避免内边距被边框吃掉。
       */}
      <div className="flex h-dvh bg-shell text-fg">
        <a href="#main-content" className="skip-link">
          跳到主要内容
        </a>

        <div className="hidden shrink-0 lg:block">{sidebar(false)}</div>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            finalFocus={navigationTrigger}
            showCloseButton={false}
            aria-describedby={undefined}
            // Keep the project shadow.
            className="w-[294px]! max-w-none! gap-0 p-0 shadow-overlay sm:max-w-none! lg:hidden"
          >
            <SheetTitle className="sr-only">导航</SheetTitle>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭导航"
                  // Keep the subdued close icon and translucent hover instead of the ghost defaults.
                  className="absolute right-3 top-6 z-10 text-muted-foreground hover:bg-hover"
                >
                  <X className="size-4" />
                </Button>
              }
            />
            {sidebar(true)}
          </SheetContent>
        </Sheet>

        <div className="mr-1 mb-1 mt-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-shell bg-surface outline outline-1 -outline-offset-1 outline-shell-line">
          {/*
           * 桌面端没有外壳自己的顶栏：参考页白面板里就是页面内容的第一行。
           * 移动端才需要这一行来放抽屉入口，页面标题由各页的 PageHeader 负责。
           */}
          <header className="flex h-11 shrink-0 items-center gap-3 px-3 lg:hidden">
            <Button
              variant="ghost"
              ref={navigationTrigger}
              aria-label="打开导航"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              // Keep the 7px icon corners and translucent hover instead of the regular ghost defaults.
              className="-ml-1 rounded-icon p-1.5 hover:bg-hover"
            >
              <Menu aria-hidden="true" />
            </Button>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className={cn(
              'min-h-0 flex-1',
              pathname.startsWith('/chat') ? 'overflow-hidden' : 'overflow-y-auto',
            )}
          >
            {pathname.startsWith('/chat') ? (
              <div className="h-full">{content}</div>
            ) : (
              // 内容区左右 24px、底部 24px；顶部内边距由 PageHeader 自己负责。
              <div className="w-full px-6 pb-6">
                <div className="w-full min-w-0">{content}</div>
              </div>
            )}
          </main>
        </div>
      </div>
      {changePasswordOpen ? (
        <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} />
      ) : null}
    </TooltipProvider>
  );
}
