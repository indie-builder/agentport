import type { ChatEvent, ConversationMessage } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent, type ChatItem, historyToItems } from '../src/lib/chat-state.js';

const fold = (items: ChatItem[], events: ChatEvent[]) => events.reduce(applyEvent, items);

const delta = (text: string, extra: Partial<Extract<ChatEvent, { type: 'text_delta' }>> = {}) =>
  ({ type: 'text_delta', text, ...extra }) as ChatEvent;

describe('streamed assistant blocks', () => {
  it('does not merge deltas from different blocks', () => {
    const items = fold(
      [],
      [
        delta('first ', { blockIndex: 0, sdkUuid: 'u1' }),
        delta('block', { blockIndex: 0, sdkUuid: 'u1' }),
        delta('second', { blockIndex: 2, sdkUuid: 'u1' }),
      ],
    );
    expect(items).toEqual([
      { kind: 'text', text: 'first block', blockIndex: 0, sdkUuid: 'u1' },
      { kind: 'text', text: 'second', blockIndex: 2, sdkUuid: 'u1' },
    ]);
  });

  it('starts a new segment only at a block boundary, not when uuid changes', () => {
    // SDK 的 stream_event.uuid 每帧都不同，不能拿它分段；边界事件才是分段的依据。
    const items = fold(
      [],
      [
        delta('answer a', { blockIndex: 0, sdkUuid: 'u1' }),
        delta(' continues', { blockIndex: 0, sdkUuid: 'u2' }),
        { type: 'assistant_block_stop', blockIndex: 0 },
        { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
        delta('answer b', { blockIndex: 0, sdkUuid: 'u3' }),
      ],
    );
    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual([
      'answer a continues',
      'answer b',
    ]);
  });

  it('does not merge sub-agent text into the parent segment', () => {
    const items = fold(
      [],
      [
        delta('parent ', { blockIndex: 0, sdkUuid: 'u1' }),
        delta('child', { blockIndex: 0, sdkUuid: 'u2', parentToolUseId: 'toolu_p' }),
        delta('continues', { blockIndex: 2, sdkUuid: 'u1' }),
      ],
    );
    // 子智能体文本自成一簿（带 parentToolUseId），不并进父段。
    expect(items).toEqual([
      { kind: 'text', text: 'parent ', blockIndex: 0, sdkUuid: 'u1' },
      { kind: 'text', text: 'child', blockIndex: 0, sdkUuid: 'u2', parentToolUseId: 'toolu_p' },
      { kind: 'text', text: 'continues', blockIndex: 2, sdkUuid: 'u1' },
    ]);
  });

  it('keeps legacy deltas merging as before', () => {
    const items = fold([], [delta('a'), delta('b')]);
    expect(items).toEqual([{ kind: 'text', text: 'ab' }]);
  });

  it('ignores block boundary events without touching displayed text', () => {
    const items = fold(
      [],
      [
        delta('kept', { blockIndex: 0, sdkUuid: 'u1' }),
        { type: 'assistant_block_start', blockIndex: 1, kind: 'tool_use', sdkUuid: 'u1' },
        { type: 'assistant_block_stop', blockIndex: 0 },
      ],
    );
    expect(items).toEqual([{ kind: 'text', text: 'kept', blockIndex: 0, sdkUuid: 'u1' }]);
  });
});

describe('history block reconstruction', () => {
  const message = (content: unknown): ConversationMessage => ({
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    runId: null,
    createdAt: '',
  });

  it('keeps blockIndex and sub-agent attribution on text rows', () => {
    expect(
      historyToItems([
        message({ type: 'text', text: 'a', blockIndex: 0 }),
        message({ type: 'text', text: 'b', blockIndex: 2, parentToolUseId: 'toolu_p' }),
      ]),
    ).toEqual([
      { id: 'm1:0', kind: 'text', text: 'a', blockIndex: 0 },
      { id: 'm1:0', kind: 'text', text: 'b', blockIndex: 2, parentToolUseId: 'toolu_p' },
    ]);
  });

  it('leaves legacy rows without block fields unchanged', () => {
    expect(historyToItems([message({ type: 'text', text: 'old' })])).toEqual([
      { id: 'm1:0', kind: 'text', text: 'old' },
    ]);
  });
});
