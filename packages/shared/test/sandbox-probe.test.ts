import { describe, expect, it } from 'bun:test';
import {
  SANDBOX_PROBES_QUEUE,
  sandboxProbeJobSchema,
  sandboxProbeOutputSchema,
  sandboxProbeTaskSchema,
} from '../src/sandbox-probe.js';

describe('sandbox probe contracts', () => {
  it('uses a dedicated queue and requires a server id', () => {
    expect(SANDBOX_PROBES_QUEUE).toBe('sandbox-probes');
    expect(sandboxProbeJobSchema.parse({ serverId: 'srv_1' })).toEqual({ serverId: 'srv_1' });
    expect(sandboxProbeJobSchema.safeParse({ serverId: '' }).success).toBe(false);
    expect(sandboxProbeJobSchema.safeParse({}).success).toBe(false);
  });

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
