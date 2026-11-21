export function uniquePath(path: string, used: Set<string>, token: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const disambiguated =
    dot > 0 ? `${path.slice(0, dot)} [${token}]${path.slice(dot)}` : `${path} [${token}]`;
  used.add(disambiguated);
  return disambiguated;
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function assertCanonicalSegments(segments: readonly string[], message: string): void {
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      /%2f|%5c/i.test(segment)
    ) {
      throw new Error(message);
    }
  }
}

export function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, '-')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must never carry control chars
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}
