import { describe, expect, it } from 'vitest';
import { runDetailSearchSchema } from '../src/routes/-search.js';

describe('shared search contract', () => {
  it('carries the backTo source URL and step together', () => {
    expect(
      runDetailSearchSchema.parse({
        step: '3',
        backTo: '/runs?agent=agent_01m5bv0faceh4v4jtw00eta1sn&status=failed',
      }),
    ).toEqual({
      step: 3,
      backTo: '/runs?agent=agent_01m5bv0faceh4v4jtw00eta1sn&status=failed',
    });
    expect(runDetailSearchSchema.parse({ step: '-1' })).toEqual({});
  });

  it('rejects backTo values that leave the site', () => {
    for (const backTo of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '//placeholder.invalid',
      '/\\placeholder.invalid',
      '/\\t/placeholder.invalid',
      '/ placeholder.invalid',
      'runs',
      '',
    ]) {
      expect(runDetailSearchSchema.parse({ backTo })).toEqual({});
    }
    expect(runDetailSearchSchema.parse({ backTo: `/${'a'.repeat(2048)}` })).toEqual({});
  });

  it('keeps in-site backTo links usable', () => {
    expect(runDetailSearchSchema.parse({ backTo: '/personal/usage?days=7&status=failed' })).toEqual(
      { backTo: '/personal/usage?days=7&status=failed' },
    );
  });
});
