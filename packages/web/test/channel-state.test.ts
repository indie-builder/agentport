import type { ChannelMessage } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import {
  applyMention,
  mentionQueryAt,
  mergeChannelMessages,
  pruneMentions,
  visibleReadSeq,
} from '../src/lib/channel-state.js';
import type { ChatItem } from '../src/lib/chat-state.js';

function message(overrides: Partial<ChannelMessage> & Pick<ChannelMessage, 'id' | 'seq'>) {
  return {
    channelId: 'channel_1',
    kind: 'human',
    authorBusinessId: 'person_1',
    agentId: null,
    runId: null,
    body: 'hello',
    clientMessageId: null,
    sourceMessageId: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } satisfies ChannelMessage;
}

describe('channel mentions', () => {
  it('opens only for an @ token at a word boundary', () => {
    expect(mentionQueryAt('你好 @', 4)).toEqual({ start: 3, query: '' });
    expect(mentionQueryAt('@a', 2)).toEqual({ start: 0, query: 'a' });
    expect(mentionQueryAt('mail@example.com', 8)).toBeNull();
    expect(mentionQueryAt('@agent 然后', 8)).toBeNull();
  });

  it('replaces the token and keeps the caret after the name', () => {
    expect(applyMention('请 @后端', 5, '后端工程师')).toEqual({
      text: '请 @后端工程师 ',
      caret: 9,
    });
  });

  it('drops mentions whose @名字 was deleted from the draft', () => {
    const selected = [
      { agentId: 'agent_a', name: '甲' },
      { agentId: 'agent_b', name: '乙' },
    ];
    expect(pruneMentions('@甲 处理', selected)).toEqual(['agent_a']);
  });
});

describe('channel message merge', () => {
  it('replaces the optimistic row when the server echoes the same clientMessageId', () => {
    const optimistic = message({
      id: 'local-1',
      seq: Number.MAX_SAFE_INTEGER,
      clientMessageId: 'client-1',
    });
    const saved = message({ id: 'message_1', seq: 7, clientMessageId: 'client-1' });
    const merged = mergeChannelMessages([optimistic], [saved]);
    expect(merged.map((item) => item.id)).toEqual(['message_1']);
  });

  it('dedupes SSE replays by id and keeps seq order', () => {
    const second = message({ id: 'b', seq: 2 });
    const first = message({ id: 'a', seq: 1 });
    expect(mergeChannelMessages([second], [first, second]).map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps the SSE-filled tail when a refetch returns only the first page', () => {
    const cached = Array.from({ length: 250 }, (_, index) =>
      message({ id: `message_${index + 1}`, seq: index + 1 }),
    );
    const refetch = cached.slice(0, 200);
    const merged = mergeChannelMessages(cached, refetch);
    expect(merged).toHaveLength(250);
    expect(merged[200]?.seq).toBe(201);
    expect(merged.at(-1)?.seq).toBe(250);
  });
});

describe('channel visible read cursor', () => {
  const item = (id: string, kind: ChatItem['kind']): ChatItem =>
    ({ id, kind, text: '' }) as ChatItem;

  it('reads a single short message that never scrolls', () => {
    expect(visibleReadSeq([item('m1', 'user')], ['m1'], new Map([['m1', 1]]))).toBe(1);
  });

  it('counts the whole visible turn and stops at the next turn', () => {
    const items = [
      item('m1', 'user'),
      item('m2', 'text'),
      item('m3', 'text'),
      item('m4', 'user'),
      item('m5', 'text'),
    ];
    const seqById = new Map([
      ['m1', 1],
      ['m2', 2],
      ['m3', 3],
      ['m4', 4],
      ['m5', 5],
    ]);
    expect(visibleReadSeq(items, ['m1'], seqById)).toBe(1);
    expect(visibleReadSeq(items, ['m2'], seqById)).toBe(3);
    expect(visibleReadSeq(items, ['m4'], seqById)).toBe(4);
  });

  it('ignores stream-only ids that have no persisted seq', () => {
    const items = [item('m1', 'user'), item('run:anchor', 'text')];
    expect(visibleReadSeq(items, ['run:anchor'], new Map([['m1', 1]]))).toBe(0);
  });
});
