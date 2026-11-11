import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentHookFiles, agents } from '../schema.js';

export type AgentHookFileRow = typeof agentHookFiles.$inferSelect;

export async function listHookFiles(db: Database, agentId: string): Promise<AgentHookFileRow[]> {
  return db
    .select()
    .from(agentHookFiles)
    .where(eq(agentHookFiles.agentId, agentId))
    .orderBy(asc(agentHookFiles.path), asc(agentHookFiles.id));
}

/** 写入或覆盖同路径 hook 脚本（唯一键 agent_id+path）。 */
export async function upsertHookFile(
  db: Database,
  agentId: string,
  input: { path: string; content: string; executable: boolean },
): Promise<AgentHookFileRow> {
  const [row] = await db
    .insert(agentHookFiles)
    .values({ id: newId('agentHookFile'), agentId, ...input })
    .onConflictDoUpdate({
      target: [agentHookFiles.agentId, agentHookFiles.path],
      set: { content: input.content, executable: input.executable, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('hook file upsert returned no row');
  return row;
}

export async function deleteHookFile(
  db: Database,
  agentId: string,
  path: string,
): Promise<boolean> {
  const rows = await db
    .delete(agentHookFiles)
    .where(and(eq(agentHookFiles.agentId, agentId), eq(agentHookFiles.path, path)))
    .returning({ id: agentHookFiles.id });
  return rows.length > 0;
}

/** hooks 开关与配置写在 agents 行；null 表示未配置。 */
export async function updateHooksSettings(
  db: Database,
  agentId: string,
  settings: { enabled: boolean; config: Record<string, unknown> | null },
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({
      hooksEnabled: settings.enabled,
      hooksConfig: settings.config,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  return rows.length > 0;
}
