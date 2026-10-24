import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/markdown.js';

describe('Markdown', () => {
  it('shifts message headings below the page h1', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '# 标题\n\n## 二级\n\n正文' }),
    );
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
  });

  it('renders marker-free streaming text without the Markdown parser', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '完整保存的回答：缺失前缀和尾部' }),
    );
    expect(html).toContain('<p');
    expect(html).not.toContain('data-streamdown');
  });
});
