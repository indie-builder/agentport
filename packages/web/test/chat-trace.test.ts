import type { ConversationMessage, PublicRunQuestion } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/lib/api.js';
import { type ChatItem, historyToItems } from '../src/lib/chat-state.js';
import type { RunMetrics } from '../src/lib/chat-store.js';
import { MessagePane } from '../src/pages/chat.js';

// 读数行里有「查看详情」链接；这里只验证可见性，不需要真实路由上下文。
vi.mock('@tanstack/react-router', async (original) => {
  const actual = await original<typeof import('@tanstack/react-router')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Link: (props: { children?: unknown }) => createElement('a', null, props.children),
  };
});

function pane(
  items: ChatItem[],
  options: {
    approvalItems?: ApprovalRequest[];
    questions?: ReadonlyMap<string, PublicRunQuestion>;
    historyMetrics?: ReadonlyMap<string, RunMetrics>;
    running?: boolean;
  } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element: ReactElement = createElement(
    QueryClientProvider,
    { client },
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
      approvalItems: options.approvalItems ?? [],
      questionsByToolUseId: options.questions,
      lastRun: null,
      historyMetrics: options.historyMetrics ?? new Map(),
      onBranchMessage() {},
      branchingMessageId: null,
      running: options.running ?? false,
      openUi: false,
      streaming: false,
      onAction() {},
    }),
  );
  return renderToStaticMarkup(element);
}

const user = (text: string, id: string): ChatItem => ({ kind: 'user', text, id });
const text = (value: string, id: string, runId?: string): ChatItem => ({
  kind: 'text',
  text: value,
  id,
  ...(runId === undefined ? {} : { runId }),
});
const tool = (
  toolUseId: string,
  name: string,
  extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {},
): ChatItem => ({ kind: 'tool', toolUseId, name, ...extra });
const done = { result: 'ok', startedAt: 1, endedAt: 2 } as const;
const notice = (value: string, id: string): ChatItem => ({
  kind: 'notice',
  text: value,
  tone: 'error',
  id,
});

const approval = (id: string, serverName: string): ApprovalRequest => ({
  id,
  serverId: serverName,
  serverName,
  toolName: 'write',
  approvedAt: null,
  createdAt: '',
});

const question: PublicRunQuestion = {
  requestId: 'request-1',
  runId: 'run-1',
  toolUseId: 'ask',
  status: 'pending',
  answers: null,
  createdAt: '',
  resolvedAt: null,
  expiresAt: '2999-01-01T00:00:00.000Z',
  closeReason: null,
  questions: [
    {
      question: '选哪个方案？',
      header: '方案',
      multiSelect: false,
      options: [{ value: '0', label: '方案 A', description: '' }],
    },
  ],
};

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

describe('per-turn execution trace', () => {
  it('folds normal calls into one trace without reordering the body text', () => {
    const html = pane([
      text('第一段', 't1'),
      tool('a', 'ReadTool', done),
      text('第二段', 't2'),
      tool('b', 'GrepTool', done),
      text('第三段', 't3'),
    ]);

    expect(html.match(/执行过程/g)).toHaveLength(1);
    expect(html.indexOf('第一段')).toBeLessThan(html.indexOf('执行过程'));
    expect(html.indexOf('执行过程')).toBeLessThan(html.indexOf('第二段'));
    expect(html.indexOf('第二段')).toBeLessThan(html.indexOf('第三段'));
    expect(html).not.toContain('ReadTool');
    expect(html).not.toContain('GrepTool');
  });

  it('keeps approvals, questions, failures, missing results and notices outside the fold once', () => {
    const html = pane(
      [
        tool('normal', 'NormalTool', done),
        tool('failed', 'FailedTool', { result: 'Error: boom', startedAt: 1, endedAt: 2 }),
        tool('missing', 'MissingTool'),
        tool('ask', 'AskUserQuestion', done),
        tool('approved', 'mcp__B__write', done),
        notice('流式错误', 'notice-1'),
      ],
      {
        approvalItems: [approval('ap-1', 'B'), approval('ap-2', 'C')],
        questions: new Map([['ask', question]]),
      },
    );

    expect(html).not.toContain('NormalTool');
    expect(html.match(/FailedTool/g)).toHaveLength(1);
    expect(html.match(/MissingTool/g)).toHaveLength(1);
    // 状态文字同时给读屏与视觉各一份，工具项本身只出现一次。
    expect(html).toContain('未收到结果');
    expect(html.match(/选哪个方案？/g)).toHaveLength(1);
    expect(html).not.toContain('AskUserQuestion');
    expect(html.match(/aria-label="批准 B \/ write"/g)).toHaveLength(1);
    expect(html.match(/aria-label="批准 C \/ write"/g)).toHaveLength(1);
    expect(html.match(/流式错误/g)).toHaveLength(1);
  });

  it('keeps a parent group visible when one child needs attention', () => {
    const html = pane([
      tool('parent', 'TaskTool', done),
      tool('child', 'ChildTool', { parentToolUseId: 'parent' }),
    ]);

    expect(html).not.toContain('执行过程');
    expect(html.match(/TaskTool/g)).toHaveLength(1);
    expect(html.match(/ChildTool/g)).toHaveLength(1);
    expect(html).toContain('未收到结果');
    // 无待处理子调用时，父组与子调用一起收进执行过程。
    const quiet = pane([
      tool('batch', 'BatchTool', done),
      tool('batch-child', 'BatchChild', { ...done, parentToolUseId: 'batch' }),
    ]);
    expect(quiet.match(/执行过程/g)).toHaveLength(1);
    expect(quiet).not.toContain('BatchTool');
    expect(quiet).not.toContain('BatchChild');
  });

  it('opens the trace while the turn is running and folds it after completion', () => {
    const live = pane([tool('run', 'RunningTool', { startedAt: 1 })], { running: true });
    expect(live).toContain('执行过程');
    expect(live).toContain('RunningTool');

    const settled = pane([tool('run', 'RunningTool', done)]);
    expect(settled).toContain('执行过程');
    expect(settled).not.toContain('RunningTool');
  });

  it('keeps a child approval outside the fold through its parent group', () => {
    const html = pane(
      [
        tool('parent', 'TaskTool', done),
        tool('child', 'mcp__B__write', { ...done, parentToolUseId: 'parent' }),
      ],
      { approvalItems: [approval('ap-1', 'B')] },
    );

    expect(html).not.toContain('执行过程');
    expect(html.match(/TaskTool/g)).toHaveLength(1);
    expect(html.match(/mcp__B__write/g)).toHaveLength(1);
    expect(html.match(/aria-label="批准 B \/ write"/g)).toHaveLength(1);
  });

  it('places an approval once on the pending call, not on identical historical successes', () => {
    const html = pane(
      [
        user('旧问题', 'u1'),
        tool('old', 'mcp__B__write', done),
        text('旧回复', 'a1', 'run-old'),
        user('新问题', 'u2'),
        tool('current', 'mcp__B__write', { startedAt: 1 }),
      ],
      { approvalItems: [approval('ap-1', 'B')] },
    );

    // 历史成功留在自己的执行过程里，当前待批单独成行并承载唯一一张审批卡。
    expect(html.match(/执行过程/g)).toHaveLength(1);
    expect(html.match(/mcp__B__write/g)).toHaveLength(1);
    expect(html.match(/aria-label="批准 B \/ write"/g)).toHaveLength(1);
  });

  it('prefers the only unfinished call when successes and a pending call share a turn', () => {
    const html = pane(
      [
        user('问题', 'u1'),
        tool('old', 'mcp__B__write', done),
        tool('current', 'mcp__B__write', { startedAt: 1 }),
      ],
      { approvalItems: [approval('ap-1', 'B')] },
    );

    expect(html.match(/执行过程/g)).toHaveLength(1);
    expect(html.match(/mcp__B__write/g)).toHaveLength(1);
    expect(html.match(/aria-label="批准 B \/ write"/g)).toHaveLength(1);
  });

  it('falls back to one card at the end when no single call can host the approval', () => {
    const html = pane(
      [
        user('问题', 'u1'),
        tool('first', 'mcp__B__write', done),
        tool('second', 'mcp__B__write', done),
      ],
      { approvalItems: [approval('ap-1', 'B')] },
    );

    expect(html.match(/执行过程/g)).toHaveLength(1);
    expect(html).not.toContain('mcp__B__write');
    expect(html.match(/aria-label="批准 B \/ write"/g)).toHaveLength(1);
  });

  it('keeps the todo list outside the folded trace', () => {
    const items = historyToItems([
      message('m1', 'assistant', [
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'ok',
          todos: [{ content: '整理资料', activeForm: '整理资料中', status: 'in_progress' }],
        },
      ]),
    ]);
    const html = pane(items);
    expect(html).toContain('执行过程');
    expect(html).toContain('整理资料中');
  });

  it.each(['failed', 'timeout'] as const)(
    'keeps the %s reason visible on an older turn',
    (status) => {
      const html = pane(
        [
          user('旧问题', 'u1'),
          text('旧回复', 'a1', 'run-old'),
          user('新问题', 'u2'),
          text('新回复', 'a2', 'run-new'),
        ],
        {
          historyMetrics: new Map([
            [
              'run-old',
              {
                runId: 'run-old',
                status,
                error: 'Connector refused the request',
              },
            ],
          ]),
        },
      );
      expect(html).toContain('Connector refused the request');
      expect(html).not.toContain('group-focus-within/turn:opacity-100');
    },
  );

  it('still reveals a successful older turn only on hover or focus', () => {
    const html = pane(
      [
        user('旧问题', 'u1'),
        text('旧回复', 'a1', 'run-old'),
        user('新问题', 'u2'),
        text('新回复', 'a2', 'run-new'),
      ],
      {
        historyMetrics: new Map([
          ['run-old', { runId: 'run-old', status: 'succeeded', durationMs: 1200 }],
        ]),
      },
    );
    expect(html).toContain('group-focus-within/turn:opacity-100');
  });
});
