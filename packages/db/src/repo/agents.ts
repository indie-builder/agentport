import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentServers, agents, servers } from '../schema.js';

export type AgentRow = typeof agents.$inferSelect;

export interface AgentWrite {
  slug: string;
  name: string;
  model: string;
  systemPromptMd: string;
  maxTurns: number;
  /** numeric 列以字符串写入，避免浮点误差。 */
  maxBudgetUsd: string;
  timeoutMs: number;
}

export async function listAgents(db: Database): Promise<AgentRow[]> {
  return db.select().from(agents).orderBy(asc(agents.createdAt), asc(agents.id));
}

export async function getAgent(db: Database, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}

export async function createAgent(
  db: Database,
  input: AgentWrite,
  serverIds: string[],
): Promise<AgentRow> {
  const id = newId('agent');
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(agents)
      .values({ id, ...input })
      .returning();
    if (serverIds.length > 0) {
      await tx
        .insert(agentServers)
        .values(serverIds.map((serverId) => ({ agentId: id, serverId })));
    }
    return inserted;
  });
  if (!row) throw new Error('agent insert returned no row');
  return row;
}

export async function updateAgent(
  db: Database,
  id: string,
  patch: Partial<AgentWrite>,
  serverIds?: string[],
): Promise<AgentRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning();
    if (!row) return null;
    if (serverIds !== undefined) {
      await tx.delete(agentServers).where(eq(agentServers.agentId, id));
      if (serverIds.length > 0) {
        await tx
          .insert(agentServers)
          .values(serverIds.map((serverId) => ({ agentId: id, serverId })));
      }
    }
    return row;
  });
}

export async function deleteAgent(db: Database, id: string): Promise<boolean> {
  const rows = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
  return rows.length > 0;
}

export async function getAgentServerIds(db: Database, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ serverId: agentServers.serverId })
    .from(agentServers)
    .where(eq(agentServers.agentId, agentId))
    .orderBy(asc(agentServers.serverId));
  return rows.map((row) => row.serverId);
}

/** 一次取回多个 agent 的绑定关系，列表接口避免 N+1。 */
export async function listAgentServerIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentServers.agentId, serverId: agentServers.serverId })
    .from(agentServers)
    .where(inArray(agentServers.agentId, agentIds))
    .orderBy(asc(agentServers.agentId), asc(agentServers.serverId));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.serverId);
    else out.set(row.agentId, [row.serverId]);
  }
  return out;
}

export async function getBoundServers(
  db: Database,
  agentId: string,
): Promise<Array<typeof servers.$inferSelect>> {
  const rows = await db
    .select({ server: servers })
    .from(agentServers)
    .innerJoin(servers, eq(agentServers.serverId, servers.id))
    .where(eq(agentServers.agentId, agentId))
    .orderBy(asc(agentServers.serverId));
  return rows.map(({ server }) => server);
}
