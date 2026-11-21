import type { CursorPage } from '@agentport/shared';
import { and, eq, gt, lt, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../client.js';

export type { CursorPage };

export type KeysetTable = AnyPgTable & { id: AnyPgColumn };

export function keysetBound(
  table: KeysetTable,
  cursorId: string,
  column: AnyPgColumn,
  direction: 'asc' | 'desc',
): SQL;
export function keysetBound(
  table: AnyPgTable,
  cursorId: string,
  column: AnyPgColumn,
  direction: 'asc' | 'desc',
  id: AnyPgColumn,
): SQL;
export function keysetBound(
  table: AnyPgTable,
  cursorId: string,
  column: AnyPgColumn,
  direction: 'asc' | 'desc',
  id = (table as KeysetTable).id,
): SQL {
  if (column === id) return direction === 'asc' ? gt(id, cursorId) : lt(id, cursorId);
  const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
  return sql`(${column}, ${id}) ${operator} (
    select cursor.${sql.identifier(column.name)}, cursor.${sql.identifier(id.name)} from ${table} cursor
    where cursor.${sql.identifier(id.name)} = ${cursorId}
  )`;
}

export function keysetBefore(
  table: KeysetTable,
  cursorId: string,
  column: AnyPgColumn = (table as unknown as { createdAt: AnyPgColumn }).createdAt,
): SQL {
  return keysetBound(table, cursorId, column, 'desc');
}

export function paginate<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export async function keysetPage<T extends { id: string }>(
  db: DbHandle,
  options: {
    limit: number;
    cursor?: string | null | undefined;
    column?: AnyPgColumn;
    direction?: 'asc' | 'desc';
    where: (SQL | undefined)[];
    load: (args: { where: SQL | undefined; limit: number }) => Promise<T[]>;
  } & ({ table: KeysetTable; id?: never } | { table: AnyPgTable; id: AnyPgColumn }),
): Promise<CursorPage<T> | null> {
  const { table, cursor, limit, load, direction = 'desc' } = options;
  const filters = options.where.filter((condition) => condition !== undefined);
  if (cursor != null) {
    const id = options.id ?? (table as KeysetTable).id;
    const [anchor] = await db
      .select({ id })
      .from(table)
      .where(and(...filters, eq(id, cursor)))
      .limit(1);
    if (!anchor) return null;
    const column = options.column ?? (table as AnyPgTable & { createdAt: AnyPgColumn }).createdAt;
    filters.push(keysetBound(table, cursor, column, direction, id));
  }
  return paginate(await load({ where: and(...filters), limit: limit + 1 }), limit);
}
