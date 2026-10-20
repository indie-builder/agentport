import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bot,
  ChevronRight,
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
 * 导航按「配置 → 使用 → 观测 → 运维」分组。
 * 平铺九项会让读者每次重新扫描；分组给出稳定的位置记忆。
 */
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
      { to: '/chat', label: '对话', icon: MessagesSquare, title: '对话' },
      { to: '/runs', label: '运行', icon: Activity, title: '运行' },
    ],
  },
  {
    label: '构建',
    items: [
      { to: '/agents', label: '智能体', icon: Bot, title: '智能体' },
      { to: '/servers', label: 'MCP Servers', icon: Server, title: 'MCP Servers' },
      { to: '/skills', label: '技能', icon: Sparkles, title: '技能' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/status', label: '健康', icon: HeartPulse, title: '健康' },
      { to: '/audit', label: '审计', icon: ScrollText, title: '审计' },
    ],
  },
] as const;

/** 工作台置顶：它是入口与待办的落点。 */
const overviewNav = {
  to: '/',
  label: '工作台',
  icon: LayoutDashboard,
  title: '工作台',
} as const;

/** 扁平列表供标题查找与路由匹配使用。 */
interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly title: string;
}
const allNavItems: readonly NavItem[] = [
  overviewNav,
  ...nav.flatMap((group) => group.items as readonly NavItem[]),
];

const COLLAPSE_KEY = 'agentport:nav-collapsed';

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const update = (next: boolean): void => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };
  return [collapsed, update];
}

/** 品牌：lucide 线框标记 + 文字，与参考页一致的图标语言。 */
function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      to="/"
      aria-label="PACE 首页"
      className={cn(
        'flex h-14 shrink-0 items-center gap-2 focus-visible:outline-none',
        collapsed ? 'justify-center' : 'px-3',
      )}
    >
      <span className="flex size-7 items-center justify-center rounded-[7px] bg-ink text-white">
        <Command aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </span>
      {collapsed ? null : (
        <span className="text-sm font-medium tracking-[0.12em] text-fg">PACE</span>
      )}
    </Link>
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
  const link = (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-[9px] text-sm transition-colors duration-150 focus-visible:outline-none',
        collapsed ? 'w-9 justify-center' : 'px-2.5',
        active ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
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
      <TooltipContent
        side="right"
        sideOffset={8}
        className="rounded-[7px] bg-ink px-2 py-1 text-2xs text-white"
      >
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
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-[7px] px-2 text-xs text-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none data-[state=open]:bg-sunken focus-visible:ring-2 focus-visible:ring-fg"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted">
            <User className="size-3" strokeWidth={1.75} />
          </span>
          <span className="hidden max-w-32 truncate sm:block">{username}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-48 rounded-[7px] border border-line bg-surface p-1 shadow-overlay"
      >
        <div className="border-b border-line px-2.5 py-2">
          <div className="truncate text-xs text-fg">{username}</div>
          <div className="text-2xs text-subtle">管理员</div>
        </div>
        <DropdownMenuItem
          className="mt-1 flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-sunken hover:text-fg focus:bg-sunken focus:text-fg"
          onSelect={() => void logout()}
        >
          <LogOut className="size-3.5" strokeWidth={1.75} />
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
    const current = allNavItems.find((item) =>
      item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
    );
    document.title = current ? `${current.title} · PACE` : 'PACE';
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
        'flex h-full flex-col bg-surface',
        drawer ? 'w-[310px]' : collapsed ? 'w-16' : 'w-[310px]',
      )}
    >
      <Brand collapsed={drawer ? false : collapsed} />
      <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 pb-3">
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
      <div className="p-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-pressed={collapsed}
          className={cn(
            'hidden h-9 items-center gap-2 rounded-[9px] text-sm text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none lg:flex',
            collapsed ? 'w-9 justify-center' : 'w-full px-2.5',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" strokeWidth={1.75} />
          ) : (
            <>
              <PanelLeftClose className="size-4" strokeWidth={1.75} />
              <span>收起侧栏</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="h-screen bg-canvas p-1 text-fg">
        <a href="#main-content" className="skip-link">
          跳到主要内容
        </a>

        {/* 外壳：参考页的核心结构——16px 圆角的白色容器承载全部内容。 */}
        <div className="flex h-full overflow-hidden rounded-[16px] bg-surface">
          <div className="hidden shrink-0 lg:block">{sidebar(false)}</div>

          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              aria-describedby={undefined}
              className="w-[310px] max-w-none gap-0 border-r border-line bg-surface p-0 shadow-overlay sm:max-w-none lg:hidden"
            >
              <SheetTitle className="sr-only">导航</SheetTitle>
              <SheetClose
                aria-label="关闭导航"
                className="absolute right-3 top-4 z-10 rounded-[7px] p-1.5 text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none"
              >
                <X className="size-4" strokeWidth={1.75} />
              </SheetClose>
              {sidebar(true)}
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* 顶部只有一行：页面名 + 用户。参考页也是如此，没有标题区与面包屑堆叠。 */}
            <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
              <button
                type="button"
                aria-label="打开导航"
                aria-expanded={mobileOpen}
                className="-ml-1 rounded-[7px] p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none lg:hidden"
                onClick={() => setMobileOpen(true)}
              >
                <Menu className="size-5" strokeWidth={1.75} />
              </button>
              {!pathname.startsWith('/chat') ? <Breadcrumb pathname={pathname} /> : null}
              <div className="ml-auto flex items-center gap-1">
                <UserMenu username={me.data.username ?? 'admin'} />
              </div>
            </header>

            <main
              id="main-content"
              tabIndex={-1}
              className={cn('min-h-0 flex-1', pathname.startsWith('/chat') && 'overflow-hidden')}
            >
              <div
                className={cn(
                  'mx-auto w-full',
                  pathname.startsWith('/chat')
                    ? 'h-full'
                    : 'max-w-[1080px] px-4 pb-10 sm:px-6 lg:px-8',
                )}
              >
                <Outlet />
              </div>
            </main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const current = allNavItems.find((item) =>
    item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
  );
  return (
    <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="hidden text-subtle sm:inline">PACE</span>
      <ChevronRight
        className="hidden size-3 shrink-0 text-line-strong sm:inline"
        strokeWidth={1.75}
      />
      <span aria-current="page" className="truncate font-medium text-fg">
        {current?.title ?? '页面不存在'}
      </span>
    </nav>
  );
}
