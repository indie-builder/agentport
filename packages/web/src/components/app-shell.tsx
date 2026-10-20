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
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

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
  return (
    <Link
      to={to}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
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
}

function UserMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    // 打开后把焦点交给菜单项；返回时随卸载回到触发器。
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const logout = async (): Promise<void> => {
    setOpen(false);
    await api.logout().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 items-center gap-2 rounded-[2px] px-2 text-xs text-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-sunken text-muted">
          <User className="size-3" />
        </span>
        <span className="hidden max-w-32 truncate sm:block">{username}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="用户菜单"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-10 z-40 w-48 rounded-[3px] border border-line bg-surface p-1 shadow-overlay"
        >
          <div className="border-b border-line px-2.5 py-2">
            <div className="truncate text-xs text-fg">{username}</div>
            <div className="text-2xs text-subtle">管理员</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="mt-1 flex w-full items-center gap-2 rounded-[2px] px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg"
            onClick={() => void logout()}
          >
            <LogOut className="size-3.5" />
            退出登录
          </button>
        </div>
      ) : null}
    </div>
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

  // 路由变化后关闭抽屉与用户菜单，避免遮住新页面。
  useEffect(() => {
    setMobileOpen(false);
  }, []);

  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // 抽屉是模态的：焦点进入、Tab 循环、Esc 关闭并归还到触发按钮。
  useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

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
            <PanelLeftOpen className="size-4" />
          ) : (
            <>
              <PanelLeftClose className="size-4" />
              <span>收起侧栏</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );

  return (
    <div className="h-screen bg-canvas p-1 text-fg">
      <a href="#main-content" className="skip-link">
        跳到主要内容
      </a>

      {/* 外壳：参考页的核心结构——16px 圆角的白色容器承载全部内容。 */}
      <div className="flex h-full overflow-hidden rounded-[16px] bg-surface">
        <div className="hidden shrink-0 lg:block">{sidebar(false)}</div>

        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="关闭导航"
              tabIndex={-1}
              className="absolute inset-0 bg-scrim"
              onClick={() => setMobileOpen(false)}
            />
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="导航"
              className="relative h-full w-[310px] bg-surface shadow-overlay"
            >
              <button
                type="button"
                aria-label="关闭导航"
                onClick={() => {
                  setMobileOpen(false);
                  menuButtonRef.current?.focus();
                }}
                className="absolute right-3 top-4 z-10 rounded-[7px] p-1.5 text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
              {sidebar(true)}
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶部只有一行：页面名 + 用户。参考页也是如此，没有标题区与面包屑堆叠。 */}
          <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
            <button
              ref={menuButtonRef}
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
  );
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const current = allNavItems.find((item) =>
    item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
  );
  return (
    <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="hidden text-subtle sm:inline">PACE</span>
      <ChevronRight className="hidden size-3 shrink-0 text-line-strong sm:inline" />
      <span aria-current="page" className="truncate font-medium text-fg">
        {current?.title ?? '页面不存在'}
      </span>
    </nav>
  );
}
