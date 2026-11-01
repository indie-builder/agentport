import { describe, expect, it } from 'vitest';
import {
  evalSearchSchema,
  runDetailSearchSchema,
  runsSearchSchema,
} from '../src/routes/-search.js';

describe('shared search contract', () => {
  it('accepts the known run statuses on the runs list', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

    for (const status of statuses) {
      expect(runsSearchSchema.parse({ status })).toEqual({ status });
    }

    expect(runsSearchSchema.parse({ status: 'unknown' })).toEqual({});
  });

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

  it('keeps the selected run and comparison sides addressable in the eval URL', () => {
    expect(
      evalSearchSchema.parse({
        agent: 'agent-a',
        run: 'evalRun_01m5bv0faceh4v4jtw00eta1sn',
        base: 'evalRun_base',
        head: 'evalRun_head',
      }),
    ).toEqual({
      agent: 'agent-a',
      run: 'evalRun_01m5bv0faceh4v4jtw00eta1sn',
      base: 'evalRun_base',
      head: 'evalRun_head',
    });

    // 空 ID 不能表达“选中”，按未选中处理，避免用空参数请求详情。
    expect(evalSearchSchema.parse({ run: '', base: '', head: '' })).toEqual({});
    expect(evalSearchSchema.parse({ unknown: 'x' })).toEqual({});
  });
});
