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
