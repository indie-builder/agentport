import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown, type MarkdownProps } from '../src/components/markdown.js';

const render = (props: MarkdownProps) => renderToStaticMarkup(createElement(Markdown, props));

const CODE = ['```ts', 'const a = 1;', '```'].join('\n');

describe('Markdown', () => {
  it('shifts message headings below the page h1', () => {
    const html = render({ text: '# 标题\n\n## 二级\n\n正文' });
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
  });

  it('renders marker-free text through the same single tree', () => {
    const html = render({ text: '完整保存的回答：缺失前缀和尾部' });
    expect(html).toContain('data-streamdown');
    expect(html).toContain('<p');
  });

  it('keeps partial Markdown readable while streaming', () => {
    const html = render({
      text: '说明 **加粗未闭合\n\n- 列表一\n- 列表二\n\n```ts\nconst a = 1;',
      streaming: true,
    });
    expect(html).toContain('data-streamdown');
    expect(html).toContain('加粗未闭合');
    expect(html).toContain('列表一');
    expect(html).toContain('const a = 1;');
  });

  it('keeps plain-text line breaks without needing Markdown markers', () => {
    const html = render({ text: '第一行\n第二行\n第三行' });
    expect(html).toContain('第一行\n第二行');
  });

  it('shows no typing caret when called statically', () => {
    const html = render({ text: '稳定回答' });
    expect(html).not.toContain('--streamdown-caret');
    expect(html).not.toContain('data-sd-caret');
  });

  it('inherits parent size and color instead of forcing body typography', () => {
    const html = render({ text: '小字说明\n\n## 小节\n\n### 小节三', presentation: 'inherit' });
    expect(html).not.toContain('text-base text-fg');
    expect(html).toContain('text-lg'); // H2 视觉档位不小于正文
    expect(html).toContain('mt-3.5 mb-1.5 text-base font-semibold');
  });

  it('never lets sub-headings fall below a larger inherited body size', () => {
    // TextContent large 的正文是 16px；H3–H6 固定 14px 会倒挂。
    const html = render({ text: '### 小节\n\n#### 小节四', presentation: 'inherit' });
    expect(html.match(/font-size:max\(1em, var\(--text-base\)\)/g)).toHaveLength(2);
    // 默认正文下 1em 仍是 14px，视觉档位不变。
    expect(render({ text: '### 小节' })).toContain('font-size:max(1em, var(--text-base))');
  });

  it('keeps body typography by default', () => {
    const html = render({ text: '正文' });
    expect(html).toContain('text-base');
    expect(html).toContain('text-fg');
  });

  it('opens external links safely and never links an incomplete sentinel', () => {
    const external = render({ text: '[文档](https://example.com/a)' });
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noreferrer noopener"');

    const relative = render({ text: '[路径](/agents)' });
    expect(relative).toContain('href="/agents"');

    const unsafe = render({ text: '[点我](javascript:alert(1))' });
    expect(unsafe).not.toContain('href="javascript:');

    const partial = render({ text: '[未闭合](https://example.com', streaming: true });
    expect(partial).toContain('未闭合');
    expect(partial).not.toContain('href="https://example.com"');
  });
});

describe('Markdown in the browser', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Streamdown 流式代码块会自动滚动到底部；jsdom 的元素没有 scrollTo。
    Element.prototype.scrollTo = () => undefined;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const mount = async (props: MarkdownProps) => {
    await act(async () => root.render(createElement(Markdown, props)));
  };

  it('disables copy while streaming and enables it once settled', async () => {
    await mount({ text: CODE, streaming: true });
    const copy = () =>
      host.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]');
    expect(copy()?.disabled).toBe(true);

    await mount({ text: CODE, streaming: false });
    expect(copy()?.disabled).toBe(false);
  });

  it('keeps the same root and paragraph while text turns into Markdown', async () => {
    await mount({ text: '第一段', streaming: true });
    const tree = host.firstElementChild;
    const paragraph = host.querySelector('p');

    await mount({ text: '第一段\n\n**加粗**\n\n- 列表', streaming: true });
    expect(host.firstElementChild).toBe(tree);
    expect(host.querySelector('p')).toBe(paragraph);
    expect(host.querySelector('[data-streamdown="strong"]')?.textContent).toBe('加粗');
    expect(host.querySelector('li')?.textContent).toBe('列表');
  });
});
