import * as Bun from 'bun';

export function hashMcpToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('base64url');
}
