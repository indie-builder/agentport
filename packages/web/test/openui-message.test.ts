import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantText } from '../src/components/openui-message.js';

// 让渲染器 chunk 真的挂起一次：预载 module 会让 Suspense 直接跳过 fallback，测不到等待态。
// 放行后 React.lazy 与模块都会被缓存，所以「等待态」用例必须排在第一。
const chunkGate = vi.hoisted(() => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
});
// 暴露最新一次渲染收到的 onInvalid，用来模拟「旧程序迟到的回调」；mounts 记录渲染器挂载次数。
const bridge = vi.hoisted(() => ({
  onInvalid: undefined as undefined | ((program: string) => void),
  mounts: 0,
}));
vi.mock('../src/openui/renderer.js', async (importOriginal) => {
  await chunkGate.promise;
  const actual = await importOriginal<typeof import('../src/openui/renderer.js')>();
  const { createElement, useEffect } = await import('react');
  const OpenUiBlock = (props: Parameters<typeof actual.OpenUiBlock>[0]) => {
    useEffect(() => {
      bridge.onInvalid = props.onInvalid;
    }, [props.onInvalid]);
    useEffect(() => {
      bridge.mounts += 1;
    }, []);
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

/** 只有提示文案不同：有效程序更新时表单实例必须保留。 */
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
  ) => {
    await act(async () => {
      root.render(
        createElement(AssistantText, {
          text,
          openUi,
          streaming,
          onAction,
          ...(uiProgram === undefined ? {} : { uiProgram }),
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
    // 等待态不能把程序源码当成正文闪出来。
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
    // 围栏前的「好的：」仍显示，说明分段渲染而不是整段丢弃。
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
    // 先确认已经回退成源码，恢复才算数。
    expect(host.textContent).toContain('这不是程序');

    await render(VALID_A, true, false);
    await settle();
    // 回退态显示整段源码；真正渲染时不会出现程序文本。
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

    // 渲染器把回调存进 ref：旧程序的迟到报告会打到当前回调上，
    // 标记必须按上报的 program 判断，不能把新快照打回源码。
    // 真实回调收到的是围栏内的裸 program，不带 fence。
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

    // 原始 text 不变，稳定态改用落库后的完整程序。
    await render(INVALID_A, true, false, undefined, VALID_A);
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).not.toContain('root = Card');
    expect(host.textContent).not.toContain('这不是程序');
  });

  it('does not remount the renderer for the same repeated failure', async () => {
    await render(INVALID_A, true, false);
    await settle();
    const mounts = bridge.mounts;
    expect(host.textContent).toContain('这不是程序');

    await render(INVALID_A, true, false);
    await settle();
    expect(bridge.mounts).toBe(mounts);
    expect(host.textContent).toContain('这不是程序');
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
    // 有效表单不能因为程序更新重挂而丢掉用户已经填的内容。
    expect(host.querySelector<HTMLInputElement>('input[name="fullName"]')?.value).toBe('张三');
  });
});
