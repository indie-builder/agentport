import type { ConversationMessage } from '@agentport/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { historyToItems } from '../src/lib/chat-state.js';
import { MessagePane } from '../src/pages/chat.js';

vi.mock('@/components/ui/button', async () => import('../src/components/ui/button.js'));

function message(id: string, conversationId = 'c1'): ConversationMessage {
  return {
    id,
    conversationId,
    role: 'user',
    content: { type: 'text', text: id },
    runId: null,
    createdAt: '',
  };
}

function pane(items: ReturnType<typeof historyToItems>) {
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
    }),
  );
}

test('历史用户消息带上原始 id，可用于分支', () => {
  expect(historyToItems([message('m1')])).toEqual([
    { id: 'm1:0', kind: 'user', text: 'm1', messageId: 'm1' },
  ]);
});

test('运行步骤重建的消息没有真实会话，不带分支锚点', () => {
  expect(historyToItems([message('run:0', '')])).toEqual([
    { id: 'run:0:0', kind: 'user', text: 'run:0' },
  ]);
});

test('只有能拿到原始 id 的用户轮显示分支按钮', () => {
  expect(pane(historyToItems([message('m1')]))).toContain('aria-label="从这条消息分支"');
  expect(pane([{ kind: 'user', text: '新消息' }])).not.toContain('aria-label="从这条消息分支"');
});
