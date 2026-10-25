import type { ChatEvent } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { createStreamBlockIds } from '../src/runner-client.js';

/**
 * 真实 SDK 的每条 assistant 消息都从 blockIndex=0 重新计数，帧 uuid 又每帧变化；
 * 前端只能靠 worker 补发的运行内稳定 id 区分「新块」与「旧块的重用序号」。
 */
function feed(events: ChatEvent[]): Array<ChatEvent & { streamBlockId?: string }> {
  const assign = createStreamBlockIds();
  return events.map((event) => assign(event) as ChatEvent & { streamBlockId?: string });
}

describe('createStreamBlockIds', () => {
  it('keeps one id for a block across deltas and its completed text', () => {
    const events = feed([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text', sdkUuid: 'msg-1' },
      { type: 'text_delta', text: 'Hel', blockIndex: 0, sdkUuid: 'frame-1' },
      { type: 'text_delta', text: 'lo', blockIndex: 0, sdkUuid: 'frame-2' },
      { type: 'assistant_block_stop', blockIndex: 0 },
      { type: 'assistant_text', text: 'Hello', blockIndex: 0, sdkUuid: 'msg-1' },
    ]);

    expect(events.map((event) => event.streamBlockId)).toEqual(['b0', 'b0', 'b0', 'b0', 'b0']);
  });

  it('issues a new id when the next SDK message reuses blockIndex 0 without a close', () => {
    // 工具调用之间的两段文本：SDK 是两条 assistant 消息，blockIndex 都是 0，且不一定发 stop。
    const events = feed([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text', sdkUuid: 'msg-1' },
      { type: 'text_delta', text: '第一段', blockIndex: 0, sdkUuid: 'frame-1' },
      { type: 'assistant_text', text: '第一段', blockIndex: 0, sdkUuid: 'msg-1' },
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text', sdkUuid: 'msg-2' },
      { type: 'text_delta', text: '第二段', blockIndex: 0, sdkUuid: 'frame-2' },
      { type: 'assistant_text', text: '第二段', blockIndex: 0, sdkUuid: 'msg-2' },
    ]);

    expect(events[3]?.streamBlockId).toBe('b1');
    expect(events.slice(3).map((event) => event.streamBlockId)).toEqual(['b1', 'b1', 'b1']);
    expect(events[0]?.streamBlockId).toBe('b0');
  });

  it('distinguishes a sub-agent block from the parent with the same index', () => {
    const events = feed([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text', sdkUuid: 'msg-1' },
      { type: 'text_delta', text: '父级', blockIndex: 0, sdkUuid: 'frame-1' },
      {
        type: 'assistant_block_start',
        blockIndex: 0,
        kind: 'text',
        sdkUuid: 'msg-2',
        parentToolUseId: 'toolu_1',
      },
      { type: 'text_delta', text: '子级', blockIndex: 0, parentToolUseId: 'toolu_1' },
    ]);

    expect(events[2]?.streamBlockId).not.toBe(events[0]?.streamBlockId);
  });

  it('falls back to block boundaries when the runner sends no start event', () => {
    // 旧 runner：只有 delta、没有 block_start；第一次 delta 起号，后续复用。
    const events = feed([
      { type: 'text_delta', text: 'a', blockIndex: 0 },
      { type: 'text_delta', text: 'b', blockIndex: 0 },
      { type: 'text_delta', text: 'c', blockIndex: 1 },
    ]);

    expect(events.map((event) => event.streamBlockId)).toEqual(['b0', 'b0', 'b1']);
  });

  it('starts a new id for each unbounded complete block of the same parent', () => {
    // 子智能体只有完整消息、没有 delta 也没有 block 边界：同 parent/index 0 连着两条，
    // 每条的 assistant_text 都要封口，不能复用 b0。
    const events = feed([
      {
        type: 'assistant_text',
        text: '第一段',
        blockIndex: 0,
        parentToolUseId: 'toolu_1',
      },
      {
        type: 'assistant_text',
        text: '第二段',
        blockIndex: 0,
        parentToolUseId: 'toolu_1',
      },
    ]);

    expect(events.map((event) => event.streamBlockId)).toEqual(['b0', 'b1']);
  });

  it('gives a delta, its completed text and the following stop one identity per message', () => {
    // 真实顺序：完整 assistant 消息在 content_block_stop 之前到达。
    const events = feed([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
      { type: 'text_delta', text: 'a', blockIndex: 0 },
      { type: 'assistant_text', text: 'a', blockIndex: 0 },
      { type: 'assistant_block_stop', blockIndex: 0 },
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
      { type: 'text_delta', text: 'b', blockIndex: 0 },
      { type: 'assistant_text', text: 'b', blockIndex: 0 },
      { type: 'assistant_block_stop', blockIndex: 0 },
    ]);

    expect(events.map((event) => event.streamBlockId)).toEqual([
      'b0',
      'b0',
      'b0',
      'b0',
      'b1',
      'b1',
      'b1',
      'b1',
    ]);
  });

  it('starts a new id per message when the runner sends no block index at all', () => {
    // 每帧 sdkUuid 都变，不能当消息身份；完整消息到达才算一段结束。
    const events = feed([
      { type: 'text_delta', text: 'a', sdkUuid: 'frame-1' },
      { type: 'text_delta', text: 'b', sdkUuid: 'frame-2' },
      { type: 'assistant_text', text: 'ab', sdkUuid: 'msg-1' },
      { type: 'text_delta', text: 'c', sdkUuid: 'frame-3' },
    ]);

    expect(events.map((event) => event.streamBlockId)).toEqual(['b0', 'b0', 'b0', 'b1']);
  });
});
