import type { PublicRunQuestion } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { mergeToolSteps, toStep } from '../src/repo/runs.js';

const at = new Date('2026-10-20T00:00:00Z');

const question: PublicRunQuestion = {
  requestId: 'req-1',
  runId: 'run-1',
  toolUseId: 't-q',
  questions: [
    {
      question: '用哪种语言？',
      header: '语言',
      options: [
        { value: '0', label: 'TypeScript', description: '' },
        { value: '1', label: 'Python', description: '' },
      ],
      multiSelect: false,
    },
  ],
  status: 'answered',
  answers: { '0': 'TypeScript' },
  createdAt: at.toISOString(),
  resolvedAt: at.toISOString(),
  expiresAt: at.toISOString(),
  closeReason: null,
};

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
      // result 单独放 result；content 留给调用参数，由 mergeToolSteps 合并。
      content: null,
      result: '{"id":1}',
      parentToolUseId: null,
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
      parentToolUseId: null,
    });
  });

  it('keeps the sub-agent attribution on tool rows', () => {
    const step = toStep({
      role: 'tool',
      content: {
        type: 'tool_use',
        id: 't2',
        name: 'mcp__x__get_user',
        input: {},
        parentToolUseId: 'toolu_parent',
      },
      createdAt: at,
    });
    expect(step).toMatchObject({ kind: 'tool', parentToolUseId: 'toolu_parent' });
  });

  it('keeps the public question snapshot on both tool halves', () => {
    const use = toStep({
      role: 'tool',
      content: { type: 'tool_use', id: 't-q', name: 'AskUserQuestion', input: {}, question },
      createdAt: at,
    });
    const result = toStep({
      role: 'tool',
      content: {
        type: 'tool_result',
        toolUseId: 't-q',
        name: 'AskUserQuestion',
        content: 'ok',
        question,
      },
      createdAt: at,
    });
    expect(use).toMatchObject({ kind: 'tool', question });
    expect(result).toMatchObject({ kind: 'tool', question });
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

describe('mergeToolSteps', () => {
  const at = new Date('2026-10-20T00:00:00Z').toISOString();

  it('merges a tool_use and its tool_result into one step', () => {
    const use = toStep({
      role: 'tool',
      content: { type: 'tool_use', id: 't1', name: 'get_user', input: { id: '1' } },
      createdAt: new Date(at),
    });
    const result = toStep({
      role: 'tool',
      content: { type: 'tool_result', name: 'get_user', toolUseId: 't1', content: '{"id":1}' },
      createdAt: new Date(at),
    });
    expect(use).not.toBeNull();
    expect(result).not.toBeNull();
    const merged = mergeToolSteps([use, result].filter((step) => step !== null));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      kind: 'tool',
      content: { id: '1' },
      result: '{"id":1}',
    });
  });

  it('keeps unmergeable steps in their original order', () => {
    const user = { kind: 'user' as const, at, text: 'hi' };
    const orphan = {
      kind: 'tool' as const,
      at,
      name: 'x',
      toolUseId: null,
      content: 1,
      parentToolUseId: null,
    };
    const merged = mergeToolSteps([user, orphan]);
    expect(merged).toEqual([user, orphan]);
  });

  it('keeps the final question snapshot when the result arrives last', () => {
    const pending: PublicRunQuestion = { ...question, status: 'pending', answers: null };
    const use = toStep({
      role: 'tool',
      content: {
        type: 'tool_use',
        id: 't-q',
        name: 'AskUserQuestion',
        input: {},
        question: pending,
      },
      createdAt: new Date(at),
    });
    const result = toStep({
      role: 'tool',
      content: {
        type: 'tool_result',
        toolUseId: 't-q',
        name: 'AskUserQuestion',
        content: 'ok',
        question,
      },
      createdAt: new Date(at),
    });
    expect(use).not.toBeNull();
    expect(result).not.toBeNull();
    const merged = mergeToolSteps([use, result].filter((step) => step !== null));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ question: { status: 'answered' } });
  });

  it('does not mutate the input step order when result arrives first', () => {
    const result = toStep({
      role: 'tool',
      content: { type: 'tool_result', name: 'g', toolUseId: 't9', content: 'ok' },
      createdAt: new Date(at),
    });
    const use = toStep({
      role: 'tool',
      content: { type: 'tool_use', id: 't9', name: 'g', input: { a: 1 } },
      createdAt: new Date(at),
    });
    const merged = mergeToolSteps([result, use].filter((step) => step !== null));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ content: { a: 1 }, result: 'ok' });
  });
});
