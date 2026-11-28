import { hasOpenUiSegment, segmentOpenUi } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

const parts = (text: string, streaming = false) =>
  segmentOpenUi(text, streaming).map(({ kind, text: value, blockKey }) => ({
    kind,
    text: value,
    ...(blockKey === undefined ? {} : { blockKey }),
  }));

const kinds = (text: string, streaming = false) =>
  segmentOpenUi(text, streaming).map((segment) => segment.kind);

describe('segmentOpenUi', () => {
  it('keeps plain prose as one Markdown segment', () => {
    expect(parts('普通文字回答')).toEqual([{ kind: 'markdown', text: '普通文字回答' }]);
    expect(hasOpenUiSegment('普通文字回答')).toBe(false);
  });

  it('splits a single fenced program out of the prose around it', () => {
    const text = '先看结论：\n\n```openui-lang\nroot = Card([])\n```\n\n补充说明。';
    expect(parts(text)).toEqual([
      { kind: 'markdown', text: '先看结论：\n\n' },
      { kind: 'openui', text: 'root = Card([])', blockKey: 's0' },
      { kind: 'markdown', text: '\n补充说明。' },
    ]);
  });

  it('handles several fenced programs in one answer and numbers only UI fences', () => {
    const text = [
      '第一段',
      '```openui-lang',
      'root = Card([])',
      '```',
      '中间',
      '```openui',
      'root = Card([TextContent("hi")])',
      '```',
      '结尾',
    ].join('\n');
    const segments = segmentOpenUi(text);
    expect(segments.map((segment) => segment.kind)).toEqual([
      'markdown',
      'openui',
      'markdown',
      'openui',
      'markdown',
    ]);
    expect(segments[1]).toMatchObject({ text: 'root = Card([])', blockKey: 's0' });
    expect(segments[3]).toMatchObject({
      text: 'root = Card([TextContent("hi")])',
      blockKey: 's1',
    });
    expect(segments[4]?.text).toContain('结尾');
  });

  it('leaves other fenced languages to Markdown', () => {
    const text = '示例：\n\n```js\nconsole.log(1)\n```\n';
    expect(parts(text)).toEqual([{ kind: 'markdown', text }]);
  });

  it('treats an unclosed fence as a live program while streaming', () => {
    const text = '生成中\n```openui-lang\nroot = Card([';
    expect(parts(text, true)).toEqual([
      { kind: 'markdown', text: '生成中\n' },
      { kind: 'openui', text: 'root = Card([', blockKey: 's0' },
    ]);
    expect(kinds(text, false)).toEqual(['markdown']);
  });

  it('drops blank filler between fences', () => {
    const text = '```openui-lang\nroot = Card([])\n```\n```openui-lang\nroot = Card([])\n```';
    expect(segmentOpenUi(text).map((segment) => segment.kind)).toEqual(['openui', 'openui']);
  });

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
});
