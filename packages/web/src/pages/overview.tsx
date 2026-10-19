import { Link } from '@tanstack/react-router';
import { ArrowRight, Bot, MessagesSquare, Server } from 'lucide-react';
import { PageHeader } from '../components/page.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Card, CardContent } from '../components/ui/card.js';
import { useAgents, useServers } from '../lib/queries.js';

const links = [
  {
    to: '/servers',
    label: 'MCP Servers',
    description: '接入 stdio / HTTP，或把 HTTP API 包装成 MCP',
    icon: Server,
  },
  {
    to: '/agents',
    label: 'Agents',
    description: '配置 prompt、模型与绑定的 MCP Servers',
    icon: Bot,
  },
  {
    to: '/chat',
    label: 'Chat',
    description: '选择 agent 发起一次带工具的对话',
    icon: MessagesSquare,
  },
] as const;

function Stat({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-xs text-zinc-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-100">{value}</div>
        <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const servers = useServers();
  const agents = useAgents();

  const error = servers.error ?? agents.error;
  const loading = servers.isPending || agents.isPending;
  const retry = () => {
    void servers.refetch();
    void agents.refetch();
  };

  return (
    <div>
      <PageHeader title="概览" description="Agentport 运行状态与快捷入口" />
      {error ? <ErrorState error={error} onRetry={retry} /> : null}
      {loading ? <LoadingState rows={2} /> : null}
      {!loading && !error ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="MCP Servers" value={servers.data?.length ?? 0} hint="已注册的 MCP Server" />
          <Stat label="Agents" value={agents.data?.length ?? 0} hint="可调用的智能体" />
        </div>
      ) : null}
      {!loading && !error && servers.data?.length === 0 && agents.data?.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500">
          还没有任何配置，从{' '}
          <Link to="/servers" className="text-emerald-400">
            MCP Servers
          </Link>{' '}
          开始。
        </p>
      ) : null}
      <div className="mt-6 grid gap-2 sm:grid-cols-3">
        {links.map(({ to, label, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
          >
            <div className="flex items-center justify-between">
              <Icon className="size-4 text-zinc-400" />
              <ArrowRight className="size-3.5 text-zinc-600 group-hover:text-zinc-400" />
            </div>
            <div className="mt-2 text-sm font-medium text-zinc-200">{label}</div>
            <div className="mt-0.5 text-xs text-zinc-500">{description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
