import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  ArrowLeft,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
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
  requiredPermissions,
  WORK_MENU,
} from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { logoutAccount, meQuery } from '../lib/queries.js';
import { animateBrand, Brand, BrandMark } from './brand.js';
import { Page, PageBody, PageHeader, PageNote, PageTopbar } from './page.js';
import { Button, buttonVariants } from './ui/button.js';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet.js';
import { Skeleton } from './ui/skeleton.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.js';

type NavItem = MenuItem & { navGroup?: 'resources' };

/** 资源入口落到第一个可读资源分类，避免只有连接器权限的人被带到技能页 403。 */
function resourceHome(me: AuthenticatedMe): string | null {
  return RESOURCE_MENU.find((item) => canAny(me, item.permissionIds))?.to ?? null;
}

const operationsNavTargets = new Set(OPERATIONS_MENU.map((item) => item.to));
const resourceNavTargets = new Set<string>(RESOURCE_MENU.map((item) => item.to));

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
          className="absolute left-0 top-0 size-8 rounded-[var(--radius-icon)] p-0 opacity-0 transition-opacity duration-[140ms] ease-out-soft hover:bg-hover focus-visible:opacity-100 group-hover/nav:opacity-100"
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
        className="h-8 min-w-0 flex-1 justify-start rounded-[var(--radius-icon)] p-0"
      >
        <Brand className="h-8 self-center" />
      </Button>
      <Button
        variant="ghost"
        aria-label="收起侧栏"
        aria-expanded={!collapsed}
        onClick={onToggle}
        // Keep 7px corners and the translucent hover instead of the regular ghost defaults.
        className="size-8 rounded-[var(--radius-icon)] p-0 hover:bg-hover"
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
  icon: MenuItem['icon'];
  collapsed: boolean;
  navGroup?: 'resources' | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  const activeRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const activeNav = ROUTE_META[activeRoute ?? '']?.to;
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
      // 归属由 ROUTE_META 判定；Link 自带的路径前缀匹配会把未知路由误判为 active。
      activeOptions={{ exact: true, includeSearch: false }}
      className={cn(
        'relative flex h-8 items-center text-sm transition-colors duration-150 ease-out-soft',
        collapsed ? 'w-8 justify-center' : 'gap-2.5 rounded-item px-2.5',
        collapsed ? '' : active ? 'bg-selected text-selected-foreground' : 'text-fg hover:bg-hover',
        collapsed && (active ? 'text-selected-foreground' : 'text-fg'),
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center transition-colors duration-150 ease-out-soft',
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
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const matchedRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const meta = matchedRoute ? ROUTE_META[matchedRoute] : undefined;
  const pageTitle = meta?.label ?? '页面不存在';
  const baseTitle = `${pageTitle} · PACE`;
  // 详情页共用同一个路由模板，固定名称无法区分实体（WCAG 2.4.2），改由页面实际 h1 命名。
  const isDetailRoute = Boolean(meta && matchedRoute?.includes('$'));
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
  const required = requiredPermissions(matchedRoute);
  const allowed = required === null || canAny(me.data, required);
  const [collapsed, setCollapsed] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const locationHref = useRouterState({ select: (state) => state.location.href });
  // 对话与频道详情占满高度；频道列表仍是普通可滚动页面。
  const immersive = pathname.startsWith('/chat') || /^\/channels\/[^/]+/.test(pathname);

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
        className="flex min-h-screen bg-canvas"
        aria-busy="true"
        role="status"
        aria-label="加载中"
      >
        <PageHeader title={pageTitle} className="sr-only" />
        <div className="hidden w-56 shrink-0 p-3 lg:block">
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
      <nav aria-label="主导航" className="mt-4 flex-1 overflow-y-auto overflow-x-hidden">
        {navGroups.map((group) => (
          <div key={group.label} className={cn(drawer || !collapsed ? 'mt-0.5' : 'mt-3')}>
            {drawer || !collapsed ? (
              <div className="px-2.5 pb-1.5 pt-4 text-xs text-muted-foreground">{group.label}</div>
            ) : null}
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
      <div className={cn('flex flex-col gap-1 pt-4', collapsed && !drawer && 'items-center')}>
        {bottomEntry ? (
          <SidebarLink
            to={bottomEntry.to}
            label={bottomEntry.label}
            icon={bottomEntry.icon}
            collapsed={drawer ? false : collapsed}
            onNavigate={drawer ? () => setMobileOpen(false) : undefined}
          />
        ) : null}
        {personalContext ? (
          drawer || !collapsed ? (
            <Button
              variant="ghost"
              onClick={() => void logout()}
              className="h-8 justify-start gap-2.5 rounded-item px-2.5 text-sm text-fg hover:bg-hover"
            >
              <LogOut aria-hidden="true" />
              退出登录
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label="退出登录"
                    onClick={() => void logout()}
                    className="size-8 rounded-tag p-0 text-fg hover:bg-hover"
                  >
                    <LogOut />
                  </Button>
                }
              />
              <TooltipContent side="right">退出登录</TooltipContent>
            </Tooltip>
          )
        ) : null}
        {drawer || !collapsed ? (
          <Link
            to="/personal/profile"
            aria-label="个人资料"
            aria-current={personalContext ? 'page' : undefined}
            onClick={drawer ? () => setMobileOpen(false) : undefined}
            className={cn(
              buttonVariants({ variant: 'ghost' }),
              // 账号入口保持独立外观：紧凑 12px 标签、8px 角、20px 头像，靠左排布。
              'h-8 w-50 justify-start gap-2 rounded-[var(--radius-icon)] px-2 text-xs text-muted-foreground',
            )}
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted-foreground">
              <User className="size-3" />
            </span>
            <span className="max-w-32 truncate">{user.user.name || user.user.username}</span>
          </Link>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  to="/personal/profile"
                  aria-label="个人资料"
                  aria-current={personalContext ? 'page' : undefined}
                  // Keep the circular account surface and translucent hover.
                  className="flex size-8 items-center justify-center rounded-full bg-sunken p-0 text-muted-foreground transition-colors duration-150 ease-out-soft hover:bg-hover"
                >
                  <User className="size-4" />
                </Link>
              }
            />
            <TooltipContent side="right">{user.user.name || user.user.username}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </motion.aside>
  );

  // 个人资料与安全对所有已登录用户开放，即使没有任何业务权限也不该被挡。
  const denied = (!personalContext && home === null) || !allowed;
  const content = denied ? (
    <AccessDenied home={home} noPermissions={home === null} onLogout={() => void logout()} />
  ) : (
    <Outlet />
  );

  return (
    <TooltipProvider delay={400}>
      {/*
       * 平铺全幅：侧栏直接坐在画布底色上，白面内容区贴边，分区靠底色差异而不是描边。
       */}
      <div className="flex h-dvh bg-canvas text-fg">
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
            className="w-73.5! max-w-none! gap-0 p-0 shadow-overlay sm:max-w-none! lg:hidden"
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
                  <X className="size-3" />
                </Button>
              }
            />
            {sidebar(true)}
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
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
              className="-ml-1 rounded-[var(--radius-icon)] p-1.5 hover:bg-hover"
            >
              <Menu aria-hidden="true" />
            </Button>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-hidden"
          >
            {immersive ? (
              <div className={cn('h-full', denied && 'p-6')}>{content}</div>
            ) : (
              // 内容区左右 24px、底部 24px；顶部内边距由 PageHeader 自己负责。
              <div className="h-full min-h-0 w-full px-6 pb-6">
                <div className="h-full min-h-0 w-full min-w-0">{content}</div>
              </div>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
