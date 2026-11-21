import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

export function keysetBound(
  table: AnyPgTable & { id: AnyPgColumn },
  cursorId: string,
  column: AnyPgColumn,
  direction: 'asc' | 'desc',
): SQL {
  const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
  return sql`(${column}, ${table.id}) ${operator} (
    select cursor.${sql.raw(column.name)}, cursor.id from ${table} cursor
    where cursor.id = ${cursorId}
  )`;
}

export function keysetBefore(
  table: AnyPgTable & { id: AnyPgColumn },
  cursorId: string,
  column: AnyPgColumn = (table as unknown as { createdAt: AnyPgColumn }).createdAt,
): SQL {
  return keysetBound(table, cursorId, column, 'desc');
}

export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
