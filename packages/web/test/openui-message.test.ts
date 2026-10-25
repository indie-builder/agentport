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
vi.mock('../src/openui/renderer.js', async (importOriginal) => {
  await chunkGate.promise;
  return await importOriginal();
});

const FENCED = [
  '好的：',
  '',
  '```openui-lang',
  'root = Card([t])',
  't = TextContent("已完成")',
  '```',
].join('\n');

describe('AssistantText', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = async (
    text: string,
    openUi: boolean,
    streaming: boolean,
    onAction: (message: string, formState?: Record<string, unknown>) => void = () => undefined,
  ) => {
    await act(async () => {
      root.render(createElement(AssistantText, { text, openUi, streaming, onAction }));
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
});
