import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenUiApprovalInput,
  OpenUiStateSaveInput,
  OpenUiToolCallInput,
} from '../src/openui/renderer.js';
import { OpenUiBlock } from '../src/openui/renderer.js';

/**
 * 渲染器生命周期：审批槽位不依赖 Query 错误、实时状态的来源与单飞写回、
 * 非空根下的诊断。全部走真实 @openuidev/react-lang runtime。
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

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(props: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(createElement(OpenUiBlock, props));
  });
  await settle();
}

async function waitDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  await settle();
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

async function type(name: string, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`input not found: ${name}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const FORM_PROGRAM = [
  'root = Card([form])',
  'form = Form("booking", buttons, [fc])',
  'buttons = Buttons([submit])',
  'submit = Button("提交", @ToAssistant("提交"), "primary")',
  'fc = FormControl("姓名", name)',
  'name = Input("fullName", "", "text", {})',
].join('\n');

const SAVE_SOURCE = { conversationId: 'conversation_s', blockKey: 's0' };

function savedValue(input: OpenUiStateSaveInput): unknown {
  const booking = input.state.booking as Record<string, { value?: unknown }> | undefined;
  return booking?.fullName?.value;
}

describe('approval outside the query error slot', () => {
  it('approves a mutation that only asks for approval, without auto replaying it', async () => {
    const onToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<unknown>>()
      .mockResolvedValueOnce({ status: 'approval_required', approvalId: 'approval_m' })
      .mockResolvedValueOnce({ status: 'ok', data: { saved: true } });
    const onApprove = vi
      .fn<(input: OpenUiApprovalInput) => Promise<void>>()
      .mockResolvedValue(undefined);

    await render({
      program: [
        'root = Card([buttons])',
        'buttons = Buttons([save])',
        'save = Button("保存记录", Action([@Run(write)]), "primary")',
        'write = Mutation("write_tool", {})',
      ].join('\n'),
      streaming: false,
      messageId: 'message_mutation',
      conversationId: 'conversation_a',
      blockKey: 's0',
      onToolCall,
      onApprove,
      onAction: vi.fn(),
    });

    await act(async () => buttonByText('保存记录').click());
    await settle();

    // 纯 Mutation 不会产生 Query 错误：审批入口仍必须出现，并带有效期说明。
    expect(host.textContent).toContain('批准工具调用');
    expect(host.textContent).toContain('8 小时');
    expect(onToolCall).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText('批准工具调用').click());
    await settle();

    expect(onApprove).toHaveBeenCalledWith({
      conversationId: 'conversation_a',
      approvalId: 'approval_m',
    });
    // 批准不会自动重放：用户必须再点原动作。
    expect(onToolCall).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText('保存记录').click());
    await settle();

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall.mock.calls[1]?.[0]).toMatchObject({ toolName: 'write_tool' });
  });

  it('asks again when the server resets an approval under the same id', async () => {
    const onToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<unknown>>()
      .mockResolvedValueOnce({ status: 'approval_required', approvalId: 'approval_reuse' })
      .mockResolvedValueOnce({ status: 'ok', data: { saved: true } })
      // 同 id 再次要批准：服务端 8 小时过期后复用原 approvalId。
      .mockResolvedValueOnce({ status: 'approval_required', approvalId: 'approval_reuse' });
    const onApprove = vi
      .fn<(input: OpenUiApprovalInput) => Promise<void>>()
      .mockResolvedValue(undefined);

    await render({
      program: [
        'root = Card([buttons])',
        'buttons = Buttons([save])',
        'save = Button("保存记录", Action([@Run(write)]), "primary")',
        'write = Mutation("write_tool", {})',
      ].join('\n'),
      streaming: false,
      messageId: 'message_reuse',
      conversationId: 'conversation_a',
      blockKey: 's0',
      onToolCall,
      onApprove,
      onAction: vi.fn(),
    });

    await act(async () => buttonByText('保存记录').click());
    await settle();
    expect(onToolCall).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText('批准工具调用').click());
    await settle();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('已批准');

    await act(async () => buttonByText('保存记录').click());
    await settle();
    expect(onToolCall).toHaveBeenCalledTimes(2);

    // 同一个 approvalId 再次要求批准：本地「已批准」必须失效，入口重新出现。
    await act(async () => buttonByText('保存记录').click());
    await settle();
    expect(onToolCall).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain('需要批准后才能调用');
    expect(() => buttonByText('批准工具调用')).not.toThrow();

    await act(async () => buttonByText('批准工具调用').click());
    await settle();
    expect(onApprove).toHaveBeenCalledTimes(2);
    expect(onApprove.mock.calls[1]?.[0]).toEqual({
      conversationId: 'conversation_a',
      approvalId: 'approval_reuse',
    });
    // 批准仍然只解除门禁，Mutation 不自动重放。
    expect(onToolCall).toHaveBeenCalledTimes(3);
  });

  it('shows a mutation failure reported through onError', async () => {
    const onToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<unknown>>()
      .mockResolvedValue({ status: 'error', error: '写入被拒绝' });

    await render({
      program: [
        'root = Card([buttons])',
        'buttons = Buttons([save])',
        'save = Button("保存记录", Action([@Run(write)]), "primary")',
        'write = Mutation("write_tool", {})',
      ].join('\n'),
      streaming: false,
      messageId: 'message_mutation_error',
      conversationId: 'conversation_a',
      blockKey: 's0',
      onToolCall,
      onAction: vi.fn(),
    });

    await act(async () => buttonByText('保存记录').click());
    await settle();

    expect(host.textContent).toContain('写入被拒绝');
    // Mutation 失败只能由用户重新点动作，不能被自动重试。
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });
});

describe('late message id', () => {
  it('keeps the pending value across debounce and hidden, then flushes when the id arrives', async () => {
    const onSaveState = vi.fn(async () => undefined);
    await render({
      program: FORM_PROGRAM,
      streaming: false,
      ...SAVE_SOURCE,
      onSaveState,
      onAction: vi.fn(),
    });

    await type('fullName', '实时输入');
    await waitDebounce();
    expect(onSaveState).not.toHaveBeenCalled();

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    state.mockRestore();
    expect(onSaveState).not.toHaveBeenCalled();

    await render({
      program: FORM_PROGRAM,
      streaming: false,
      ...SAVE_SOURCE,
      messageId: 'message_late',
      onSaveState,
      onAction: vi.fn(),
    });

    expect(onSaveState).toHaveBeenCalledTimes(1);
    expect(onSaveState.mock.calls[0]?.[0]).toMatchObject({ messageId: 'message_late' });
    expect(savedValue(onSaveState.mock.calls[0]?.[0] as OpenUiStateSaveInput)).toBe('实时输入');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not send a value recorded for one message to another message', async () => {
    const onSaveState = vi.fn(async () => undefined);
    const props = {
      program: FORM_PROGRAM,
      streaming: false,
      conversationId: 'conversation_s',
      blockKey: 's0',
      onSaveState,
      onAction: vi.fn(),
    };
    await render({ ...props, messageId: 'message_a' });

    await type('fullName', '甲消息');
    await render({ ...props, messageId: 'message_b' });
    await waitDebounce();

    const seen = onSaveState.mock.calls.map(([input]) => input as OpenUiStateSaveInput);
    expect(seen.filter((input) => input.messageId === 'message_b')).toEqual([]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('serial state writes', () => {
  it('retries the newest value when an older save rejects after newer input', async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const onSaveState = vi
      .fn<(input: OpenUiStateSaveInput) => Promise<unknown>>()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error('再次失败'))
      .mockResolvedValue(undefined);

    await render({
      program: FORM_PROGRAM,
      streaming: false,
      ...SAVE_SOURCE,
      messageId: 'message_serial',
      onSaveState,
      onAction: vi.fn(),
    });

    await type('fullName', '旧值');
    await waitDebounce();
    expect(savedValue(onSaveState.mock.calls[0]?.[0] as OpenUiStateSaveInput)).toBe('旧值');

    await type('fullName', '新值');
    await act(async () => {
      rejectFirst(new Error('网络中断'));
    });
    await settle();

    // 旧请求失败后立刻排队写最新值（单飞：不并写，也不拿旧值覆盖新输入）。
    const autoRetry = onSaveState.mock.calls.map(([input]) => input as OpenUiStateSaveInput);
    expect(savedValue(autoRetry[1] as OpenUiStateSaveInput)).toBe('新值');
    expect(host.textContent).toContain('再次失败');

    await act(async () => buttonByText('重试').click());
    await settle();

    const calls = onSaveState.mock.calls.map(([input]) => input as OpenUiStateSaveInput);
    expect(calls).toHaveLength(3);
    expect(savedValue(calls[2] as OpenUiStateSaveInput)).toBe('新值');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('settled diagnostics', () => {
  it('shows parser diagnostics for an unknown child even when the root renders', async () => {
    await render({
      program: [
        'root = Card([t, mystery])',
        't = TextContent("可见内容")',
        'mystery = NoSuchThing("x")',
      ].join('\n'),
      streaming: false,
      onAction: vi.fn(),
    });

    expect(host.textContent).toContain('可见内容');
    expect(host.textContent).toContain('NoSuchThing');
  });

  it('does not diagnose an incomplete program while it is still streaming, and recovers on a valid program', async () => {
    await render({
      program: '这不是程序',
      streaming: true,
      onAction: vi.fn(),
    });
    expect(host.textContent).not.toContain('NoSuchThing');
    expect(host.textContent).not.toContain('could not be parsed');

    await render({
      program: [
        'root = Card([t, mystery])',
        't = TextContent("可见内容")',
        'mystery = NoSuchThing("x")',
      ].join('\n'),
      streaming: false,
      onAction: vi.fn(),
    });
    expect(host.textContent).toContain('NoSuchThing');

    await render({
      program: ['root = Card([t])', 't = TextContent("修复后")'].join('\n'),
      streaming: false,
      onAction: vi.fn(),
    });
    expect(host.textContent).toContain('修复后');
    expect(host.textContent).not.toContain('NoSuchThing');
  });
});
