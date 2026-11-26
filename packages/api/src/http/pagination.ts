import { fail, INVALID_CURSOR_MESSAGE } from '@agentport/core';
import type { CursorPage } from '@agentport/db';

export function invalidCursor(): never {
  return fail('INVALID_INPUT', INVALID_CURSOR_MESSAGE, { path: '/cursor' });
}

export function requireCursorPage<T>(page: CursorPage<T> | null): CursorPage<T> {
  return page ?? invalidCursor();
}

export type PageQuery = { cursor?: string | undefined; limit?: number | undefined };

export function cursorOption(cursor: string | undefined): { cursor?: string } {
  return cursor === undefined ? {} : { cursor };
}

export function pageOptions(query: PageQuery): { cursor?: string; limit?: number } {
  return {
    ...cursorOption(query.cursor),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

export async function collectPages<T>(
  fetchPage: (options: { cursor?: string; limit?: number }) => Promise<CursorPage<T> | null>,
  limit = 200,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = requireCursorPage(await fetchPage({ limit, ...cursorOption(cursor) }));
    items.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
}
