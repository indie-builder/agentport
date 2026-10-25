import { describe, expect, it } from 'vitest';
import { applyEvent, type ChatItem } from '../src/lib/chat-state.js';

/**
 * 真实 SDK 的 `stream_event.uuid` 每帧都不同（评审用 CLI 2.1.310 实测），
 * 所以增量只能按「块序号 + 父调用」合并，不能拿 uuid 当块身份。
 * 这条测试锁住真实语义：同一块内 uuid 变化仍要拼成一段。
 */
function textDeltas(events: Parameters<typeof applyEvent>[1][]): ChatItem[] {
  return events.reduce<ChatItem[]>((items, event) => applyEvent(items, event), []);
}

describe('text_delta merging', () => {
  it('merges deltas in the same block even when sdkUuid changes every frame', () => {
    const items = textDeltas([
      { type: 'text_delta', text: 'Hello ', blockIndex: 0, sdkUuid: 'frame-1' },
      { type: 'text_delta', text: 'from ', blockIndex: 0, sdkUuid: 'frame-2' },
      { type: 'text_delta', text: 'the ', blockIndex: 0, sdkUuid: 'frame-3' },
      { type: 'text_delta', text: 'model.', blockIndex: 0, sdkUuid: 'frame-4' },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'text', text: 'Hello from the model.' });
  });

  it('keeps separate blocks apart', () => {
    const items = textDeltas([
      { type: 'text_delta', text: '第一段', blockIndex: 0 },
      { type: 'text_delta', text: '第二段', blockIndex: 1 },
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['第一段', '第二段']);
  });

  it('does not merge sub-agent text into the parent block', () => {
    const items = textDeltas([
      { type: 'text_delta', text: '父级', blockIndex: 0 },
      { type: 'text_delta', text: '子级', blockIndex: 0, parentToolUseId: 'toolu_1' },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ text: '子级', parentToolUseId: 'toolu_1' });
  });

  it('starts a new item after a block boundary even with the same index', () => {
    const items = textDeltas([
      { type: 'text_delta', text: '旧块', blockIndex: 0 },
      { type: 'assistant_block_stop', blockIndex: 0 },
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
      { type: 'text_delta', text: '新块', blockIndex: 0 },
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['旧块', '新块']);
  });
});
