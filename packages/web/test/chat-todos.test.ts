import type { ChatEvent, ConversationMessage, ProgressTodo } from '@agentport/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import {
  applyEvent,
  type ChatItem,
  historyToItems,
  latestTopLevelTodos,
  mergeOlderHistory,
  snapshotHistory,
} from '../src/lib/chat-state.js';
import { MessagePane } from '../src/pages/chat.js';

vi.mock('@/components/ui/button', async () => import('../src/components/ui/button.js'));

function todo(content: string, status: ProgressTodo['status'] = 'pending'): ProgressTodo {
  return { content, activeForm: `${content}中`, status };
}

const fold = (items: ChatItem[], events: ChatEvent[]) => events.reduce(applyEvent, items);

function toolEvents(toolUseId: string, todos?: ProgressTodo[]): ChatEvent[] {
  return [
    { type: 'tool_start', toolUseId, name: 'TodoWrite' },
    {
      type: 'tool_result',
      toolUseId,
      content: 'ok',
      ...(todos === undefined ? {} : { todos }),
    },
  ];
}

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: unknown,
): ConversationMessage => ({
  id,
  conversationId: 'c1',
  role,
  content,
  runId: null,
  createdAt: id,
});

function pane(items: ChatItem[]) {
  return renderToStaticMarkup(
    createElement(MessagePane, {
      items,
      loading: false,
      error: null,
      onRetry() {},
      hasOlder: false,
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

describe('live todo snapshots', () => {
  test('a confirmed todo_result replaces the snapshot; omission keeps it', () => {
    const first = fold([], toolEvents('t1', [todo('读代码', 'in_progress')]));
    expect(latestTopLevelTodos(first)).toEqual([todo('读代码', 'in_progress')]);

    // 省略 todos 的 tool_result（普通工具）不改上一条清单。
    const unchanged = fold(first, [{ type: 'tool_result', toolUseId: 't1', content: 'again' }]);
    expect(latestTopLevelTodos(unchanged)).toEqual([todo('读代码', 'in_progress')]);

    const updated = fold(unchanged, [
      {
        type: 'tool_result',
        toolUseId: 't1',
        content: 'ok',
        todos: [todo('读代码', 'completed'), todo('改代码', 'in_progress')],
      },
    ]);
    expect(latestTopLevelTodos(updated)).toEqual([
      todo('读代码', 'completed'),
      todo('改代码', 'in_progress'),
    ]);
    // 同一轮消息随实时快照更新渲染。
    expect(pane(updated)).toContain('改代码中');
  });

  test('an empty array clears the snapshot', () => {
    const items = fold(
      [],
      [
        ...toolEvents('t1', [todo('旧步骤')]),
        { type: 'tool_result', toolUseId: 't1', content: 'done', todos: [] },
      ],
    );
    expect(latestTopLevelTodos(items)).toBeUndefined();
  });
});

describe('history todo snapshots', () => {
  test('tool_result rows keep their todos when replayed', () => {
    const items = historyToItems([
      message('m1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'TodoWrite' }]),
      message('m2', 'assistant', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'ok',
          todos: [todo('整理资料', 'in_progress')],
        },
      ]),
    ]);
    expect(items).toEqual([
      {
        id: 'm1:0',
        kind: 'tool',
        toolUseId: 't1',
        name: 'TodoWrite',
        input: '{}',
        result: 'ok',
        todos: [todo('整理资料', 'in_progress')],
        todoSeq: 1,
        resultMessageId: 'm2',
      },
    ]);
  });

  test('pagination merges the result snapshot onto the older tool_use', () => {
    const firstPage = {
      conversation: { id: 'c1', agentId: 'a1', title: '', createdAt: '' },
      messages: [
        message('m2', 'assistant', [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'ok',
            todos: [todo('整理资料', 'completed')],
          },
        ]),
      ],
      runMetrics: [],
      nextBefore: null,
    };
    const loaded = historyToItems(firstPage.messages);
    const merged = mergeOlderHistory(
      snapshotHistory(firstPage, loaded),
      {
        ...firstPage,
        messages: [
          message('m1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'TodoWrite' }]),
          ...firstPage.messages,
        ],
      },
      loaded,
    );
    expect(merged?.items[0]).toMatchObject({
      kind: 'tool',
      name: 'TodoWrite',
      result: 'ok',
      todos: [todo('整理资料', 'completed')],
    });
  });

  test('malformed stored todos are ignored instead of breaking history', () => {
    const items = historyToItems([
      message('m1', 'assistant', [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok', todos: [{ content: 1 }] },
      ]),
    ]);
    expect(items[0]).not.toHaveProperty('todos');
  });
});

describe('snapshot confirmation order', () => {
  // trace 位置来自 tool_start，早开始的调用可能晚确认；选择必须按结果到达顺序。
  const reversedLive = [
    { type: 'tool_start', toolUseId: 'a', name: 'TodoWrite' },
    { type: 'tool_start', toolUseId: 'b', name: 'TodoWrite' },
    { type: 'tool_result', toolUseId: 'b', content: 'ok', todos: [todo('B')] },
    { type: 'tool_result', toolUseId: 'a', content: 'ok', todos: [todo('A')] },
  ] as ChatEvent[];

  test('live selection follows result order, not tool_start position', () => {
    expect(latestTopLevelTodos(fold([], reversedLive))).toEqual([todo('A')]);
  });

  test('a cleared snapshot confirmed last wins over an earlier non-empty one', () => {
    const items = fold(
      [],
      [
        ...reversedLive.slice(0, 3),
        { type: 'tool_result', toolUseId: 'a', content: 'ok', todos: [] },
      ],
    );
    expect(latestTopLevelTodos(items)).toBeUndefined();
  });

  test('history selects by result order when tool_use precedes the results', () => {
    const items = historyToItems([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 'a', name: 'TodoWrite' },
        { type: 'tool_use', id: 'b', name: 'TodoWrite' },
      ]),
      message('m2', 'assistant', [
        { type: 'tool_result', tool_use_id: 'b', content: 'ok', todos: [todo('B')] },
        { type: 'tool_result', tool_use_id: 'a', content: 'ok', todos: [todo('A')] },
      ]),
    ]);
    expect(latestTopLevelTodos(items)).toEqual([todo('A')]);
  });

  test('loading older tool_use does not flip the confirmed snapshot', () => {
    const results = message('m2', 'assistant', [
      { type: 'tool_result', tool_use_id: 'b', content: 'ok', todos: [todo('B')] },
      { type: 'tool_result', tool_use_id: 'a', content: 'ok', todos: [todo('A')] },
    ]);
    const page = {
      conversation: { id: 'c1', agentId: 'a1', title: '', createdAt: '' },
      messages: [results],
      runMetrics: [],
      nextBefore: null,
    };
    const loaded = historyToItems(page.messages);
    expect(latestTopLevelTodos(loaded)).toEqual([todo('A')]);

    const merged = mergeOlderHistory(
      snapshotHistory(page, loaded),
      {
        ...page,
        messages: [
          message('m1', 'assistant', [
            { type: 'tool_use', id: 'a', name: 'TodoWrite' },
            { type: 'tool_use', id: 'b', name: 'TodoWrite' },
          ]),
          results,
        ],
      },
      loaded,
    );
    expect(merged && latestTopLevelTodos(merged.items)).toEqual([todo('A')]);
  });
});

describe('per-turn selection', () => {
  test('the last top-level snapshot wins; sub-agent snapshots do not', () => {
    const items: ChatItem[] = [
      { kind: 'tool', toolUseId: 't1', name: 'TodoWrite', todos: [todo('旧步骤')] },
      { kind: 'tool', toolUseId: 't2', name: 'TodoWrite', todos: [todo('新步骤')] },
      {
        kind: 'tool',
        toolUseId: 't3',
        name: 'TodoWrite',
        parentToolUseId: 't2',
        todos: [todo('子步骤')],
      },
    ];
    expect(latestTopLevelTodos(items)).toEqual([todo('新步骤')]);
  });

  test('turns do not leak snapshots into each other', () => {
    const firstTurn = fold([], toolEvents('t1', [todo('第一轮')]));
    const secondTurn = fold([], toolEvents('t2'));
    const items: ChatItem[] = [...firstTurn, { kind: 'user', text: '继续' }, ...secondTurn];
    expect(latestTopLevelTodos(items.slice(0, firstTurn.length))).toEqual([todo('第一轮')]);
    expect(latestTopLevelTodos(items.slice(firstTurn.length + 1))).toBeUndefined();
  });

  test('stop, failure and success keep every step status unchanged', () => {
    const snapshots = [todo('进行中', 'in_progress'), todo('待处理')];
    for (const terminal of [
      { type: 'run_finished', status: 'failed' },
      { type: 'run_finished', status: 'cancelled' },
      { type: 'run_finished', status: 'succeeded' },
    ] as ChatEvent[]) {
      const items = fold(fold([], toolEvents('t1', snapshots)), [
        terminal,
        { type: 'error', message: '连接中断' },
      ]);
      expect(latestTopLevelTodos(items)).toEqual(snapshots);
    }
  });
});

describe('turn checklist rendering', () => {
  test('shows one compact list with the active form and completed count', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: '继续' },
      { kind: 'text', text: '开始处理' },
      { kind: 'tool', toolUseId: 't1', name: 'TodoWrite', todos: [todo('旧步骤')] },
      {
        kind: 'tool',
        toolUseId: 't2',
        name: 'TodoWrite',
        todos: [
          todo('整理资料', 'completed'),
          todo('撰写结论', 'in_progress'),
          todo('校对', 'pending'),
        ],
      },
    ];
    const html = pane(items);
    expect(html).toContain('aria-label="任务清单"');
    expect(html).toContain('1/3');
    expect(html).toContain('撰写结论中');
    expect(html).toContain('校对');
    expect(html).toContain('整理资料');
    expect(html).not.toContain('旧步骤');
    expect(html.match(/aria-label="任务清单"/g)).toHaveLength(1);
    // 字号沿用既有 token：计数 12px（xs），步骤正文 14px（base），不另造小字号。
    expect(html).toContain('font-mono text-xs tabular-nums');
    expect(html).toContain('flex items-start gap-1.5 text-base');
    expect(html).not.toContain('text-2xs');
  });

  test('does not render without a snapshot, after a clear, or for a sub-agent only', () => {
    expect(
      pane([
        { kind: 'user', text: '你好' },
        { kind: 'text', text: '在' },
      ]),
    ).not.toContain('aria-label="任务清单"');
    expect(
      pane([
        { kind: 'text', text: '在' },
        { kind: 'tool', toolUseId: 't1', name: 'TodoWrite', todos: [] },
      ]),
    ).not.toContain('aria-label="任务清单"');
    expect(
      pane([
        { kind: 'text', text: '在' },
        {
          kind: 'tool',
          toolUseId: 't1',
          name: 'TodoWrite',
          parentToolUseId: 'parent',
          todos: [todo('子步骤')],
        },
      ]),
    ).not.toContain('aria-label="任务清单"');
  });
});
