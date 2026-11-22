import { isAbsolute, resolve } from 'node:path';

const repoRoot = Bun.fileURLToPath(new URL('../../', import.meta.url));

export function storageDir(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}
