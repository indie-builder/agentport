import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { ApprovalCard, Composer, findApproval } from '../src/pages/chat.js';

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

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useDebugValue: () => {},
}));

function approval(serverName: string | null, id = serverName ?? 'unknown'): ApprovalRequest {
  return { id, serverId: id, serverName, toolName: 'write', approvedAt: null, createdAt: '' };
}
const tool = { kind: 'tool', toolUseId: 'call-b', name: 'mcp__B__write' } as const;

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

describe('approval placement', () => {
  it('disables every approval while labeling only the matching request pending', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(ApprovalCard, { item: approval('A'), pending: 'A', onApprove() {} }),
        createElement(ApprovalCard, { item: approval('B'), pending: 'A', onApprove() {} }),
      ),
    );
    expect(html.match(/<button\b[^>]*disabled/g)).toHaveLength(2);
    expect(html.match(/批准中…/g)).toHaveLength(1);
    expect(html).not.toContain('批准并继续');
    expect(html).toContain('>批准</button>');
  });
  it('matches the exact server when two servers share the tool name', () => {
    const a = approval('A');
    const b = approval('B');
    expect(findApproval(tool, [a, b])).toBe(b);
  });
  it('leaves a known different server for its fallback card', () => {
    expect(findApproval(tool, [approval('A')])).toBeUndefined();
  });
  it('leaves ambiguous unknown servers for fallback cards', () => {
    expect(findApproval(tool, [approval(null, 'a'), approval(null, 'b')])).toBeUndefined();
  });
  it('accepts a unique candidate without a server name', () => {
    const candidate = approval(null);
    expect(findApproval(tool, [candidate])).toBe(candidate);
  });
  it('prefers exact identity over an unknown-server candidate', () => {
    const exact = approval('B');
    expect(findApproval(tool, [approval(null), exact])).toBe(exact);
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
