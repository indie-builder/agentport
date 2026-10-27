import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantText } from '../src/components/openui-message.js';
import type { OpenUiStateSaveInput, OpenUiToolCallInput } from '../src/openui/renderer.js';
import '../src/openui/renderer.js';

/**
 * 接线契约：动作保留完整载荷、每段工具调用带自己的来源、审批可见可重试、
 * 状态保存失败可见且动作前必须落盘。
 */

const FENCE = (lines: string[]) => ['```openui-lang', ...lines, '```'].join('\n');

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

/** 保存防抖是真实计时器：按条件等它落定，不靠固定睡眠时长。 */
async function waitFor(probe: () => boolean, tries = 100): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (probe()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(probe()).toBe(true);
}

async function render(props: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(createElement(AssistantText, { openUi: true, ...props }));
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
  'submit = Button("提交", @ToAssistant("提交", { chart: "revenue" }), "primary")',
  'fc = FormControl("姓名", name)',
  'name = Input("fullName", "", "text", {})',
];

describe('action payload and source', () => {
  it('sends the whole action with params.context, form values and segment source', async () => {
    const onAction = vi.fn();
    await render({
      text: `说明\n\n${FENCE(FORM_PROGRAM)}`,
      streaming: false,
      messageId: 'message_a',
      conversationId: 'conversation_a',
      onAction,
    });

    await type('fullName', '张三');
    await act(async () => buttonByText('提交').click());

    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({
      type: 'continue_conversation',
      message: '提交',
      params: { context: { chart: 'revenue' } },
      context: { chart: 'revenue' },
      formName: 'booking',
      formState: { booking: { fullName: { value: '张三' } } },
      messageId: 'message_a',
      blockKey: 's0',
    });
  });
});

describe('per-segment tool source', () => {
  const TWO_SEGMENTS = [
    '第一段：',
    '',
    FENCE([
      'root = Card([t])',
      't = TextContent(q.label)',
      'q = Query("tool_a", {}, { label: "默认 A" })',
    ]),
    '',
    '第二段：',
    '',
    FENCE([
      'root = Card([t])',
      't = TextContent(q.label)',
      'q = Query("tool_b", {}, { label: "默认 B" })',
    ]),
  ].join('\n');

  it('binds every segment to its own message and segment index', async () => {
    const onToolCall = vi.fn(async (input: OpenUiToolCallInput) => ({
      status: 'ok' as const,
      data: { label: `来自 ${input.toolName}` },
    }));

    await render({
      text: TWO_SEGMENTS,
      streaming: false,
      messageId: 'message_history',
      conversationId: 'conversation_a',
      onToolCall,
      onAction: vi.fn(),
    });

    expect(onToolCall.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        conversationId: 'conversation_a',
        messageId: 'message_history',
        blockKey: 's0',
        toolName: 'tool_a',
      }),
      expect.objectContaining({
        conversationId: 'conversation_a',
        messageId: 'message_history',
        blockKey: 's1',
        toolName: 'tool_b',
      }),
    ]);
    expect(host.textContent).toContain('来自 tool_a');
    expect(host.textContent).toContain('来自 tool_b');
  });

  it('numbers only UI fences, so surrounding Markdown never shifts the keys', async () => {
    const onToolCall = vi.fn(async (input: OpenUiToolCallInput) => ({
      status: 'ok' as const,
      data: { label: `${input.toolName}@${input.blockKey}` },
    }));

    await render({
      text: [
        '## 开头',
        '',
        '这里也有一个普通代码块：',
        '```js',
        'const a = 1;',
        '```',
        '',
        FENCE(['root = Card([t])', 't = TextContent(q.label)', 'q = Query("first", {}, {})']),
        '',
        '中间说明',
        '',
        FENCE(['root = Card([t])', 't = TextContent(q.label)', 'q = Query("second", {}, {})']),
        '',
        '结尾说明',
      ].join('\n'),
      streaming: false,
      messageId: 'message_markdown',
      conversationId: 'conversation_a',
      onToolCall,
      onAction: vi.fn(),
    });

    expect(onToolCall.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ blockKey: 's0', toolName: 'first' }),
      expect.objectContaining({ blockKey: 's1', toolName: 'second' }),
    ]);
    expect(host.textContent).toContain('first@s0');
    expect(host.textContent).toContain('second@s1');
    expect(host.textContent).toContain('中间说明');
    expect(host.textContent).toContain('const a = 1;');
  });

  it('keeps two roots with identical statement names in separate namespaces', async () => {
    const onToolCall = vi.fn(async (input: OpenUiToolCallInput) => ({
      status: 'ok' as const,
      data: { label: `${input.toolName}:${String(input.args.segment)}` },
    }));
    const program = (tool: string, segment: string) =>
      FENCE([
        'root = Card([t])',
        't = TextContent(q.label)',
        `q = Query("${tool}", { segment: "${segment}" }, { label: "等待" })`,
      ]);

    await render({
      text: [program('tool_a', 'a'), '', program('tool_b', 'b')].join('\n'),
      streaming: false,
      messageId: 'message_twins',
      conversationId: 'conversation_a',
      onToolCall,
      onAction: vi.fn(),
    });

    expect(onToolCall.mock.calls.map(([input]) => input.args)).toEqual([
      { segment: 'a' },
      { segment: 'b' },
    ]);
    expect(host.textContent).toContain('tool_a:a');
    expect(host.textContent).toContain('tool_b:b');
  });

  it('waits for the persisted message id instead of failing the query', async () => {
    const onToolCall = vi.fn(async () => ({ status: 'ok' as const, data: { label: '已取到' } }));
    const program = FENCE([
      'root = Card([t])',
      't = TextContent(q.label)',
      'q = Query("tool_live", {}, { label: "默认值" })',
    ]);

    await render({
      text: program,
      streaming: false,
      conversationId: 'conversation_a',
      onToolCall,
      onAction: vi.fn(),
    });

    // 还没有 id：界面照常可见，不报错，也不发注定失败的请求。
    expect(host.textContent).toContain('默认值');
    expect(onToolCall).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await render({
      text: program,
      streaming: false,
      conversationId: 'conversation_a',
      messageId: 'message_live',
      onToolCall,
      onAction: vi.fn(),
    });

    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message_live', toolName: 'tool_live' }),
    );
    expect(host.textContent).toContain('已取到');
  });
});

describe('approval entry', () => {
  it('shows the approval with its validity, approves, then retries the query', async () => {
    const onToolCall = vi
      .fn<(input: OpenUiToolCallInput) => Promise<unknown>>()
      .mockResolvedValueOnce({ status: 'approval_required', approvalId: 'approval_1' })
      .mockResolvedValueOnce({ status: 'ok', data: { label: '已批准的数据' } });
    const onApprove = vi.fn(async () => undefined);

    await render({
      text: FENCE([
        'root = Card([t])',
        't = TextContent(q.label)',
        'q = Query("risky", {}, { label: "加载中" })',
      ]),
      streaming: false,
      messageId: 'message_approve',
      conversationId: 'conversation_a',
      onToolCall,
      onApprove,
      onAction: vi.fn(),
    });

    expect(host.textContent).toContain('需要批准');
    expect(host.textContent).toContain('8 小时');

    await act(async () => buttonByText('批准工具调用').click());
    await settle();

    expect(onApprove).toHaveBeenCalledWith({
      conversationId: 'conversation_a',
      approvalId: 'approval_1',
    });
    expect(host.textContent).toContain('不会自动重放');

    await act(async () => buttonByText('重试').click());
    await settle();

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('已批准的数据');
  });
});

describe('state persistence', () => {
  it('reports a failed save with a retry that resends the same snapshot', async () => {
    const onSaveState = vi
      .fn<(input: OpenUiStateSaveInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(undefined);

    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_state',
      conversationId: 'conversation_a',
      onSaveState,
      onAction: vi.fn(),
    });

    await type('fullName', '李四');
    await waitFor(() => onSaveState.mock.calls.length > 0);

    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation_a',
        messageId: 'message_state',
        blockKey: 's0',
        state: expect.objectContaining({
          booking: expect.objectContaining({ fullName: expect.anything() }),
        }),
      }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('界面状态没有保存');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('网络中断');

    await act(async () => buttonByText('重试').click());
    await settle();
    expect(onSaveState).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('网络中断');
  });

  it('flushes the latest value before firing an action', async () => {
    const order: string[] = [];
    const onSaveState = vi.fn(async () => {
      order.push('save');
    });
    const onAction = vi.fn(() => {
      order.push('action');
    });

    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_flush',
      conversationId: 'conversation_a',
      onSaveState,
      onAction,
    });

    await type('fullName', '王五');
    await act(async () => buttonByText('提交').click());

    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message_flush',
        blockKey: 's0',
        state: expect.objectContaining({
          booking: expect.objectContaining({
            fullName: { value: '王五', componentType: undefined },
          }),
        }),
      }),
    );
    expect(order).toEqual(['save', 'action']);
  });

  it('flushes on unmount instead of dropping the debounced value', async () => {
    const onSaveState = vi.fn(async () => undefined);
    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_unmount',
      conversationId: 'conversation_a',
      onSaveState,
      onAction: vi.fn(),
    });

    await type('fullName', '赵六');
    await act(async () => root.unmount());

    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message_unmount',
        blockKey: 's0',
        state: expect.objectContaining({
          booking: expect.objectContaining({
            fullName: { value: '赵六', componentType: undefined },
          }),
        }),
      }),
    );

    // afterEach 还会再 unmount 一次，这里换一个全新的根。
    root = createRoot(document.createElement('div'));
  });

  it('flushes when the page becomes hidden', async () => {
    const onSaveState = vi.fn(async () => undefined);
    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_hidden',
      conversationId: 'conversation_a',
      onSaveState,
      onAction: vi.fn(),
    });

    await type('fullName', '钱七');
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    state.mockRestore();

    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message_hidden',
        state: expect.objectContaining({
          booking: expect.objectContaining({
            fullName: { value: '钱七', componentType: undefined },
          }),
        }),
      }),
    );
  });
});

describe('restored state', () => {
  const SNAPSHOT = {
    version: 1,
    blocks: {
      s0: { booking: { fullName: { value: '已保存' } } },
      s1: { booking: { fullName: { value: '别的段' } } },
    },
  };

  it('hydrates the snapshot of its own segment only', async () => {
    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_restore',
      conversationId: 'conversation_a',
      uiState: SNAPSHOT,
      onAction: vi.fn(),
    });

    expect(host.querySelector<HTMLInputElement>('input[name="fullName"]')?.value).toBe('已保存');
  });

  it('restores the same state after branching gives the message a new id', async () => {
    // branch 复制 uiState 但换消息 id；键里不含 id，所以段快照仍按 sN 命中。
    await render({
      text: FENCE(FORM_PROGRAM),
      streaming: false,
      messageId: 'message_branch_copy',
      conversationId: 'conversation_branch',
      uiState: SNAPSHOT,
      onAction: vi.fn(),
    });

    expect(host.querySelector<HTMLInputElement>('input[name="fullName"]')?.value).toBe('已保存');
  });
});

describe('edit mode rendering', () => {
  it('renders the settled canonical program instead of the raw patch', async () => {
    await render({
      text: `补丁\n\n${FENCE(['root = Card([t])', 't = TextContent("半成品")'])}`,
      uiProgram: `完整\n\n${FENCE(['root = Card([t])', 't = TextContent("完整界面")'])}`,
      streaming: false,
      onAction: vi.fn(),
    });

    expect(host.textContent).toContain('完整界面');
    expect(host.textContent).not.toContain('半成品');
  });

  it('keeps the previous UI while a patch is still streaming', async () => {
    await render({
      text: `更新中\n\n${FENCE(['t = TextContent("半补丁")'])}`,
      streaming: true,
      onAction: vi.fn(),
    });

    expect(host.textContent).not.toContain('半补丁');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
