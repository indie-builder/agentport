import { describe, expect, test } from 'bun:test';
import { segmentOpenUi } from '@agentport/shared';
import { resolveOpenUiResponse, resolveOpenUiResponseDetailed } from '../src/openui-response.js';

const FENCE = (program: string) => `\`\`\`openui-lang\n${program}\n\`\`\``;

const BASE = `上一轮说明。\n\n${FENCE(
  [
    'root = Card([title, body])',
    'title = TextContent("行程")',
    'body = TextContent("原计划")',
  ].join('\n'),
)}\n`;

const programs = (text: string) =>
  segmentOpenUi(text)
    .filter((segment) => segment.kind === 'openui')
    .map((segment) => segment.text);

describe('resolveOpenUiResponse', () => {
  test('merges a patch into the previous program of the same segment', () => {
    const response = `补充说明。\n\n${FENCE('body = TextContent("新计划")')}\n`;
    const merged = resolveOpenUiResponse(BASE, response);
    const [program] = programs(merged);
    expect(program).toContain('新计划');
    expect(program).toContain('title = TextContent("行程")');
    expect(program).not.toContain('原计划');
    expect(merged.startsWith('补充说明。')).toBe(true);
  });

  test('a complete new program replaces the segment without merging', () => {
    const response = `全新界面：\n\n${FENCE(
      ['root = Card([list])', 'list = TextContent("完全不同的回答")'].join('\n'),
    )}`;
    const merged = resolveOpenUiResponse(BASE, response);
    const [program] = programs(merged);
    expect(program).toContain('完全不同的回答');
    expect(program).not.toContain('行程');
  });

  test('returns plain text unchanged when there is no previous UI', () => {
    const response = '就是一段普通文字。';
    expect(resolveOpenUiResponse('', response)).toBe(response);
  });

  test('a text-only turn keeps the current text and carries the previous UI over', () => {
    const response = 'hello';
    const merged = resolveOpenUiResponse(BASE, response);
    expect(merged.startsWith('hello')).toBe(true);
    expect(merged).not.toContain('上一轮说明');
    expect(programs(merged)).toHaveLength(1);
    expect(programs(merged)[0]).toContain('root = Card([title, body])');
    expect(merged.replace(response, '')).toContain('```openui-lang');
  });

  test('a patch to s0 keeps the untouched previous s1 with its own root', () => {
    const previous = `${FENCE(
      ['root = Card([a])', 'a = TextContent("第一段原样")'].join('\n'),
    )}\n中间\n${FENCE(['root = Card([b])', 'b = TextContent("第二段原样")'].join('\n'))}`;
    const response = `本轮补充。\n\n${FENCE('a = TextContent("第一段更新")')}`;
    const merged = resolveOpenUiResponse(previous, response);
    expect(merged.startsWith('本轮补充。')).toBe(true);
    expect(merged).not.toContain('中间');
    const [first, second] = programs(merged);
    expect(first).toContain('第一段更新');
    expect(second).toContain('root = Card([b])');
    expect(second).toContain('第二段原样');
  });

  test('a complete new program keeps any extra previous segment; deleting it takes an empty fence', () => {
    const previous = `${FENCE(['root = Card([a])', 'a = TextContent("旧")'].join('\n'))}\n${FENCE(
      ['root = Card([b])', 'b = TextContent("要删掉的第二段")'].join('\n'),
    )}`;
    const response = FENCE(['root = Card([c])', 'c = TextContent("全新界面")'].join('\n'));
    const withExtra = resolveOpenUiResponse(previous, response);
    expect(programs(withExtra)).toHaveLength(2);
    expect(programs(withExtra)[1]).toContain('要删掉的第二段');

    const explicit = resolveOpenUiResponse(previous, `${response}\n\n${FENCE('')}`);
    expect(programs(explicit)).toHaveLength(1);
    expect(programs(explicit)[0]).toContain('全新界面');
  });

  test('deleting a segment renumbers the ones after it because blockKey is positional', () => {
    const previous = `${FENCE(['root = Card([a])', 'a = TextContent("一")'].join('\n'))}\n${FENCE(
      ['root = Card([b])', 'b = TextContent("二")'].join('\n'),
    )}`;
    const merged = resolveOpenUiResponse(previous, FENCE(''));
    expect(programs(merged)).toHaveLength(1);
    expect(programs(merged)[0]).toContain('TextContent("二")');
  });

  test('does not merge a patch that has no baseline', () => {
    const response = FENCE('body = TextContent("无基线的补丁")');
    const { text, diagnostics } = resolveOpenUiResponseDetailed('', response);
    expect(text).toBe(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ blockKey: 's0', code: 'missing-baseline' });
  });

  test('merges each of several segments with its own baseline by block key', () => {
    const previous = `${FENCE(
      ['root = Card([a])', 'a = TextContent("第一版")'].join('\n'),
    )}\n中间\n${FENCE(['root = Card([b])', 'b = TextContent("第二段原样")'].join('\n'))}`;
    const response = `${FENCE('a = TextContent("第一段更新")')}\n中间\n${FENCE(
      'b = TextContent("第二段更新")',
    )}`;
    const merged = resolveOpenUiResponse(previous, response);
    const [first, second] = programs(merged);
    expect(first).toContain('第一段更新');
    expect(second).toContain('第二段更新');
  });

  test('a second, independent root is not merged into the first segment', () => {
    const previous = FENCE(['root = Card([a])', 'a = TextContent("旧")'].join('\n'));
    const response = FENCE(
      ['root = Card([a, b])', 'a = TextContent("旧")', 'b = TextContent("新段")'].join('\n'),
    );
    const merged = resolveOpenUiResponse(previous, response);
    expect(programs(merged)).toHaveLength(1);
    expect(programs(merged)[0]).toContain('新段');
  });

  test('keeps the original text when the merged program still does not parse', () => {
    const previous = FENCE(['root = Card([a])', 'a = TextContent("旧")'].join('\n'));
    const response = FENCE('root = Card([missing])');
    const { text, diagnostics } = resolveOpenUiResponseDetailed(previous, response);
    expect(text).toBe(response);
    expect(diagnostics.some((item) => item.code === 'invalid-program')).toBe(true);
  });

  test('does not merge an incomplete (half-written) program', () => {
    const response = `流式半截：\n\n${FENCE('root = Card([')}`;
    const { diagnostics } = resolveOpenUiResponseDetailed(BASE, response);
    expect(
      diagnostics.some(
        (item) => item.code === 'missing-baseline' || item.code === 'invalid-program',
      ),
    ).toBe(true);
  });

  test('keeps merged program when base or patch has recoverable non-fatal errors like excess-args', () => {
    const baseWithExcess = FENCE(
      [
        'root = Card([title, body])',
        'title = TextContent("行程", "default", "extra")',
        'body = TextContent("原计划")',
      ].join('\n'),
    );
    const patch = FENCE('body = TextContent("新计划", "default", "extra-patch")');
    const { text, diagnostics } = resolveOpenUiResponseDetailed(baseWithExcess, patch);
    expect(diagnostics).toEqual([]);
    const [program] = programs(text);
    expect(program).toContain('root = Card([title, body])');
    expect(program).toContain('title = TextContent("行程", "default", "extra")');
    expect(program).toContain('body = TextContent("新计划", "default", "extra-patch")');
  });

  test('does not treat a non-root Card snippet as a full replacement via no-root fallback', () => {
    const response = FENCE('sub = Card([TextContent("子项")])');
    const { text, diagnostics } = resolveOpenUiResponseDetailed(BASE, response);
    expect(diagnostics).toEqual([]);
    const [program] = programs(text);
    expect(program).toContain('root = Card([title, body])');
    expect(program).toContain('title = TextContent("行程")');
    expect(program).toContain('body = TextContent("原计划")');
    expect(program).not.toContain('sub = Card');
  });

  test('reports invalid-program and keeps raw text when fence has no valid statements', () => {
    const response = FENCE('Error: failed');
    const { text, diagnostics } = resolveOpenUiResponseDetailed(BASE, response);
    expect(text).toBe(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ blockKey: 's0', code: 'invalid-program' });
  });
});
