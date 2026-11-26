import type { ConversationMessage } from '@agentport/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { MessagePane } from '../src/components/chat/chat-thread/message-pane.js';
import { historyToItems } from '../src/lib/chat-state.js';

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

test('只有能拿到原始 id 的用户轮显示分支按钮', () => {
  expect(pane(historyToItems([message('m1')]))).toContain('aria-label="从这条消息分支"');
  expect(pane([{ kind: 'user', text: '新消息' }])).not.toContain('aria-label="从这条消息分支"');
  expect(pane(historyToItems([message('run:0', '')]))).not.toContain('aria-label="从这条消息分支"');
});
