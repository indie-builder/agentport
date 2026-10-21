import { timingSafeEqual } from 'node:crypto';

/** 取 `Authorization: Bearer <token>` 里的 token；头缺失或格式不对时为 undefined。 */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
}

/**
 * 常量时间比较。expected 为空视为未配置，一律不通过。
 * hash 用于 run 的短期 token：与存库的哈希比较。
 */
export function tokenMatches(
  expected: unknown,
  token: string | undefined,
  hash: (token: string) => string = (value) => value,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0 || token === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(hash(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
