import { describe, expect, it } from 'bun:test';
import { sandboxProbeOutputSchema, sandboxProbeTaskSchema } from '../src/sandbox-probe.js';

describe('sandbox probe contracts', () => {
  it('validates the stdin task as stdio only and fills defaults', () => {
    expect(sandboxProbeTaskSchema.parse({ kind: 'stdio', command: 'node' })).toEqual({
      kind: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    expect(sandboxProbeTaskSchema.safeParse({ kind: 'http', command: 'node' }).success).toBe(false);
    expect(sandboxProbeTaskSchema.safeParse({ kind: 'stdio', command: '' }).success).toBe(false);
  });

  it('accepts a failure line without tools or duration', () => {
    expect(sandboxProbeOutputSchema.parse({ ok: false, error: 'boom' })).toEqual({
      ok: false,
      tools: [],
      error: 'boom',
    });
    expect(sandboxProbeOutputSchema.safeParse({ ok: true, tools: 'nope' }).success).toBe(false);
  });
});
