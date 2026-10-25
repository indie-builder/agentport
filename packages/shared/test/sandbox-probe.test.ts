import { describe, expect, it } from 'vitest';
import {
  limitToolCatalog,
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

  it('maps only the four contract fields and keeps exactly 1000 tools', () => {
    const inputSchema = { type: 'object', properties: { id: { type: 'integer' } } };
    const tools = Array.from({ length: 1000 }, (_, i) => ({
      name: `tool-${i}`,
      title: `Tool ${i}`,
      description: `description ${i}`,
      inputSchema,
      icons: [{ src: 'https://example.test/icon.png' }],
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
      _meta: { token: 'fixture-token' },
    }));

    const limited = limitToolCatalog(tools);

    expect(limited).toHaveLength(1000);
    for (const tool of limited) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'inputSchema', 'name', 'title']);
    }
    expect(JSON.stringify(limited)).not.toContain('fixture-token');
  });

  it('rejects more than 1000 tools', () => {
    const tools = Array.from({ length: 1001 }, (_, i) => ({ name: `tool-${i}` }));
    expect(() => limitToolCatalog(tools)).toThrow(/上限 1000/);
  });

  it('rejects a catalog over 1MiB by UTF-8 byte length', () => {
    // 「界」是 3 字节：13 万个字符约 39 万字节的 JSON，必然超过 1MiB。
    const tools = [{ name: 'huge', description: '界'.repeat(400_000) }];
    expect(() => limitToolCatalog(tools)).toThrow(/1048576/);
  });
});
