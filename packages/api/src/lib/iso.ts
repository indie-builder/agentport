export function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
