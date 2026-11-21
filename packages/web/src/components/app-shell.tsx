import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  LogOut,
  Menu,
  PanelLeftClose,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import {
  type AuthenticatedMe,
  authenticated,
  BUILD_MENU,
  canAny,
  homePath,
  isPersonalPath,
  type MenuItem,
  OPERATIONS_MENU,
  PERSONAL_NAV_GROUPS,
  PLATFORM_MENU,
  RESOURCE_MENU,
  ROUTE_META,
  WORK_MENU,
} from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { logoutAccount, meQuery, useUnreadNotificationCount } from '../lib/queries.js';
import { animateBrand, Brand } from './brand.js';
import { CommandPalette, CommandPaletteTrigger } from './command-palette.js';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog.js';
import { Page, PageBody, PageHeader, PageNote, PageTopbar } from './page.js';
import { Button, buttonVariants } from './ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet.js';
import { Skeleton } from './ui/skeleton.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

type NavItem = MenuItem & { navGroup?: 'resources' };

function resourceHome(me: AuthenticatedMe): string | null {
  return RESOURCE_MENU.find((item) => canAny(me, item.permissionIds))?.to ?? null;
}

const operationsNavTargets = new Set(OPERATIONS_MENU.map((item) => item.to));
const resourceNavTargets = new Set<string>(RESOURCE_MENU.map((item) => item.to));

const COLLAPSE_KEY = 'agentport:nav-collapsed';

type SidebarMode = 'expanded' | 'rail';

const AVATAR_TONES = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
] as const;

function pickAvatarTone(seed: string): string {
  let n = 0;
  for (const ch of seed) n = (n + (ch.codePointAt(0) ?? 0)) % 9973;
  return AVATAR_TONES[n % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

function SidebarBrand({
  expanded,
  iconOnly,
  toggleRef,
  logoRef,
  onToggle,
}: {
  expanded: boolean;
  iconOnly: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  logoRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2">
      <Button
        ref={toggleRef}
        variant="plain"
        aria-label={expanded ? '收起为窄边' : '展开侧栏'}
        aria-expanded={!iconOnly}
        onClick={onToggle}
        className="size-8 shrink-0 rounded-[var(--radius-icon)] p-0 text-fg hover:bg-sidebar-hover"
      >
        <PanelLeftClose className="size-4" />
      </Button>
      {!iconOnly ? (
        <Button
          ref={logoRef}
          type="button"
          variant="plain"
          aria-label="切换 PACE Logo"
          onClick={animateBrand}
          className="h-8 min-w-0 flex-1 justify-start rounded-[var(--radius-icon)] p-0"
        >
          <Brand className="h-8 self-center" />
        </Button>
      ) : null}
    </div>
  );
}

function SidebarLink({
  to,
  label,
  icon: Icon,
  iconOnly,
  navGroup,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: MenuItem['icon'];
  iconOnly: boolean;
  navGroup?: 'resources' | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const activeRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const activeNav = ROUTE_META[activeRoute ?? '']?.to;
  const active =
    navGroup === 'resources'
      ? activeNav !== undefined && resourceNavTargets.has(activeNav)
      : activeNav === to;
  return (
    <Tooltip disabled={!iconOnly} delay={400}>
      <TooltipTrigger
        render={
          <Link
            to={to}
            onClick={onNavigate}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            activeOptions={{ exact: true, includeSearch: false }}
            className={cn(
              'relative flex h-8 items-center text-sm transition-colors duration-150 ease-out-soft',
              iconOnly ? 'w-8 justify-center rounded-tag' : 'gap-2.5 rounded-item px-2',
              active
                ? 'bg-sidebar-selected text-selected-foreground'
                : 'text-fg hover:bg-sidebar-hover',
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Icon aria-hidden="true" />
            </span>
            {!iconOnly ? <span className="truncate">{label}</span> : null}
          </Link>
        }
      />
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
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
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: meQuery.queryKey });
  };
  return (
    <Page>
      <PageTopbar>
        <PageHeader title={noPermissions ? '没有可用权限' : '无权访问'} />
      </PageTopbar>
      <PageBody>
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
                <Link
                  to={home}
                  className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'underline')}
                >
                  返回可用页面
                </Link>
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
      </PageBody>
    </Page>
  );
}

export function AppShell() {
  const me = useQuery(meQuery);
  const unreadNotifications = useUnreadNotificationCount(me.data?.authenticated === true);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const matchedRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const meta = matchedRoute ? ROUTE_META[matchedRoute] : undefined;
  const pageTitle = meta?.label ?? '页面不存在';
  const baseTitle = `${pageTitle} · PACE`;
  // 详情页共用同一个路由模板，固定名称无法区分实体（WCAG 2.4.2），改由页面实际 h1 命名。
  const isDetailRoute = Boolean(
    meta && matchedRoute !== '/_shell/$' && matchedRoute?.includes('$'),
  );
  const user = authenticated(me.data);
  const home = homePath(me.data);
  const firstOperations = [...OPERATIONS_MENU, ...PLATFORM_MENU].find((item) =>
    canAny(me.data, item.permissionIds),
  );
  const isOperationsContext = meta
    ? operationsNavTargets.has(meta.to) || PLATFORM_MENU.some((item) => item.to === meta.to)
    : false;
  const personalContext = isPersonalPath(pathname);
  const visibleWork = WORK_MENU.filter((item) => canAny(me.data, item.permissionIds));
  const visibleOperations = OPERATIONS_MENU.filter((item) => canAny(me.data, item.permissionIds));
  const visiblePlatform = PLATFORM_MENU.filter((item) => canAny(me.data, item.permissionIds));
  const visiblePersonalGroups = PERSONAL_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.permissionIds.length === 0 || canAny(me.data, item.permissionIds),
    ),
  })).filter((group) => group.items.length > 0);
  const resourceTarget = user ? resourceHome(user) : null;
  const buildItems: NavItem[] = BUILD_MENU.filter((item) =>
    canAny(me.data, item.permissionIds),
  ).map((item) =>
    item.to === '/skills' && resourceTarget
      ? { ...item, to: resourceTarget, navGroup: 'resources' }
      : item,
  );
  const navGroups: { label: string; items: readonly NavItem[] }[] = personalContext
    ? visiblePersonalGroups
    : isOperationsContext
      ? [
          ...(visibleOperations.length > 0 ? [{ label: '运维', items: visibleOperations }] : []),
          ...(visiblePlatform.length > 0 ? [{ label: '平台', items: visiblePlatform }] : []),
        ]
      : [
          ...(visibleWork.length > 0 ? [{ label: '工作', items: visibleWork }] : []),
          ...(buildItems.length > 0 ? [{ label: '构建', items: buildItems }] : []),
        ];
  const bottomEntry = personalContext
    ? home !== null
      ? { to: home, label: '返回工作区', icon: ArrowLeft }
      : null
    : isOperationsContext
      ? home !== null &&
        !operationsNavTargets.has(home) &&
        !PLATFORM_MENU.some((item) => item.to === home)
        ? { to: home, label: '返回工作区', icon: ArrowLeft }
        : null
      : firstOperations
        ? { to: firstOperations.to, label: '运维', icon: Wrench }
        : null;
  const allowed =
    meta !== undefined && (meta.permissionIds.length === 0 || canAny(me.data, meta.permissionIds));
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      if (stored === 'expanded') return stored;
    } catch {}
    return 'rail';
  });
  const [previewing, setPreviewing] = useState(false);
  const preview = sidebarMode === 'rail' && previewing;
  const sidebarWidth = {
    expanded: 'var(--sidebar-width)',
    rail: 'var(--sidebar-collapsed)',
  }[sidebarMode];
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const pointerInSidebar = useRef(false);
  const sidebarLogo = useRef<HTMLButtonElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const restoreToggleFocus = useRef(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const locationHref = useRouterState({ select: (state) => state.location.href });
  const immersive = pathname.startsWith('/chat') || /^\/channels\/[^/]+/.test(pathname);

  const logout = async (): Promise<void> => {
    await logoutAccount();
    await navigate({ to: '/login' });
  };

  useEffect(() => {
    if (!me.data || me.data.authenticated) return;
    if (/^\/login(?:[?#]|$)/.test(locationHref)) return;
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
    const main = document.getElementById('main-content');
    if (!main) return;
    const sync = (): void => {
      apply(main.querySelector('h1')?.textContent?.trim() || undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(main, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [baseTitle, isDetailRoute, pathname, me.isPending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次路径变化都要把焦点移入新页面，即使标题相同。
  useEffect(() => {
    document.getElementById('main-content')?.focus();
  }, [pathname]);

  useEffect(() => {
    if (sidebarMode === 'rail' || !restoreToggleFocus.current) return;
    restoreToggleFocus.current = false;
    sidebarToggle.current?.focus();
  }, [sidebarMode]);

  useEffect(() => {
    if (!preview || mobileOpen || accountOpen) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.activeElement === sidebarLogo.current) sidebarToggle.current?.focus();
      setPreviewing(false);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [preview, mobileOpen, accountOpen]);

  if (me.isPending) {
    return (
      <div
        className="flex min-h-screen bg-canvas"
        aria-busy="true"
        role="status"
        aria-label="加载中"
      >
        <PageHeader title={pageTitle} className="sr-only" />
        <div
          className="hidden shrink-0 bg-sidebar lg:block"
          style={{
            width: sidebarWidth,
            padding: sidebarMode === 'rail' ? 'var(--sidebar-pad-collapsed)' : 'var(--sidebar-pad)',
          }}
        >
          <Skeleton className="mb-3 h-8 w-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-4 bg-surface px-6 pb-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (me.isError || !me.data?.authenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas text-sm text-muted-foreground">
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

  const avatarTone = pickAvatarTone(user.user.username);

  const toggleSidebar = (): void => {
    const mode = sidebarMode === 'expanded' ? 'rail' : 'expanded';
    restoreToggleFocus.current =
      mode !== 'rail' && document.activeElement === sidebarToggle.current;
    setPreviewing(false);
    setSidebarMode(mode);
    try {
      localStorage.setItem(COLLAPSE_KEY, mode);
    } catch {}
  };
  const sidebar = (drawer: boolean) => {
    const iconOnly = !drawer && sidebarMode === 'rail' && !preview;
    const interactiveRail = !drawer && sidebarMode === 'rail';
    const accountInitial = (
      Array.from(user.user.name.trim())[0] ??
      Array.from(user.user.username)[0] ??
      ''
    ).toUpperCase();
    const displayName = user.user.name || user.user.username;
    const roleNames = user.roles.map((role) => role.name).join('、');
    const accountSecondary = roleNames || user.user.username;
    const unreadCount = unreadNotifications.data?.unreadCount ?? 0;
    const accountCurrent =
      pathname === '/personal/profile' || pathname === '/personal' ? 'page' : undefined;
    const accountAvatar = (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-surface',
          iconOnly ? 'size-8' : 'size-5',
          avatarTone,
        )}
      >
        {accountInitial}
      </span>
    );
    const accountLabel = !iconOnly ? (
      <span className="min-w-0 flex-1 truncate text-left">
        <span className="text-fg">{displayName}</span>
        <span className="text-muted-foreground"> · {accountSecondary}</span>
      </span>
    ) : null;
    const accountClass = iconOnly
      ? 'size-8 rounded-full p-0'
      : 'h-8 min-w-0 flex-1 justify-start gap-2 rounded-item px-2';
    const onNavigate = (): void => {
      if (drawer) setMobileOpen(false);
      else setPreviewing(false);
    };
    return (
      <motion.aside
        className={cn(
          'flex h-full flex-col overflow-hidden bg-sidebar',
          drawer ? 'px-3 py-4' : 'absolute inset-y-0 left-0 border-r border-line',
          !drawer && preview && 'shadow-overlay',
        )}
        initial={false}
        animate={
          drawer
            ? { width: '100%' }
            : {
                width: iconOnly ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)',
                padding: iconOnly ? 'var(--sidebar-pad-collapsed)' : 'var(--sidebar-pad)',
              }
        }
        transition={reduce ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        onPointerEnter={
          drawer
            ? undefined
            : () => {
                pointerInSidebar.current = true;
                if (interactiveRail) setPreviewing(true);
              }
        }
        onPointerLeave={
          drawer
            ? undefined
            : (event) => {
                pointerInSidebar.current = false;
                if (!event.currentTarget.contains(document.activeElement)) setPreviewing(false);
              }
        }
        onFocus={
          interactiveRail
            ? (event) => {
                if (
                  event.currentTarget.contains(event.target) &&
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setPreviewing(true);
                }
              }
            : undefined
        }
        onBlur={
          interactiveRail
            ? (event) => {
                if (
                  !pointerInSidebar.current &&
                  !event.currentTarget.contains(event.relatedTarget)
                ) {
                  setPreviewing(false);
                }
              }
            : undefined
        }
      >
        {drawer ? (
          <Link
            to="/"
            aria-label="返回首页"
            onClick={onNavigate}
            className="flex h-8 items-center rounded-icon"
          >
            <Brand className="h-8 self-center" />
          </Link>
        ) : (
          <SidebarBrand
            expanded={sidebarMode === 'expanded'}
            iconOnly={iconOnly}
            toggleRef={sidebarToggle}
            logoRef={sidebarLogo}
            onToggle={toggleSidebar}
          />
        )}
        <div
          className={cn(
            'mt-3',
            iconOnly &&
              '[&>button]:size-8 [&>button]:justify-center [&>button]:rounded-tag [&>button]:p-0 [&>button>span]:hidden',
          )}
        >
          <CommandPaletteTrigger />
        </div>
        <nav
          aria-label="主导航"
          className={cn(
            '-mx-2 mt-4 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2',
            iconOnly && '[scrollbar-width:none]',
          )}
        >
          {navGroups.map((group) => (
            <div key={group.label} className="mt-0.5">
              <div
                className={cn(
                  'whitespace-nowrap px-2 pb-1.5 pt-4 text-[13px] font-medium text-muted-foreground',
                  iconOnly && 'invisible',
                )}
              >
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <SidebarLink
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    iconOnly={iconOnly}
                    navGroup={item.navGroup}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-1 pt-4">
          {bottomEntry ? (
            <SidebarLink
              to={bottomEntry.to}
              label={bottomEntry.label}
              icon={bottomEntry.icon}
              iconOnly={iconOnly}
              onNavigate={onNavigate}
            />
          ) : null}
          <Link
            to="/notifications"
            aria-label={unreadCount > 0 ? `通知（${unreadCount} 条未读）` : '通知'}
            onClick={onNavigate}
            className={cn(
              'flex h-8 items-center text-sm text-fg transition-colors duration-150 ease-out-soft hover:bg-sidebar-hover',
              iconOnly
                ? 'relative w-8 justify-center rounded-tag p-0'
                : 'gap-2.5 rounded-item px-2',
            )}
          >
            <Bell aria-hidden="true" className="shrink-0" />
            {!iconOnly ? <span className="truncate">通知</span> : null}
            {unreadCount > 0 && !iconOnly ? (
              <span
                aria-hidden="true"
                className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-fg px-1.5 text-xs font-medium leading-none text-surface tabular-nums"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
            {unreadCount > 0 && iconOnly ? (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-xs font-medium leading-none text-surface tabular-nums"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
          </Link>
          {personalContext ? (
            <Button
              variant="ghost"
              aria-label="退出登录"
              onClick={() => void logout()}
              className={cn(
                'h-8 text-sm text-fg hover:bg-sidebar-hover',
                iconOnly ? 'w-8 rounded-tag p-0' : 'justify-start gap-2.5 rounded-item px-2',
              )}
            >
              <LogOut aria-hidden="true" />
              {!iconOnly ? <span>退出登录</span> : null}
            </Button>
          ) : null}
          <div
            className={cn(
              '-mx-2 mt-1 flex items-center gap-1 border-t border-line px-2 pt-2',
              iconOnly && 'flex-col items-start',
            )}
          >
            {personalContext ? (
              <Link
                to="/personal/profile"
                aria-label="个人资料"
                aria-current={accountCurrent}
                onClick={onNavigate}
                className={cn(
                  'flex items-center text-sm text-fg hover:bg-sidebar-hover',
                  accountClass,
                  iconOnly && 'justify-center',
                )}
              >
                {accountAvatar}
                {accountLabel}
              </Link>
            ) : (
              <Popover open={accountOpen} onOpenChange={setAccountOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      aria-label="账户菜单"
                      aria-current={accountCurrent}
                      className={cn('text-sm text-fg hover:bg-sidebar-hover', accountClass)}
                    >
                      {accountAvatar}
                      {accountLabel}
                      {!iconOnly ? (
                        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                      ) : null}
                    </Button>
                  }
                />
                <PopoverContent side="top" align="start" sideOffset={8} className="w-72 gap-0 p-0">
                  <div className="flex min-w-0 items-center gap-3 p-3">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-medium text-surface',
                        avatarTone,
                      )}
                    >
                      {accountInitial}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="min-w-0 truncate text-sm font-medium text-fg">{displayName}</p>
                      <p className="min-w-0 truncate text-xs text-muted-foreground">
                        @{user.user.username} · {roleNames || '无角色'}
                      </p>
                    </div>
                  </div>
                  <div className="h-px bg-line" />
                  <div className="flex flex-col gap-0.5 p-2">
                    {visiblePersonalGroups.map((group) => (
                      <div key={group.label} className="flex flex-col gap-0.5">
                        <div className="px-3 pb-1 pt-1.5 text-xs text-muted-foreground">
                          {group.label}
                        </div>
                        {group.items.map((item) => (
                          <Link
                            key={item.to}
                            to={item.to}
                            onClick={() => {
                              setAccountOpen(false);
                              onNavigate();
                            }}
                            className="flex h-9 items-center gap-2.5 rounded-item px-3 text-sm text-fg transition-colors duration-150 ease-out-soft hover:bg-hover"
                          >
                            <item.icon
                              aria-hidden="true"
                              className="shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 truncate">{item.label}</span>
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="h-px bg-line" />
                  <div className="p-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setAccountOpen(false);
                        void logout();
                      }}
                      className="h-9 w-full justify-start gap-2.5 rounded-item px-3 text-sm text-danger hover:bg-hover hover:text-danger"
                    >
                      <LogOut aria-hidden="true" className="shrink-0" />
                      退出登录
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </motion.aside>
    );
  };

  const selfService = personalContext || /^\/notifications(?:\/|$)/.test(pathname);
  const denied = (!selfService && home === null) || !allowed;
  const content = denied ? (
    <AccessDenied home={home} noPermissions={home === null} onLogout={() => void logout()} />
  ) : (
    <Outlet />
  );

  return (
    <div className="flex h-dvh bg-canvas text-fg">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>

      <motion.div
        className="relative z-20 hidden shrink-0 lg:block"
        initial={false}
        animate={{ width: sidebarWidth }}
        transition={reduce ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      >
        {sidebar(false)}
      </motion.div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          finalFocus={() => navigationTrigger.current}
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-73.5! max-w-none! gap-0 p-0 shadow-overlay sm:max-w-none! lg:hidden"
        >
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭导航"
                className="absolute right-3 top-6 z-10 text-muted-foreground hover:bg-sidebar-hover"
              >
                <X className="size-3" />
              </Button>
            }
          />
          {sidebar(true)}
        </SheetContent>
      </Sheet>

      <div className="relative isolate flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
        <header className="flex h-11 shrink-0 items-center gap-3 px-3 lg:hidden">
          <Button
            variant="ghost"
            ref={navigationTrigger}
            aria-label="打开导航"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="-ml-1 rounded-[var(--radius-icon)] p-1.5 hover:bg-hover"
          >
            <Menu aria-hidden="true" />
          </Button>
        </header>

        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-hidden">
          {immersive ? (
            <div className={cn('h-full', denied && 'p-6')}>{content}</div>
          ) : (
            <div className="h-full min-h-0 w-full px-6 pb-6">
              <div className="h-full min-h-0 w-full min-w-0">{content}</div>
            </div>
          )}
        </main>
      </div>

      <CommandPalette me={me.data} />
      <KeyboardShortcutsDialog />
    </div>
  );
}
