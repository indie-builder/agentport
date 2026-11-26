import type { KnowledgeBase } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { agentsQuery } from '../../lib/queries.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { buttonVariants } from '../ui/button.js';

export function ExpertUsage({ base }: { base: KnowledgeBase }) {
  const agents = useQuery(agentsQuery);
  const used: Array<{ id: string; name: string }> = [];
  let unknown = 0;
  for (const agent of agents.data?.items ?? []) {
    if (!agent.serverIds) {
      unknown += 1;
      continue;
    }
    if (agent.serverIds.includes(base.serverId)) used.push({ id: agent.id, name: agent.name });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {agents.isPending ? <LoadingState rows={2} /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {used.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {used.map((agent) => (
            <li key={agent.id} className="flex min-w-0 items-center justify-between gap-2">
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                search={{ tab: 'config', section: 'capability' }}
                className="min-w-0 truncate text-sm text-fg underline underline-offset-2"
              >
                {agent.name}
              </Link>
              <span className="shrink-0 text-sm text-muted-foreground">配置 · 能力</span>
            </li>
          ))}
        </ul>
      ) : null}
      {used.length > 0 ? (
        <Link to="/agents" className="self-start text-xs text-fg underline underline-offset-2">
          选择其他专家
        </Link>
      ) : null}
      {agents.isSuccess && used.length === 0 && unknown === 0 ? (
        <EmptyState
          variant="idle"
          scale="inline"
          icon={<Users aria-hidden="true" />}
          title="还没有专家绑定此知识库"
          description="在专家的能力配置中勾选此库即可启用检索。"
          action={
            <Link to="/agents" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              前往找专家
            </Link>
          }
        />
      ) : null}
      {unknown > 0 ? (
        <span className="text-xs text-muted-foreground">部分专家的使用关系无法确认</span>
      ) : null}
    </div>
  );
}
