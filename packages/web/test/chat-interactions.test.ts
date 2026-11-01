import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { ApprovalCard, Composer } from '../src/pages/chat.js';

vi.mock('../src/lib/chat-store.js', async (original) => {
  const { useChatStore: store } = await original<typeof import('../src/lib/chat-store.js')>();
  return {
    useChatStore: Object.assign(
      (selector: (state: ReturnType<typeof store.getState>) => unknown) =>
        selector(store.getState()),
      store,
    ),
  };
});

vi.mock('@/components/ui/button', async () => import('../src/components/ui/button.js'));

// Composer 直接作为函数调用，没有路由上下文；这里固定返回当前位置。
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => createElement('a', null, children),
  useLocation: () => ({ href: '/chat' }),
}));

// Composer 直接作为函数调用，没有 QueryClientProvider；这里固定返回管理员 grants。
vi.mock('@tanstack/react-query', async (original) => {
  const { DEFAULT_ROLES } = await import('@agentport/shared');
  return {
    ...(await original<typeof import('@tanstack/react-query')>()),
    useQuery: () => ({
      data: {
        authenticated: true,
        user: { businessId: 'admin', username: 'admin', name: '管理员' },
        roles: [],
        grants: [...DEFAULT_ROLES.find((role) => role.systemKey === 'admin')!.grants],
      },
    }),
  };
});

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useDebugValue: () => {},
}));

function approval(serverName: string | null, id = serverName ?? 'unknown'): ApprovalRequest {
  return { id, serverId: id, serverName, toolName: 'write', approvedAt: null, createdAt: '' };
}
function findElement(
  node: ReactElement,
  predicate: (props: Record<string, unknown>) => boolean,
): ReactElement | undefined {
  const props = node.props as Record<string, unknown>;
  if (predicate(props)) return node;
  for (const child of [props.children].flat(Infinity)) {
    if (child && typeof child === 'object' && 'props' in child) {
      const found = findElement(child as ReactElement, predicate);
      if (found) return found;
    }
  }
}

beforeEach(() => useChatStore.getState().reset());

describe('approval card', () => {
  it('disables every approval while labeling only the matching request pending', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ApprovalCard, {
          item: { ...approval('A'), waiting: true },
          pending: 'A',
          onApprove() {},
        }),
        createElement(ApprovalCard, { item: approval('B'), pending: 'A', onApprove() {} }),
      ),
    );
    expect(html.match(/<button\b[^>]*disabled/g)).toHaveLength(2);
    expect(html.match(/批准中…/g)).toHaveLength(1);
    expect(html).toContain('aria-label="批准 A / write"');
    expect(html).toContain('aria-label="批准 B / write"');
    expect(html).toContain('调用仍在等待，批准后可继续本次调用，无需重发');
    expect(html).toContain('本次调用已结束等待，批准仅对后续调用生效，不会恢复已结束的调用。');
    expect(html).toContain('>批准后续调用</button>');
  });
});

describe('composer keyboard handling', () => {
  it('blocks the form and Enter until history is ready', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tree = Composer({
      agent: null,
      send,
      textareaRef: { current: null },
      lastRunId: null,
      welcome: false,
      historyReady: false,
    });
    const textarea = findElement(tree, (props) => props['aria-label'] === '消息');
    const button = findElement(tree, (props) => props['aria-label'] === '发送消息');
    if (!textarea || !button) throw new Error('Expected composer controls');
    expect((textarea.props as { disabled: boolean }).disabled).toBe(true);
    expect((button.props as { disabled: boolean }).disabled).toBe(true);
    (textarea.props as { onKeyDown: (event: unknown) => void }).onKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: {},
      preventDefault() {},
    });
    (tree.props as { onSubmit: (event: unknown) => void }).onSubmit({ preventDefault() {} });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])('does not submit IME confirmation %j', (nativeEvent) => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tree = Composer({
      agent: null,
      send,
      textareaRef: { current: null },
      lastRunId: null,
      welcome: false,
    });
    const textarea = findElement(tree, (props) => props['aria-label'] === '消息');
    const preventDefault = vi.fn();
    if (!textarea) throw new Error('Expected message textarea');
    const onKeyDown = (textarea.props as { onKeyDown: (event: unknown) => void }).onKeyDown;
    onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent, preventDefault });
    expect(send).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it('submits plain Enter and preserves Shift+Enter', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tree = Composer({
      agent: null,
      send,
      textareaRef: { current: null },
      lastRunId: null,
      welcome: false,
    });
    const textarea = findElement(tree, (props) => props['aria-label'] === '消息');
    if (!textarea) throw new Error('Expected message textarea');
    const onKeyDown = (textarea.props as { onKeyDown: (event: unknown) => void }).onKeyDown;
    const preventDefault = vi.fn();
    onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: {}, preventDefault });
    expect(send).not.toHaveBeenCalled();
    onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault });
    expect(send).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
