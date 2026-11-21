import type { CursorPage } from '@agentport/shared';
import { and, eq, gt, lt, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { DbHandle } from '../client.js';

export type { CursorPage };

export type KeysetTable = AnyPgTable & { id: AnyPgColumn };

export type CursorKind = 'timestamp' | 'text';

export function cursorValueSql(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const TIMESTAMP_CURSOR = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

export function isCanonicalTimestamp(value: string): boolean {
  const m = TIMESTAMP_CURSOR.exec(value);
  if (m === null) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

function encodeValueCursor(value: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: value, id }), 'utf8').toString('base64url');
}

function decodeValueCursor(raw: string, kind: CursorKind): { v: string; id: string } | null {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (Buffer.from(text, 'utf8').toString('base64url') !== raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, id } = parsed as { v?: unknown; id?: unknown };
  if (typeof v !== 'string' || typeof id !== 'string' || v === '' || id === '') return null;
  if (kind === 'timestamp' && !isCanonicalTimestamp(v)) return null;
  return { v, id };
}

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

export function paginate<T extends { id: string }>(
  rows: T[],
  limit: number,
  cursorOf?: (row: T) => string,
): CursorPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? (cursorOf?.(last) ?? last.id) : null,
  };
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
    valueCursor?: (row: NoInfer<T>) => string;
    cursorKind?: CursorKind;
  } & ({ table: KeysetTable; id?: never } | { table: AnyPgTable; id: AnyPgColumn }),
): Promise<CursorPage<T> | null> {
  const { table, cursor, limit, load, direction = 'desc', valueCursor } = options;
  const filters = options.where.filter((condition) => condition !== undefined);
  const id = options.id ?? (table as KeysetTable).id;
  if (cursor != null) {
    const column = options.column ?? (table as AnyPgTable & { createdAt: AnyPgColumn }).createdAt;
    if (valueCursor === undefined) {
      const [anchor] = await db
        .select({ id })
        .from(table)
        .where(and(...filters, eq(id, cursor)))
        .limit(1);
      if (!anchor) return null;
      filters.push(keysetBound(table, cursor, column, direction, id));
    } else {
      const kind = options.cursorKind ?? 'text';
      const decoded = decodeValueCursor(cursor, kind);
      if (decoded === null) return null;
      const [anchor] = await db
        .select({ id })
        .from(table)
        .where(and(...filters, eq(id, decoded.id)))
        .limit(1);
      if (!anchor) return null;
      const operator = direction === 'asc' ? sql.raw('>') : sql.raw('<');
      const value = kind === 'timestamp' ? sql`${decoded.v}::timestamptz` : sql`${decoded.v}`;
      filters.push(sql`(${column}, ${id}) ${operator} (${value}, ${decoded.id})`);
    }
  }
  const cursorOf =
    valueCursor === undefined ? undefined : (row: T) => encodeValueCursor(valueCursor(row), row.id);
  return paginate(await load({ where: and(...filters), limit: limit + 1 }), limit, cursorOf);
}
