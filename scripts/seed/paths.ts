import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function storageDir(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}
