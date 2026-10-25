import { segmentOpenUi } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

/**
 * 分段器的三条硬约束（评审实测发现的边界）：
 * 1. CRLF 换行不能把围栏漏掉；
 * 2. 外层已是别的语言围栏时，里面的 ```openui-lang 只是代码内容；
 * 3. 围栏之间的空行属于 Markdown，不能被吞掉。
 */
describe('segmentOpenUi edge cases', () => {
  it('recognises fenced programs with CRLF line endings', () => {
    const text =
      '说明\r\n\r\n```openui-lang\r\nroot = Card([t])\r\nt = TextContent("hi")\r\n```\r\n';
    const segments = segmentOpenUi(text, false);
    expect(segments.some((s) => s.kind === 'openui')).toBe(true);
    expect(segments.find((s) => s.kind === 'openui')?.text).toContain('root = Card');
  });

  it('does not extract openui fences nested inside another language fence', () => {
    const text = ['示例：', '```md', '```openui-lang', 'root = Card([t])', '```', '```'].join('\n');
    const segments = segmentOpenUi(text, false);
    expect(segments.every((s) => s.kind === 'markdown')).toBe(true);
    expect(segments.map((s) => s.text).join('')).toContain('```openui-lang');
  });

  it('keeps blank lines between fences in the markdown segments', () => {
    const text = [
      '```openui-lang',
      'root = Card([t])',
      '```',
      '',
      '中间文字',
      '',
      '```openui-lang',
      't = TextContent("x")',
      '```',
    ].join('\n');
    const segments = segmentOpenUi(text, false);
    const markdown = segments.filter((s) => s.kind === 'markdown').map((s) => s.text);
    expect(markdown.join('')).toContain('中间文字');
    expect(segments.filter((s) => s.kind === 'openui')).toHaveLength(2);
  });

  it('treats an unclosed fence as openui only while streaming', () => {
    const text = '```openui-lang\nroot = Card([t])\nt = TextContent("未完';
    expect(segmentOpenUi(text, true).some((s) => s.kind === 'openui')).toBe(true);
    expect(segmentOpenUi(text, false).every((s) => s.kind === 'markdown')).toBe(true);
  });
});
