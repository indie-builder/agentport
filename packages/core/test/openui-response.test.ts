import { segmentOpenUi } from '@agentport/shared';
import { describe, expect, test } from 'vitest';
import { resolveOpenUiResponse, resolveOpenUiResponseDetailed } from '../src/openui-response.js';

/**
 * 跨轮补丁的合并语义。返回值是这条消息的**完整快照**（worker 原样落库），契约：
 * - 只合并**已完成**、且与上一轮同序号段的完整程序；
 * - 每个 UI 段独立（s0/s1 各自一条基线）；
 * - 完整新程序（有 root）直接生效，不需要基线；
 * - 本轮没提到的旧 UI 段一律保留（追加到末尾、保持 sN 顺序、带原 root），
 *   不重复旧 Markdown；只有显式写出空段才表示删除；
 * - 缺基线、合并后仍不可解析时保留原文并给出诊断，不猜、不静默丢内容。
 */
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
    // Markdown 部分原样保留。
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
    // 返回值是完整快照：本轮文字在，上一轮的界面仍在，且带自己的 root。
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
    // 旧 Markdown 不重复，UI 段按 s0、s1 顺序完整保留。
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

    // 显式空围栏才是删除声明，静默消失不算。
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
    // 只改 root 引用一个不存在的语句：合并后缺语句，不能当完整程序。
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
});
