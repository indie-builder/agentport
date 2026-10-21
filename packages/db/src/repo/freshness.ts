import { type AnyColumn, sql } from 'drizzle-orm';

/**
 * 乐观锁条件：行的 updated_at 与客户端回传的一致。
 * 原始 sql 无法用 builder 表达：Postgres 的 now() 带微秒，JS Date 只有毫秒，
 * 两边必须先截断到毫秒再比较，否则永远不相等。
 */
export function notStale(column: AnyColumn, expected: Date) {
  return sql`date_trunc('milliseconds', ${column}) = date_trunc('milliseconds', ${expected}::timestamptz)`;
}
