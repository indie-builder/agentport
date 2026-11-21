export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, normalize((v as Record<string, unknown>)[key])]),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(JSON.parse(JSON.stringify(value) ?? 'null')));
}
