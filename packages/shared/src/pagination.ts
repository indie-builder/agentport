import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const ADMIN_PAGE_LIMIT_MAX = 200;
export const CURSOR_MAX_LENGTH = 16384;

export function cursorQuerySchema(options?: { max?: number }) {
  return z.object({
    cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(options?.max ?? PAGE_LIMIT_MAX)
      .default(PAGE_LIMIT_DEFAULT),
  });
}

export const pageQuerySchema = cursorQuerySchema();
export const adminPageQuerySchema = cursorQuerySchema({ max: ADMIN_PAGE_LIMIT_MAX });

export function offsetQuerySchema(options?: { max?: number }) {
  return z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(options?.max ?? PAGE_LIMIT_MAX)
      .default(PAGE_LIMIT_DEFAULT),
    offset: z.coerce.number().int().min(0).default(0),
  });
}

export function cursorPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() });
}

export function offsetPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ items: z.array(itemSchema), total: z.number().int() });
}

export type CursorPage<T> = z.infer<ReturnType<typeof cursorPageSchema<z.ZodType<T>>>>;
export type OffsetPage<T> = z.infer<ReturnType<typeof offsetPageSchema<z.ZodType<T>>>>;

type WebGlobals = {
  TextEncoder: new () => { encode: (input: string) => Uint8Array };
  TextDecoder: new () => { decode: (input: Uint8Array) => string };
  btoa: (input: string) => string;
  atob: (input: string) => string;
};

const { TextEncoder, TextDecoder, btoa, atob } = globalThis as unknown as WebGlobals;

function toBase64Url(text: string): string {
  const binary = Array.from(new TextEncoder().encode(text), (byte) =>
    String.fromCharCode(byte),
  ).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeCursor(parts: readonly string[]): string {
  return toBase64Url(JSON.stringify(parts));
}

export function decodeCursor(cursor: string, expectedParts: number): string[] | null {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (toBase64Url(text) !== cursor) return null;
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) &&
      parsed.length === expectedParts &&
      parsed.every((part) => typeof part === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}
