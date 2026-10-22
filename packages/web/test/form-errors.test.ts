import { httpUrlSchema } from '@agentport/shared';
import { expect, test } from 'vitest';
import { fieldErrors } from '../src/lib/form.js';

test('preserves actionable custom schema messages without exposing URL values', () => {
  const parsed = httpUrlSchema.safeParse('https://fixture-user:fixture-pass@example.com/mcp');
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const message = fieldErrors(parsed.error.issues).form;
  expect(message).toContain('URL不能包含账号密码');
  expect(message).toContain('headers');
  expect(message).not.toContain('fixture-pass');
});
