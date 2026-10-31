import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { conversations, outputShares } from '../schema.js';

export type OutputShareRow = typeof outputShares.$inferSelect;

export interface CreateOutputShareInput {
  conversationId: string;
  runId: string;
  path: string;
  sha256: string;
  tokenHash: string;
  tokenEncrypted: string;
}

export async function create(db: Database, input: CreateOutputShareInput): Promise<OutputShareRow> {
  const [row] = await db
    .insert(outputShares)
    .values({ id: newId('outputShare'), ...input })
    .returning();
  if (!row) throw new Error('output share insert returned no row');
  return row;
}

/** 撤销后的分享对公开访问一律不可见，查询默认只看未撤销行。 */
const active = isNull(outputShares.revokedAt);

export async function findActiveById(db: Database, id: string): Promise<OutputShareRow | null> {
  const [row] = await db
    .select()
    .from(outputShares)
    .where(and(eq(outputShares.id, id), active))
    .limit(1);
  return row ?? null;
}

/** 同一文件已有有效分享时复用，避免重复生成 token。 */
export async function findByTriple(
  db: Database,
  conversationId: string,
  runId: string,
  path: string,
): Promise<OutputShareRow | null> {
  const [row] = await db
    .select()
    .from(outputShares)
    .where(
      and(
        eq(outputShares.conversationId, conversationId),
        eq(outputShares.runId, runId),
        eq(outputShares.path, path),
        active,
      ),
    )
    .orderBy(desc(outputShares.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listByTriple(
  db: Database,
  conversationId: string,
  runId: string,
  path: string,
): Promise<OutputShareRow[]> {
  return db
    .select()
    .from(outputShares)
    .where(
      and(
        eq(outputShares.conversationId, conversationId),
        eq(outputShares.runId, runId),
        eq(outputShares.path, path),
      ),
    )
    .orderBy(desc(outputShares.createdAt), desc(outputShares.id));
}

export async function revoke(db: Database, id: string): Promise<OutputShareRow | null> {
  const [row] = await db
    .update(outputShares)
    .set({ revokedAt: new Date() })
    .where(and(eq(outputShares.id, id), active))
    .returning();
  return row ?? null;
}

/** 「我的分享」列表项：归属由来源会话本人判定，分享表自身没有创建者。 */
export interface PersonalOutputShareRow {
  id: string;
  conversationId: string;
  runId: string;
  path: string;
  sha256: string;
  tokenEncrypted: string;
  createdAt: Date;
  conversationTitle: string;
  agentId: string;
}

export interface PersonalOutputSharePage {
  items: PersonalOutputShareRow[];
  nextCursor: string | null;
}

const ownedBy = (businessId: string): SQL => eq(conversations.createdBy, businessId);

/**
 * 只列本人来源会话下未撤销的分享；按 (createdAt, id) 倒序翻页。
 * 游标必须落在同一 owner + 未撤销范围内，越界游标按找不到返回 null。
 */
export async function listActiveOwnedBy(
  db: Database,
  options: { businessId: string; cursor?: string; limit: number },
): Promise<PersonalOutputSharePage | null> {
  const filters: SQL[] = [ownedBy(options.businessId), active];
  if (options.cursor !== undefined) {
    const [anchor] = await db
      .select({ id: outputShares.id })
      .from(outputShares)
      .innerJoin(conversations, eq(conversations.id, outputShares.conversationId))
      .where(and(eq(outputShares.id, options.cursor), ...filters))
      .limit(1);
    if (!anchor) return null;
    filters.push(sql`(${outputShares.createdAt}, ${outputShares.id}) < (
      select cursor.created_at, cursor.id from ${outputShares} cursor
      where cursor.id = ${options.cursor}
    )`);
  }

  const rows = await db
    .select({
      id: outputShares.id,
      conversationId: outputShares.conversationId,
      runId: outputShares.runId,
      path: outputShares.path,
      sha256: outputShares.sha256,
      tokenEncrypted: outputShares.tokenEncrypted,
      createdAt: outputShares.createdAt,
      conversationTitle: conversations.title,
      agentId: conversations.agentId,
    })
    .from(outputShares)
    .innerJoin(conversations, eq(conversations.id, outputShares.conversationId))
    .where(and(...filters))
    .orderBy(desc(outputShares.createdAt), desc(outputShares.id))
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

/** 本人来源会话下的分享，含已撤销行；用于区分「已撤销」与「不存在/他人」。 */
export async function findOwnedById(
  db: Database,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  conversationId: string;
  runId: string;
  path: string;
  revokedAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: outputShares.id,
      conversationId: outputShares.conversationId,
      runId: outputShares.runId,
      path: outputShares.path,
      revokedAt: outputShares.revokedAt,
    })
    .from(outputShares)
    .innerJoin(conversations, eq(conversations.id, outputShares.conversationId))
    .where(and(eq(outputShares.id, id), ownedBy(businessId)))
    .limit(1);
  return row ?? null;
}

/** owner 条件写进同一条 UPDATE：不能把全局 revoke 当作个人撤销。 */
export async function revokeOwned(
  db: Database,
  businessId: string,
  id: string,
): Promise<OutputShareRow | null> {
  const [row] = await db
    .update(outputShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(outputShares.id, id),
        active,
        sql`exists (
          select 1 from ${conversations}
          where ${conversations.id} = ${outputShares.conversationId}
            and ${conversations.createdBy} = ${businessId}
        )`,
      ),
    )
    .returning();
  return row ?? null;
}
