import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagePane } from '../src/components/chat/chat-thread/message-pane.js';
import { AssistantText } from '../src/components/chat/openui-message.js';
import type { ChatItem } from '../src/lib/chat-state.js';

// 让渲染器 chunk 真的挂起一次：预载 module 会让 Suspense 直接跳过 fallback，测不到等待态。
// 放行后 React.lazy 与模块都会被缓存，所以「等待态」用例必须排在第一。
const chunkGate = vi.hoisted(() => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
});
const bridge = vi.hoisted(() => ({
  onInvalid: undefined as undefined | ((program: string) => void),
}));
vi.mock('../src/openui/renderer.js', async (importOriginal) => {
  await chunkGate.promise;
  const actual = await importOriginal<typeof import('../src/openui/renderer.js')>();
  const { createElement, useEffect } = await import('react');
  const OpenUiBlock = (props: Parameters<typeof actual.OpenUiBlock>[0]) => {
    useEffect(() => {
      bridge.onInvalid = props.onInvalid;
    }, [props.onInvalid]);
    return createElement(actual.OpenUiBlock, props);
  };
  return { ...actual, OpenUiBlock };
});

const FENCED = [
  '好的：',
  '',
  '```openui-lang',
  'root = Card([t])',
  't = TextContent("已完成")',
  '```',
].join('\n');

const fence = (lines: string[]) => ['```openui-lang', ...lines, '```'].join('\n');

const INVALID_A = fence(['这不是程序']);
const INVALID_B = fence(['仍然不是程序']);
const VALID_A = fence(['root = Card([t])', 't = TextContent("已完成")']);
const VALID_B = fence(['root = Card([t])', 't = TextContent("修复后")']);

const formProgram = (note: string) =>
  fence([
    'root = Card([note, form])',
    `note = TextContent("${note}")`,
    'form = Form("booking", buttons, [fc])',
    'buttons = Buttons([submit])',
    'submit = Button("提交", @ToAssistant("提交"), "primary")',
    'fc = FormControl("姓名", name)',
    'name = Input("fullName", "", "text", {})',
  ]);

describe('AssistantText', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (
    text: string,
    openUi: boolean,
    streaming: boolean,
    onAction: (message: string, formState?: Record<string, unknown>) => void = () => undefined,
    uiProgram?: string,
    previousUiProgram?: string,
  ) => {
    await act(async () => {
      root.render(
        createElement(AssistantText, {
          text,
          openUi,
          streaming,
          onAction,
          ...(uiProgram === undefined ? {} : { uiProgram }),
          ...(previousUiProgram === undefined ? {} : { previousUiProgram }),
        }),
      );
    });
  };
  // 放行渲染器 chunk 并等 Suspense 真正落地：动态 import 要真实时间，纯微任务等不到。
  const settle = async () => {
    chunkGate.release();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      if (!host.querySelector('[data-slot="skeleton"]')) break;
    }
  };

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

  it('shows a skeleton instead of the program while the renderer chunk loads', async () => {
    await render(FENCED, true, true);
    expect(host.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('openui-lang');
  });

  it('renders fenced programs as components, not source', async () => {
    await render(FENCED, true, true);
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('openui-lang');
    expect(host.textContent).not.toContain('root = Card');
  });

  it('keeps prose outside the fence as Markdown', async () => {
    await render(FENCED, true, true);
    expect(host.textContent).toContain('好的');
    await settle();
    expect(host.textContent).toContain('已完成');
  });

  it('leaves non-openui fences as Markdown code', async () => {
    const text = ['说明', '', '```js', 'const a = 1;', '```'].join('\n');
    await render(text, true, false);
    await settle();
    expect(host.textContent).toContain('const a = 1;');
  });

  it('falls back to Markdown when the agent is a markdown agent', async () => {
    await render(FENCED, false, false);
    await settle();
    expect(host.textContent).toContain('openui-lang');
  });

  it('falls back to Markdown for plain answers without a fence', async () => {
    await render('普通文字回答', true, false);
    await settle();
    expect(host.textContent).toContain('普通文字回答');
  });

  it('falls back to source when the fenced program renders no root', async () => {
    await render('说明\n\n```openui-lang\n这不是程序\n```', true, false);
    await settle();
    expect(host.textContent).toContain('这不是程序');
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it('recovers when the same block later receives a valid program', async () => {
    await render(INVALID_A, true, false);
    await settle();
    expect(host.textContent).toContain('这不是程序');

    await render(VALID_A, true, false);
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('这不是程序');
  });

  it('falls back again when a recovered block receives another invalid program', async () => {
    await render(VALID_A, true, false);
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('root = Card');

    await render(INVALID_B, true, false);
    await settle();
    expect(host.textContent).toContain('仍然不是程序');

    await render(VALID_B, true, false);
    await settle();
    expect(host.textContent).toContain('修复后');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('仍然不是程序');
  });

  it('ignores a late onInvalid report for a previous program', async () => {
    await render(INVALID_A, true, false);
    await settle();
    expect(host.textContent).toContain('这不是程序');

    await render(VALID_A, true, false);
    await settle();
    expect(host.textContent).not.toContain('root = Card');

    await act(async () => bridge.onInvalid?.('这不是程序'));
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('这不是程序');
  });

  it('recovers when the persisted uiProgram arrives for an invalid stream text', async () => {
    await render(INVALID_A, true, false);
    await settle();
    expect(host.textContent).toContain('这不是程序');

    await render(INVALID_A, true, false, undefined, VALID_A);
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('这不是程序');
  });

  it('keeps user input when a valid program updates', async () => {
    await render(formProgram('第一版'), true, false);
    await settle();
    const input = host.querySelector<HTMLInputElement>('input[name="fullName"]');
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, '张三');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await render(formProgram('第二版'), true, false);
    await settle();
    expect(host.textContent).toContain('第二版');
    expect(host.querySelector<HTMLInputElement>('input[name="fullName"]')?.value).toBe('张三');
  });

  it('renders a merged preview when streaming a rootless patch with previousUiProgram', async () => {
    const baseline = fence([
      'root = Card([header, t])',
      'header = CardHeader("周报", "基线")',
      't = TextContent("旧内容")',
    ]);
    const patch = fence(['t = TextContent("补丁更新")']);
    await render(patch, true, true, undefined, undefined, baseline);
    await settle();
    expect(host.textContent).toContain('周报');
    expect(host.textContent).toContain('补丁更新');
    expect(host.textContent).not.toContain('旧内容');
    expect(host.textContent).not.toContain('正在更新界面…');
  });

  it('shows updating placeholder when streaming a rootless patch without previousUiProgram', async () => {
    const patch = fence(['t = TextContent("补丁更新")']);
    await render(patch, true, true);
    expect(host.textContent).toContain('正在更新界面…');
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('unlocks closed text blocks and chains same-turn baseline in MessagePane', async () => {
    const firstBlock = fence([
      'root = Card([header, note, buttons])',
      'header = CardHeader("同轮标题", "阶段一")',
      'note = TextContent("旧正文")',
      'buttons = Buttons([b1])',
      'b1 = Button("可点按钮", @ToAssistant("点到了"), "primary")',
    ]);
    const secondPatch = fence(['note = TextContent("同轮补丁新正文")']);
    const items: ChatItem[] = [
      { id: 'u1', kind: 'user', text: '生成界面' },
      { id: 'a1:0', kind: 'text', text: firstBlock, closed: true },
      { id: 'a1:1', kind: 'tool', toolUseId: 't1', name: 'Read', input: '{}' },
      { id: 'a1:2', kind: 'text', text: secondPatch },
    ];
    const onAction = vi.fn();
    await act(async () => {
      root.render(
        createElement(MessagePane, {
          items,
          loading: false,
          error: null,
          onRetry: () => undefined,
          hasOlder: false,
          loadingOlder: false,
          olderDisabled: false,
          welcome: null,
          approvalItems: [],
          lastRun: null,
          historyMetrics: new Map(),
          currentRunId: 'run_1',
          branchingMessageId: null,
          running: true,
          openUi: true,
          streaming: true,
          onAction,
        }),
      );
    });
    await settle();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent === '可点按钮',
    );
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]?.disabled).toBe(false);
    expect(host.textContent).toContain('同轮标题');
    expect(host.textContent).toContain('同轮补丁新正文');
    expect(host.textContent).not.toContain('正在更新界面…');
  });

  it('keeps closed rootless patch blocks merged with baseline instead of degrading to source or clobbering baseline', async () => {
    const firstBlock = fence([
      'root = Card([header, note])',
      'header = CardHeader("基线标题", "保留")',
      'note = TextContent("初版内容")',
    ]);
    const closedPatch = fence(['note = TextContent("阶段二补丁")']);
    const streamingPatch = fence(['note = TextContent("阶段三补丁")']);
    const items: ChatItem[] = [
      { id: 'u1', kind: 'user', text: '逐步更新' },
      { id: 'a1:0', kind: 'text', text: firstBlock, closed: true },
      { id: 'a1:1', kind: 'tool', toolUseId: 't1', name: 'Read', input: '{}' },
      { id: 'a1:2', kind: 'text', text: closedPatch, closed: true },
      { id: 'a1:3', kind: 'tool', toolUseId: 't2', name: 'Read', input: '{}' },
      { id: 'a1:4', kind: 'text', text: streamingPatch },
    ];

    await act(async () => {
      root.render(
        createElement(MessagePane, {
          items,
          loading: false,
          error: null,
          onRetry: () => undefined,
          hasOlder: false,
          loadingOlder: false,
          olderDisabled: false,
          welcome: null,
          approvalItems: [],
          lastRun: null,
          historyMetrics: new Map(),
          currentRunId: 'run_2',
          branchingMessageId: null,
          running: true,
          openUi: true,
          streaming: true,
          onAction: vi.fn(),
        }),
      );
    });
    await settle();

    expect(host.textContent).toContain('基线标题');
    expect(host.textContent).toContain('阶段二补丁');
    expect(host.textContent).toContain('阶段三补丁');
    expect(host.textContent).not.toContain('note = TextContent');
    expect(host.textContent).not.toContain('正在更新界面…');
  });
});
