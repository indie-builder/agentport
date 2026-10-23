import type { ConversationDetail, ConversationMessage } from '@agentport/shared';
import { expect, test } from 'vitest';
import { historyToItems, mergeOlderHistory, snapshotHistory } from '../src/lib/chat-state.js';

/** 分页详情：调用方拿到的是「更早页在前、最新页在后」的时间正序消息。 */
function detail(messages: ConversationMessage[]): ConversationDetail {
  return {
    conversation: { id: 'c1', agentId: 'a1', title: 't', createdAt: '2026-01-01T00:00:00Z' },
    messages,
    nextBefore: null,
  };
}

function message(id: string, role: 'user' | 'assistant', content: unknown): ConversationMessage {
  return { id, conversationId: 'c1', role, content, runId: null, createdAt: id };
}

test('跨页的工具调用与结果合并成一行，历史 id 稳定且不受后续页影响', () => {
  const older = [message('m1', 'assistant', [{ type: 'tool_use', id: 'tu1', name: 'search' }])];
  const newer = [
    message('m2', 'user', { type: 'text', text: '继续' }),
    message('m3', 'assistant', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
  ];

  // 只加载最新页时结果找不到调用；补上更早一页后应合并到同一工具行。
  expect(historyToItems(newer)).toEqual([
    { id: 'm2:0', kind: 'user', text: '继续', messageId: 'm2' },
    { id: 'm3:0', kind: 'tool', toolUseId: 'tu1', name: '未知工具', result: 'ok' },
  ]);
  expect(historyToItems([...older, ...newer])).toEqual([
    { id: 'm1:0', kind: 'tool', toolUseId: 'tu1', name: 'search', input: '{}', result: 'ok' },
    { id: 'm2:0', kind: 'user', text: '继续', messageId: 'm2' },
  ]);
});

test('补入工具调用时即使渲染项数量不变也替换未知工具并保留尾部', () => {
  const firstPage = detail([
    message('m2', 'assistant', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
  ]);
  const loaded = historyToItems(firstPage.messages);
  const tail = [{ kind: 'text' as const, text: '本轮回答' }];
  const merged = mergeOlderHistory(
    snapshotHistory(firstPage, loaded),
    detail([
      message('m1', 'assistant', [{ type: 'tool_use', id: 'tu1', name: 'search' }]),
      ...firstPage.messages,
    ]),
    [...loaded, ...tail],
  );
  expect(merged?.items).toEqual([
    { id: 'm1:0', kind: 'tool', toolUseId: 'tu1', name: 'search', input: '{}', result: 'ok' },
    ...tail,
  ]);
});

test('补旧消息只替换历史前缀，流式尾部原样保留', () => {
  const firstPage = detail([message('m2', 'user', { type: 'text', text: '现在' })]);
  const loaded = historyToItems(firstPage.messages);
  const snapshot = snapshotHistory(firstPage, loaded);
  const tail = [{ kind: 'text' as const, text: '正在回答' }];

  const merged = mergeOlderHistory(
    snapshot,
    detail([message('m1', 'user', { type: 'text', text: '更早' }), ...firstPage.messages]),
    [...loaded, ...tail],
  );

  expect(merged?.items).toEqual([
    { id: 'm1:0', kind: 'user', text: '更早', messageId: 'm1' },
    { id: 'm2:0', kind: 'user', text: '现在', messageId: 'm2' },
    ...tail,
  ]);
});

test('本轮已落库的消息不会因分页刷新而重复拼进尾部', () => {
  const firstPage = detail([message('m1', 'user', { type: 'text', text: '你好' })]);
  const loaded = historyToItems(firstPage.messages);
  const snapshot = snapshotHistory(firstPage, loaded);
  const tail = [{ kind: 'text' as const, text: '流式回答' }];

  // 运行结束后服务端多出 user/assistant 两条；合并只能取边界之前的旧历史。
  const merged = mergeOlderHistory(
    snapshot,
    detail([
      message('m0', 'user', { type: 'text', text: '最早' }),
      ...firstPage.messages,
      message('m2', 'user', { type: 'text', text: '你好' }),
      message('m3', 'assistant', [{ type: 'text', text: '流式回答' }]),
    ]),
    [...loaded, ...tail],
  );

  expect(merged?.items.map((item) => ('id' in item ? item.id : undefined))).toEqual([
    'm0:0',
    'm1:0',
    undefined,
  ]);
});

test('切换会话后迟到的旧分页不能写进当前消息', () => {
  const firstPage = detail([message('m1', 'user', { type: 'text', text: '旧会话' })]);
  const loaded = historyToItems(firstPage.messages);
  const snapshot = snapshotHistory(firstPage, loaded);

  const other = detail([
    message('n1', 'user', { type: 'text', text: '新会话' }),
    message('n2', 'assistant', [{ type: 'text', text: '更早' }]),
  ]);

  expect(mergeOlderHistory(snapshot, other, loaded)).toBeNull();
});

/** 最新页窗口在两次分页之间前移：消息按 createdAt 排序，id 只用于同刻兜底。 */
function page(from: number, to: number): ConversationMessage[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => {
    const index = from + offset;
    const id = `m${index}`;
    return {
      ...message(id, 'user', { type: 'text', text: id }),
      createdAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`,
    };
  });
}

const tail = [{ kind: 'text' as const, text: '本轮回答' }];

test('窗口前移时不重写已加载前缀，也不重复持久化尾部', () => {
  const first = detail(page(11, 60));
  const loaded = historyToItems(first.messages);
  const snapshot = snapshotHistory(first, loaded);

  // 刷新回 m17..m66：没有更早的新消息，返回 null 让已加载的 m11..m16 原样留在 store。
  expect(mergeOlderHistory(snapshot, detail(page(17, 66)), [...loaded, ...tail])).toBeNull();

  // 之后再补真正更早的一页：旧消息全部保留，尾部仍只有一份。
  const older = mergeOlderHistory(snapshot, detail(page(1, 50)), [...loaded, ...tail]);
  expect(older?.items.map((item) => ('id' in item ? item.id : undefined))).toEqual([
    ...page(1, 60).map((item) => `${item.id}:0`),
    undefined,
  ]);
  expect(older?.snapshot).toMatchObject({ conversationId: 'c1', boundaryId: 'm60', count: 60 });
  expect(older?.snapshot.messages.map((item) => item.id)).toEqual(
    page(1, 60).map((item) => item.id),
  );
});

test('跨页补旧只取边界之前，按原始顺序且不重复已加载消息', () => {
  const first = detail(page(11, 60));
  const loaded = historyToItems(first.messages);
  const snapshot = snapshotHistory(first, loaded);

  // 新数据同时含边界 m60 之后的落库消息 m61..m66 与更早的 m1..m10。
  const older = mergeOlderHistory(snapshot, detail([...page(1, 10), ...page(11, 66)]), [
    ...loaded,
    ...tail,
  ]);

  expect(older?.items.map((item) => ('id' in item ? item.id : undefined))).toEqual([
    ...page(1, 60).map((item) => `${item.id}:0`),
    undefined,
  ]);
  expect(older?.snapshot.messages.map((item) => item.id)).toEqual(
    page(1, 60).map((item) => item.id),
  );
});

test('重复合并同一份数据返回 null，避免 effect 循环', () => {
  const first = detail(page(11, 60));
  const loaded = historyToItems(first.messages);
  const snapshot = snapshotHistory(first, loaded);

  expect(mergeOlderHistory(snapshot, first, [...loaded, ...tail])).toBeNull();
});
