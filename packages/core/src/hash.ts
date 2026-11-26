import * as Bun from 'bun';

export function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}
