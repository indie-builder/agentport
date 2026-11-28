/**
 * 把助手回复切成 Markdown 与 OpenUI 程序两种段。
 *
 * 官方 `stripFences()` 会提取**任意**三反引号围栏，整段交给 Renderer 会把
 * js/json 代码块也当程序解析。这里只认 `openui-lang`（允许 `openui` 别名），
 * 且只识别不在其他围栏内部的围栏。浏览器与服务端共用这一份。
 */

export type OpenUiBlockKey = string;

export interface OpenUiSegment {
  kind: 'markdown' | 'openui';
  text: string;
  blockKey?: OpenUiBlockKey;
}

const FENCE_OPEN = /^ {0,3}```(.*)$/;
const OPENUI_LANG = /^(?:openui-lang|openui)[ \t]*$/;
const FENCE_CLOSE = /^ {0,3}```[ \t]*$/;

interface Line {
  body: string;
  width: number;
  start: number;
}

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
    const value = text.slice(markdownStart, end);
    if (value !== '') segments.push({ kind: 'markdown', text: value });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const open = FENCE_OPEN.exec(line.body);
    if (open === null) continue;

    const lang = open[1] ?? '';
    if (!OPENUI_LANG.test(lang)) {
      let close = index + 1;
      while (close < lines.length && !FENCE_CLOSE.test(lines[close]?.body ?? '')) close += 1;
      index = close;
      continue;
    }

    let close = index + 1;
    while (close < lines.length && !FENCE_CLOSE.test(lines[close]?.body ?? '')) close += 1;
    const unclosed = close >= lines.length;
    if (unclosed && !streaming) break;

    flushMarkdown(line.start);
    const bodyStart = line.start + line.width;
    const bodyEnd = unclosed
      ? text.length
      : (lines[close]?.start ?? text.length) - newlineWidthOf(lines[close - 1]);
    segments.push({
      kind: 'openui',
      text: text.slice(bodyStart, bodyEnd),
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

export function hasOpenUiSegment(text: string): boolean {
  return segmentOpenUi(text).some((segment) => segment.kind === 'openui');
}
