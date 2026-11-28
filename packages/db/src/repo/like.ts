import { type Column, ilike, like, type SQL } from 'drizzle-orm';

export type LikePattern = string & { readonly __brand: 'LikePattern' };

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function containsPattern(value: string): LikePattern {
  return `%${escapeLike(value)}%` as LikePattern;
}

export function prefixPattern(value: string): LikePattern {
  return `${escapeLike(value)}%` as LikePattern;
}

export function ilikeContains(column: Column | SQL.Aliased | SQL, value: string): SQL {
  return ilike(column, containsPattern(value));
}

export function likePrefix(column: Column | SQL.Aliased | SQL, value: string): SQL {
  return like(column, prefixPattern(value));
}
