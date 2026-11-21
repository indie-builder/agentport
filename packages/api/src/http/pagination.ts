import { fail } from '@agentport/core';
import type { CursorPage } from '@agentport/db';

export function invalidCursor(): never {
  return fail('INVALID_INPUT', '分页游标无效，请刷新后重试', { path: '/cursor' });
}

export function requireCursorPage<T>(page: CursorPage<T> | null): CursorPage<T> {
  return page ?? invalidCursor();
}
