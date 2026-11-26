import { timingSafeEqual } from 'node:crypto';

export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
}

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
