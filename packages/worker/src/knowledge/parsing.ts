import { errorText, type KnowledgeAudioMetadata } from '@agentport/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import { fromMarkdown } from 'mdast-util-from-markdown';
import TurndownService from 'turndown';
import { z } from 'zod';
import { assertUsableImage } from './image-processing.js';

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

type Format = 'md' | 'txt' | 'csv' | 'json' | 'html' | 'docling';

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** 真实 magic 决定格式；上传声明的 MIME 只用于一致性校验，不单独采信。 */
function sniffImage(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function imageDocument(
  bytes: Uint8Array,
  image: { mimeType: string; extension: string },
): ParsedDocument {
  const name = `image-1.${image.extension}`;
  const reference = `![${name}](images/${name})`;
  return {
    markdown: reference,
    images: [{ name, data: bytes, mimeType: image.mimeType, page: 1 }],
    pageMap: [],
    blocks: [{ content: reference, heading: '', locator: { page: 1, kind: 'image' } }],
  };
}

// OCR on large scans is slow; a silent hang would pin a job forever.
const DOCLING_TIMEOUT_MS = 10 * 60 * 1000;

function detectFormat(filename: string, mimeType: string): Format {
  const mime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  const ext = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    ext === 'md' ||
    ext === 'markdown'
  ) {
    return 'md';
  }
  if (
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    ext === 'html' ||
    ext === 'htm' ||
    ext === 'xhtml'
  ) {
    return 'html';
  }
  if (mime === 'text/csv' || mime === 'application/csv' || ext === 'csv') return 'csv';
  if (mime === 'application/json' || mime.endsWith('+json') || ext === 'json') return 'json';
  if (
    mime === 'text/plain' ||
    mime === 'text/x-log' ||
    ext === 'txt' ||
    ext === 'text' ||
    ext === 'log'
  ) {
    return 'txt';
  }
  return 'docling';
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function emptyHeading(heading: string[]): string {
  return heading.filter((part) => part !== '').join(' > ');
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

export function isFenceStart(value: string): boolean {
  return FENCE.test(value);
}

/** A fence closes only with its own character repeated at least as many times, then whitespace. */
function fenceCloser(marker: string): RegExp {
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
function splitLines(markdown: string): { lines: string[]; offsets: number[] } {
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
function lineAtOffset(lineStarts: number[], offset: number): number {
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

function textBlocks(text: string): ParsedBlock[] {
  const lineStarts = splitLines(text).offsets;
  let cursor = 0;
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((content) => {
      const startOffset = text.indexOf(content, cursor);
      const endOffset = startOffset + content.length;
      cursor = endOffset;
      return {
        content,
        heading: '',
        locator: {
          page: 'unknown',
          startOffset,
          endOffset,
          line: lineAtOffset(lineStarts, startOffset),
        },
      };
    });
}

function parseCsvRows(text: string): string[][] {
  let rows: string[][];
  try {
    rows = parseCsv(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      record_delimiter: ['\r\n', '\n', '\r'],
      cast: false,
      trim: false,
    });
  } catch (error) {
    throw new KnowledgeParseError(
      'invalid_input',
      `CSV 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return rows.filter((row) => row.some((value) => value.trim() !== ''));
}

function escapeCell(value: string): string {
  return value
    .trim()
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}

function renderTable(rows: string[][]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cells = rows.map((row) =>
    Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? '')),
  );
  const format = (row: string[]) => `| ${row.join(' | ')} |`;
  const [header = [], ...body] = cells;
  return [
    format(header),
    format(Array.from({ length: width }, () => '---')),
    ...body.map(format),
  ].join('\n');
}

function csvDocument(text: string): ParsedDocument {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new KnowledgeParseError('invalid_input', 'CSV 文件没有可解析的行');
  const markdown = renderTable(rows);
  return {
    markdown,
    images: [],
    pageMap: [],
    blocks: [
      {
        content: markdown,
        heading: '',
        locator: {
          page: 'unknown',
          kind: 'csv',
          rows: rows.length - 1,
          startOffset: 0,
          endOffset: markdown.length,
          line: 1,
        },
      },
    ],
  };
}

function jsonDocument(text: string): ParsedDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new KnowledgeParseError(
      'invalid_input',
      `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const markdown = ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
  return {
    markdown,
    images: [],
    pageMap: [],
    blocks: [
      {
        content: markdown,
        heading: '',
        locator: {
          page: 'unknown',
          kind: 'json',
          startOffset: 0,
          endOffset: markdown.length,
          line: 1,
        },
      },
    ],
  };
}

type DomLike = {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomLike>;
  getElementsByTagName(tag: string): ArrayLike<DomLike>;
};

function htmlTableToMarkdown(table: DomLike): string {
  const rows: string[][] = [];
  const rowNodes = table.getElementsByTagName('tr');
  for (let i = 0; i < rowNodes.length; i += 1) {
    const rowNode = rowNodes[i];
    if (!rowNode) continue;
    const cells: string[] = [];
    for (let j = 0; j < rowNode.childNodes.length; j += 1) {
      const cell = rowNode.childNodes[j];
      if (cell && cell.nodeType === 1 && /^(TD|TH)$/.test(cell.nodeName)) {
        cells.push(cell.textContent ?? '');
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? `\n\n${renderTable(rows)}\n\n` : '';
}

function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  service.remove([
    'head',
    'title',
    'script',
    'style',
    'noscript',
    'template',
    'nav',
    'footer',
    'aside',
    'iframe',
    'svg',
    'canvas',
    'form',
    'button',
    'input',
    'select',
    'textarea',
  ]);
  service.addRule('gfmTable', {
    filter: 'table',
    replacement: (_content, node) => htmlTableToMarkdown(node as unknown as DomLike),
  });
  return service
    .turndown(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const doclingBboxSchema = z.looseObject({
  l: z.number(),
  t: z.number(),
  r: z.number(),
  b: z.number(),
  coord_origin: z.string().optional(),
});

const doclingProvSchema = z.looseObject({
  page_no: z.number().optional(),
  bbox: doclingBboxSchema.optional(),
});

const doclingTextSchema = z.looseObject({
  self_ref: z.string().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  level: z.number().optional(),
  code_language: z.string().optional(),
  prov: z.array(doclingProvSchema).default([]),
});

const doclingTableCellSchema = z.looseObject({
  text: z.string(),
  start_row_offset_idx: z.number(),
  start_col_offset_idx: z.number(),
});

const doclingTableSchema = z.looseObject({
  self_ref: z.string().optional(),
  prov: z.array(doclingProvSchema).default([]),
  data: z
    .looseObject({
      num_rows: z.number().optional(),
      num_cols: z.number().optional(),
      table_cells: z.array(doclingTableCellSchema).default([]),
    })
    .optional(),
});

const doclingPictureSchema = z.looseObject({
  self_ref: z.string().optional(),
  prov: z.array(doclingProvSchema).default([]),
  // 官方响应里无法提取的图（如纯文本/无页图）会给出 image: null。
  image: z
    .looseObject({
      mimetype: z.string().optional(),
      uri: z.string().optional(),
    })
    .nullish(),
});

const doclingJsonSchema = z.looseObject({
  body: z
    .looseObject({ children: z.array(z.looseObject({ $ref: z.string() })).default([]) })
    .optional(),
  texts: z.array(doclingTextSchema).default([]),
  tables: z.array(doclingTableSchema).default([]),
  pictures: z.array(doclingPictureSchema).default([]),
  groups: z
    .array(z.looseObject({ children: z.array(z.looseObject({ $ref: z.string() })).default([]) }))
    .default([]),
});

// v1.38.2 官方 ErrorItem：只校验我们真正消费的 error_message，其余字段原样保留。
const doclingErrorSchema = z.looseObject({ error_message: z.string() });

const doclingResponseSchema = z.looseObject({
  status: z.enum(['success', 'partial_success', 'failure', 'skipped']),
  errors: z.array(doclingErrorSchema).default([]),
  document: z
    .looseObject({
      // 成功响应里 md_content 也可能为 null（只请求到 JSON 或导出失败时）。
      md_content: z.string().nullish(),
      json_content: doclingJsonSchema.nullish(),
    })
    .optional(),
});

type DoclingJson = z.infer<typeof doclingJsonSchema>;
type DoclingProv = z.infer<typeof doclingProvSchema>;

type AnyDoclingItem = { self_ref?: string | undefined; prov: DoclingProv[] };

function doclingLocator(item: AnyDoclingItem): Record<string, unknown> {
  const first = item.prov[0];
  const locator: Record<string, unknown> = {};
  if (item.self_ref) locator.ref = item.self_ref;
  if (typeof first?.page_no === 'number') locator.page = first.page_no;
  else locator.page = 'unknown';
  if (first?.bbox) {
    locator.bbox = {
      l: first.bbox.l,
      t: first.bbox.t,
      r: first.bbox.r,
      b: first.bbox.b,
      ...(first.bbox.coord_origin ? { coord_origin: first.bbox.coord_origin } : {}),
    };
  }
  return locator;
}

function tableMarkdownFromCells(table: z.infer<typeof doclingTableSchema>): string {
  const cells = table.data?.table_cells ?? [];
  if (cells.length === 0) return '';
  const rowCount =
    table.data?.num_rows ?? Math.max(...cells.map((cell) => cell.start_row_offset_idx)) + 1;
  const colCount =
    table.data?.num_cols ?? Math.max(...cells.map((cell) => cell.start_col_offset_idx)) + 1;
  const grid = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => ''));
  for (const cell of cells) {
    const row = grid[cell.start_row_offset_idx];
    if (row) row[cell.start_col_offset_idx] = cell.text;
  }
  return renderTable(grid);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Tables/code can be rendered differently by md vs json; compare their cells/content instead. */
function fingerprint(content: string): string {
  if (isTableBlock(content)) {
    return JSON.stringify(
      content
        .split('\n')
        .filter((line) => !isTableDelimiterLine(line))
        .map((line) =>
          line
            .trim()
            .replace(/^\||(?<!\\)\|$/g, '')
            .split(/(?<!\\)\|/)
            .map((cell) => normalizeText(markdownDisplaySource(cell).text)),
        ),
    );
  }
  const lines = content.split('\n');
  const opener = FENCE.exec(lines[0] ?? '')?.[1];
  if (opener && lines.length > 1 && fenceCloser(opener).test(lines.at(-1) ?? '')) {
    lines.shift();
    lines.pop();
    return normalizeText(lines.join(' '));
  }
  return normalizeText(content);
}

/** Walks body refs (descending into groups) so blocks keep the document's reading order. */
function orderedRefs(json: DoclingJson, includeUnreferenced = true): string[] {
  const refs: string[] = [];
  const visit = (children: Array<{ $ref: string }>, depth = 0) => {
    if (depth > 100) return;
    for (const child of children) {
      const ref = child.$ref;
      const group = /^#\/groups\/(\d+)$/.exec(ref);
      if (group) {
        const groupItem = json.groups[Number(group[1])];
        if (groupItem) visit(groupItem.children, depth + 1);
        continue;
      }
      refs.push(ref);
    }
  };
  if (json.body) visit(json.body.children);
  if (!includeUnreferenced) return refs;
  const seen = new Set(refs);
  json.texts.forEach((_text, index) => {
    const ref = `#/texts/${index}`;
    if (!seen.has(ref)) refs.push(ref);
  });
  json.tables.forEach((_table, index) => {
    const ref = `#/tables/${index}`;
    if (!seen.has(ref)) refs.push(ref);
  });
  return refs;
}

function doclingBlocks(json: DoclingJson): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const headings: string[] = [];
  let pending: Array<{ level: number; block: ParsedBlock }> = [];
  const flushPending = (level: number) => {
    if (!pending.some((entry) => entry.level >= level)) return;
    for (const { block } of pending) blocks.push(block);
    pending = [];
  };

  for (const ref of orderedRefs(json)) {
    const textRef = /^#\/texts\/(\d+)$/.exec(ref);
    if (textRef) {
      const item = json.texts[Number(textRef[1])];
      if (!item) continue;
      const label = item.label ?? '';
      const value = (item.text ?? '').trim();
      if (label === 'page_header' || label === 'page_footer' || value === '') continue;
      if (label === 'section_header' || label === 'title') {
        const level = label === 'title' ? 1 : Math.max(1, Math.min(6, item.level ?? 1));
        flushPending(level);
        headings.length = Math.min(headings.length, level - 1);
        headings[level - 1] = value;
        pending.push({
          level,
          block: { content: value, heading: emptyHeading(headings), locator: doclingLocator(item) },
        });
        continue;
      }
      pending = [];
      const content =
        label === 'code'
          ? `\`\`\`${item.code_language && item.code_language !== 'unknown' ? item.code_language : ''}\n${value}\n\`\`\``
          : value;
      blocks.push({
        content,
        heading: emptyHeading(headings),
        locator: doclingLocator(item),
      });
      continue;
    }
    const tableRef = /^#\/tables\/(\d+)$/.exec(ref);
    if (tableRef) {
      const table = json.tables[Number(tableRef[1])];
      if (!table) continue;
      const content = tableMarkdownFromCells(table);
      if (content === '') continue;
      pending = [];
      blocks.push({
        content,
        heading: emptyHeading(headings),
        locator: doclingLocator(table),
      });
    }
  }

  flushPending(1);

  return blocks;
}

const DATA_URI = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i;

/** 只接受响应内嵌的 data URI；远程 URL 一律不读，避免解析器替我们发起任意出站请求。 */
function doclingImages(json: DoclingJson): Array<{ image: ParsedImage; payload: string }> {
  const images: Array<{ image: ParsedImage; payload: string }> = [];
  for (const [index, picture] of json.pictures.entries()) {
    const match = DATA_URI.exec(picture.image?.uri ?? '');
    if (!match) continue;
    const payload = match[2] ?? '';
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length === 0) continue;
    const page = picture.prov[0]?.page_no;
    if (typeof page !== 'number') continue;
    const mimeType = match[1] ?? picture.image?.mimetype ?? 'application/octet-stream';
    const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    images.push({
      image: { name: `image-${index + 1}.${extension}`, data: bytes, mimeType, page },
      payload: payload.replace(/\s+/g, ''),
    });
  }
  return images;
}

const MARKDOWN_DATA_IMAGE = /!\[[^\]]*\]\(data:[^,)]*,([a-z0-9+/=\s]+)\)/gi;

/** embedded 模式下 md 与 json 内嵌同一张 data URI 图；md 里的 base64 不能进分块文本。 */
function normalizeEmbeddedImages(
  markdown: string,
  images: Array<{ image: ParsedImage; payload: string }>,
): string {
  // 按 base64 内容而不是整个 URI 匹配：两条导出路径的 URI 前缀可能不同，图片字节才是同一张。
  const byPayload = new Map(images.map(({ image, payload }) => [payload, image.name]));
  return markdown.replace(MARKDOWN_DATA_IMAGE, (_whole, payload: string) => {
    const name = byPayload.get(payload.replace(/\s+/g, ''));
    // shortcut: 没有落盘对应图的 data URI 用 Docling 自身的占位符替换；需要保留这类图时再单独抽取。
    return name ? `![${name}](images/${name})` : '<!-- image -->';
  });
}

type SourceRange = { start: number; end: number };

type DisplayRange = { start: number | null; end: number | null };
type DisplaySource = { text: string; ranges: DisplayRange[] };

type MarkdownRegion = SourceRange & {
  content: string;
  heading: string;
  kind: 'text' | 'table' | 'code' | 'image';
  display: DisplaySource;
  claims: Array<SourceRange & { locator: ParsedBlock['locator'] }>;
};

/** 短 OCR 文本只能匹配独立单词，不能把 "1" 定位到 "1234" 里。 */
function hasWordBoundary(text: string, start: number, end: number, needle: string): boolean {
  const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);
  return (
    !(isWord(needle[0]) && isWord(text[start - 1])) && !(isWord(needle.at(-1)) && isWord(text[end]))
  );
}

/** 显示字符与 UTF-16 原文区间一起生成；格式边界归属其首尾字符，正文始终取原文。 */
function markdownDisplaySource(content: string, sourceStart = 0): DisplaySource {
  const tree = fromMarkdown(content);
  const display: DisplaySource = { text: '', ranges: [] };
  const append = (value: string, ranges: DisplayRange[]) => {
    for (let index = 0; index < value.length; index += 1) {
      const char = /\s/.test(value[index] ?? '') ? ' ' : (value[index] ?? '');
      const range = ranges[index] ?? { start: null, end: null };
      if (char === ' ' && display.text.endsWith(' ')) {
        const previous = display.ranges.at(-1);
        if (previous && range) previous.end = range.end;
        continue;
      }
      display.text += char;
      display.ranges.push(range);
    }
  };
  const visit = (node: (typeof tree.children)[number]) => {
    if (node.type === 'image' || node.type === 'imageReference') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const before = display.text.length;
    if ('children' in node) {
      for (const child of node.children) visit(child);
    } else if ('value' in node) {
      const value = node.value.replace(/\r\n?/g, '\n');
      let at = start ?? 0;
      const ranges: DisplayRange[] = [];
      for (let index = 0; index < value.length; ) {
        const from = at;
        let decoded = content[at] ?? '';
        if (content[at] === '\r') {
          decoded = '\n';
          at += content[at + 1] === '\n' ? 2 : 1;
        } else if (content[at] === '\\' && /[!-/:-@[-`{-~]/.test(content[at + 1] ?? '')) {
          decoded = content[at + 1] ?? '';
          at += 2;
        } else {
          const entity =
            content[at] === '&' ? /^&(?:#\d+|#x[\da-f]+|[a-z]+);/i.exec(content.slice(at)) : null;
          const paragraph = entity ? fromMarkdown(entity[0]).children[0] : undefined;
          const text = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
          if (entity && text?.type === 'text') {
            decoded = text.value;
            at += entity[0].length;
          } else at += 1;
        }
        if (
          start === undefined ||
          end === undefined ||
          at > end ||
          !value.startsWith(decoded, index) ||
          decoded === ''
        ) {
          for (let rest = index; rest < value.length; rest += 1)
            ranges.push({ start: null, end: null });
          break;
        }
        for (let part = 0; part < decoded.length; part += 1)
          ranges.push({
            start: part === 0 ? sourceStart + from : null,
            end: part === decoded.length - 1 ? sourceStart + at : null,
          });
        index += decoded.length;
      }
      // inlineCode 的显示值不含反引号；整个节点位置可靠，内部不冒充逐字源码。
      if (node.type === 'inlineCode') {
        append(value, []);
      } else append(value, ranges);
    } else if (node.type === 'break') {
      append('\n', [
        {
          start: start === undefined ? null : sourceStart + start,
          end: end === undefined ? null : sourceStart + end,
        },
      ]);
    }
    const first = display.ranges[before];
    const last = display.ranges.at(-1);
    if (display.text.length > before && start !== undefined && end !== undefined) {
      if (first) first.start = sourceStart + start;
      if (last) last.end = sourceStart + end;
    }
  };
  for (const [index, node] of tree.children.entries()) {
    if (index > 0) append('\n', []);
    visit(node);
  }
  const leading = display.text.length - display.text.trimStart().length;
  const trailing = display.text.trimEnd().length;
  return {
    text: display.text.slice(leading, trailing),
    ranges: display.ranges.slice(leading, trailing),
  };
}

function markdownRegions(markdown: string): MarkdownRegion[] {
  return markdownBlocks(markdown, (_line, start = 0, end = start) => ({ start, end })).map(
    (block) => {
      const { start, end } = block.locator as SourceRange;
      const kind = isTableBlock(block.content)
        ? 'table'
        : isFenceStart(block.content)
          ? 'code'
          : /^!\[[^\]]*\]\([^)]*\)$/.test(block.content)
            ? 'image'
            : 'text';
      return {
        content: block.content,
        heading: block.heading,
        kind,
        start,
        end,
        display:
          kind === 'text'
            ? markdownDisplaySource(markdown.slice(start, end), start)
            : { text: '', ranges: [] },
        claims: [],
      };
    },
  );
}

/** 整段和段内只搜索同一份显示文本，认领范围只从对应的源码映射取得。 */
function locateBlock(region: MarkdownRegion, content: string): SourceRange | null {
  const needle = normalizeText(content);
  if (needle === '') return null;
  const { text, ranges } = region.display;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const first = ranges[at];
    const last = ranges[end - 1];
    if (first?.start == null || last?.end == null || !hasWordBoundary(text, at, end, needle))
      continue;
    const range = { start: first.start, end: last.end };
    if (!region.claims.some((claim) => range.start < claim.end && claim.start < range.end))
      return range;
  }
  return null;
}

/** 每个 JSON 项只映射一次 occurrence；正文、行号与 pageMap 都消费这一份映射。 */
function anchorParsedBlocks(
  blocks: ParsedBlock[],
  markdown: string,
  readingOrder: string[],
): { blocks: ParsedBlock[]; pageMap: PageRange[] } {
  const regions = markdownRegions(markdown);
  const lineStarts = splitLines(markdown).offsets;
  const unlocated: ParsedBlock[] = [];
  const matches = new Map<string, SourceRange>();
  for (const block of blocks) {
    const kind = isTableBlock(block.content)
      ? 'table'
      : isFenceStart(block.content)
        ? 'code'
        : 'text';
    let matched = false;
    for (const region of regions) {
      if (region.kind !== kind) continue;
      const range =
        kind === 'text'
          ? locateBlock(region, block.content)
          : region.claims.length === 0 && fingerprint(region.content) === fingerprint(block.content)
            ? { start: region.start, end: region.end }
            : null;
      if (!range) continue;
      region.claims.push({ ...range, locator: block.locator });
      if (typeof block.locator.ref === 'string') matches.set(block.locator.ref, range);
      matched = true;
      break;
    }
    // JSON 独有的 OCR/代码仍可检索，但没有证据把它安放进某个原文字符区间。
    if (!matched) unlocated.push(block);
  }

  const anchored: ParsedBlock[] = [];
  const pageMap: PageRange[] = [];
  const emit = (
    region: MarkdownRegion,
    start: number,
    end: number,
    metadata: ParsedBlock['locator'] = { page: 'unknown' },
  ) => {
    const raw = markdown.slice(start, end);
    const from = start + raw.length - raw.trimStart().length;
    const to = start + raw.trimEnd().length;
    if (from >= to) return;
    const locator = {
      ...metadata,
      startOffset: from,
      endOffset: to,
      line: lineAtOffset(lineStarts, from),
    };
    anchored.push({
      content: markdown.slice(from, to).replace(/\r\n?/g, '\n'),
      heading: region.heading,
      locator,
    });
    if (typeof metadata.page === 'number')
      pageMap.push({ page: metadata.page, startOffset: from, endOffset: to });
  };
  for (const region of regions) {
    let cursor = region.start;
    for (const claim of region.claims.sort((left, right) => left.start - right.start)) {
      if (cursor < claim.start) emit(region, cursor, claim.start);
      emit(region, claim.start, claim.end, claim.locator);
      cursor = claim.end;
    }
    if (cursor < region.end) emit(region, cursor, region.end);
  }
  const between = new Map<string, ParsedBlock[]>();
  const trailing: ParsedBlock[] = [];
  for (const block of unlocated) {
    const order =
      typeof block.locator.ref === 'string' ? readingOrder.indexOf(block.locator.ref) : -1;
    const before = readingOrder.slice(0, Math.max(0, order)).findLast((ref) => matches.has(ref));
    const after =
      order < 0 ? undefined : readingOrder.slice(order + 1).find((ref) => matches.has(ref));
    const left = before ? matches.get(before) : undefined;
    const right = after ? matches.get(after) : undefined;
    if (after && left && right && left.end <= right.start) {
      const entries = between.get(after) ?? [];
      entries.push(block);
      between.set(after, entries);
    } else trailing.push(block);
  }
  return {
    blocks: [
      ...anchored.flatMap((block) => [
        ...(typeof block.locator.ref === 'string' ? (between.get(block.locator.ref) ?? []) : []),
        block,
      ]),
      ...trailing,
    ],
    pageMap,
  };
}

function doclingErrorMessage(errors: Array<{ error_message: string }>): string {
  return errors
    .map((error) => error.error_message)
    .filter((text) => text !== '')
    .join('; ');
}

async function parseWithDocling(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  parserUrl: string;
  parserKey?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ParsedDocument> {
  const endpoint = `${input.parserUrl.replace(/\/+$/, '')}/v1/convert/file`;
  const form = new FormData();
  form.append('files', new Blob([input.bytes], { type: input.mimeType }), input.filename);
  form.append('to_formats', 'md');
  form.append('to_formats', 'json');
  form.append('do_ocr', 'true');
  form.append('do_table_structure', 'true');
  // 同步内联响应；embedded 让图片同时出现在 md 与 json 里，正文不会再是 base64 之外的引用。
  form.append('target_type', 'inbody');
  form.append('image_export_mode', 'embedded');
  form.append('include_images', 'true');

  const timeout = AbortSignal.timeout(DOCLING_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      body: form,
      redirect: 'manual',
      signal,
      ...(input.parserKey ? { headers: { 'X-Api-Key': input.parserKey } } : {}),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new KnowledgeParseError('aborted', 'Docling 解析已取消');
    if (timeout.aborted) {
      throw new KnowledgeParseError('upstream_http', `Docling 超过 ${DOCLING_TIMEOUT_MS}ms 未响应`);
    }
    throw new KnowledgeParseError(
      'upstream_http',
      `请求 Docling 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    throw new KnowledgeParseError(
      'redirect',
      `Docling 返回重定向 ${response.status}，需要把 ${endpoint} 指向最终地址`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new KnowledgeParseError(
      'upstream_http',
      `Docling 返回 HTTP ${response.status}: ${detail}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new KnowledgeParseError('invalid_response', 'Docling 返回的不是合法 JSON');
  }
  const parsed = doclingResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new KnowledgeParseError(
      'invalid_response',
      `Docling 响应不符合约定: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  const detail = doclingErrorMessage(parsed.data.errors);
  if (parsed.data.status === 'partial_success') {
    throw new KnowledgeParseError(
      'partial_success',
      `Docling 部分成功${detail ? `: ${detail}` : ''}`,
    );
  }
  if (parsed.data.status === 'skipped') {
    throw new KnowledgeParseError(
      'unsupported',
      `Docling 跳过了该文件${detail ? `: ${detail}` : ''}`,
    );
  }
  if (parsed.data.status === 'failure') {
    throw new KnowledgeParseError(
      'upstream_failure',
      `Docling 解析失败${detail ? `: ${detail}` : ''}`,
    );
  }

  const document = parsed.data.document;
  if (!document?.json_content) {
    throw new KnowledgeParseError('invalid_response', 'Docling 成功响应缺少 document.json_content');
  }
  const json = document.json_content;
  const embedded = doclingImages(json);
  const markdown = normalizeEmbeddedImages(document.md_content ?? '', embedded);
  const blocks = doclingBlocks(json);
  if (blocks.length === 0 && markdown.trim() === '') {
    throw new KnowledgeParseError('invalid_response', 'Docling 响应没有任何可索引内容');
  }
  const finalMarkdown =
    markdown !== '' ? markdown : blocks.map((block) => block.content).join('\n\n');
  // 没有官方 Markdown 时，拼接位置本来就已知；不再把 JSON 正文当成 Markdown 语法重解析。
  if (markdown === '') {
    let cursor = 0;
    const pageMap: PageRange[] = [];
    const lineStarts = splitLines(finalMarkdown).offsets;
    const located = blocks.map((block) => {
      const startOffset = cursor;
      const endOffset = startOffset + block.content.length;
      cursor = endOffset + 2;
      const page = block.locator.page;
      if (typeof page === 'number') pageMap.push({ page, startOffset, endOffset });
      return {
        ...block,
        locator: {
          ...block.locator,
          startOffset,
          endOffset,
          line: lineAtOffset(lineStarts, startOffset),
        },
      };
    });
    return {
      markdown: finalMarkdown,
      blocks: located,
      images: embedded.map(({ image }) => image),
      pageMap,
    };
  }
  const anchored = anchorParsedBlocks(blocks, finalMarkdown, orderedRefs(json, false));
  return {
    markdown: finalMarkdown,
    blocks: anchored.blocks,
    images: embedded.map(({ image }) => image),
    pageMap: anchored.pageMap,
  };
}

export async function parseDocument(input: {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  parserUrl?: string;
  parserKey?: string;
  signal?: AbortSignal;
}): Promise<ParsedDocument> {
  if (input.signal?.aborted) throw new KnowledgeParseError('aborted', '解析已取消');
  // 独立图片按真实 magic 识别，声明的 MIME 只做一致性校验；不一致直接拒绝。
  const sniffed = sniffImage(input.bytes);
  if (sniffed) {
    const declared = (input.mimeType.split(';')[0] ?? '').trim().toLowerCase();
    const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (normalized.startsWith('image/') && normalized !== sniffed.mimeType) {
      throw new KnowledgeParseError(
        'invalid_input',
        `图片声明为 ${declared}，实际内容是 ${sniffed.mimeType}`,
      );
    }
    // magic 只说明文件声明自己是什么；真正解码一次，截断/超限的图不进收费的视觉调用。
    await assertUsableImage({ mimeType: sniffed.mimeType, data: input.bytes }).catch(
      (err: unknown) => {
        throw new KnowledgeParseError('invalid_input', errorText(err));
      },
    );
    return imageDocument(input.bytes, sniffed);
  }
  const declaredMime = (input.mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (declaredMime.startsWith('image/') && !input.parserUrl) {
    // 没有 Docling 时声明图片但 magic 不认识：明确不支持，不把原字节伪标 PNG。
    throw new KnowledgeParseError(
      'unsupported',
      `${input.filename}（${input.mimeType}）不是受支持的图片格式（PNG/JPEG/GIF/WebP）`,
    );
  }
  const format = detectFormat(input.filename, input.mimeType);
  if (format === 'docling') {
    if (!input.parserUrl) {
      throw new KnowledgeParseError(
        'parser_unavailable',
        `${input.filename}（${input.mimeType}）需要配置 Docling 解析服务`,
      );
    }
    return parseWithDocling({
      bytes: input.bytes,
      filename: input.filename,
      mimeType: input.mimeType,
      parserUrl: input.parserUrl,
      parserKey: input.parserKey,
      signal: input.signal,
    });
  }

  const text = decode(input.bytes);
  if (format === 'md') {
    return {
      markdown: text,
      images: [],
      pageMap: [],
      blocks: markdownBlocks(text, (line, offset = 0, endOffset = offset) => ({
        page: 'unknown',
        line,
        startOffset: offset,
        endOffset,
      })),
    };
  }
  if (format === 'txt')
    return {
      markdown: text,
      images: [],
      pageMap: [],
      blocks: textBlocks(text),
    };
  if (format === 'csv') return csvDocument(text);
  if (format === 'json') return jsonDocument(text);
  const markdown = htmlToMarkdown(text);
  return {
    markdown,
    images: [],
    pageMap: [],
    blocks: markdownBlocks(markdown, (line, offset = 0, endOffset = offset) => ({
      page: 'unknown',
      kind: 'html',
      line,
      startOffset: offset,
      endOffset,
    })),
  };
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
