import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Cable,
  CalendarClock,
  Container,
  FlaskConical,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  User,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { animateBrand, Brand, BrandMark } from './brand.js';
import { PageHeader } from './page.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet.js';
import { Skeleton } from './ui/skeleton.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.js';

/**
 * 导航按「使用 → 构建 → 系统」排，不按实体平铺。
 *
 * 依据（docs/UI-REDESIGN.md）：对话是每天多次的最高频动作，构建是低频但
 * 要求高准确度的动作，系统只在出问题时进入。把三者放在同一层级，
 * 等于让用户每次重新判断「我现在要做哪类事」。
 */
const nav = [
  {
    label: '使用',
    items: [
      { to: '/chat', label: '对话', icon: MessagesSquare },
      { to: '/runs', label: '运行', icon: Activity },
      { to: '/schedules', label: '定时任务', icon: CalendarClock },
    ],
  },
  {
    label: '构建',
    items: [
      { to: '/agents', label: '专家·技能·连接器·插件·知识库', icon: Cable },
      { to: '/eval', label: '评估', icon: FlaskConical },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/runtime-environments', label: '运行环境', icon: Container },
      { to: '/status', label: '健康', icon: HeartPulse },
      { to: '/audit', label: '审计', icon: ScrollText },
    ],
  },
] as const;

/** 工作台置顶：它是入口与待办的落点。 */
const overviewNav = {
  to: '/',
  label: '工作台',
  icon: LayoutDashboard,
} as const;

const resourceLabels: Record<string, string> = {
  '/agents': '专家',
  '/skills': '技能',
  '/servers': '连接器',
  '/plugins': '插件',
  '/knowledge': '知识库',
};

/** 主导航归属按实际命中的路由判断；未知路由（`/_shell/$`）不在表内，任何导航都不选中。 */
const navRoutes: Record<string, string> = {
  '/_shell/': '/',
  '/_shell/chat': '/chat',
  '/_shell/runs/': '/runs',
  '/_shell/runs/$runId': '/runs',
  '/_shell/schedules': '/schedules',
  '/_shell/agents/': '/agents',
  '/_shell/agents/$agentId': '/agents',
  '/_shell/skills': '/agents',
  '/_shell/servers': '/agents',
  '/_shell/plugins/': '/agents',
  '/_shell/plugins/$pluginId': '/agents',
  '/_shell/knowledge/': '/agents',
  '/_shell/knowledge/$baseId': '/agents',
  '/_shell/eval': '/eval',
  '/_shell/runtime-environments/': '/runtime-environments',
  '/_shell/runtime-environments/$environmentId': '/runtime-environments',
  '/_shell/status': '/status',
  '/_shell/audit': '/audit',
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
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof Cable;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const activeRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const active = navRoutes[activeRoute ?? ''] === to;
  // 收起态按参考页：整行透明，状态落在 32×32、radius 6 的图标块上。
  const link = (
    <Link
      to={to}
      onClick={onNavigate}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // 归属由 navRoutes 判定；Link 自带的路径前缀匹配会把未知路由误判为 active。
      activeOptions={{ exact: true, includeSearch: false }}
      className={cn(
        'relative flex h-8 items-center text-sm transition-colors duration-150',
        collapsed ? 'w-8 justify-center' : 'gap-2.5 rounded-item px-2.5',
        collapsed
          ? ''
          : active
            ? 'bg-selected font-medium text-fg'
            : 'text-muted-foreground hover:bg-hover hover:text-fg',
        collapsed && (active ? 'text-fg' : 'text-muted-foreground'),
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

function UserMenu({ username }: { username: string }) {
  const navigate = useNavigate();

  const logout = async (): Promise<void> => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aria-label={`账户 ${username}`}
            // Keep the compact 12px account label, 7px corners, and opaque open-state surface.
            className="gap-2 rounded-icon px-2 text-xs data-[popup-open]:bg-sunken"
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted-foreground">
              <User className="size-3" />
            </span>
            <span className="hidden max-w-32 truncate sm:block">{username}</span>
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        // Keep the 7px menu corners, explicit border, and project overlay shadow.
        className="w-48 rounded-icon border p-1 shadow-overlay"
      >
        <div className="border-b px-2.5 py-2">
          <div className="truncate text-xs text-fg">{username}</div>
          <div className="text-2xs text-muted-foreground">管理员</div>
        </div>
        <DropdownMenuGroup>
          <DropdownMenuItem
            // Keep the smaller muted label and opaque hover/focus surface instead of the base accent.
            className="mt-1 flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sunken hover:text-fg focus:bg-sunken"
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

export function AppShell() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentPage = [
    overviewNav,
    ...nav.flatMap<{ to: string; label: string }>((group) => group.items),
  ].find((item) => (item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)));
  const isNotFound = useRouterState({
    select: (state) => state.matches.at(-1)?.routeId === '/_shell/$',
  });
  // 插件不在主导航里，按实际命中的路由命名，列表与详情共用「插件」。
  const matchedRoute = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const pageTitle = isNotFound
    ? '页面不存在'
    : matchedRoute?.startsWith('/_shell/plugins')
      ? '插件'
      : (resourceLabels[pathname] ??
        (pathname.startsWith('/knowledge/') ? '知识库' : currentPage?.label) ??
        '页面不存在');
  const [collapsed, setCollapsed] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (me.data && !me.data.authenticated) void navigate({ to: '/login' });
  }, [me.data, navigate]);

  useEffect(() => {
    document.title = `${pageTitle} · 控制台`;
  }, [pageTitle]);

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
        <SidebarLink
          to={overviewNav.to}
          label={overviewNav.label}
          icon={overviewNav.icon}
          collapsed={drawer ? false : collapsed}
          onNavigate={drawer ? () => setMobileOpen(false) : undefined}
        />
        {nav.map((group) => (
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
                  collapsed={drawer ? false : collapsed}
                  onNavigate={drawer ? () => setMobileOpen(false) : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      {/* 底部：用户信息（参考页把升级入口放在同一位置）。 */}
      <div className={cn('pt-[18px]', collapsed && !drawer && 'flex justify-center')}>
        {drawer || !collapsed ? (
          <UserMenu username={me.data.username ?? 'admin'} />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={`账户 ${me.data.username ?? 'admin'}`}
                  onClick={() => setCollapsed(false)}
                  // Keep the circular account surface and translucent hover instead of the ghost defaults.
                  className="size-8 rounded-full bg-sunken p-0 hover:bg-hover"
                >
                  <User className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="right">{me.data.username ?? 'admin'}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </motion.aside>
  );

  return (
    <TooltipProvider delay={400}>
      {/*
       * 实测结构：侧栏在外、白壳在内。壳的下/右留 4px，左侧紧贴侧栏。
       * 壳用 1px outline（.04）而不是 border，避免内边距被边框吃掉。
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
              <div className="h-full">
                <Outlet />
              </div>
            ) : (
              // 实测：内容区距白壳边缘 12px。顶部内边距由 PageHeader 承担。
              <div className="w-full px-3 pb-10">
                <div className="w-full min-w-0">
                  <Outlet />
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
