import { type Column, type SQL, sql } from 'drizzle-orm';

export const DEFAULT_LOG_TAIL_LIMIT = 64 * 1024;

export function logTailFields(options: {
  tailColumn: Column;
  truncatedColumn: Column;
  chunk: string;
  sourceTruncated?: boolean | undefined;
  limitBytes?: number | undefined;
}): { tail: SQL; truncated: SQL } {
  const limit = options.limitBytes ?? DEFAULT_LOG_TAIL_LIMIT;
  const sourceTruncated = options.sourceTruncated ?? false;
  const joined = sql`${options.tailColumn} || ${options.chunk}`;
  const slice = sql`substring(convert_to(${joined}, 'UTF8') from greatest(1, octet_length(convert_to(${joined}, 'UTF8')) - ${limit} + 1))`;
  return {
    tail: sql`(select convert_from(substring(tail.bytes from case
      when octet_length(tail.bytes) = 0 then 1
      when get_byte(tail.bytes, 0) < 128 or get_byte(tail.bytes, 0) >= 192 then 1
      when octet_length(tail.bytes) <= 1 then 2
      when get_byte(tail.bytes, 1) < 128 or get_byte(tail.bytes, 1) >= 192 then 2
      when octet_length(tail.bytes) <= 2 then 3
      when get_byte(tail.bytes, 2) < 128 or get_byte(tail.bytes, 2) >= 192 then 3
      else 4
    end), 'UTF8') from (select ${slice} as bytes) tail)`,
    truncated: sql`${options.truncatedColumn} or ${sourceTruncated} or octet_length(${joined}) > ${limit}`,
  };
}
