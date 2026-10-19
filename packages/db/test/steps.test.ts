import { describe, expect, it } from 'vitest';
import { toStep } from '../src/repo/runs.js';

const at = new Date('2026-10-20T00:00:00Z');

describe('toStep', () => {
  it('maps a user text message', () => {
    expect(toStep({ role: 'user', content: { text: 'hi' }, createdAt: at })).toEqual({
      kind: 'user',
      at: at.toISOString(),
      text: 'hi',
    });
  });

  it('maps an assistant text message', () => {
    expect(
      toStep({ role: 'assistant', content: { type: 'text', text: 'done' }, createdAt: at }),
    ).toEqual({ kind: 'assistant', at: at.toISOString(), text: 'done' });
  });

  it('maps a tool result message', () => {
    expect(
      toStep({
        role: 'tool',
        content: { type: 'tool_result', name: 'get_user', toolUseId: 't1', content: '{"id":1}' },
        createdAt: at,
      }),
    ).toEqual({
      kind: 'tool',
      at: at.toISOString(),
      name: 'get_user',
      toolUseId: 't1',
      content: '{"id":1}',
    });
  });

  it('maps a tool_use row to a tool step', () => {
    expect(
      toStep({
        role: 'tool',
        content: { type: 'tool_use', id: 't1', name: 'get_user', input: { id: '1' } },
        createdAt: at,
      }),
    ).toEqual({
      kind: 'tool',
      at: at.toISOString(),
      name: 'get_user',
      toolUseId: 't1',
      content: { id: '1' },
    });
  });

  it('tolerates missing tool name and id', () => {
    const step = toStep({ role: 'tool', content: { type: 'tool_result' }, createdAt: at });
    expect(step).toMatchObject({ kind: 'tool', name: null, toolUseId: null });
  });

  it('drops unrecognised rows instead of throwing', () => {
    expect(toStep({ role: 'system', content: {}, createdAt: at })).toBeNull();
    expect(toStep({ role: 'user', content: null, createdAt: at })).toBeNull();
  });
});
