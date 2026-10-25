import { segmentOpenUi } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

/** web 直接消费 shared 分段器；这里守住「浏览器拿到的段号与文本」。 */
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
    // 流结束后仍没有闭合围栏：还原成 Markdown，让用户看到原文而不是空白。
    expect(kinds(text, false)).toEqual(['markdown']);
  });

  it('drops blank filler between fences', () => {
    const text = '```openui-lang\nroot = Card([])\n```\n```openui-lang\nroot = Card([])\n```';
    expect(segmentOpenUi(text).map((segment) => segment.kind)).toEqual(['openui', 'openui']);
  });
});
