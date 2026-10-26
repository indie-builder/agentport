import { describe, expect, it } from 'vitest';
import { schedulePatchSchema } from '../src/index.js';

describe('schedule PATCH schema', () => {
  it('does not inject create defaults for omitted fields', () => {
    const parsed = schedulePatchSchema.parse({ name: 'renamed' });
    expect(parsed).toEqual({ name: 'renamed' });
    // 省略 enabled 时不能被 default(true) 重新启用任务。
    expect(parsed).not.toHaveProperty('enabled');
  });

  it('keeps an explicit enabled value', () => {
    expect(schedulePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(schedulePatchSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });
});
