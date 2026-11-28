import { describe, expect, it } from 'bun:test';
import { promptWithOpenUiAction } from '../src/runs/openui-action.js';

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

  it('drops duplicate params.context when it matches top-level context', () => {
    const shared = { card: 'paris', items: [1, 2] };
    const onlyDuplicate = promptWithOpenUiAction(
      [
        { type: 'text', text: 'explore' },
        {
          type: 'openui_action',
          params: { context: shared },
          context: { card: 'paris', items: [1, 2] },
        },
      ],
      'fallback',
    );
    const parsedOnly = JSON.parse(
      onlyDuplicate.slice(onlyDuplicate.indexOf('[openui_action] ') + 16),
    );
    expect(parsedOnly).toEqual({ context: shared });
    expect('params' in parsedOnly).toBe(false);

    const withOtherParam = promptWithOpenUiAction(
      [
        { type: 'text', text: 'explore' },
        {
          type: 'openui_action',
          params: { context: shared, extra: 'keep' },
          context: shared,
        },
      ],
      'fallback',
    );
    const parsedExtra = JSON.parse(
      withOtherParam.slice(withOtherParam.indexOf('[openui_action] ') + 16),
    );
    expect(parsedExtra).toEqual({ params: { extra: 'keep' }, context: shared });

    const distinctContext = promptWithOpenUiAction(
      [
        { type: 'text', text: 'explore' },
        {
          type: 'openui_action',
          params: { context: { card: 'lyon' } },
          context: shared,
        },
      ],
      'fallback',
    );
    const parsedDistinct = JSON.parse(
      distinctContext.slice(distinctContext.indexOf('[openui_action] ') + 16),
    );
    expect(parsedDistinct).toEqual({
      params: { context: { card: 'lyon' } },
      context: shared,
    });
  });

  it('ignores a malformed action part', () => {
    expect(
      promptWithOpenUiAction([{ type: 'text', text: 'ok' }, { type: 'openui_action' }], 'x'),
    ).toBe('ok');
  });
});
