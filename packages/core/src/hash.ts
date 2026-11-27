import * as Bun from 'bun';

export function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export function hashMcpToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('base64url');
}
