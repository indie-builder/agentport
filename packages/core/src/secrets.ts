import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export { SECRET_MASK } from '@agentport/shared';

const IV_LEN = 12;
const TAG_LEN = 16;

/** 从 APP_SECRET_KEY 派生固定 32 字节数据密钥；密钥格式变化时必须保持同一 info。 */
function deriveKey(keyB64url: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(keyB64url, 'utf8'), Buffer.alloc(0), 'agentport:secrets:v1', 32),
  );
}

/** 输出 base64url(iv || tag || ciphertext)，可直接存 text 列。 */
export function encryptSecrets(obj: Record<string, string>, keyB64url: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyB64url), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptSecrets(payload: string, keyB64url: string): Record<string, string> {
  const buf = Buffer.from(payload, 'base64url');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('secrets payload too short');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyB64url), buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  const plain = Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  const parsed: unknown = JSON.parse(plain.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('secrets payload is not an object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') throw new Error(`secret ${k} is not a string`);
    out[k] = v;
  }
  return out;
}
