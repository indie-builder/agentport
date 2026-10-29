import { describe, expect, it } from 'vitest';
import {
  evalSearchSchema,
  runDetailSearchSchema,
  runsSearchSchema,
} from '../src/routes/-search.js';

describe('shared search contract', () => {
  it('accepts the same run statuses on run detail filters as the runs list', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

    for (const status of statuses) {
      expect(runsSearchSchema.parse({ status })).toEqual({ status });
      expect(runDetailSearchSchema.parse({ fromStatus: status })).toEqual({ fromStatus: status });
    }

    expect(runDetailSearchSchema.parse({ fromStatus: 'unknown' })).toEqual({});
    expect(runsSearchSchema.parse({ status: 'unknown' })).toEqual({});
  });

  it('carries the originating run filters and step together', () => {
    expect(
      runDetailSearchSchema.parse({
        step: '3',
        fromAgent: 'agent_01m5bv0faceh4v4jtw00eta1sn',
        fromStatus: 'failed',
      }),
    ).toEqual({
      step: 3,
      fromAgent: 'agent_01m5bv0faceh4v4jtw00eta1sn',
      fromStatus: 'failed',
    });
    expect(runDetailSearchSchema.parse({ step: '-1' })).toEqual({});
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
