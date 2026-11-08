import type { KnowledgeBase } from '@agentport/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { agentAccessQuery, agentDetailQuery, agentsQuery } from '../lib/queries.js';
import { ErrorState, LoadingState } from './states.js';
import { Button } from './ui/button.js';

/**
 * 关系只在弹层或概览页签打开时查询。/api/agents 摘要没有绑定信息，必须逐个读 access，
 * 再只为拥有 agents.config.read 的专家取详情；读不到的专家标为无法确认，不当作未使用。
 *
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
  const agentIds = agents.data?.map((agent) => agent.id) ?? [];
  const accessQueries = useQueries({
    queries: agentIds.map((id) => ({ ...agentAccessQuery(id), enabled })),
  });
  const readableIds = agentIds.filter((_id, index) =>
    accessQueries[index]?.data?.permissionIds.includes('agents.config.read'),
  );
  const detailQueries = useQueries({
    queries: readableIds.map((id) => ({ ...agentDetailQuery(id), enabled })),
  });
  const detailById = new Map(readableIds.map((id, index) => [id, detailQueries[index]]));
  const pending =
    agents.isPending ||
    accessQueries.some((query) => query.isPending) ||
    detailQueries.some((query) => query.isPending);
  const failed = [
    ...accessQueries.filter((query) => query.isError),
    ...detailQueries.filter((query) => query.isError),
  ];
  const used: Array<{ id: string; name: string }> = [];
  let unknown = failed.length;
  (agents.data ?? []).forEach((agent, index) => {
    const access = accessQueries[index];
    if (access?.isError) return;
    if (!access?.data?.permissionIds.includes('agents.config.read')) {
      unknown += access?.isSuccess ? 1 : 0;
      return;
    }
    const detail = detailById.get(agent.id);
    if (detail?.isError) return;
    if (!detail?.data) return;
    if ((detail.data.serverIds ?? []).includes(base.serverId)) {
      used.push({ id: agent.id, name: agent.name });
    }
  });

  const retry = (): void => {
    for (const query of [...accessQueries, ...detailQueries]) {
      if (query.isError) void query.refetch();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {showTitle ? <span className="text-sm font-medium text-fg">使用此库的专家</span> : null}
      {agents.isPending || (pending && used.length === 0) ? <LoadingState rows={2} /> : null}
      {agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : null}
      {failed.length > 0 ? (
        <Button variant="link" size="xs" className="self-start" onClick={retry}>
          部分关系没有加载出来，重试
        </Button>
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
      {agents.isSuccess && used.length === 0 && unknown === 0 && !pending ? (
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
