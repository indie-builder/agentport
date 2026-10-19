import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Bot, LayoutDashboard, LogOut, MessagesSquare, Server } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { meQuery, queryClient } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Skeleton } from './ui/skeleton.js';

const nav = [
  { to: '/', label: '概览', icon: LayoutDashboard },
  { to: '/servers', label: 'MCP Servers', icon: Server },
  { to: '/agents', label: '智能体', icon: Bot },
  { to: '/chat', label: '对话', icon: MessagesSquare },
] as const;

export function AppShell() {
  const me = useQuery(meQuery);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (me.data && !me.data.authenticated) void navigate({ to: '/login' });
  }, [me.data, navigate]);

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <Skeleton className="h-6 w-40" />
      </div>
    );
  }

  if (me.isError || !me.data?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-400">
        {me.isError ? '无法验证登录状态' : '正在跳转登录…'}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="flex h-12 items-center gap-2 border-b border-zinc-800 px-4">
          <div className="size-2 rounded-full bg-emerald-500" />
          <span className="text-sm font-semibold tracking-tight">Agentport</span>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {nav.map(({ to, label, icon: Icon }) => {
            const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
                  active
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800 p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="truncate text-xs text-zinc-500">{me.data.username ?? 'admin'}</span>
            <Button
              variant="ghost"
              size="icon"
              title="退出登录"
              onClick={async () => {
                await api.logout();
                queryClient.clear();
                await navigate({ to: '/login' });
              }}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
