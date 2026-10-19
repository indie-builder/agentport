import type { Agent, AgentInput } from '@agentport/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentServers, agentSkills, agents, servers, skills } from '../schema.js';

export type AgentRow = typeof agents.$inferSelect;

export interface AgentWrite {
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPromptMd: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
  effort: string | null;
  maxThinkingTokens: number | null;
  enabled: boolean;
  maxTurns: number;
  /** numeric 列以字符串写入，避免浮点误差。 */
  maxBudgetUsd: string;
  timeoutMs: number;
}

/** DB 行 → 共享 Agent；所有字段映射只在这里做一次。 */
export function toAgent(row: AgentRow, serverIds: string[], skillIds: string[]): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    serverIds,
    skillIds,
    allowedTools: row.allowedTools,
    disallowedTools: row.disallowedTools,
    permissionMode: row.permissionMode as AgentInput['permissionMode'],
    maxTurns: row.maxTurns,
    maxBudgetUsd: Number(row.maxBudgetUsd),
    timeoutMs: row.timeoutMs,
    ...(row.effort === null ? {} : { effort: row.effort as NonNullable<AgentInput['effort']> }),
    ...(row.maxThinkingTokens === null ? {} : { maxThinkingTokens: row.maxThinkingTokens }),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  skillIds: string[],
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
    if (skillIds.length > 0) {
      await tx.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId })));
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
  skillIds?: string[],
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
    if (skillIds !== undefined) {
      await tx.delete(agentSkills).where(eq(agentSkills.agentId, id));
      if (skillIds.length > 0) {
        await tx.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId })));
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

export async function getAgentSkillIds(db: Database, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.skillId));
  return rows.map((row) => row.skillId);
}

export async function listAgentSkillIds(
  db: Database,
  agentIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ agentId: agentSkills.agentId, skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(inArray(agentSkills.agentId, agentIds))
    .orderBy(asc(agentSkills.agentId), asc(agentSkills.skillId));
  for (const row of rows) {
    const list = out.get(row.agentId);
    if (list) list.push(row.skillId);
    else out.set(row.agentId, [row.skillId]);
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

export async function getBoundSkills(
  db: Database,
  agentId: string,
): Promise<Array<typeof skills.$inferSelect>> {
  const rows = await db
    .select({ skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(skills.slug));
  return rows.map(({ skill }) => skill);
}
