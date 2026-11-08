import type { KnowledgeAudioMetadata } from '@agentport/shared';

/**
 * 知识库解析产物的纯结构：解析（Docling/本地格式）在 worker 里产生它们，
 * 分块与预览在这里计算，两处共用同一份类型。
 */
export type ParsedBlock = {
  content: string;
  heading: string;
  locator: Record<string, unknown>;
};

export type ParsedImage = {
  name: string;
  data: Uint8Array;
  mimeType: string;
  page: number;
};

export type PageRange = { page: number; startOffset: number; endOffset: number };

export type ParsedDocument = {
  markdown: string;
  blocks: ParsedBlock[];
  images: ParsedImage[];
  pageMap: PageRange[];
  /** 仅音频转录取值；段级偏移与真实时码存放在版本 metadata。 */
  audio?: KnowledgeAudioMetadata;
};

export type ParseErrorCode =
  | 'invalid_input'
  | 'parser_unavailable'
  | 'upstream_http'
  | 'redirect'
  | 'invalid_response'
  | 'partial_success'
  | 'upstream_failure'
  | 'unsupported'
  | 'aborted';

export class KnowledgeParseError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgeParseError';
    this.code = code;
  }
}

/** 面包屑标题拼接；空层级不产生空段，Docling 与 Markdown 解析共用。 */
export function emptyHeading(heading: string[]): string {
  return heading.filter((part) => part !== '').join(' > ');
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

export function isFenceStart(value: string): boolean {
  return FENCE.test(value);
}

/** 围栏起始行的标记（``` 或 ~~~ 及其长度）；解析侧去掉围栏时用同一份语法。 */
export function fenceStartMarker(line: string): string | null {
  return FENCE.exec(line)?.[1] ?? null;
}

/** A fence closes only with its own character repeated at least as many times, then whitespace. */
export function fenceCloser(marker: string): RegExp {
  const char = marker[0] ?? '`';
  return new RegExp(`^\\s*${char}{${marker.length},}\\s*$`);
}

export function isTableDelimiterLine(line: string): boolean {
  return line.includes('|') && TABLE_DELIMITER.test(line);
}

export function isTableBlock(content: string): boolean {
  // A fenced block is code even when its body shows a table.
  if (isFenceStart(content)) return false;
  return content.split('\n').some(isTableDelimiterLine);
}

/** Tables/code stay whole for chunking, including GFM tables without outer pipes. */
export function isAtomicBlock(content: string): boolean {
  return isTableBlock(content) || isFenceStart(content);
}

/** Splits CRLF/CR/LF keeping each line's original offset so page ranges stay exact. */
export function splitLines(markdown: string): { lines: string[]; offsets: number[] } {
  const lines: string[] = [];
  const offsets: number[] = [];
  let start = 0;
  for (let index = 0; index <= markdown.length; index += 1) {
    const char = markdown[index];
    if (index === markdown.length || char === '\n' || char === '\r') {
      lines.push(markdown.slice(start, index));
      offsets.push(start);
      if (char === '\r' && markdown[index + 1] === '\n') index += 1;
      start = index + 1;
    }
  }
  return { lines, offsets };
}

/** 二分查找偏移所在行号；行首表来自 splitLines，CRLF 的 CR 不会多算一行。 */
export function lineAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Line-based Markdown splitter: fenced code and tables stay whole, headings only set the
 * breadcrumb, blank lines separate paragraphs. Not full CommonMark.
 *
 * 没有正文承接的标题（连续同级标题、文末标题）落成自己的内容块，OCR 纯标题页才不会被丢掉。
 */
export function markdownBlocks(
  markdown: string,
  locator: (line: number, offset?: number, endOffset?: number) => Record<string, unknown>,
): ParsedBlock[] {
  const { lines, offsets } = splitLines(markdown);
  const blocks: ParsedBlock[] = [];
  const headings: string[] = [];
  // 标题先挂起，等正文消费成面包屑；被同级/上级标题覆盖或文末仍挂起时转成内容块。
  let pending: Array<{
    level: number;
    title: string;
    line: number;
    startOffset: number;
    endOffset: number;
  }> = [];
  let paragraph: string[] = [];
  let paragraphIndex = 0;
  let paragraphEnd = 0;

  // 块内容整体 trim 过；区间必须对应原文里真正的首尾字符，且跳过 CRLF 的 CR。
  const contentStart = (lineIndex: number) => {
    const line = lines[lineIndex] ?? '';
    return (offsets[lineIndex] ?? 0) + line.length - line.trimStart().length;
  };
  const contentEnd = (lineIndex: number) => {
    const line = lines[lineIndex] ?? '';
    return (offsets[lineIndex] ?? 0) + line.trimEnd().length;
  };

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      content: paragraph.join('\n').trim(),
      heading: emptyHeading(headings),
      locator: locator(paragraphIndex + 1, contentStart(paragraphIndex), contentEnd(paragraphEnd)),
    });
    paragraph = [];
  };

  const setHeading = (level: number, title: string) => {
    headings.length = Math.min(headings.length, level - 1);
    headings[level - 1] = title;
  };

  /** 正文承接挂起标题：它们只是面包屑，不进内容。 */
  const commitPending = () => {
    for (const entry of pending) setHeading(entry.level, entry.title);
    pending = [];
  };

  // 被覆盖的子标题之前，尚无正文的祖先也按阅读顺序保留下来。
  const flushPending = (level: number) => {
    if (!pending.some((entry) => entry.level >= level)) return;
    for (const entry of pending) {
      setHeading(entry.level, entry.title);
      blocks.push({
        content: entry.title,
        heading: emptyHeading(headings),
        locator: locator(entry.line + 1, entry.startOffset, entry.endOffset),
      });
    }
    pending = [];
  };

  const pushHeading = (level: number, title: string, line: number, startOffset: number) => {
    flushPending(level);
    pending.push({ level, title, line, startOffset, endOffset: startOffset + title.length });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      commitPending();
      flush();
      const marker = fence[1] ?? '```';
      const closer = fenceCloser(marker);
      const start = index;
      index += 1;
      while (index < lines.length && !closer.test(lines[index] ?? '')) index += 1;
      if (index < lines.length) index += 1;
      blocks.push({
        content: lines.slice(start, index).join('\n').trim(),
        heading: emptyHeading(headings),
        locator: locator(start + 1, contentStart(start), contentEnd(index - 1)),
      });
      continue;
    }
    // A GFM table starts with a pipe row followed by a delimiter row; outer pipes are optional.
    if (line.includes('|') && isTableDelimiterLine(lines[index + 1] ?? '')) {
      commitPending();
      flush();
      const start = index;
      index += 1;
      while (index < lines.length) {
        const row = lines[index] ?? '';
        if (row.trim() === '' || !row.includes('|')) break;
        index += 1;
      }
      blocks.push({
        content: lines.slice(start, index).join('\n').trim(),
        heading: emptyHeading(headings),
        locator: locator(start + 1, contentStart(start), contentEnd(index - 1)),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const title = (heading[2] ?? '').trim();
      const titleAt = line.indexOf(title);
      pushHeading(
        (heading[1] ?? '#').length,
        title,
        index,
        titleAt === -1 ? contentStart(index) : (offsets[index] ?? 0) + titleAt,
      );
      index += 1;
      continue;
    }
    // Minimal setext support: only a one-line paragraph followed by its underline.
    const setext = SETEXT.exec(line);
    if (setext && paragraph.length === 1) {
      pushHeading(
        setext[1]?.startsWith('=') ? 1 : 2,
        (paragraph[0] ?? '').trim(),
        paragraphIndex,
        contentStart(paragraphIndex),
      );
      paragraph = [];
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      flush();
      index += 1;
      continue;
    }
    if (paragraph.length > 0 || !SETEXT.test(lines[index + 1] ?? '')) commitPending();
    if (paragraph.length === 0) paragraphIndex = index;
    paragraphEnd = index;
    paragraph.push(line);
    index += 1;
  }
  flushPending(1);
  flush();
  return blocks;
}

function mergeLocators(blocks: ParsedBlock[]): Record<string, unknown> {
  const pages = blocks
    .map((block) => block.locator.page)
    .filter((page): page is number => typeof page === 'number');
  const locator: Record<string, unknown> = {};
  if (pages.length > 0) {
    const page = Math.min(...pages);
    const pageTo = Math.max(...pages);
    locator.page = page;
    if (pageTo > page) locator.pageTo = pageTo;
  }
  // 混入无原文位置的 JSON 内容后，首尾偏移不能代表整个 chunk。
  const located = blocks.every(
    (block) =>
      typeof block.locator.startOffset === 'number' && typeof block.locator.endOffset === 'number',
  );
  const lines = located
    ? blocks
        .map((block) => block.locator.line)
        .filter((line): line is number => typeof line === 'number')
    : [];
  if (lines.length > 0) locator.line = Math.min(...lines);
  const starts = blocks
    .map((block) => block.locator.startOffset)
    .filter((offset): offset is number => typeof offset === 'number');
  const ends = blocks
    .map((block) => block.locator.endOffset)
    .filter((offset): offset is number => typeof offset === 'number');
  if (located && starts.length > 0) locator.startOffset = Math.min(...starts);
  if (located && ends.length > 0) locator.endOffset = Math.max(...ends);
  // 只有组成块全都有时码才能给整块时间；部分时间会冒充全块来源。
  const timed = blocks.every(
    (block) =>
      typeof block.locator.timeFromMs === 'number' && typeof block.locator.timeToMs === 'number',
  );
  if (timed) {
    locator.timeFromMs = Math.min(...blocks.map((block) => block.locator.timeFromMs as number));
    locator.timeToMs = Math.max(...blocks.map((block) => block.locator.timeToMs as number));
  }
  // 解析器引用/坐标只对单个块无歧义；合并块不能编造一个共同坐标。
  const only = blocks.length === 1 ? blocks[0]?.locator : undefined;
  if (typeof only?.ref === 'string') locator.ref = only.ref;
  if (only?.bbox !== undefined) locator.bbox = only.bbox;
  if (Object.keys(locator).length === 0) return { page: 'unknown' };
  return locator;
}

/**
 * 把规范化块内容的下标映射回原文 UTF-16 下标：块内容用 LF 拼行，原文可能是 CRLF。
 * 无法逐字对齐时返回 null，调用方就不能把整块区间冒充成分片区间。
 */
function mapContentOffsets(
  markdown: string,
  start: number,
  end: number,
  content: string,
): { starts: number[]; ends: number[] } | null {
  if (start < 0 || end > markdown.length || end < start) return null;
  const starts = new Array<number>(content.length);
  const ends = new Array<number>(content.length);
  let at = start;
  for (let index = 0; index < content.length; index += 1) {
    const before = at;
    if (content[index] === '\n') {
      if (markdown[at] === '\r' && markdown[at + 1] === '\n') at += 2;
      else if (markdown[at] === '\r' || markdown[at] === '\n') at += 1;
      else return null;
    } else {
      if (markdown[at] !== content[index]) return null;
      at += 1;
    }
    if (at > end) return null;
    starts[index] = before;
    ends[index] = at;
  }
  return { starts, ends };
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** 落在代理对中间的下标退到高代理项：end 不切开 emoji，重叠起点也从完整字符开始。 */
function codePointBoundary(text: string, index: number): number {
  return index > 0 &&
    index < text.length &&
    isLowSurrogate(text.charCodeAt(index)) &&
    isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

/** 已对齐界的下标取完整 code point 宽度；预算小到装不下时靠它保证切块继续前进。 */
function codePointLength(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))
    ? 2
    : 1;
}

/** 行拆分的表格/代码块不是原文连续片段：保留整表 ref/bbox，但不保留块级文本区间。 */
function withoutTextRange(block: ParsedBlock): ParsedBlock {
  const locator = { ...block.locator };
  delete locator.startOffset;
  delete locator.endOffset;
  delete locator.line;
  delete locator.charStart;
  delete locator.charEnd;
  return { ...block, locator };
}

/**
 * 表格按行拆分时保留列语义，按 maxChars 预算切块并重复表头。
 * shortcut: 单行超过预算时不拆行，那个 chunk 会超预算；模型窗口真的卡住时再按单元格拆。
 */
function splitTable(block: ParsedBlock, maxChars: number): ParsedBlock[] {
  const lines = block.content.split('\n');
  const separator = lines[1] !== undefined && isTableDelimiterLine(lines[1]) ? lines[1] : null;
  const header = separator ? [lines[0] ?? '', separator] : [];
  const head = header.length > 0 ? lines.slice(0, 2) : [lines[0] ?? ''];
  const rows = lines.slice(head.length);
  const parts: ParsedBlock[] = [];
  let current: string[] = [];
  let size = head.join('\n').length;
  const flush = () => {
    if (current.length === 0) return;
    parts.push(withoutTextRange({ ...block, content: [...head, ...current].join('\n') }));
    current = [];
    size = head.join('\n').length;
  };
  for (const row of rows) {
    if (current.length > 0 && size + row.length + 1 > maxChars) flush();
    current.push(row);
    size += row.length + 1;
  }
  flush();
  return parts;
}

/** 代码块按行拆分时每段都自带完整 fence，保证切块后仍是有效 Markdown。 */
function splitFence(block: ParsedBlock, maxChars: number): ParsedBlock[] {
  const lines = block.content.split('\n');
  const opener = lines[0] ?? '';
  const closer = lines.at(-1) ?? '';
  const body = lines.slice(1, -1);
  const overhead = opener.length + closer.length + 1;
  const parts: ParsedBlock[] = [];
  let current: string[] = [];
  let size = overhead;
  const flush = () => {
    if (current.length === 0) return;
    parts.push(withoutTextRange({ ...block, content: [opener, ...current, closer].join('\n') }));
    current = [];
    size = overhead;
  };
  for (const line of body) {
    if (current.length > 0 && size + line.length + 1 > maxChars) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return parts;
}

/** 超长块先按语义二次切分：表格按行（重复表头）、代码按行（补全 fence）。 */
function clampChunk(block: ParsedBlock, maxChars: number): ParsedBlock[] {
  if (block.content.length <= maxChars) return [block];
  if (isTableBlock(block.content)) return splitTable(block, maxChars);
  if (isFenceStart(block.content)) return splitFence(block, maxChars);
  return [block];
}

/**
 * 摄取与预览共用的分块入口：clamp（超长块二次切分）→ 原子分组（表格/代码独立成块）
 * → 结构感知合并。两边必须走同一条路径，否则同一段 Markdown 会给出不同的块数。
 */
export function chunkBlocks(
  blocks: ParsedBlock[],
  markdown: string,
  options: { chunkSize: number; chunkOverlap: number },
): Array<{ content: string; heading: string; locator: Record<string, unknown> }> {
  // chunkTokens 是字符预算：下限 200 字符，重叠不能吃掉整个预算，否则切块无法前进。
  const maxChars = Math.max(200, options.chunkSize);
  const overlap = Math.max(0, Math.min(options.chunkOverlap, maxChars - 1));
  const rows = blocks.flatMap((block) => clampChunk(block, maxChars));

  // 表格/代码块必须整块独立成 chunk，不能再被跨块合并；连续散文才交给结构感知合并。
  const groups: ParsedBlock[][] = [];
  let atomicGroup = false;
  for (const block of rows) {
    const atomic = isAtomicBlock(block.content);
    const last = groups.at(-1);
    if (!atomic && last && !atomicGroup) {
      last.push(block);
      continue;
    }
    groups.push([block]);
    atomicGroup = atomic;
  }

  return groups.flatMap((group) =>
    chunkDocument(
      { markdown, blocks: group, images: [], pageMap: [] },
      { chunkSize: maxChars, chunkOverlap: overlap },
    ),
  );
}

export function chunkDocument(
  parsed: ParsedDocument,
  options?: { chunkSize?: number; chunkOverlap?: number },
): Array<{ content: string; heading: string; locator: Record<string, unknown> }> {
  const chunkSize = options?.chunkSize ?? 1200;
  const chunkOverlap = options?.chunkOverlap ?? 200;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new KnowledgeParseError('invalid_input', `chunkSize 必须是正整数，收到 ${chunkSize}`);
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new KnowledgeParseError(
      'invalid_input',
      `chunkOverlap 必须满足 0 <= overlap < chunkSize，收到 ${chunkOverlap}`,
    );
  }

  const chunks: Array<{ content: string; heading: string; locator: Record<string, unknown> }> = [];
  let pending: ParsedBlock[] = [];
  let pendingSize = 0;

  const flush = () => {
    if (pending.length === 0) return;
    chunks.push({
      content: pending.map((block) => block.content).join('\n\n'),
      heading: pending[0]?.heading ?? '',
      locator: mergeLocators(pending),
    });
    pending = [];
    pendingSize = 0;
  };

  const splitLong = (block: ParsedBlock) => {
    const { content, heading, locator } = block;
    const sourceStart = locator.startOffset;
    const sourceEnd = locator.endOffset;
    const mapped =
      typeof sourceStart === 'number' && typeof sourceEnd === 'number'
        ? mapContentOffsets(parsed.markdown, sourceStart, sourceEnd, content)
        : null;
    const lineStarts = mapped ? splitLines(parsed.markdown).offsets : [];
    let start = 0;
    while (start < content.length) {
      let end = Math.min(start + chunkSize, content.length);
      end = codePointBoundary(content, end);
      // 预算装不下开头的整个 code point 时整取，避免 end <= start 卡住。
      if (end <= start) end = start + codePointLength(content, start);
      const chunkLocator: Record<string, unknown> = { ...locator, charStart: start, charEnd: end };
      if (mapped) {
        const chunkStart = mapped.starts[start] ?? (sourceStart as number);
        chunkLocator.startOffset = chunkStart;
        chunkLocator.endOffset = mapped.ends[end - 1] ?? chunkStart;
        chunkLocator.line = lineAtOffset(lineStarts, chunkStart);
      } else if (typeof sourceStart === 'number' || typeof sourceEnd === 'number') {
        // 内容无法逐字映射到原文时不保留块级区间，避免分片继续指向整段。
        delete chunkLocator.startOffset;
        delete chunkLocator.endOffset;
        delete chunkLocator.line;
      }
      chunks.push({ content: content.slice(start, end), heading, locator: chunkLocator });
      if (end === content.length) break;
      const next = codePointBoundary(content, end - chunkOverlap);
      // 对齐边界可能退回到上一片起点；此时直接取下一个完整字符，始终向前。
      start = next > start ? next : start + codePointLength(content, start);
    }
  };

  for (const block of parsed.blocks) {
    if (block.content.trim() === '') continue;
    if (block.content.length > chunkSize) {
      flush();
      if (isAtomicBlock(block.content)) {
        chunks.push({ content: block.content, heading: block.heading, locator: block.locator });
      } else {
        splitLong(block);
      }
      continue;
    }
    if (pending.length > 0 && pending[0]?.heading !== block.heading) flush();
    if (pending.length > 0 && pendingSize + block.content.length + 2 > chunkSize) flush();
    pending.push(block);
    pendingSize += block.content.length + (pending.length > 1 ? 2 : 0);
  }
  flush();
  return chunks;
}
