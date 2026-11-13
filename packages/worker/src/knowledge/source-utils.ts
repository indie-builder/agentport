import { z } from 'zod';
import { makeSourceFailure } from './source-http.js';
import type { SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

export const sourceCursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

export function parseInitialCursor(
  cursor: Record<string, unknown> | undefined,
): z.infer<typeof sourceCursorSchema> | undefined {
  if (cursor === undefined || Object.keys(cursor).length === 0) return undefined;
  return sourceCursorSchema.parse(cursor);
}

export function parseCursor<T>(
  type: string,
  schema: z.ZodType<T>,
  cursor: Record<string, unknown> | undefined,
): T | undefined {
  // The DB column defaults to {}; that is "first sync", not a malformed cursor.
  if (cursor === undefined || Object.keys(cursor).length === 0) return undefined;
  const parsed = schema.safeParse(cursor);
  if (!parsed.success) {
    throw new Error(`invalid ${type} cursor; start from a cursor returned by readSource`);
  }
  return parsed.data;
}

export function snapshotOf(
  items: SourceItem[],
  failures: SourceFailure[],
  previous: ReturnType<typeof parseInitialCursor>,
): SourceSnapshot {
  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

export function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot + 1).toLowerCase();
}

export function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/** Human-facing link: encode each segment (`#`, `?`, spaces) but keep `/` as hierarchy. */
export function encodePathSegments(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

export function titleWithExtension(name: string, extension: string): string {
  return extensionOf(name) === extension.toLowerCase() ? name : `${name}.${extension}`;
}

/** 分页上限/空页仍未证明终页：单项失败，不能把截断内容当完整文档发布。 */
export class SourceTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceTruncatedError';
  }
}

export const failureOf = makeSourceFailure((err) => err instanceof SourceTruncatedError);
