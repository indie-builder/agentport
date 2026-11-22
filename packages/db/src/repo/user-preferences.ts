import { and, eq, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { userPreferences } from '../schema.js';

export type UserPreferenceRow = typeof userPreferences.$inferSelect;

export async function get(db: Database, businessId: string): Promise<UserPreferenceRow | null> {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.businessId, businessId))
    .limit(1);
  return row ?? null;
}

export async function upsertWithRevision(
  db: DbHandle,
  businessId: string,
  content: string,
  expectedRevision: number,
): Promise<UserPreferenceRow | null> {
  const [updated] = await db
    .update(userPreferences)
    .set({
      content,
      revision: sql<number>`${userPreferences.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userPreferences.businessId, businessId),
        eq(userPreferences.revision, expectedRevision),
      ),
    )
    .returning();
  if (updated) return updated;
  if (expectedRevision !== 0) return null;

  const [inserted] = await db
    .insert(userPreferences)
    .values({ businessId, content, revision: 1, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning();
  return inserted ?? null;
}
