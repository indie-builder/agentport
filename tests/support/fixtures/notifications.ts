import { newId } from '../../../packages/db/src/index.js';
import type { NotificationKind } from '../../../packages/shared/src/notifications.js';
import { client as sql } from './database.js';

export interface SeededNotification {
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
}

const SOURCE_PREFIX = 'e2e-notification-';

export async function seed(
  businessId: string,
  items: readonly SeededNotification[],
): Promise<string[]> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const rows = items.map((item, index) => ({
    item,
    id: newId('notification'),
    sourceId: `${SOURCE_PREFIX}${suffix}-${index}`,
    createdAt: new Date(createdAt - index * 1_000),
  }));
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`insert into notifications (id, business_id, kind, title, body, link, source_id, created_at)
        values (${row.id}, ${businessId}, ${row.item.kind}, ${row.item.title}, ${row.item.body ?? ''}, ${row.item.link ?? '/notifications'}, ${row.sourceId}, ${row.createdAt})`;
    }
  });
  return rows.map((row) => row.id);
}

export async function list(businessId: string) {
  return sql<
    { id: string; kind: string; title: string; read_at: Date | null }[]
  >`select id, kind, title, read_at from notifications where business_id = ${businessId} order by created_at desc, id desc`;
}

export async function readState(id: string): Promise<Date | null> {
  const rows = await sql<
    { read_at: Date | null }[]
  >`select read_at from notifications where id = ${id}`;
  return rows[0]?.read_at ?? null;
}

export async function cleanup(targets: {
  ids?: readonly string[];
  businessIds?: readonly string[];
}): Promise<void> {
  if (targets.ids !== undefined && targets.ids.length > 0) {
    await sql`delete from notifications where id = any(${sql.array([...targets.ids], 'TEXT')}::text[]) and source_id like ${`${SOURCE_PREFIX}%`}`;
  }
  if (targets.businessIds !== undefined && targets.businessIds.length > 0) {
    await sql`delete from notifications where business_id = any(${sql.array([...targets.businessIds], 'TEXT')}::text[]) and source_id like ${`${SOURCE_PREFIX}%`}`;
  }
}
