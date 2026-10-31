import type { MemoryChange, MemoryContentSnapshot, MemoryReviewTarget } from '@agentport/shared';
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { memoryChanges } from '../schema.js';

export type MemoryChangeRow = typeof memoryChanges.$inferSelect;

export interface InsertMemoryChangeInput {
  businessId: string;
  agentId?: string | null;
  target: MemoryReviewTarget;
  before: MemoryContentSnapshot;
  after: MemoryContentSnapshot;
  sourceReviewRunId?: string | null;
  reversesChangeId?: string | null;
}

export async function insert(
  db: Database,
  input: InsertMemoryChangeInput,
): Promise<MemoryChangeRow> {
  const [row] = await db
    .insert(memoryChanges)
    .values({ id: newId('memoryChange'), ...input, state: 'applied' })
    .returning();
  if (!row) throw new Error('memory change insert returned no row');
  return row;
}

export async function find(db: Database, id: string): Promise<MemoryChangeRow | null> {
  const [row] = await db.select().from(memoryChanges).where(eq(memoryChanges.id, id)).limit(1);
  return row ?? null;
}

export async function remove(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .delete(memoryChanges)
    .where(eq(memoryChanges.id, id))
    .returning({ id: memoryChanges.id });
  return rows.length > 0;
}

/** 回滚崩溃恢复：同一被撤销变更只允许补记一次。 */
export async function findByReverses(
  db: Database,
  reversesChangeId: string,
): Promise<MemoryChangeRow | null> {
  const [row] = await db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.reversesChangeId, reversesChangeId))
    .limit(1);
  return row ?? null;
}

export async function listByUser(
  db: Database,
  businessId: string,
  limit = 50,
): Promise<MemoryChangeRow[]> {
  return db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.businessId, businessId))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(limit);
}

export async function listByAgent(
  db: Database,
  agentId: string,
  limit = 50,
): Promise<MemoryChangeRow[]> {
  return db
    .select()
    .from(memoryChanges)
    .where(eq(memoryChanges.agentId, agentId))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(limit);
}

export interface ListMemoryChangesOptions {
  agentId: string;
  kind: 'personal' | 'agent_memory' | 'agent_rule';
  slug?: string;
  before?: Date;
  limit: number;
}

/** 专家记忆/规则版本：按目标类型过滤，规则再按 slug 收窄。 */
export async function listFiltered(
  db: Database,
  options: ListMemoryChangesOptions,
): Promise<MemoryChangeRow[]> {
  const filters: SQL[] = [
    eq(memoryChanges.agentId, options.agentId),
    sql`${memoryChanges.target}->>'kind' = ${options.kind}`,
  ];
  if (options.slug !== undefined) {
    filters.push(sql`${memoryChanges.target}->>'slug' = ${options.slug}`);
  }
  if (options.before) filters.push(lt(memoryChanges.createdAt, options.before));
  return db
    .select()
    .from(memoryChanges)
    .where(and(...filters))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(options.limit);
}

export function toMemoryChange(row: MemoryChangeRow): MemoryChange {
  return {
    id: row.id,
    target: row.target,
    before: row.before,
    after: row.after,
    sourceReviewRunId: row.sourceReviewRunId,
    reversesChangeId: row.reversesChangeId,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
  };
}
