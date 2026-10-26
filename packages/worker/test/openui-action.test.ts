import { describe, expect, it } from 'vitest';
import { promptWithOpenUiAction } from '../src/openui-action.js';

describe('promptWithOpenUiAction', () => {
  it('passes plain text messages through unchanged', () => {
    expect(promptWithOpenUiAction({ type: 'text', text: 'hello' }, 'fallback')).toBe('hello');
  });

  it('falls back to the queued prompt when the row has no text', () => {
    expect(promptWithOpenUiAction({ type: 'tool_result' }, 'queued prompt')).toBe('queued prompt');
  });

  it('appends context and form state as one controlled JSON block', () => {
    const prompt = promptWithOpenUiAction(
      [
        { type: 'text', text: 'Plan a trip to Paris' },
        {
          type: 'openui_action',
          context: { card: 'paris' },
          formState: { budget: 2500 },
          formName: 'trip-planner',
        },
      ],
      'ignored',
    );
    expect(prompt.startsWith('Plan a trip to Paris\n\n[openui_action] ')).toBe(true);
    const json = JSON.parse(prompt.slice(prompt.indexOf('[openui_action] ') + 16));
    expect(json).toEqual({
      context: { card: 'paris' },
      formState: { budget: 2500 },
      formName: 'trip-planner',
    });
  });

  it('passes the whole action context through instead of dropping it at 16KB', () => {
    const prompt = promptWithOpenUiAction(
      [
        { type: 'text', text: 'big' },
        { type: 'openui_action', context: { blob: 'x'.repeat(20_000) } },
      ],
      'fallback',
    );
    // 入口已按 64KB 拒绝超限动作；这里再截断会让模型读到半份上下文。
    expect(prompt).not.toContain('已省略');
    const json = JSON.parse(prompt.slice(prompt.indexOf('[openui_action] ') + 16));
    expect(json).toEqual({ context: { blob: 'x'.repeat(20_000) } });
  });

  it('keeps params verbatim when the action carries them', () => {
    const prompt = promptWithOpenUiAction(
      [
        { type: 'text', text: 'open' },
        { type: 'openui_action', params: { url: 'https://example.com' } },
      ],
      'fallback',
    );
    expect(prompt).toContain('https://example.com');
  });

  it('ignores a malformed action part', () => {
    expect(
      promptWithOpenUiAction([{ type: 'text', text: 'ok' }, { type: 'openui_action' }], 'x'),
    ).toBe('ok');
  });
});
