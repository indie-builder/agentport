/**
 * 把助手回复切成 Markdown 与 OpenUI 程序两种段。
 *
 * 官方 `stripFences()` 会提取**任意**三反引号围栏，整段交给 Renderer 会把
 * js/json 代码块也当程序解析。这里只认 `openui-lang`（允许 `openui` 别名），
 * 且只识别不在其他围栏内部的围栏。浏览器与服务端共用这一份。
 */

/** UI 段的稳定身份：只数 openui 段，Markdown 不占号；同一条消息内 `s0`、`s1`…… */
export type OpenUiBlockKey = string;

export interface OpenUiSegment {
  kind: 'markdown' | 'openui';
  text: string;
  /** 原文中的起止字符偏移；调用方可以据此重建完整混合文本。 */
  start: number;
  end: number;
  /** 仅 openui 段：动作与表单状态的命名空间。 */
  blockKey?: OpenUiBlockKey;
}

/** 任一围栏起始行：三反引号 + 可选语言标签。 */
const FENCE_OPEN = /^ {0,3}```(.*)$/;
const OPENUI_LANG = /^(?:openui-lang|openui)[ \t]*$/;
const FENCE_CLOSE = /^ {0,3}```[ \t]*$/;

interface Line {
  /** 不含换行符的正文。 */
  body: string;
  /** 原文里这一行占的字符数（含 \r\n），用于切片。 */
  width: number;
  start: number;
}

/** 按 \r?\n 切行；`width` 保留原始长度，切片时不会错位。 */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = match[0];
    if (raw === '') break;
    lines.push({ body: raw.replace(/\r?\n$|\r$/, ''), width: raw.length, start });
    start += raw.length;
    if (start >= text.length) break;
  }
  return lines;
}

function newlineWidthOf(line: Line | undefined): number {
  if (line === undefined) return 0;
  return line.width - line.body.length;
}

export function segmentOpenUi(text: string, streaming = false): OpenUiSegment[] {
  const lines = splitLines(text);
  const segments: OpenUiSegment[] = [];
  let markdownStart = 0;
  let uiCount = 0;

  const flushMarkdown = (end: number) => {
    if (end <= markdownStart) return;
    // 纯空白段也保留：围栏之间的空行属于 Markdown，吞掉会改变排版。
    const value = text.slice(markdownStart, end);
    if (value !== '') segments.push({ kind: 'markdown', text: value, start: markdownStart, end });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const open = FENCE_OPEN.exec(line.body);
    if (open === null) continue;

    const lang = open[1] ?? '';
    if (!OPENUI_LANG.test(lang)) {
      // 外层是别的语言围栏：跳到它自己的关闭处，里面的 openui 围栏只是内容。
      let close = index + 1;
      while (close < lines.length && !FENCE_CLOSE.test(lines[close]?.body ?? '')) close += 1;
      index = close;
      continue;
    }

    let close = index + 1;
    while (close < lines.length && !FENCE_CLOSE.test(lines[close]?.body ?? '')) close += 1;
    const unclosed = close >= lines.length;
    // 未闭合围栏只在流式期间当作「正在生成」；稳定消息退回 Markdown 原文。
    if (unclosed && !streaming) break;

    flushMarkdown(line.start);
    const bodyStart = line.start + line.width;
    // 闭合围栏前的那一行换行不属于程序正文；只保留程序自身的行。
    const bodyEnd = unclosed
      ? text.length
      : (lines[close]?.start ?? text.length) - newlineWidthOf(lines[close - 1]);
    segments.push({
      kind: 'openui',
      text: text.slice(bodyStart, bodyEnd),
      start: bodyStart,
      end: bodyEnd,
      blockKey: `s${uiCount}`,
    });
    uiCount += 1;
    if (unclosed) return segments;

    const closeLine = lines[close];
    markdownStart = (closeLine?.start ?? text.length) + (closeLine?.width ?? 0);
    index = close;
  }
  flushMarkdown(text.length);
  return segments;
}

/** 是否有任何 UI 段；服务端落库前用它判断要不要合并。 */
export function hasOpenUiSegment(text: string): boolean {
  return segmentOpenUi(text).some((segment) => segment.kind === 'openui');
}
