import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Bot,
  Command,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Server,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { Brand } from './brand.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
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
    ],
  },
  {
    label: '构建',
    items: [
      { to: '/agents', label: '智能体', icon: Bot },
      { to: '/servers', label: 'MCP Servers', icon: Server },
      { to: '/skills', label: '技能', icon: Sparkles },
    ],
  },
  {
    label: '系统',
    items: [
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

const COLLAPSE_KEY = 'agentport:nav-collapsed';

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const update = (next: boolean): void => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };
  return [collapsed, update];
}

/**
 * 品牌区（实测参考页侧栏头部，32px 高）：
 * - 展开：字标在左，折叠按钮贴右（x=228）。按钮是 32×32、radius 7。
 * - 收起：整行缩成 32×32，logo 与按钮重叠在同一位置。默认露 logo，
 *   悬停或内部有焦点时 logo 淡出、换成展开按钮（140ms），布局不跳动。
 */
function SidebarBrand({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <div className="relative h-8 w-8 shrink-0">
        <Link
          to="/"
          aria-label="PACE 首页"
          className="group/logo absolute -left-0.5 top-0 flex h-[30px] w-9 items-center justify-center rounded-icon bg-ink px-[3px] text-white transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/nav:opacity-0 group-has-[:focus-visible]/nav:opacity-0"
        >
          <Command aria-hidden="true" className="size-3.5" />
        </Link>
        <Button
          variant="ghost"
          aria-label="展开侧栏"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="absolute left-0 top-0 size-8 rounded-icon p-0 text-fg opacity-0 transition-opacity duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-hover focus-visible:opacity-100 group-hover/nav:opacity-100"
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-2">
      <Link
        to="/"
        aria-label="PACE 首页"
        className="flex h-8 min-w-0 flex-1 items-center rounded-icon"
      >
        <Brand />
      </Link>
      <Button
        variant="ghost"
        aria-label="收起侧栏"
        aria-expanded={!collapsed}
        onClick={onToggle}
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
  icon: typeof Server;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
  // 收起态按参考页：整行透明，状态落在 32×32、radius 6 的图标块上。
  const link = (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 text-sm transition-colors duration-150',
        collapsed ? 'w-8 justify-center' : 'rounded-item px-2.5',
        collapsed
          ? ''
          : active
            ? 'bg-hover font-medium text-fg'
            : 'text-muted hover:bg-hover hover:text-fg',
        collapsed && (active ? 'text-fg' : 'text-muted'),
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center transition-colors duration-150',
          collapsed
            ? cn('size-8 rounded-tag', active ? 'bg-selected' : 'group-hover/nav:bg-hover')
            : 'size-4',
        )}
      >
        <Icon className={collapsed ? 'size-5' : 'size-4'} aria-hidden="true" />
      </span>
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
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
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="gap-2 rounded-icon px-2 text-xs data-[state=open]:bg-sunken"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted">
            <User className="size-3" />
          </span>
          <span className="hidden max-w-32 truncate sm:block">{username}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-48 rounded-icon border border-line bg-surface p-1 shadow-overlay"
      >
        <div className="border-b border-line px-2.5 py-2">
          <div className="truncate text-xs text-fg">{username}</div>
          <div className="text-2xs text-subtle">管理员</div>
        </div>
        <DropdownMenuItem
          className="mt-1 flex w-full items-center gap-2 rounded-icon px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-sunken hover:text-fg focus:bg-sunken focus:text-fg"
          onSelect={() => void logout()}
        >
          <LogOut className="size-3.5" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsed, setCollapsed] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (me.data && !me.data.authenticated) void navigate({ to: '/login' });
  }, [me.data, navigate]);

  useEffect(() => {
    const flat: { to: string; label: string }[] = [overviewNav];
    for (const group of nav) flat.push(...group.items);
    const current = flat.find((item) =>
      item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
    );
    document.title = current ? `${current.label} · PACE` : 'PACE';
  }, [pathname]);

  if (me.isPending) {
    return (
      <div
        className="flex min-h-screen bg-canvas"
        aria-busy="true"
        role="status"
        aria-label="加载中"
      >
        <div className="hidden w-56 shrink-0 border-r border-line p-3 sm:block">
          <Skeleton className="mb-3 h-8 w-full" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
        <div className="flex-1 space-y-4 p-8">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (me.isError || !me.data?.authenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas text-sm text-muted">
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

  const sidebar = (drawer: boolean) => (
    <aside
      className={cn(
        'group/nav flex h-full shrink-0 flex-col overflow-hidden',
        // 实测：展开 272 / 收起 68，宽高与内边距一起过渡 160ms。
        drawer
          ? 'w-[294px] px-3'
          : collapsed
            ? 'w-(--sidebar-collapsed) p-(--sidebar-pad-collapsed)'
            : 'w-(--sidebar-width) p-(--sidebar-pad)',
      )}
      style={{ transition: 'width 160ms var(--ease-out-soft), padding 160ms var(--ease-out-soft)' }}
    >
      <SidebarBrand
        collapsed={drawer ? false : collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <nav aria-label="主导航" className="mt-[18px] flex-1 overflow-y-auto">
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
              <div className="px-2.5 pb-1.5 pt-4 text-xs text-subtle">{group.label}</div>
            ) : (
              <div className="mx-auto mb-1 h-px w-6 bg-line" aria-hidden="true" />
            )}
            <div className="space-y-0.5">
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
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                aria-label={`账户 ${me.data.username ?? 'admin'}`}
                onClick={() => setCollapsed(false)}
                className="size-8 rounded-full bg-sunken p-0 hover:bg-hover"
              >
                <User className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{me.data.username ?? 'admin'}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </aside>
  );

  return (
    <TooltipProvider delayDuration={400}>
      {/*
       * 实测结构：侧栏在外、白壳在内。壳的下/右留 4px，左侧紧贴侧栏。
       * 壳用 1px outline（.04）而不是 border，避免内边距被边框吃掉。
       */}
      <div className="flex h-screen bg-canvas text-fg">
        <a href="#main-content" className="skip-link">
          跳到主要内容
        </a>

        <div className="hidden shrink-0 lg:block">{sidebar(false)}</div>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            aria-describedby={undefined}
            className="w-[294px] max-w-none gap-0 border-r border-line bg-surface p-0 shadow-overlay sm:max-w-none lg:hidden"
          >
            <SheetTitle className="sr-only">导航</SheetTitle>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭导航"
                className="absolute right-3 top-4 z-10 rounded-icon text-subtle hover:bg-hover"
              >
                <X className="size-4" />
              </Button>
            </SheetClose>
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
              aria-label="打开导航"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="-ml-1 rounded-icon p-1.5 hover:bg-hover"
            >
              <Menu className="size-5" />
            </Button>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className={cn('min-h-0 flex-1', pathname.startsWith('/chat') && 'overflow-hidden')}
          >
            {pathname.startsWith('/chat') ? (
              <div className="h-full">
                <Outlet />
              </div>
            ) : (
              // 实测：内容区距白壳边缘 12px。顶部内边距由 PageHeader 承担。
              <div className="w-full px-3 pb-10">
                <div className="mx-auto w-full max-w-[960px]">
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
