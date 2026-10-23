import { AppError } from '@agentport/core';
import type { Agent } from '@agentport/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { agentVersions } from '../schema.js';

export type AgentVersionRow = typeof agentVersions.$inferSelect;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface AgentVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdAt: string;
}

/** 事务内写入快照；版本号靠 (agent_id, version) 唯一约束兜底并发。 */
export async function insertAgentVersion(
  tx: Tx,
  agentId: string,
  snapshot: Agent,
  note: string | null = null,
): Promise<void> {
  const [last] = await tx
    .select({ max: sql<number | null>`max(${agentVersions.version})` })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId));
  await tx.insert(agentVersions).values({
    id: newId('agentVersion'),
    agentId,
    version: (last?.max ?? 0) + 1,
    snapshot,
    note,
  });
}

function isVersionConflict(err: unknown): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint' in cause &&
      cause.constraint === 'agent_versions_agent_version_idx'
    ) {
      return true;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/** 并发下两个事务可能读到同一个 max；唯一约束冲突时整段事务重试一次。 */
export async function retryOnVersionConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isVersionConflict(err)) throw err;
    try {
      return await run();
    } catch (retryErr) {
      if (!isVersionConflict(retryErr)) throw retryErr;
      // 版本冲突可重试：调用方重新读最新版本再写。
      throw new AppError('CONFLICT', 'agent version conflict, retry later', { retryable: true });
    }
  }
}

export async function listAgentVersions(
  db: Database,
  agentId: string,
): Promise<AgentVersionSummary[]> {
  const rows = await db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      note: agentVersions.note,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** 最新快照版本号；智能体尚无快照时返回 null。 */
export async function latestAgentVersion(
  db: Database | Tx,
  agentId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${agentVersions.version})` })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId));
  return row?.max ?? null;
}

export async function getAgentVersion(
  db: Database,
  agentId: string,
  version: number,
): Promise<AgentVersionRow | null> {
  const [row] = await db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)))
    .limit(1);
  return row ?? null;
}
