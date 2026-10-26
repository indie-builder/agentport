import type { ChatEvent } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent, type ChatItem } from '../src/lib/chat-state.js';

/** worker 为每次块边界补发运行内稳定 id；前端必须按它对齐而不是按会被重用的 blockIndex。 */
function run(events: ChatEvent[]): ChatItem[] {
  return events.reduce<ChatItem[]>((items, event) => applyEvent(items, event), []);
}

describe('streamBlockId identity', () => {
  it('starts a new text block when the id changes even though blockIndex repeats', () => {
    const items = run([
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' } as ChatEvent,
      { type: 'text_delta', text: '第一段', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      { type: 'assistant_text', text: '第一段', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' } as ChatEvent,
      { type: 'text_delta', text: '第二段', blockIndex: 0, streamBlockId: 'b1' } as ChatEvent,
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['第一段', '第二段']);
    expect(items.map((item) => item.kind === 'text' && item.streamBlockId)).toEqual(['b0', 'b1']);
  });

  it('merges deltas of one block regardless of per-frame sdkUuid', () => {
    const items = run([
      {
        type: 'text_delta',
        text: 'Hel',
        blockIndex: 0,
        streamBlockId: 'b0',
        sdkUuid: 'f1',
      } as ChatEvent,
      {
        type: 'text_delta',
        text: 'lo',
        blockIndex: 0,
        streamBlockId: 'b0',
        sdkUuid: 'f2',
      } as ChatEvent,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'text', text: 'Hello' });
  });

  it('does not merge sub-agent text that shares the parent stream id', () => {
    const items = run([
      { type: 'text_delta', text: '父级', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      {
        type: 'text_delta',
        text: '子级',
        blockIndex: 0,
        streamBlockId: 'b0',
        parentToolUseId: 'toolu_1',
      } as ChatEvent,
    ]);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ text: '子级', parentToolUseId: 'toolu_1' });
  });

  it('still splits reused blockIndex without stream ids (block-boundary fallback)', () => {
    const items = run([
      { type: 'text_delta', text: '旧块', blockIndex: 0 },
      { type: 'assistant_block_stop', blockIndex: 0 },
      { type: 'assistant_block_start', blockIndex: 0, kind: 'text' },
      { type: 'text_delta', text: '新块', blockIndex: 0 },
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['旧块', '新块']);
  });
});

describe('completed assistant_text', () => {
  it('shows sub-agent text that only ever arrived as a complete block', () => {
    // 子智能体没有 delta：只忽略 assistant_text 会让它的输出完全不可见。
    const items = run([
      {
        type: 'assistant_text',
        text: '子级结果',
        blockIndex: 0,
        streamBlockId: 'b0',
        parentToolUseId: 'toolu_1',
      } as ChatEvent,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'text',
      text: '子级结果',
      streamBlockId: 'b0',
      parentToolUseId: 'toolu_1',
      closed: true,
    });
  });

  it('updates the segment built from deltas instead of appending a duplicate', () => {
    const items = run([
      { type: 'text_delta', text: 'Hel', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      { type: 'text_delta', text: 'lo', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      {
        type: 'assistant_text',
        text: 'Hello',
        blockIndex: 0,
        streamBlockId: 'b0',
        sdkUuid: 'msg-1',
      } as ChatEvent,
      // 完整块之后的异常 delta 不能重开这一段，也不能再追加。
      { type: 'text_delta', text: '!', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'text',
      text: 'Hello',
      streamBlockId: 'b0',
      sdkUuid: 'msg-1',
      closed: true,
    });
  });

  it('finds the existing segment when parent and child deltas interleave', () => {
    const items = run([
      { type: 'text_delta', text: '父级一', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      {
        type: 'text_delta',
        text: '子级',
        blockIndex: 0,
        streamBlockId: 'b1',
        parentToolUseId: 'toolu_1',
      } as ChatEvent,
      // 父级续写：同一 id 的段在列表中间，不能只查末尾。
      { type: 'text_delta', text: '二', blockIndex: 0, streamBlockId: 'b0' } as ChatEvent,
      {
        type: 'assistant_text',
        text: '子级',
        blockIndex: 0,
        streamBlockId: 'b1',
        parentToolUseId: 'toolu_1',
      } as ChatEvent,
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['父级一二', '子级']);
    expect(items.map((item) => item.kind === 'text' && item.parentToolUseId)).toEqual([
      undefined,
      'toolu_1',
    ]);
  });

  it('does not merge into the previous run that reused the same ids', () => {
    // 上一轮已结束的段与新一轮的 b0 同号；用户气泡是运行边界。
    const previous: ChatItem[] = [
      { kind: 'user', text: '第一轮' },
      { kind: 'text', text: '旧回答', blockIndex: 0, streamBlockId: 'b0', closed: true },
      { kind: 'user', text: '第二轮' },
    ];
    const items = [
      { type: 'text_delta', text: '新回答', blockIndex: 0, streamBlockId: 'b0' },
      { type: 'assistant_text', text: '新回答', blockIndex: 0, streamBlockId: 'b0' },
    ].reduce((state, event) => applyEvent(state, event as ChatEvent), previous);

    expect(items.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual([
      '旧回答',
      '新回答',
    ]);
  });

  it('replaces longer delta text with the truncated full text and marks it', () => {
    const items = run([
      {
        type: 'text_delta',
        text: 'x'.repeat(2048),
        blockIndex: 0,
        streamBlockId: 'b0',
      } as ChatEvent,
      {
        type: 'assistant_text',
        text: 'x'.repeat(1024),
        blockIndex: 0,
        streamBlockId: 'b0',
        truncated: true,
      } as ChatEvent,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'text',
      text: 'x'.repeat(1024),
      truncated: true,
      closed: true,
    });
  });

  it('falls back to the block boundary when the complete text has no stream id', () => {
    const items = run([
      { type: 'text_delta', text: 'partial', blockIndex: 0 },
      { type: 'assistant_text', text: 'complete', blockIndex: 0 },
      { type: 'assistant_text', text: 'second', blockIndex: 1 },
    ]);

    expect(items.map((item) => item.kind === 'text' && item.text)).toEqual(['complete', 'second']);
  });
});
