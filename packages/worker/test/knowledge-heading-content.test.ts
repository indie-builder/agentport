import { describe, expect, it } from 'vitest';
import { markdownBlocks } from '../src/knowledge/parsing.js';
import { createParsingAdapter } from '../src/knowledge/parsing-adapter.js';

// 这是数据丢失的独立回归：没有正文承接的标题必须作为 content 进入分块，不能只落 breadcrumb。
const adapter = createParsingAdapter();

const chunk = (markdown: string, pageMap: Parameters<typeof adapter.chunkMarkdown>[1] = []) =>
  adapter.chunkMarkdown(markdown, pageMap, { chunkTokens: 1200, overlap: 0 });

describe('标题无正文时的 content 承接', () => {
  it('连续同级标题全部进入 content，不丢任何标题', () => {
    const markdown = '## A\n\n## INVOICE4207\n\n## END';
    const content = chunk(markdown)
      .map((entry) => entry.content)
      .join('\n');
    for (const title of ['A', 'INVOICE4207', 'END']) {
      expect(content).toContain(title);
    }
    expect(content.split('INVOICE4207')).toHaveLength(2);
  });

  it('普通标题带正文时正文只出现一次，不重复标题文本', () => {
    const markdown = '# Parent\n## Child\n正文';
    const chunks = chunk(markdown);
    const content = chunks.map((entry) => entry.content).join('\n\n');
    expect(content).toBe('正文');
    expect(chunks).toHaveLength(1);
    expect(content.split('正文').length - 1).toBe(1);
    expect(chunks[0]?.heading).toContain('Parent');
    expect(chunks[0]?.heading).toContain('Child');
  });

  it('尾部标题进入 content，locator 指向标题文字坐标而非 ##，重复标题不用全局首现位置', () => {
    const markdown = '## 尾部😀\n\n正文\n\n## 尾部😀\r\n';
    const spans: Array<{ start: number; end: number }> = [];
    const blocks = markdownBlocks(markdown, (_line, start = 0, end = start) => {
      spans.push({ start, end });
      return {};
    });
    const headingBlocks = blocks.filter((block) => block.content.includes('尾部😀'));
    expect(headingBlocks).toHaveLength(1);
    // 只有末尾那个标题没有正文承接；它对应的区间必须在正文之后，且只覆盖标题文字。
    const tail = markdown.indexOf('正文') + '正文'.length;
    const tailSpan = spans[blocks.indexOf(headingBlocks[0] as (typeof blocks)[number])];
    expect(tailSpan).toBeDefined();
    expect(tailSpan?.start).toBeGreaterThanOrEqual(tail);
    const raw = markdown.slice(tailSpan?.start, tailSpan?.end);
    expect(raw).toBe('尾部😀');
    expect(raw).not.toContain('#');
    expect(raw).not.toContain('\r');

    const chunks = chunk(markdown);
    expect(chunks.map((entry) => entry.content).join('\n\n')).toContain('尾部😀');
  });

  it('孤立标题 chunk 自身继承标题文字范围页码', () => {
    const markdown = '## INVOICE4207\n';
    const titleStart = markdown.indexOf('INVOICE4207');
    const pageMap = [
      { page: 4, startOffset: titleStart, endOffset: titleStart + 'INVOICE4207'.length },
    ];
    const chunks = chunk(markdown, pageMap);
    const heading = chunks.find((entry) => entry.content.includes('INVOICE4207'));
    expect(heading).toBeDefined();
    expect(heading?.pageFrom).toBe(4);
  });

  it('孤立的 Setext 标题同样进入 content', () => {
    const markdown = '孤立标题\n===\n';
    const chunks = chunk(markdown);
    expect(chunks.map((entry) => entry.content).join('\n\n')).toContain('孤立标题');
  });
});
