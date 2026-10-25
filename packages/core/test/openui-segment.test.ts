import { hasOpenUiSegment, segmentOpenUi } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

/**
 * shared 分段器是浏览器与服务端共用的唯一实现。
 * 它必须做到：只认 openui 围栏、给出稳定 blockKey（只数 UI 段）、
 * 以及足够重建完整文本的偏移量。
 */
const kinds = (text: string, streaming = false) =>
  segmentOpenUi(text, streaming).map((segment) => segment.kind);

describe('segmentOpenUi', () => {
  it('keeps plain prose as one Markdown segment', () => {
    expect(segmentOpenUi('普通文字回答')).toEqual([
      { kind: 'markdown', text: '普通文字回答', start: 0, end: 6 },
    ]);
    expect(hasOpenUiSegment('普通文字回答')).toBe(false);
  });

  it('splits a single fenced program out of the prose around it', () => {
    const text = '先看结论：\n\n```openui-lang\nroot = Card([])\n```\n\n补充说明。';
    expect(segmentOpenUi(text)).toEqual([
      { kind: 'markdown', text: '先看结论：\n\n', start: 0, end: 7 },
      { kind: 'openui', text: 'root = Card([])', start: 22, end: 37, blockKey: 's0' },
      { kind: 'markdown', text: '\n补充说明。', start: 42, end: 48 },
    ]);
  });

  it('names UI segments s0, s1... and never counts Markdown', () => {
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
    expect(segments.filter((segment) => segment.kind === 'openui').map((s) => s.blockKey)).toEqual([
      's0',
      's1',
    ]);
    // 多段之间插入多少 Markdown 都不改变 UI 段身份。
    expect(
      segmentOpenUi(text.replace('中间', '中间\n\n多一行')).filter((s) => s.kind === 'openui'),
    ).toHaveLength(2);
  });

  it('offsets locate each segment and the gaps between them are only fences', () => {
    const text =
      '前言\r\n```openui-lang\r\nroot = Card([t])\r\nt = TextContent("hi")\r\n```\r\n尾巴';
    const segments = segmentOpenUi(text);
    for (const segment of segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    }
    const gaps = segments
      .slice(1)
      .map((segment, index) => text.slice(segments[index]?.end, segment.start));
    expect(gaps).toEqual(['```openui-lang\r\n', '\r\n```\r\n']);
    expect(segments.filter((segment) => segment.kind === 'openui')).toHaveLength(1);
  });

  it('leaves other fenced languages to Markdown', () => {
    const text = '示例：\n\n```js\nconsole.log(1)\n```\n';
    expect(segmentOpenUi(text)).toEqual([{ kind: 'markdown', text, start: 0, end: text.length }]);
  });

  it('does not extract openui fences nested inside another language fence', () => {
    const text = ['示例：', '```md', '```openui-lang', 'root = Card([t])', '```', '```'].join('\n');
    const segments = segmentOpenUi(text);
    expect(segments.every((segment) => segment.kind === 'markdown')).toBe(true);
    expect(segments.map((segment) => segment.text).join('')).toContain('```openui-lang');
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
    const segments = segmentOpenUi(text);
    expect(segments.filter((s) => s.kind === 'openui').map((s) => s.blockKey)).toEqual([
      's0',
      's1',
    ]);
    expect(
      segments
        .filter((s) => s.kind === 'markdown')
        .map((s) => s.text)
        .join(''),
    ).toContain('中间文字');
  });

  it('treats an unclosed fence as a live program only while streaming', () => {
    const text = '生成中\n```openui-lang\nroot = Card([';
    expect(kinds(text, true)).toEqual(['markdown', 'openui']);
    // 流结束后仍没有闭合围栏：还原成 Markdown，让用户看到原文而不是空白。
    expect(kinds(text, false)).toEqual(['markdown']);
  });
});
