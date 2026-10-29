import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { userPreferences } from '../schema.js';

export type UserPreferenceRow = typeof userPreferences.$inferSelect;

export async function get(db: Database, userId: string): Promise<UserPreferenceRow | null> {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * 期望版本号匹配才写入，并把 revision 加一；不匹配返回 null（调用方据此报 409）。
 * expectedRevision=0 时行还不存在，条件更新落空后插入初始行。
 */
export async function upsertWithRevision(
  db: Database,
  userId: string,
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
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.revision, expectedRevision)))
    .returning();
  if (updated) return updated;
  if (expectedRevision !== 0) return null;

  const [inserted] = await db
    .insert(userPreferences)
    .values({ userId, content, revision: 1, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning();
  return inserted ?? null;
}
