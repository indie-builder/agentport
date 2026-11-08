import {
  INDEX_FILE_NAME,
  type MemoryChange,
  type MemoryContentSnapshot,
  type MemoryReviewTarget,
} from '@agentport/shared';
import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { memoryChanges } from '../schema.js';

export type MemoryChangeRow = typeof memoryChanges.$inferSelect;

export interface InsertMemoryChangeInput {
  /** 手工写入预分配的稳定操作身份；缺省由仓储生成。 */
  id?: string;
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
  const { id = newId('memoryChange'), ...values } = input;
  const [row] = await db
    .insert(memoryChanges)
    .values({ id, ...values, state: 'applied' })
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

/** 个人记忆版本：同一 businessId 也会作为操作者写入专家记忆/规则，必须按目标类型收窄。 */
export async function listPersonalByUser(
  db: Database,
  businessId: string,
  options: { before?: Date; limit: number },
): Promise<MemoryChangeRow[]> {
  const filters: SQL[] = [
    eq(memoryChanges.businessId, businessId),
    sql`${memoryChanges.target}->>'kind' = 'personal'`,
  ];
  if (options.before) filters.push(lt(memoryChanges.createdAt, options.before));
  return db
    .select()
    .from(memoryChanges)
    .where(and(...filters))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(options.limit);
}

export interface MemoryChangeFilterOptions {
  agentId: string;
  kind: 'personal' | 'agent_memory' | 'agent_rule';
  slug?: string;
  /** 专家记忆文件名；在 LIMIT 之前按目标名收窄。 */
  name?: string;
  /** MEMORY.md 的历史还包含实际改动了伴随索引的主题变更。 */
  includeIndexChanges?: boolean;
  before?: Date;
}

export interface ListMemoryChangesOptions extends MemoryChangeFilterOptions {
  limit: number;
}

/** 列表、计数与按文件归并都必须复用同一组过滤条件，避免口径漂移。 */
function changeFilters(options: MemoryChangeFilterOptions): SQL[] {
  const filters: SQL[] = [
    eq(memoryChanges.agentId, options.agentId),
    sql`${memoryChanges.target}->>'kind' = ${options.kind}`,
  ];
  if (options.slug !== undefined) {
    filters.push(sql`${memoryChanges.target}->>'slug' = ${options.slug}`);
  }
  if (options.name !== undefined) {
    const ownTarget = sql`${memoryChanges.target}->>'name' = ${options.name}`;
    if (options.includeIndexChanges) {
      filters.push(
        or(
          ownTarget,
          sql`${memoryChanges.before}->'index' IS DISTINCT FROM ${memoryChanges.after}->'index'`,
        ) as SQL,
      );
    } else {
      filters.push(ownTarget);
    }
  }
  if (options.before) filters.push(lt(memoryChanges.createdAt, options.before));
  return filters;
}

/** 专家记忆/规则版本：按目标类型过滤，规则再按 slug、记忆按文件名收窄。 */
export async function listFiltered(
  db: Database,
  options: ListMemoryChangesOptions,
): Promise<MemoryChangeRow[]> {
  return db
    .select()
    .from(memoryChanges)
    .where(and(...changeFilters(options)))
    .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
    .limit(options.limit);
}

/** 与 listFiltered 同源的计数：不受 LIMIT 影响，用于概览里的真实总数。 */
export async function countFiltered(
  db: Database,
  options: MemoryChangeFilterOptions,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(memoryChanges)
    .where(and(...changeFilters(options)));
  return row?.total ?? 0;
}

/**
 * 每个目标文件最近一次平台写入时间：一次 group by 取代「取最近 N 条再在内存归并」，
 * 不会因为历史条数增长而把较早的记账误判成未记账。
 * 主题变更若同时改动了伴随索引，也把这次时间记到 MEMORY.md 上。
 */
export async function latestCreatedAtByTarget(
  db: Database,
  agentId: string,
  kind: MemoryChangeFilterOptions['kind'],
): Promise<Map<string, Date>> {
  const rows = await db.execute<{ name: string | null; latest: Date | string }>(sql`
    select entries.name as name, max(entries.created_at) as latest
    from (
      select ${memoryChanges.target}->>'name' as name, ${memoryChanges.createdAt} as created_at
      from ${memoryChanges}
      where ${memoryChanges.agentId} = ${agentId}
        and ${memoryChanges.target}->>'kind' = ${kind}
      union all
      select ${INDEX_FILE_NAME}::text as name, ${memoryChanges.createdAt} as created_at
      from ${memoryChanges}
      where ${memoryChanges.agentId} = ${agentId}
        and ${memoryChanges.target}->>'kind' = ${kind}
        and ${memoryChanges.before}->'index' IS DISTINCT FROM ${memoryChanges.after}->'index'
    ) entries
    group by entries.name
  `);
  const latest = new Map<string, Date>();
  for (const row of rows) {
    if (row.name === null) continue;
    latest.set(row.name, row.latest instanceof Date ? row.latest : new Date(row.latest));
  }
  return latest;
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
