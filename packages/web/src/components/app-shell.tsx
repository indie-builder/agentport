import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Bot,
  ChevronRight,
  FlaskConical,
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
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

const nav = [
  { to: '/', label: '概览', icon: LayoutDashboard, title: '概览' },
  { to: '/servers', label: 'MCP Servers', icon: Server, title: 'MCP Servers' },
  { to: '/agents', label: '智能体', icon: Bot, title: '智能体' },
  { to: '/skills', label: '技能', icon: Sparkles, title: '技能' },
  { to: '/chat', label: '对话', icon: MessagesSquare, title: '对话' },
  { to: '/runs', label: '运行', icon: Activity, title: '运行' },
  { to: '/eval', label: '评估', icon: FlaskConical, title: '评估' },
  { to: '/audit', label: '审计', icon: ScrollText, title: '审计' },
] as const;

const COLLAPSE_KEY = 'agentport:nav-collapsed';

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const update = (next: boolean): void => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  };
  return [collapsed, update];
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      to="/"
      aria-label="PACE 首页"
      className={cn(
        'flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
        collapsed ? 'justify-center px-0' : 'px-5',
      )}
    >
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[4, 8, 12, 8].map((height, index) => (
          <span
            key={height}
            className={cn('w-[3px] rounded-sm', index === 2 ? 'bg-accent' : 'bg-line-strong')}
            style={{ height }}
          />
        ))}
      </span>
      {collapsed ? null : (
        <span className="text-[13px] font-semibold tracking-[0.08em] text-fg">PACE</span>
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
        'relative flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        collapsed ? 'justify-center px-0' : 'px-2.5',
        active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-subtle')} />
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
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
        className="flex h-8 items-center gap-2 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-2/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 text-muted">
          <User className="size-3" />
        </span>
        <span className="hidden max-w-32 truncate sm:block">{username}</span>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="用户菜单"
          className="absolute right-0 top-10 z-40 w-48 rounded-lg border border-line bg-surface p-1 shadow-xl shadow-black/40"
        >
          <div className="border-b border-line px-2.5 py-2">
            <div className="truncate text-xs text-fg">{username}</div>
            <div className="text-[11px] text-subtle">管理员</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  useEffect(() => {
    const current = nav.find((item) =>
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
        'flex h-full flex-col border-r border-line bg-canvas',
        drawer ? 'w-64' : collapsed ? 'w-14' : 'w-56',
      )}
    >
      <Brand collapsed={drawer ? false : collapsed} />
      <nav aria-label="主导航" className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {nav.map((item) => (
          <SidebarLink
            key={item.to}
            to={item.to}
            label={item.label}
            icon={item.icon}
            collapsed={drawer ? false : collapsed}
            onNavigate={drawer ? () => setMobileOpen(false) : undefined}
          />
        ))}
      </nav>
      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-pressed={collapsed}
          className={cn(
            'hidden h-8 items-center gap-2 rounded-md text-xs text-subtle transition-colors hover:bg-surface-2/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 md:flex',
            collapsed ? 'w-full justify-center' : 'w-full px-2',
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
    <div className="flex min-h-screen bg-canvas text-fg">
      <div className="sticky top-0 hidden h-screen shrink-0 md:block">{sidebar(false)}</div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="关闭导航"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导航"
            className="relative h-full w-64 border-r border-line bg-canvas shadow-2xl"
          >
            <button
              type="button"
              aria-label="关闭导航"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4 z-10 rounded-md p-1 text-subtle hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" />
            </button>
            {sidebar(true)}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur sm:px-8">
          <button
            type="button"
            aria-label="打开导航"
            className="-ml-1 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 md:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" />
          </button>
          <Breadcrumb pathname={pathname} />
          <div className="ml-auto flex items-center gap-1">
            <UserMenu username={me.data.username ?? 'admin'} />
          </div>
        </header>

        <main className="min-h-0 flex-1">
          <div
            className={cn(
              'mx-auto w-full max-w-[1200px] px-4 sm:px-8',
              pathname.startsWith('/chat') ? 'h-[calc(100vh-52px)] py-4' : 'py-8',
            )}
          >
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const current = nav.find((item) =>
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
