import { z } from 'zod';
import type { SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

const sourceCursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

export function parseInitialCursor(
  cursor: Record<string, unknown> | undefined,
): z.infer<typeof sourceCursorSchema> | undefined {
  if (cursor === undefined || Object.keys(cursor).length === 0) return undefined;
  return sourceCursorSchema.parse(cursor);
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
