import { timingSafeEqual } from 'node:crypto';

const WINDOW_MS = 300_000;

function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  const digest = new Bun.CryptoHasher('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: string,
): boolean {
  if (timestampHeader === undefined || signatureHeader === undefined) return false;
  if (!/^\d{10}$|^\d{13}$/.test(timestampHeader)) return false;
  const value = Number(timestampHeader);
  const timestampMs = timestampHeader.length === 13 ? value : value * 1000;
  if (Math.abs(Date.now() - timestampMs) > WINDOW_MS) return false;
  const expected = Buffer.from(signWebhook(secret, timestampHeader, rawBody));
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
