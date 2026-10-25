import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/markdown.js';

function render(props: Parameters<typeof Markdown>[0]): string {
  return renderToStaticMarkup(createElement(Markdown, props));
}

/** 带 Markdown 标记，确保走解析器；HTML 仍只能作为文字出现。 */
const PARSED = '# 标题\n\n';

describe('Markdown static content', () => {
  it('shows HTML as literal text instead of creating nodes', () => {
    const html = render({
      text: `${PARSED}<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">`,
      staticContent: true,
    });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;');
  });

  it('drops inline event handlers from HTML in the body', () => {
    const html = render({
      text: `${PARSED}正文 <b onclick="alert(1)">bold</b> 结尾`,
      staticContent: true,
    });

    expect(html).not.toContain('<b ');
    expect(html).toContain('&lt;b onclick=&quot;alert(1)&quot;&gt;');
  });

  it('does not render a javascript: link', () => {
    const html = render({ text: `${PARSED}[点我](javascript:alert(1))`, staticContent: true });

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a');
    expect(html).toContain('点我');
  });

  it('keeps external links safe and moves body h1 below the page heading', () => {
    const html = render({
      text: '# 标题\n\n[文档](https://example.com/docs)',
      staticContent: true,
    });

    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('keeps chat rendering unchanged by default', () => {
    const html = render({ text: '# 标题\n\n正文', staticContent: false });

    expect(html).toContain('<h2');
    expect(html).not.toContain('<h1');
  });
});
