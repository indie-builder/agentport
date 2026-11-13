import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

export function keysetBefore(
  table: AnyPgTable & { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursorId: string,
): SQL {
  return sql`(${table.createdAt}, ${table.id}) < (
    select cursor.created_at, cursor.id from ${table} cursor
    where cursor.id = ${cursorId}
  )`;
}

export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
