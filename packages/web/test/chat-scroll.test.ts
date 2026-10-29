import type { ConversationMessage } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConversationDetail } from '../src/lib/api.js';
import {
  type ChatItem,
  historyToItems,
  mergeOlderHistory,
  snapshotHistory,
} from '../src/lib/chat-state.js';
import { MessagePane } from '../src/pages/chat.js';

// jsdom 没有真实滚动几何；只把「回到底部」这一个副作用换成 spy，
// MessageScroller 的 Provider/Item 仍是真实实现，验证的是 ScrollToLatest 的判定。
const { scrollToEnd } = vi.hoisted(() => ({ scrollToEnd: vi.fn() }));

vi.mock('@shadcn/react/message-scroller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shadcn/react/message-scroller')>();
  return {
    ...actual,
    useMessageScroller: () => ({
      scrollToEnd,
      scrollToMessage: vi.fn(),
      scrollToStart: vi.fn(),
    }),
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  const { createElement: element } = await import('react');
  return {
    ...actual,
    Link: (props: { children?: unknown }) => element('a', null, props.children),
  };
});

function message(id: string, role: 'user' | 'assistant', text: string): ConversationMessage {
  return {
    id,
    conversationId: 'c1',
    role,
    content: role === 'user' ? { type: 'text', text } : [{ type: 'text', text }],
    runId: null,
    createdAt: id,
  };
}

function detail(messages: ConversationMessage[]): ConversationDetail {
  return {
    conversation: { id: 'c1', agentId: 'a1', title: 't', createdAt: '2026-01-01T00:00:00Z' },
    messages,
    runMetrics: [],
    nextBefore: null,
  };
}

/** 首屏与更早一页；最后一条是用户消息，覆盖「末尾用户项」场景。 */
const newest = [
  message('m1', 'user', '旧问题'),
  message('m2', 'assistant', '旧回复'),
  message('m3', 'user', '现在'),
];
const olderPage = detail([message('m0', 'user', '更早'), ...newest]);

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

function pane(items: ChatItem[], hasOlder = false) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(MessagePane, {
      items,
      loading: false,
      error: null,
      onRetry() {},
      hasOlder,
      loadingOlder: false,
      onLoadOlder() {},
      olderDisabled: false,
      welcome: null,
      approvals: { pending: null, onApprove() {} },
      approvalItems: [],
      lastRun: null,
      historyMetrics: new Map(),
      onBranchMessage() {},
      branchingMessageId: null,
      running: false,
      openUi: false,
      streaming: false,
      onAction() {},
    }),
  );
}

async function render(items: ChatItem[], hasOlder = false): Promise<void> {
  await act(async () => {
    root.render(pane(items, hasOlder));
  });
}

beforeEach(() => {
  scrollToEnd.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

test('补旧重新解析同一末尾用户消息时不回到底部，显式发送才回底', async () => {
  const first = detail(newest);
  const loaded = historyToItems(first.messages);
  const snapshot = snapshotHistory(first, loaded);

  await render(loaded);
  expect(scrollToEnd).not.toHaveBeenCalled();

  // 补入更早一页：末尾用户消息 id / messageId 不变，只是对象引用被重建。
  const merged = mergeOlderHistory(snapshot, olderPage, loaded);
  expect(merged).not.toBeNull();
  const repaired = merged?.items ?? [];
  expect(repaired.at(-1)).toMatchObject({ kind: 'user', id: 'm3:0', messageId: 'm3' });
  expect(repaired.at(-1)).not.toBe(loaded.at(-1));
  await render(repaired);
  expect(scrollToEnd).not.toHaveBeenCalled();

  // 向上阅读时追加助手增量：末尾不是用户项，不抢滚动。
  await render([...repaired, { kind: 'text', text: '流式增量', id: 'live:0' }]);
  expect(scrollToEnd).not.toHaveBeenCalled();

  // 显式发送产生没有持久 id 的新用户项：回到底部一次。
  const sent = [...repaired, { kind: 'text' as const, text: '回复', id: 'live:0' }];
  await render([...sent, { kind: 'user', text: '新问题' }]);
  expect(scrollToEnd).toHaveBeenCalledTimes(1);

  // 同一发送后续的流式增量不重复回底。
  await render([
    ...sent,
    { kind: 'user', text: '新问题' },
    { kind: 'text', text: '继续', id: 'live:1' },
  ]);
  expect(scrollToEnd).toHaveBeenCalledTimes(1);
});

test('加载更早消息入口在内容区之外，首项始终是真实消息', async () => {
  const loaded = historyToItems(newest);
  await render(loaded, true);

  const viewport = host.querySelector('[data-slot="message-scroller-viewport"]');
  const content = host.querySelector('[data-slot="message-scroller-content"]');
  const entry = [...host.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === '加载更早消息',
  );
  expect(entry).toBeDefined();
  expect(viewport).not.toBeNull();
  expect(content).not.toBeNull();
  // 原语靠「Content 旧首子项新 index > 0」识别 prepend，入口不能占首项。
  expect(entry?.closest('[data-slot="message-scroller-content"]')).toBeNull();
  expect(entry?.closest('[data-slot="message-scroller-viewport"]')).toBe(viewport);
  expect(content?.firstElementChild?.getAttribute('data-message-id')).toBe(loaded[0]?.id);
});
