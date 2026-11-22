const IV_LEN = 12;
const TAG_LEN = 16;
const INFO = new TextEncoder().encode('agentport:secrets:v1');

async function deriveKey(keyB64url: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyB64url),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecrets(
  obj: Record<string, string>,
  keyB64url: string,
): Promise<string> {
  const key = await deriveKey(keyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new TextEncoder().encode(JSON.stringify(obj)),
    ),
  );
  const ciphertext = encrypted.subarray(0, encrypted.length - TAG_LEN);
  const tag = encrypted.subarray(encrypted.length - TAG_LEN);
  const out = new Uint8Array(IV_LEN + TAG_LEN + ciphertext.length);
  out.set(iv, 0);
  out.set(tag, IV_LEN);
  out.set(ciphertext, IV_LEN + TAG_LEN);
  return Buffer.from(out).toString('base64url');
}

export async function decryptSecrets(
  payload: string,
  keyB64url: string,
): Promise<Record<string, string>> {
  const buf = Buffer.from(payload, 'base64url');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('secrets payload too short');
  const key = await deriveKey(keyB64url);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const data = new Uint8Array(ciphertext.length + TAG_LEN);
  data.set(ciphertext, 0);
  data.set(tag, ciphertext.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
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
