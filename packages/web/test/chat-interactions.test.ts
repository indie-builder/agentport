import { type AgentSummary, agentInputSchema, DEFAULT_ROLES } from '@agentport/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard, Composer } from '../src/components/chat/chat-thread.js';
import { type ApprovalRequest, api } from '../src/lib/api.js';
import { useChatStore } from '../src/lib/chat-store.js';
import { meQuery } from '../src/lib/queries.js';

const adminRole = DEFAULT_ROLES.find((role) => role.systemKey === 'admin');
if (adminRole === undefined) throw new Error('admin role is missing');

const adminMe = {
  authenticated: true as const,
  user: { businessId: 'admin', username: 'admin', name: '管理员' },
  roles: [],
  grants: [...adminRole.grants],
};

const sampleAgent: AgentSummary = {
  ...agentInputSchema.parse({ slug: 'expert', name: 'Expert' }),
  id: 'agent-a',
  isDefault: false,
  parentId: null,
  createdAt: '',
  updatedAt: '',
};

function approval(serverName: string | null, id = serverName ?? 'unknown'): ApprovalRequest {
  return {
    id,
    serverId: id,
    serverName,
    toolName: 'write',
    approvedAt: null,
    deniedAt: null,
    createdAt: '',
    expiresAt: null,
    waiting: false,
  };
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;

async function mountComposer(props: ComponentProps<typeof Composer>): Promise<void> {
  const rootRoute = createRootRoute({ component: Outlet });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/chat',
    component: () => createElement(Composer, props),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([chatRoute]),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
  });

  await act(async () => {
    await router.load();
    root.render(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  });
  await act(async () => {});
}

function getComposerControls() {
  const form = host.querySelector('form');
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]');
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]');
  if (!form || !textarea || !button) throw new Error('Expected composer controls');
  return { form, textarea, button };
}

function dispatchEnter(
  target: HTMLElement,
  options: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: options.shiftKey ?? false,
    isComposing: options.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: options.keyCode });
    Object.defineProperty(event, 'which', { value: options.keyCode });
  }
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  useChatStore.getState().reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(meQuery.queryKey, adminMe);
  vi.spyOn(api, 'me').mockResolvedValue(adminMe);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
  vi.restoreAllMocks();
});

describe('approval card', () => {
  it('enables only the waiting approval action and invokes onApprove on click', async () => {
    const onApprove = vi.fn();
    const itemA = { ...approval('A'), waiting: true };
    const itemB = approval('B');

    await act(async () => {
      root.render(
        createElement(
          'div',
          null,
          createElement(ApprovalCard, { item: itemA, pending: null, onApprove }),
          createElement(ApprovalCard, { item: itemB, pending: null, onApprove }),
        ),
      );
    });

    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    const approveButton = buttons[0];
    if (!approveButton) throw new Error('Expected approval button');
    expect(approveButton.disabled).toBe(false);
    expect(approveButton.getAttribute('aria-label')).toBe('批准 A / write');
    expect(approveButton.textContent).toBe('批准本次调用');
    expect(host.querySelector('button[aria-label="批准 B / write"]')).toBeNull();
    expect(host.textContent).toContain('调用仍在等待，批准后可继续本次调用，无需重发');
    expect(host.textContent).toContain('批准仅对本次运行的当前判定有效。');
    expect(host.textContent).toContain('审批已失效，请让智能体重新发起。');

    await act(async () => {
      approveButton.click();
    });
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledWith(itemA);
  });

  it('shows pending state on the active approval and explains expired approvals', async () => {
    await act(async () => {
      root.render(
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
    });

    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    const pendingButton = buttons[0];
    if (!pendingButton) throw new Error('Expected pending approval button');
    expect(pendingButton.disabled).toBe(true);
    expect(pendingButton.getAttribute('aria-busy')).toBe('true');
    expect(pendingButton.getAttribute('aria-label')).toBe('批准 A / write');
    expect(pendingButton.textContent).toBe('批准中…');
    expect(host.querySelector('button[aria-label="批准 B / write"]')).toBeNull();
    expect(host.textContent).toContain('调用仍在等待，批准后可继续本次调用，无需重发');
    expect(host.textContent).toContain('审批已失效，请让智能体重新发起。');
  });
});

describe('composer keyboard handling', () => {
  it('blocks the form and Enter until history is ready', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    useChatStore.getState().setInput('hello');
    await mountComposer({
      agent: sampleAgent,
      send,
      textareaRef: { current: null },
      welcome: false,
      historyReady: false,
    });

    const { form, textarea, button } = getComposerControls();
    expect(textarea.disabled).toBe(true);
    expect(button.disabled).toBe(true);

    await act(async () => {
      dispatchEnter(textarea);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])('does not submit IME confirmation %j', async (imeEvent) => {
    const send = vi.fn().mockResolvedValue(undefined);
    useChatStore.getState().setInput('nihao');
    await mountComposer({
      agent: sampleAgent,
      send,
      textareaRef: { current: null },
      welcome: false,
    });

    const { textarea } = getComposerControls();
    let dispatched: KeyboardEvent | undefined;
    await act(async () => {
      dispatched = dispatchEnter(textarea, imeEvent);
    });

    expect(send).not.toHaveBeenCalled();
    expect(dispatched?.defaultPrevented).toBe(false);
  });

  it('submits plain Enter and preserves Shift+Enter', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    useChatStore.getState().setInput('hello');
    await mountComposer({
      agent: sampleAgent,
      send,
      textareaRef: { current: null },
      welcome: false,
    });

    const { textarea } = getComposerControls();
    let shiftEnter: KeyboardEvent | undefined;
    await act(async () => {
      shiftEnter = dispatchEnter(textarea, { shiftKey: true });
    });

    expect(send).not.toHaveBeenCalled();
    expect(shiftEnter?.defaultPrevented).toBe(false);

    let plainEnter: KeyboardEvent | undefined;
    await act(async () => {
      plainEnter = dispatchEnter(textarea);
    });

    expect(send).toHaveBeenCalledOnce();
    expect(plainEnter?.defaultPrevented).toBe(true);
  });
});
