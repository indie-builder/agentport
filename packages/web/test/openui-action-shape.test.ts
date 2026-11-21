import { openUiActionSchema } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

describe('openUiActionSchema', () => {
  it('accepts an action without a persisted message id', () => {
    const parsed = openUiActionSchema.safeParse({
      type: 'continue_conversation',
      params: {},
      message: '提交',
      formState: { form: { a: 1 } },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.formState).toEqual({ form: { a: 1 } });
  });

  it('still rejects an empty message', () => {
    const parsed = openUiActionSchema.safeParse({
      type: 'continue_conversation',
      params: {},
      message: '',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a non-http url', () => {
    const parsed = openUiActionSchema.safeParse({
      type: 'open_url',
      params: { url: 'javascript:alert(1)' },
      message: '打开',
    });

    expect(parsed.success).toBe(false);
  });
});
