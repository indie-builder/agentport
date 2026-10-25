import { openUiActionSchema } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

/**
 * 实时消息在本轮落库前没有持久化 id。动作必须仍能发出：
 * 表单值本身不依赖来源 id，卡在这里会让「收到 UI 立刻点按钮」直接失败。
 */
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
