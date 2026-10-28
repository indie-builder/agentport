import { parse as parseCsv } from 'csv-parse/sync';
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
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => ({ content: part, heading: '', locator: { page: 'unknown' } }));
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
        locator: { page: 'unknown', kind: 'csv', rows: rows.length - 1 },
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
    blocks: [{ content: markdown, heading: '', locator: { page: 'unknown', kind: 'json' } }],
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
    return normalizeText(
      content
        .split('\n')
        .filter((line) => !isTableDelimiterLine(line))
        .flatMap((line) => line.split(/(?<!\\)\|/))
        .map((cell) => cell.replace(/\\\|/g, '|'))
        .join(' '),
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
function orderedRefs(json: DoclingJson): string[] {
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

function doclingBlocks(json: DoclingJson, markdown: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const headings: string[] = [];
  const seenTexts = new Set<string>();
  const seenBlocks = new Set<string>();
  let pending: Array<{ level: number; block: ParsedBlock }> = [];
  const flushPending = (level: number) => {
    if (!pending.some((entry) => entry.level >= level)) return;
    for (const { block } of pending) {
      blocks.push(block);
      seenTexts.add(normalizeText(block.content));
    }
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
      seenTexts.add(normalizeText(value));
      const content =
        label === 'code'
          ? `\`\`\`${item.code_language && item.code_language !== 'unknown' ? item.code_language : ''}\n${value}\n\`\`\``
          : value;
      // 代码在 md 里可能用不同长度的 fence；按内容而非 fence 比较。
      if (label === 'code') seenBlocks.add(fingerprint(content));
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
      for (const cell of table.data?.table_cells ?? []) seenTexts.add(normalizeText(cell.text));
      seenBlocks.add(fingerprint(content));
      blocks.push({
        content,
        heading: emptyHeading(headings),
        locator: doclingLocator(table),
      });
    }
  }

  flushPending(1);

  // Items the JSON body never referenced still belong in the output; nothing is dropped silently.
  // JSON wins over the md rendering of the same table/code (it carries page provenance).
  for (const block of markdownBlocks(markdown, () => ({ page: 'unknown' }))) {
    if (seenTexts.has(normalizeText(block.content))) continue;
    if (seenBlocks.has(fingerprint(block.content))) continue;
    blocks.push({ ...block, heading: block.heading || emptyHeading(headings) });
  }
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

type MarkdownRegion = {
  content: string;
  kind: 'text' | 'table' | 'code' | 'image';
  startOffset: number;
  endOffset: number;
  /** 已认领的原文区间；块级认领就是整块范围。 */
  claimed: Array<{ start: number; end: number }>;
};

/** 短 OCR 文本（如 "1"）只能匹配独立单词，不能在 "1234" 中间造出伪区间。 */
function hasWordBoundary(text: string, start: number, end: number, needle: string): boolean {
  const isWord = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);
  if (isWord(needle[0]) && isWord(text[start - 1])) return false;
  // 原文里的换行可能比 needle 长（CRLF），边界要按真实结束位置算。
  if (isWord(needle.at(-1)) && isWord(text[end])) return false;
  return true;
}

function markdownRegions(markdown: string): MarkdownRegion[] {
  return markdownBlocks(markdown, (_line, startOffset = 0, endOffset = startOffset) => ({
    startOffset,
    endOffset,
  })).map((block) => {
    const { startOffset, endOffset } = block.locator as {
      startOffset: number;
      endOffset: number;
    };
    const kind = isTableBlock(block.content)
      ? 'table'
      : isFenceStart(block.content)
        ? 'code'
        : /^!\[[^\]]*\]\([^)]*\)$/.test(block.content)
          ? 'image'
          : 'text';
    return {
      content: block.content,
      kind,
      startOffset,
      endOffset,
      claimed: [],
    };
  });
}

/**
 * 在段落原文里定位块文本：JSON 用 LF 拼行，原文可能是 CRLF，直接 indexOf LF 子串会错。
 * 比较时换行按 CRLF/CR/LF 等价，返回真实原文区间；已被其它页占用的候选跳到下一处。
 */
function locateBlock(
  text: string,
  region: MarkdownRegion,
  needle: string,
  claimed: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  const first = needle[0];
  if (first === undefined) return null;
  for (
    let base = text.indexOf(first, region.startOffset);
    base !== -1 && base < region.endOffset;
  ) {
    let at = base;
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      const want = needle[index];
      if (want === '\n') {
        if (text[at] === '\r' && text[at + 1] === '\n') at += 2;
        else if (text[at] === '\r' || text[at] === '\n') at += 1;
        else {
          matched = false;
          break;
        }
        continue;
      }
      if (text[at] !== want) {
        matched = false;
        break;
      }
      at += 1;
    }
    const start = base;
    const end = at;
    const free =
      matched &&
      end <= region.endOffset &&
      hasWordBoundary(text, start, end, needle) &&
      !claimed.some((span) => start < span.end && span.start < end);
    if (free) return { start, end };
    base = text.indexOf(first, start + 1);
  }
  return null;
}

/**
 * 页码只从原文 Markdown 里真实存在的块认领：JSON 表格/代码按 fingerprint 配同类块，
 * 普通文本先整块后段内子串；位置全局一次性使用，找不到就不给区间而不是编造偏移。
 */
function pageMapFrom(blocks: ParsedBlock[], markdown: string): PageRange[] {
  const regions = markdownRegions(markdown);
  const ranges: PageRange[] = [];

  for (const block of blocks) {
    const page = block.locator.page;
    if (typeof page !== 'number') continue;
    const kind = isTableBlock(block.content)
      ? 'table'
      : isFenceStart(block.content)
        ? 'code'
        : 'text';

    if (kind === 'text') {
      const whole = regions.find(
        (region) =>
          region.kind === 'text' && region.claimed.length === 0 && region.content === block.content,
      );
      if (whole) {
        whole.claimed.push({ start: whole.startOffset, end: whole.endOffset });
        ranges.push({ page, startOffset: whole.startOffset, endOffset: whole.endOffset });
        continue;
      }
      // 多个 JSON 项可能组成同一个 Markdown 段落，允许在段落内做带边界的子串匹配；
      // 已认领的区间（整段或子串）由 overlaps 避开，段落仍可继续认领未占用的部分。
      for (const region of regions) {
        if (region.kind !== 'text') continue;
        const located = locateBlock(markdown, region, block.content, region.claimed);
        if (!located) continue;
        region.claimed.push(located);
        ranges.push({ page, startOffset: located.start, endOffset: located.end });
        break;
      }
      continue;
    }

    const wanted = fingerprint(block.content);
    const target = regions.find(
      (region) =>
        region.kind === kind &&
        region.claimed.length === 0 &&
        fingerprint(region.content) === wanted,
    );
    if (!target) continue;
    target.claimed.push({ start: target.startOffset, end: target.endOffset });
    ranges.push({ page, startOffset: target.startOffset, endOffset: target.endOffset });
  }

  return ranges.sort((left, right) => left.startOffset - right.startOffset);
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
  const blocks = doclingBlocks(json, markdown);
  if (blocks.length === 0) {
    throw new KnowledgeParseError('invalid_response', 'Docling 响应没有任何可索引内容');
  }
  const finalMarkdown =
    markdown !== '' ? markdown : blocks.map((block) => block.content).join('\n\n');
  // md_content 为空时 markdown 是拿 blocks 拼出来的，偏移必须针对最终文本计算。
  return {
    markdown: finalMarkdown,
    blocks,
    images: embedded.map(({ image }) => image),
    pageMap: pageMapFrom(blocks, finalMarkdown),
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
        throw new KnowledgeParseError(
          'invalid_input',
          err instanceof Error ? err.message : String(err),
        );
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
      blocks: markdownBlocks(text, (line) => ({ page: 'unknown', line })),
    };
  }
  if (format === 'txt')
    return { markdown: text, images: [], pageMap: [], blocks: textBlocks(text) };
  if (format === 'csv') return csvDocument(text);
  if (format === 'json') return jsonDocument(text);
  const markdown = htmlToMarkdown(text);
  return {
    markdown,
    images: [],
    pageMap: [],
    blocks: markdownBlocks(markdown, () => ({ page: 'unknown', kind: 'html' })),
  };
}

function mergeLocators(blocks: ParsedBlock[]): Record<string, unknown> {
  const pages = blocks
    .map((block) => block.locator.page)
    .filter((page): page is number => typeof page === 'number');
  if (pages.length === 0) return { page: 'unknown' };
  const page = Math.min(...pages);
  const pageTo = Math.max(...pages);
  return pageTo > page ? { page, pageTo } : { page };
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
    let start = 0;
    while (start < content.length) {
      let end = Math.min(start + chunkSize, content.length);
      // Never cut a surrogate pair in half.
      const code = content.charCodeAt(end - 1);
      if (end < content.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      chunks.push({
        content: content.slice(start, end),
        heading,
        locator: { ...locator, charStart: start, charEnd: end },
      });
      if (end === content.length) break;
      start = end - chunkOverlap;
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
