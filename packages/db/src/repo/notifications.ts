import type { NotificationKind } from '@agentport/shared';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { notifications } from '../schema.js';
import { keysetBefore, paginate } from './keyset.js';

export type NotificationRow = typeof notifications.$inferSelect;

export interface CreateNotificationInput {
  businessId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  sourceId: string;
}

export async function createNotification(
  db: DbHandle,
  input: CreateNotificationInput,
): Promise<void> {
  await db
    .insert(notifications)
    .values({ id: newId('notification'), ...input })
    .onConflictDoNothing();
}

export async function createScheduleFailedNotification(
  db: DbHandle,
  input: { businessId: string; scheduleId: string; runId: string; title: string; body: string },
): Promise<void> {
  await createNotification(db, {
    businessId: input.businessId,
    kind: 'schedule_failed',
    title: input.title,
    body: input.body,
    link: '/schedules',
    sourceId: `schedule-failed:${input.scheduleId}:${input.runId}`,
  });
}

export async function listNotifications(
  db: Database,
  input: { businessId: string; unreadOnly: boolean; cursor?: string; limit: number },
): Promise<{ items: NotificationRow[]; nextCursor: string | null } | null> {
  const filters = [eq(notifications.businessId, input.businessId)];
  if (input.cursor !== undefined) {
    const [anchor] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.id, input.cursor), ...filters))
      .limit(1);
    if (!anchor) return null;
    filters.push(keysetBefore(notifications, input.cursor));
  }
  if (input.unreadOnly) filters.push(isNull(notifications.readAt));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(input.limit + 1);
  return paginate(rows, input.limit);
}

export async function countNotificationsByKindSince(
  db: DbHandle,
  kind: NotificationKind,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(distinct ${notifications.sourceId})::int` })
    .from(notifications)
    .where(and(eq(notifications.kind, kind), gte(notifications.createdAt, since)));
  return row?.total ?? 0;
}

export async function unreadCount(db: Database, businessId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.businessId, businessId), isNull(notifications.readAt)));
  return Number(row?.total ?? 0);
}

export async function markRead(db: Database, businessId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), eq(notifications.businessId, businessId)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markBySource(
  db: DbHandle,
  kind: NotificationKind,
  sourceId: string,
): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.kind, kind),
        eq(notifications.sourceId, sourceId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

export async function markAllRead(db: Database, businessId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.businessId, businessId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
