import type { AuthMe, Server } from '@agentport/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { settle } from '@ui-sdk/core/testing';
import { act, createElement, type ReactElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.js';
import { Button } from '../src/components/ui/button.js';
import { Field, FieldLabel } from '../src/components/ui/field.js';
import { Input } from '../src/components/ui/input.js';
import { Textarea } from '../src/components/ui/textarea.js';
import { UiAgentHost } from '../src/components/ui-agent-host.js';
import { api } from '../src/lib/api.js';
import { queryClient } from '../src/lib/queries.js';
import {
  createUiAgent,
  setUiAgentConfirmHandler,
  type UiAgentConfirmHandler,
  uiAgent,
} from '../src/lib/ui-agent.js';
import { ServerFormDialog } from '../src/pages/servers/server-form-dialog.js';
import { routeTree } from '../src/routeTree.gen.js';

vi.mock('../src/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, me: vi.fn(), login: vi.fn(), agentReference: vi.fn() },
  };
});

interface MockModelContextTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: object;
  execute: (input: object, context?: { signal?: AbortSignal }) => unknown;
}

interface MockModelContext {
  registerTool: (tool: MockModelContextTool, options?: { signal?: AbortSignal }) => Promise<void>;
  unregisterTool: (name: string) => void;
}

let host: HTMLDivElement;
let root: Root;
let activeHistory: ReturnType<typeof createMemoryHistory> | undefined;
let originalModelContextDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalModelContextDescriptor = Object.getOwnPropertyDescriptor(document, 'modelContext');
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  vi.mocked(api.me).mockReset();
  vi.mocked(api.login).mockReset();
  vi.mocked(api.agentReference).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  setUiAgentConfirmHandler(null);
  await act(async () => root.unmount());
  activeHistory?.destroy();
  activeHistory = undefined;
  host.remove();
  document.body.replaceChildren();
  queryClient.clear();
  if (originalModelContextDescriptor) {
    Object.defineProperty(document, 'modelContext', originalModelContextDescriptor);
  } else {
    Reflect.deleteProperty(document, 'modelContext');
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
});

async function render(element: ReactElement) {
  await act(async () => root.render(element));
  await flushUi();
}

async function flushUi() {
  await act(async () => {
    await settle();
  });
}

async function typeIntoField(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    element.focus();
    setter?.call(element, text);
    element.dispatchEvent(new InputEvent('input', { data: text, bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
}

function findDialogButton(dialog: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(dialog.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`Missing dialog button: ${text}`);
  }
  return button;
}

function getAlertDialog(): HTMLElement {
  const dialogs = Array.from(document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]'));
  const dialog = dialogs.find((item) => item.textContent?.includes('确认智能体操作'));
  if (!dialog) {
    throw new Error('Missing UiAgentHost alertdialog');
  }
  return dialog;
}

function hasHostAlertDialog(): boolean {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]')).some(
    (item) => item.textContent?.includes('确认智能体操作'),
  );
}

async function startPendingAct(
  steps: Parameters<typeof uiAgent.act>[0]['steps'],
  options?: Parameters<typeof uiAgent.act>[1],
): Promise<{ promise: ReturnType<typeof uiAgent.act> }> {
  let pending!: ReturnType<typeof uiAgent.act>;
  await act(async () => {
    pending = uiAgent.act({ steps }, options);
    await settle();
  });
  return { promise: pending };
}

function installMockModelContext() {
  const tools = new Map<string, MockModelContextTool>();
  const signals = new Map<string, AbortSignal | undefined>();
  const unregisterTool = vi.fn((name: string) => {
    tools.delete(name);
  });
  const registerTool = vi.fn(
    async (tool: MockModelContextTool, options?: { signal?: AbortSignal }) => {
      tools.set(tool.name, tool);
      signals.set(tool.name, options?.signal);
      options?.signal?.addEventListener(
        'abort',
        () => {
          unregisterTool(tool.name);
        },
        { once: true },
      );
    },
  );
  const modelContext: MockModelContext = { registerTool, unregisterTool };
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    writable: true,
    value: modelContext,
  });
  return { tools, signals, registerTool, unregisterTool };
}

async function mountWithInlineRouter(element: ReactElement) {
  const rootRoute = createRootRoute({ component: () => element });
  activeHistory = createMemoryHistory({ initialEntries: ['/'] });
  const router = createRouter({ routeTree: rootRoute, history: activeHistory });
  await act(async () => {
    await router.load();
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  await flushUi();
}

describe('lib/ui-agent bridge and confirm handler registration', () => {
  it('denies data-agent-confirm actions without a confirm handler while allowing normal actions', async () => {
    const isolatedAgent = createUiAgent();
    const onNormal = vi.fn();
    const onSensitive = vi.fn();

    await render(
      createElement(
        'div',
        null,
        createElement(Button, { type: 'button', onClick: onNormal }, '执行普通动作'),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '删除孤立测试数据', onClick: onSensitive },
          '执行受保护动作',
        ),
      ),
    );

    const normalResult = await isolatedAgent.act({
      steps: [{ ref: '执行普通动作', action: 'press' }],
    });
    expect(normalResult.ok, normalResult.error?.message).toBe(true);
    expect(onNormal).toHaveBeenCalledTimes(1);

    const deniedResult = await isolatedAgent.act({
      steps: [{ ref: '执行受保护动作', action: 'press' }],
    });
    expect(deniedResult.ok).toBe(false);
    expect(deniedResult.error?.message).toBeTruthy();
    expect(onSensitive).not.toHaveBeenCalled();
  });

  it('registers confirm handlers and returns a cleanup that only clears if still active', async () => {
    const onAction = vi.fn();
    await render(
      createElement(
        Button,
        { type: 'button', 'data-agent-confirm': '确认清理边界', onClick: onAction },
        '验证句柄清理',
      ),
    );

    const firstHandler = vi.fn<UiAgentConfirmHandler>(async () => false);
    const secondHandler = vi.fn<UiAgentConfirmHandler>(async () => true);

    const clearFirst = setUiAgentConfirmHandler(firstHandler);
    let clearSecond: (() => void) | undefined;
    try {
      const firstResult = await uiAgent.act({
        steps: [{ ref: '验证句柄清理', action: 'press' }],
      });
      expect(firstResult.ok).toBe(false);
      expect(firstHandler).toHaveBeenCalledTimes(1);
      expect(firstHandler.mock.calls[0]?.[0]).toBe('确认清理边界');
      expect(firstHandler.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(onAction).not.toHaveBeenCalled();

      clearSecond = setUiAgentConfirmHandler(secondHandler);
      clearFirst();

      const secondResult = await uiAgent.act({
        steps: [{ ref: '验证句柄清理', action: 'press' }],
      });
      expect(secondResult.ok, secondResult.error?.message).toBe(true);
      expect(firstHandler).toHaveBeenCalledTimes(1);
      expect(secondHandler).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledTimes(1);

      clearSecond();
      const thirdResult = await uiAgent.act({
        steps: [{ ref: '验证句柄清理', action: 'press' }],
      });
      expect(thirdResult.ok).toBe(false);
      expect(secondHandler).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledTimes(1);
    } finally {
      clearFirst();
      clearSecond?.();
    }
  });
});

describe('UiAgentHost end-to-end confirmation flow', () => {
  it('hides the confirm dialog from snapshot, handles reject and allow, aborts cleanly, and settles on unmount', async () => {
    const onDanger = vi.fn();

    function HostHarness({ showHost }: { showHost: boolean }) {
      return createElement(
        'div',
        null,
        showHost ? createElement(UiAgentHost) : null,
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '删除测试项目', onClick: onDanger },
          '删除测试项目按钮',
        ),
      );
    }

    await render(createElement(HostHarness, { showHost: true }));

    const rejectedPending = await startPendingAct([{ ref: '删除测试项目按钮', action: 'press' }]);
    const rejectDialog = getAlertDialog();
    expect(rejectDialog.textContent).toContain('确认智能体操作');
    expect(rejectDialog.textContent).toContain('删除测试项目');

    const snapshotWhileOpen = uiAgent.snapshot().filter((entry) => !entry.offPage);
    expect(snapshotWhileOpen.some((entry) => entry.component === 'alert-dialog')).toBe(false);
    expect(
      snapshotWhileOpen.some((entry) =>
        ['确认智能体操作', '允许执行', '拒绝'].includes(entry.label ?? ''),
      ),
    ).toBe(false);
    expect(
      snapshotWhileOpen.some(
        (entry) =>
          entry.buttons?.includes('允许执行') ||
          entry.buttons?.includes('拒绝') ||
          entry.text?.includes('删除测试项目'),
      ),
    ).toBe(false);

    await act(async () => {
      findDialogButton(rejectDialog, '拒绝').click();
      await settle();
    });
    const rejectedResult = await rejectedPending.promise;
    expect(rejectedResult.ok).toBe(false);
    expect(onDanger).not.toHaveBeenCalled();
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const allowedPending = await startPendingAct([{ ref: '删除测试项目按钮', action: 'press' }]);
    const allowDialog = getAlertDialog();
    await act(async () => {
      findDialogButton(allowDialog, '允许执行').click();
      await settle();
    });
    const allowedResult = await allowedPending.promise;
    expect(allowedResult.ok, allowedResult.error?.message).toBe(true);
    expect(onDanger).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const abortController = new AbortController();
    const abortedPending = await startPendingAct([{ ref: '删除测试项目按钮', action: 'press' }], {
      signal: abortController.signal,
    });
    expect(hasHostAlertDialog()).toBe(true);
    await act(async () => {
      abortController.abort();
      await settle();
    });
    const abortedResult = await abortedPending.promise;
    expect(abortedResult.ok).toBe(false);
    expect(abortedResult.error?.message).toContain('cancelled');
    expect(onDanger).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const unmountPending = await startPendingAct([{ ref: '删除测试项目按钮', action: 'press' }]);
    expect(hasHostAlertDialog()).toBe(true);
    await render(createElement(HostHarness, { showHost: false }));
    const unmountResult = await unmountPending.promise;
    expect(unmountResult.ok).toBe(false);
    expect(onDanger).toHaveBeenCalledTimes(1);
    expect(hasHostAlertDialog()).toBe(false);
  });

  it('queues concurrent confirmation requests and resolves each dialog independently', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const secondaryAgent = createUiAgent();

    await render(
      createElement(
        'div',
        null,
        createElement(UiAgentHost),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '删除第一个资源', onClick: onFirst },
          '触发第一操作',
        ),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '删除第二个资源', onClick: onSecond },
          '触发第二操作',
        ),
      ),
    );

    let firstPending!: ReturnType<typeof uiAgent.act>;
    let secondPending!: ReturnType<typeof secondaryAgent.act>;
    await act(async () => {
      firstPending = uiAgent.act({ steps: [{ ref: '触发第一操作', action: 'press' }] });
      secondPending = secondaryAgent.act({ steps: [{ ref: '触发第二操作', action: 'press' }] });
      await settle();
    });

    const firstDialogs = document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]');
    expect(firstDialogs).toHaveLength(1);
    const firstDialog = getAlertDialog();
    expect(firstDialog.textContent).toContain('删除第一个资源');
    expect(firstDialog.textContent).not.toContain('删除第二个资源');
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).not.toHaveBeenCalled();
    expect(
      await Promise.race([secondPending.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending');

    await act(async () => {
      findDialogButton(firstDialog, '拒绝').click();
      await settle();
    });

    const firstResult = await firstPending;
    expect(firstResult.ok).toBe(false);
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).not.toHaveBeenCalled();
    expect(
      await Promise.race([secondPending.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending');

    const secondDialog = getAlertDialog();
    expect(secondDialog.textContent).toContain('删除第二个资源');

    await act(async () => {
      findDialogButton(secondDialog, '允许执行').click();
      await settle();
    });

    const secondResult = await secondPending;
    expect(secondResult.ok, secondResult.error?.message).toBe(true);
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    let thirdPending!: ReturnType<typeof uiAgent.act>;
    let fourthPending!: ReturnType<typeof uiAgent.act>;
    await act(async () => {
      thirdPending = uiAgent.act({ steps: [{ ref: '触发第一操作', action: 'press' }] });
      fourthPending = uiAgent.act({ steps: [{ ref: '触发第二操作', action: 'press' }] });
      await settle();
    });

    const thirdDialog = getAlertDialog();
    expect(thirdDialog.textContent).toContain('删除第一个资源');
    expect(
      await Promise.race([fourthPending.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending');

    await act(async () => {
      findDialogButton(thirdDialog, '允许执行').click();
      await thirdPending;
      await settle();
    });

    const thirdResult = await thirdPending;
    expect(thirdResult.ok, thirdResult.error?.message).toBe(true);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onSecond).toHaveBeenCalledTimes(1);

    const fourthDialog = getAlertDialog();
    expect(fourthDialog.textContent).toContain('删除第二个资源');

    await act(async () => {
      findDialogButton(fourthDialog, '拒绝').click();
      await settle();
    });

    const fourthResult = await fourthPending;
    expect(fourthResult.ok).toBe(false);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onSecond).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);
  });

  it('rejects confirmation and closes the dialog when Escape is pressed', async () => {
    const onConfirm = vi.fn();

    await render(
      createElement(
        'div',
        null,
        createElement(UiAgentHost),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '重置系统配置', onClick: onConfirm },
          '重置配置按钮',
        ),
      ),
    );

    const pending = await startPendingAct([{ ref: '重置配置按钮', action: 'press' }]);
    const dialog = getAlertDialog();
    expect(dialog.textContent).toContain('重置系统配置');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const target = document.activeElement instanceof HTMLElement ? document.activeElement : dialog;
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      target.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await settle();
    });

    const result = await pending.promise;
    expect(result.ok).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);
  });

  it('keeps the confirmation dialog open and pending on backdrop click', async () => {
    const onConfirm = vi.fn();

    await render(
      createElement(
        'div',
        null,
        createElement(UiAgentHost),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '清空工作区缓存', onClick: onConfirm },
          '清空缓存按钮',
        ),
      ),
    );

    const pending = await startPendingAct([{ ref: '清空缓存按钮', action: 'press' }]);
    const dialog = getAlertDialog();
    expect(dialog.textContent).toContain('清空工作区缓存');

    const backdrop = document.body.querySelector<HTMLElement>(
      '[data-slot="alert-dialog-backdrop"]',
    );
    if (!backdrop) {
      throw new Error('Missing UiAgentHost backdrop');
    }

    await act(async () => {
      backdrop.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 1,
        }),
      );
      backdrop.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 1,
        }),
      );
      backdrop.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 0,
        }),
      );
      backdrop.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 0,
        }),
      );
      backdrop.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: 1,
        }),
      );
      await settle();
    });

    expect(hasHostAlertDialog()).toBe(true);
    expect(getAlertDialog().textContent).toContain('清空工作区缓存');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      await Promise.race([pending.promise.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending');

    await act(async () => {
      findDialogButton(getAlertDialog(), '允许执行').click();
      await settle();
    });

    const result = await pending.promise;
    expect(result.ok, result.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);
  });
});

describe('WebMCP registerTools bridge on UiAgentHost', () => {
  it('registers snapshot, query, and act on mount, executes tools with single confirmation, and unregisters on unmount', async () => {
    const { tools, signals, registerTool, unregisterTool } = installMockModelContext();
    const onNormal = vi.fn();
    const onConfirm = vi.fn();

    await render(
      createElement(
        'div',
        null,
        createElement(UiAgentHost),
        createElement(Button, { type: 'button', onClick: onNormal }, 'WebMCP普通按钮'),
        createElement(
          Button,
          { type: 'button', 'data-agent-confirm': '执行WebMCP敏感操作', onClick: onConfirm },
          'WebMCP确认按钮',
        ),
      ),
    );

    expect(registerTool).toHaveBeenCalledTimes(3);
    expect([...tools.keys()].sort()).toEqual(['act', 'query', 'snapshot']);

    const snapshotTool = tools.get('snapshot');
    const actTool = tools.get('act');
    if (!snapshotTool || !actTool) {
      throw new Error('Missing registered WebMCP tools');
    }

    const snap = await snapshotTool.execute({});
    expect(Array.isArray(snap)).toBe(true);
    const snapEntries = (snap as Array<{ label?: string; offPage?: boolean }>).filter(
      (entry) => !entry.offPage,
    );
    expect(snapEntries.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(['WebMCP普通按钮', 'WebMCP确认按钮']),
    );

    const normalRes = (await act(async () =>
      actTool.execute({ steps: [{ ref: 'WebMCP普通按钮', action: 'press' }] }),
    )) as { ok: boolean; error?: { message: string } };
    expect(normalRes.ok, normalRes.error?.message).toBe(true);
    expect(onNormal).toHaveBeenCalledTimes(1);

    let pendingToolAct!: Promise<unknown>;
    await act(async () => {
      pendingToolAct = Promise.resolve(
        actTool.execute({ steps: [{ ref: 'WebMCP确认按钮', action: 'press' }] }),
      );
      await settle();
    });

    const dialogs = Array.from(document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]'));
    expect(dialogs).toHaveLength(1);
    const confirmDialog = dialogs[0];
    if (!confirmDialog) {
      throw new Error('Missing WebMCP confirmation dialog');
    }
    expect(confirmDialog.textContent).toContain('执行WebMCP敏感操作');

    await act(async () => {
      findDialogButton(confirmDialog, '允许执行').click();
      await settle();
    });

    const confirmRes = (await pendingToolAct) as { ok: boolean; error?: { message: string } };
    expect(confirmRes.ok, confirmRes.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    await act(async () => root.unmount());
    expect(signals.get('snapshot')?.aborted).toBe(true);
    expect(signals.get('query')?.aborted).toBe(true);
    expect(signals.get('act')?.aborted).toBe(true);
    expect(unregisterTool).toHaveBeenCalledTimes(3);
    expect(tools.size).toBe(0);
  });

  it('preserves uiAgent confirmation dialog and WebMCP registerTools across React StrictMode double-mount', async () => {
    const { tools, signals, registerTool, unregisterTool } = installMockModelContext();
    const onConfirm = vi.fn();

    await render(
      createElement(
        StrictMode,
        null,
        createElement(
          'div',
          null,
          createElement(UiAgentHost),
          createElement(
            Button,
            { type: 'button', 'data-agent-confirm': 'StrictMode敏感操作', onClick: onConfirm },
            'StrictMode确认按钮',
          ),
        ),
      ),
    );

    expect(registerTool).toHaveBeenCalledTimes(6);
    expect(unregisterTool).toHaveBeenCalledTimes(3);
    expect([...tools.keys()].sort()).toEqual(['act', 'query', 'snapshot']);
    expect(signals.get('snapshot')?.aborted).toBe(false);
    expect(signals.get('query')?.aborted).toBe(false);
    expect(signals.get('act')?.aborted).toBe(false);

    const directPending = await startPendingAct([{ ref: 'StrictMode确认按钮', action: 'press' }]);
    const directDialog = getAlertDialog();
    expect(directDialog.textContent).toContain('StrictMode敏感操作');

    await act(async () => {
      findDialogButton(directDialog, '允许执行').click();
      await settle();
    });

    const directResult = await directPending.promise;
    expect(directResult.ok, directResult.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const actTool = tools.get('act');
    if (!actTool) {
      throw new Error('Missing WebMCP act tool after StrictMode remount');
    }

    let pendingToolAct!: Promise<unknown>;
    await act(async () => {
      pendingToolAct = Promise.resolve(
        actTool.execute({ steps: [{ ref: 'StrictMode确认按钮', action: 'press' }] }),
      );
      await settle();
    });

    const webMcpDialog = getAlertDialog();
    expect(webMcpDialog.textContent).toContain('StrictMode敏感操作');

    await act(async () => {
      findDialogButton(webMcpDialog, '允许执行').click();
      await settle();
    });

    const toolResult = (await pendingToolAct) as { ok: boolean; error?: { message: string } };
    expect(toolResult.ok, toolResult.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(2);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    await act(async () => root.unmount());
    expect(signals.get('snapshot')?.aborted).toBe(true);
    expect(signals.get('query')?.aborted).toBe(true);
    expect(signals.get('act')?.aborted).toBe(true);
    expect(unregisterTool).toHaveBeenCalledTimes(6);
    expect(tools.size).toBe(0);
  });
});

describe('real app UI agent-readiness checks', () => {
  it('exposes LoginPage labels and keeps PasswordInput redacted before and after visibility toggle', async () => {
    vi.mocked(api.me).mockResolvedValue({ authenticated: false } satisfies AuthMe);
    activeHistory = createMemoryHistory({ initialEntries: ['/login'] });
    const router = createRouter({ routeTree, history: activeHistory });

    await act(async () => {
      await router.load();
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(RouterProvider, { router }),
        ),
      );
    });
    await flushUi();

    expect(host.querySelector('h1')?.textContent).toBe('登录 PACE');

    const initialSnapshot = uiAgent.snapshot().filter((entry) => !entry.offPage);
    const labels = initialSnapshot.map((entry) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(['用户名', '密码', '登录']));

    const passwordInput = host.querySelector<HTMLInputElement>('input#password');
    const toggleButton = host.querySelector<HTMLButtonElement>('button[aria-label="显示密码"]');
    if (!passwordInput || !toggleButton) {
      throw new Error('Missing LoginPage password controls');
    }
    expect(passwordInput.type).toBe('password');

    await typeIntoField(passwordInput, 'top-secret-password');

    const hiddenEntry = uiAgent
      .snapshot()
      .find((entry) => !entry.offPage && entry.component === 'password-input');
    expect(hiddenEntry).toMatchObject({
      label: '密码',
      value: '[redacted]',
      visible: false,
    });

    await act(async () => {
      toggleButton.click();
      await settle();
    });

    expect(passwordInput.type).toBe('text');
    expect(toggleButton.getAttribute('aria-pressed')).toBe('true');

    const revealedEntry = uiAgent
      .snapshot()
      .find((entry) => !entry.offPage && entry.component === 'password-input');
    expect(revealedEntry).toMatchObject({
      label: '密码',
      value: '[redacted]',
      visible: true,
    });
  });

  it('redacts data-agent-secret Input, Textarea, and ServerFormDialog #server-env and #server-headers', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(
          Field,
          null,
          createElement(FieldLabel, { htmlFor: 'secret-token-input' }, '集成访问令牌'),
          createElement(Input, {
            id: 'secret-token-input',
            'data-agent-secret': true,
          }),
        ),
        createElement(
          Field,
          null,
          createElement(FieldLabel, { htmlFor: 'secret-pem-textarea' }, '私钥内容'),
          createElement(Textarea, {
            id: 'secret-pem-textarea',
            'data-agent-secret': true,
          }),
        ),
      ),
    );

    const actResult = await act(async () =>
      uiAgent.act({
        steps: [
          { ref: '集成访问令牌', action: 'setValue', args: ['tok_live_secret_123'] },
          { ref: '私钥内容', action: 'setValue', args: ['PRIVATE_KEY_DATA'] },
        ],
      }),
    );
    expect(actResult.ok, actResult.error?.message).toBe(true);

    const liveEntries = uiAgent.snapshot().filter((entry) => !entry.offPage);
    expect(liveEntries.find((entry) => entry.label === '集成访问令牌')).toMatchObject({
      component: 'input',
      value: '[redacted]',
    });
    expect(liveEntries.find((entry) => entry.label === '私钥内容')).toMatchObject({
      component: 'textarea',
      value: '[redacted]',
    });

    const stdioServer: Server = {
      id: 'srv_stdio',
      name: 'local-fs',
      description: '本地文件系统',
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { API_TOKEN: 'secret-env-value' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await mountWithInlineRouter(
      createElement(ServerFormDialog, {
        server: stdioServer,
        onClose: () => {},
        onSaved: () => {},
        getReturnFocus: () => null,
      }),
    );

    const envInput = document.getElementById('server-env');
    if (!(envInput instanceof HTMLTextAreaElement)) {
      throw new Error('Missing ServerFormDialog #server-env');
    }
    expect(envInput.value).toBe('API_TOKEN=secret-env-value');
    expect(
      uiAgent
        .snapshot()
        .find((entry) => !entry.offPage && entry.label === '环境变量（每行 KEY=value）'),
    ).toMatchObject({
      component: 'textarea',
      value: '[redacted]',
    });

    await typeIntoField(envInput, 'API_TOKEN=updated-secret-env');
    expect(
      uiAgent
        .snapshot()
        .find((entry) => !entry.offPage && entry.label === '环境变量（每行 KEY=value）'),
    ).toMatchObject({
      component: 'textarea',
      value: '[redacted]',
    });

    await act(async () => root.unmount());
    activeHistory?.destroy();
    activeHistory = undefined;
    root = createRoot(host);

    const httpServer: Server = {
      id: 'srv_http',
      name: 'remote-mcp',
      description: '远程连接器',
      kind: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-http-token' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await mountWithInlineRouter(
      createElement(ServerFormDialog, {
        server: httpServer,
        onClose: () => {},
        onSaved: () => {},
        getReturnFocus: () => null,
      }),
    );

    const headersInput = document.getElementById('server-headers');
    if (!(headersInput instanceof HTMLTextAreaElement)) {
      throw new Error('Missing ServerFormDialog #server-headers');
    }
    expect(headersInput.value).toBe('Authorization=Bearer secret-http-token');
    expect(
      uiAgent
        .snapshot()
        .find((entry) => !entry.offPage && entry.label === 'Headers（每行 KEY=value）'),
    ).toMatchObject({
      component: 'textarea',
      value: '[redacted]',
    });
  });

  it('guards real ConfirmDialog action via UiAgentHost confirmation before invoking onConfirm', async () => {
    const onConfirm = vi.fn(async () => {});

    function ConfirmHarness() {
      const [open, setOpen] = useState(true);
      return createElement(
        'div',
        null,
        createElement(UiAgentHost),
        createElement(ConfirmDialog, {
          open,
          onClose: () => setOpen(false),
          title: '删除连接器',
          description: '删除该连接器后不可恢复',
          confirmLabel: '确认删除连接器',
          onConfirm,
        }),
      );
    }

    await render(createElement(ConfirmHarness));

    const confirmEntry = uiAgent
      .snapshot()
      .find((entry) => !entry.offPage && entry.label === '确认删除连接器');
    expect(confirmEntry).toMatchObject({
      component: 'button',
      label: '确认删除连接器',
      confirm: '删除该连接器后不可恢复',
    });

    const rejectPending = await startPendingAct([{ ref: '确认删除连接器', action: 'press' }]);
    const rejectDialog = getAlertDialog();
    expect(rejectDialog.textContent).toContain('删除该连接器后不可恢复');

    await act(async () => {
      findDialogButton(rejectDialog, '拒绝').click();
      await settle();
    });
    const rejectedResult = await rejectPending.promise;
    expect(rejectedResult.ok).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);

    const allowPending = await startPendingAct([{ ref: '确认删除连接器', action: 'press' }]);
    const allowDialog = getAlertDialog();
    expect(allowDialog.textContent).toContain('删除该连接器后不可恢复');

    await act(async () => {
      findDialogButton(allowDialog, '允许执行').click();
      await settle();
    });
    const allowedResult = await allowPending.promise;
    expect(allowedResult.ok, allowedResult.error?.message).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await flushUi();
    expect(hasHostAlertDialog()).toBe(false);
  });
});
