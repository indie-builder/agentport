import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * Select / TextArea 的真实提交链路：必填拦截、值进入 formState、
 * 空串覆盖字面量初值、原始快照卸载后恢复、流式期间不可操作。
 */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(program: string, props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(createElement(OpenUiBlock, { program, ...props }));
  });
}

async function settle(rounds = 12) {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(probe: () => boolean, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(probe()).toBe(true);
}

async function click(element: Element | undefined | null) {
  await act(async () => {
    (element as HTMLElement | null)?.click();
  });
}

function submit(): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '提交');
  if (!button) throw new Error('submit button not found');
  return button;
}

function trigger(): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  if (!element) throw new Error('select trigger not found');
  return element;
}

function textarea(): HTMLTextAreaElement {
  const element = host.querySelector<HTMLTextAreaElement>('textarea[name="notes"]');
  if (!element) throw new Error('textarea not found');
  return element;
}

async function choose(label: string) {
  await click(trigger());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!option) throw new Error(`option not found: ${label}`);
  await click(option);
}

async function type(value: string) {
  const element = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 恢复快照要换一个全新的根，跟真实消息重新挂载一致。 */
async function remount(
  program: string,
  initialState: Record<string, unknown>,
  props: Record<string, unknown> = {},
) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(program, { ...props, initialState });
  await settle();
}

const SELECT_FORM = [
  'root = Form("booking", buttons, [fc])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
  'fc = FormControl("人数", sel)',
  'sel = Select("people", [s1, s2], "选择人数", { required: true })',
  's1 = SelectItem("1", "1 人")',
  's2 = SelectItem("2", "2 人")',
].join('\n');

const TEXT_FORM = [
  'root = Form("booking", buttons, [fc])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
  'fc = FormControl("备注", notes)',
  'notes = TextArea("notes", "写下备注", 3)',
].join('\n');

const REQUIRED_TEXT_FORM = [
  'root = Form("booking", buttons, [fc])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
  'fc = FormControl("备注", notes)',
  'notes = TextArea("notes", "写下备注", 3, { required: true })',
].join('\n');

describe('Select', () => {
  it('blocks an empty required select, then submits the chosen value', async () => {
    const onAction = vi.fn();
    await render(SELECT_FORM, { onAction });

    await click(submit());
    await settle();
    expect(onAction).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-invalid')).toBe('true');

    await choose('2 人');
    await settle();
    expect(trigger().textContent).toContain('2 人');
    expect(trigger().getAttribute('aria-invalid')).toBeNull();

    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.people?.value).toBe('2');
  });

  it('restores its raw snapshot after unmount and submits the same value', async () => {
    const onSaveState = vi.fn().mockResolvedValue(undefined);
    const props = { conversationId: 'c1', messageId: 'm1', blockKey: '0', onSaveState };
    await render(SELECT_FORM, props);

    await choose('2 人');
    await waitFor(() => onSaveState.mock.calls.length > 0);
    const snapshot = onSaveState.mock.calls.at(-1)?.[0]?.state as Record<string, unknown>;
    expect(snapshot?.booking?.people?.value).toBe('2');

    const onAction = vi.fn();
    await remount(SELECT_FORM, snapshot, { onAction });
    expect(trigger().textContent).toContain('2 人');

    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.people?.value).toBe('2');
  });

  it('is disabled while streaming and cannot dispatch', async () => {
    const onAction = vi.fn();
    await render(SELECT_FORM, { onAction, streaming: true });

    expect(trigger().hasAttribute('disabled')).toBe(true);
    await click(trigger());
    expect(document.querySelector('[role="option"]')).toBeNull();

    await click(submit());
    await settle();
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('TextArea', () => {
  it('submits the complete multiline text', async () => {
    const onAction = vi.fn();
    await render(TEXT_FORM, { onAction });

    await type('第一行\n第二行');
    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.notes?.value).toBe(
      '第一行\n第二行',
    );
  });

  it('submits an empty string after clearing the literal initial value', async () => {
    const onAction = vi.fn();
    await render(
      [
        'root = Form("booking", buttons, [fc])',
        'buttons = Buttons([submit])',
        'submit = Button("提交", @ToAssistant("提交"), "primary")',
        'fc = FormControl("备注", notes)',
        'notes = TextArea("notes", "写下备注", 3, {}, "旧值")',
      ].join('\n'),
      { onAction },
    );

    expect(textarea().value).toBe('旧值');
    await type('');
    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.notes?.value).toBe('');
  });

  it('blocks submitting an empty required textarea', async () => {
    const onAction = vi.fn();
    await render(REQUIRED_TEXT_FORM, { onAction });

    await click(submit());
    await settle();
    expect(onAction).not.toHaveBeenCalled();
    expect(textarea().getAttribute('aria-invalid')).toBe('true');

    await type('有内容');
    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.notes?.value).toBe('有内容');
  });

  it('restores typed text and an explicitly cleared empty string from raw snapshots', async () => {
    const onSaveState = vi.fn().mockResolvedValue(undefined);
    const props = { conversationId: 'c1', messageId: 'm1', blockKey: '0', onSaveState };
    await render(TEXT_FORM, props);

    await type('多行\n文本');
    await waitFor(() => onSaveState.mock.calls.length > 0);
    const typedSnapshot = onSaveState.mock.calls.at(-1)?.[0]?.state as Record<string, unknown>;
    expect(typedSnapshot?.booking?.notes?.value).toBe('多行\n文本');

    await remount(TEXT_FORM, typedSnapshot, props);
    expect(textarea().value).toBe('多行\n文本');

    await type('');
    await waitFor(() =>
      onSaveState.mock.calls.some(([input]) => input?.state?.booking?.notes?.value === ''),
    );
    const emptySnapshot = onSaveState.mock.calls.at(-1)?.[0]?.state as Record<string, unknown>;

    const onAction = vi.fn();
    await remount(TEXT_FORM, emptySnapshot, { onAction });
    expect(textarea().value).toBe('');
    await click(submit());
    await settle();
    expect(onAction.mock.calls.at(-1)?.[0]?.formState?.booking?.notes?.value).toBe('');
  });

  it('is disabled while streaming', async () => {
    const onAction = vi.fn();
    await render(TEXT_FORM, { onAction, streaming: true });

    expect(textarea().disabled).toBe(true);
    await click(submit());
    await settle();
    expect(onAction).not.toHaveBeenCalled();
  });
});
