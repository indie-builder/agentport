import type { KnowledgeBase } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { agentsQuery } from '../../lib/queries.js';
import { ErrorState, LoadingState } from '../states.js';

/**
 * `showTitle=false` 用于外层已用 PageSection 标题表达同一语义的分区，避免重复标签。
 */
export function ExpertUsage({
  base,
  enabled,
  showTitle = true,
}: {
  base: KnowledgeBase;
  enabled: boolean;
  showTitle?: boolean;
}) {
  const agents = useQuery({ ...agentsQuery, enabled });
  const used: Array<{ id: string; name: string }> = [];
  let unknown = 0;
  for (const agent of agents.data ?? []) {
    if (!agent.serverIds) {
      unknown += 1;
      continue;
    }
    if (agent.serverIds.includes(base.serverId)) used.push({ id: agent.id, name: agent.name });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {showTitle ? <span className="text-sm font-medium text-fg">使用此库的专家</span> : null}
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
        <div className="flex flex-col gap-1">
          <span className="text-sm text-fg">没有被任何专家使用</span>
          <span className="text-sm text-muted-foreground">在专家的能力配置中绑定此知识库。</span>
          <Link to="/agents" className="self-start text-xs text-fg underline underline-offset-2">
            选择专家
          </Link>
        </div>
      ) : null}
      {unknown > 0 ? (
        <span className="text-xs text-muted-foreground">部分专家的使用关系无法确认</span>
      ) : null}
    </div>
  );
}
