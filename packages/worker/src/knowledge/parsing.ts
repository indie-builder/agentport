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
 */
export function markdownBlocks(
  markdown: string,
  locator: (line: number, offset?: number) => Record<string, unknown>,
): ParsedBlock[] {
  const { lines, offsets } = splitLines(markdown);
  const blocks: ParsedBlock[] = [];
  const headings: string[] = [];
  let paragraph: string[] = [];
  let paragraphIndex = 0;

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      content: paragraph.join('\n').trim(),
      heading: emptyHeading(headings),
      locator: locator(paragraphIndex + 1, offsets[paragraphIndex] ?? 0),
    });
    paragraph = [];
  };

  const setHeading = (level: number, title: string) => {
    headings.length = Math.min(headings.length, level - 1);
    headings[level - 1] = title;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
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
        locator: locator(start + 1, offsets[start] ?? 0),
      });
      continue;
    }
    // A GFM table starts with a pipe row followed by a delimiter row; outer pipes are optional.
    if (line.includes('|') && isTableDelimiterLine(lines[index + 1] ?? '')) {
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
        locator: locator(start + 1, offsets[start] ?? 0),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      setHeading((heading[1] ?? '#').length, (heading[2] ?? '').trim());
      index += 1;
      continue;
    }
    // Minimal setext support: only a one-line paragraph followed by its underline.
    const setext = SETEXT.exec(line);
    if (setext && paragraph.length === 1) {
      setHeading(setext[1]?.startsWith('=') ? 1 : 2, (paragraph[0] ?? '').trim());
      paragraph = [];
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      flush();
      index += 1;
      continue;
    }
    if (paragraph.length === 0) paragraphIndex = index;
    paragraph.push(line);
    index += 1;
  }
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
  image: z
    .looseObject({
      mime_type: z.string().optional(),
      uri: z.string().optional(),
    })
    .optional(),
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

const doclingResponseSchema = z.looseObject({
  status: z.enum(['success', 'partial_success', 'failure', 'skipped']),
  errors: z.array(z.unknown()).default([]),
  document: z
    .looseObject({
      md_content: z.string().optional(),
      json_content: doclingJsonSchema.optional(),
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

  for (const ref of orderedRefs(json)) {
    const textRef = /^#\/texts\/(\d+)$/.exec(ref);
    if (textRef) {
      const item = json.texts[Number(textRef[1])];
      if (!item) continue;
      const label = item.label ?? '';
      const value = (item.text ?? '').trim();
      if (label === 'page_header' || label === 'page_footer') continue;
      if (label === 'section_header' || label === 'title') {
        const level = label === 'title' ? 1 : Math.max(1, Math.min(6, item.level ?? 1));
        headings.length = Math.min(headings.length, level - 1);
        headings[level - 1] = value;
        continue;
      }
      if (value === '') continue;
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
      for (const cell of table.data?.table_cells ?? []) seenTexts.add(normalizeText(cell.text));
      seenBlocks.add(fingerprint(content));
      blocks.push({
        content,
        heading: emptyHeading(headings),
        locator: doclingLocator(table),
      });
    }
  }

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
function doclingImages(json: DoclingJson): ParsedImage[] {
  const images: ParsedImage[] = [];
  for (const [index, picture] of json.pictures.entries()) {
    const match = DATA_URI.exec(picture.image?.uri ?? '');
    if (!match) continue;
    const bytes = Buffer.from(match[2] ?? '', 'base64');
    if (bytes.length === 0) continue;
    const page = picture.prov[0]?.page_no;
    if (typeof page !== 'number') continue;
    const mimeType = match[1] ?? picture.image?.mime_type ?? 'application/octet-stream';
    const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    images.push({ name: `image-${index + 1}.${extension}`, data: bytes, mimeType, page });
  }
  return images;
}

/** markdown 里可能存在重复文本；按出现顺序找，找不到就不给区间而不是编造偏移。 */
function pageMapFrom(blocks: ParsedBlock[], markdown: string): PageRange[] {
  const ranges: PageRange[] = [];
  const cursor = new Map<number, number>();
  for (const block of blocks) {
    const page = block.locator.page;
    if (typeof page !== 'number') continue;
    const from = cursor.get(page) ?? 0;
    const startOffset = markdown.indexOf(block.content, from);
    if (startOffset === -1) continue;
    const endOffset = startOffset + block.content.length;
    cursor.set(page, endOffset);
    const last = ranges.at(-1);
    if (last && last.page === page && last.endOffset <= startOffset) last.endOffset = endOffset;
    else ranges.push({ page, startOffset, endOffset });
  }
  return ranges;
}

function doclingErrorMessage(errors: unknown[]): string {
  return errors
    .map((error) => {
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error) {
        return String((error as { message: unknown }).message);
      }
      return JSON.stringify(error);
    })
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
  const markdown = document.md_content ?? '';
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
    images: doclingImages(json),
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
