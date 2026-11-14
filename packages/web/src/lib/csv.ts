export function csvCell(value: unknown): string {
  const field = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `﻿${[header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n')}`;
}
