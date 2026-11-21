import { describe, expect, it } from 'bun:test';
import { schedulePatchSchema } from '../src/index.js';

describe('schedule PATCH schema', () => {
  it('does not inject create defaults for omitted fields', () => {
    const parsed = schedulePatchSchema.parse({ name: 'renamed' });
    expect(parsed).toEqual({ name: 'renamed' });
    expect(parsed).not.toHaveProperty('enabled');
  });

  it('keeps an explicit enabled value', () => {
    expect(schedulePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(schedulePatchSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });
});
