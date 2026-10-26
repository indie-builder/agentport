import { unionById } from '@agentport/core';
import { type Database, repo } from '@agentport/db';

/**
 * 父 + 启用子级绑定：一次查询按 owner 严格归属，并集按 server id 全局排序去重，
 * 保证每次 run 的 .mcp.json 内容与顺序稳定。排序与 API 预览/导出共用 core 的 helper。
 */
export async function loadRunServerBindings(
  db: Database,
  agentId: string,
  subAgentRows: Array<{ id: string; enabled: boolean }>,
) {
  const serversByAgent = await repo.agents.getBoundServersByAgentIds(db, [
    agentId,
    ...subAgentRows.filter((row) => row.enabled).map((row) => row.id),
  ]);
  const serverNamesByAgent = new Map(
    [...serversByAgent].map(([owner, rows]) => [owner, rows.map((row) => row.name)] as const),
  );
  // helper 按 agent 分组返回；工作区并集不能继承这个分组顺序。
  const serverRows = unionById([...serversByAgent.values()]);

  return { serverNamesByAgent, serverRows };
}
