type StorageKind = 'local' | 'session';

function resolveStorage(kind: StorageKind): Storage {
  return kind === 'session' ? sessionStorage : localStorage;
}

export function readStorage(key: string, kind: StorageKind = 'local'): string | null {
  try {
    return resolveStorage(kind).getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string, kind: StorageKind = 'local'): void {
  try {
    resolveStorage(kind).setItem(key, value);
  } catch {}
}

export function removeStorage(key: string, kind: StorageKind = 'local'): void {
  try {
    resolveStorage(kind).removeItem(key);
  } catch {}
}

export function readJsonStorage<T>(key: string, fallback: T, kind: StorageKind = 'local'): T {
  const raw = readStorage(key, kind);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key: string, value: unknown, kind: StorageKind = 'local'): void {
  try {
    writeStorage(key, JSON.stringify(value), kind);
  } catch {}
}
