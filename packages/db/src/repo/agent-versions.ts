import { AppError } from '@agentport/core';
import type { Agent } from '@agentport/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import { agentVersions } from '../schema.js';
import { isPgConstraint } from './pg-errors.js';

export type AgentVersionRow = typeof agentVersions.$inferSelect;

export interface AgentVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdAt: string;
}

/** 事务内写入快照；版本号靠 (agent_id, version) 唯一约束兜底并发。 */
export async function insertAgentVersion(
  tx: Transaction,
  agentId: string,
  snapshot: Agent,
  note: string | null = null,
): Promise<void> {
  await tx.insert(agentVersions).values({
    id: newId('agentVersion'),
    agentId,
    // 版本号在 INSERT 内计算，少一次往返；并发仍由唯一约束兜底。
    version: sql`(select coalesce(max(${agentVersions.version}), 0) + 1 from ${agentVersions} where ${agentVersions.agentId} = ${agentId})`,
    snapshot,
    note,
  });
}

function isVersionConflict(err: unknown): boolean {
  return isPgConstraint(err, ['23505'], 'agent_versions_agent_version_idx');
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
export async function latestAgentVersion(db: DbHandle, agentId: string): Promise<number | null> {
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
