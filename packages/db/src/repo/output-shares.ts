import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { outputShares } from '../schema.js';

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

export async function findByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<OutputShareRow | null> {
  const [row] = await db
    .select()
    .from(outputShares)
    .where(and(eq(outputShares.tokenHash, tokenHash), active))
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
