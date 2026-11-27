import { fail, isAppError, sha256Hex } from '@agentport/core';
import type {
  KnowledgeFaq,
  KnowledgeFaqImportIssue,
  KnowledgeFaqImportResult,
  KnowledgeFaqTransferEntry,
  knowledgeFaqInputSchema,
} from '@agentport/shared';
import { FAQ_ANSWER_REQUIRED_MESSAGE } from '@agentport/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import { Converter } from 'opencc-js';
import type { z } from 'zod';
import { decodeZipEntries, type ZipFileEntry, type ZipReadLimits } from '../../lib/package-zip.js';

const FAQ_MAX_ITEMS = 500;
export const FAQ_MAX_BYTES = 2 * 1024 * 1024;
const FAQ_MAX_XLSX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

const FAQ_XLSX_ZIP_LIMITS: ZipReadLimits = {
  maxEntries: 100,
  maxUncompressedBytes: FAQ_MAX_XLSX_DECOMPRESSED_BYTES,
};
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

export type FaqEntry = KnowledgeFaq;
export type FaqTransferEntry = KnowledgeFaqTransferEntry;
export type FaqImportIssue = KnowledgeFaqImportIssue;
type FaqImportRowStatus = KnowledgeFaqImportResult['status'];
type FaqImportOperation = KnowledgeFaqImportResult['operation'];

export type FaqInput = z.infer<typeof knowledgeFaqInputSchema>;

const FAQ_COLUMNS = [
  'question',
  'similarQuestions',
  'negativeQuestions',
  'answers',
  'answerStrategy',
  'isRecommended',
  'enabled',
] as const;

export type FaqImportFormat = 'json' | 'csv' | 'xlsx';
export type FaqImportMode = 'append' | 'replace';

export interface FaqParsedRow {
  row: number;
  entry: FaqTransferEntry | null;
  issues: FaqImportIssue[];
}

export interface FaqExistingEntry {
  documentId: string;
  faq: KnowledgeFaq;
  enabled: boolean;
  latestDraftVersionId: string | null;
  publishedVersionId: string | null;
  updatedAt: string;
}

export interface FaqImportPlanRow {
  row: number;
  status: FaqImportRowStatus;
  operation: FaqImportOperation;
  documentId?: string;
  expectedVersionId?: string | null;
  issues: FaqImportIssue[];
}

interface FaqImportDraft {
  operation: 'add' | 'merge';
  documentId: string;
  faq: FaqEntry;
  enabled: boolean;
}

export interface FaqImportPlan {
  counts: {
    total: number;
    success: number;
    failed: number;
    partialFailed: number;
    skipped: number;
    added: number;
    merged: number;
  };
  results: FaqImportPlanRow[];
  drafts: FaqImportDraft[];
}

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
const BOUNDARY_PUNCTUATION =
  /^[\s?.!,;:'"()[\]{}<>，。！？；：、（）【】《》“”‘’]+|[\s?.!,;:'"()[\]{}<>，。！？；：、（）【】《》“”‘’]+$/g;
const HAN_SPACE = /(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu;

const toSimplified = Converter({ from: 't', to: 'cn' });

export function normalizeFaqQuestion(value: string): string {
  return toSimplified(value.trim().replace(URL_PATTERN, ' ').toLowerCase())
    .replace(BOUNDARY_PUNCTUATION, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(HAN_SPACE, '')
    .trim();
}

export function faqContentHash(faq: FaqEntry): string {
  const sortedUnique = (values: string[]): string[] =>
    [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
  const normalizedUnique = (values: string[]): string[] =>
    [...new Set(values.map(normalizeFaqQuestion).filter((value) => value.length > 0))].sort();
  return sha256Hex(
    JSON.stringify([
      normalizeFaqQuestion(faq.question),
      normalizedUnique(faq.similarQuestions),
      normalizedUnique(faq.negativeQuestions),
      sortedUnique(faq.answers),
    ]),
  );
}

function issue(field: string, code: string, message: string): FaqImportIssue {
  return { field, code, message };
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

function rawText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const text = rawText(value)?.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

function parseStringArray(
  value: unknown,
  field: string,
  issues: FaqImportIssue[],
): string[] | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      issues.push(issue(field, 'INVALID_JSON_ARRAY', `${field} 不是合法 JSON 数组`));
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    issues.push(issue(field, 'INVALID_JSON_ARRAY', `${field} 必须是字符串数组`));
    return null;
  }
  return parsed as string[];
}

export function normalizeFaqEntry(input: unknown): {
  entry: FaqTransferEntry | null;
  issues: FaqImportIssue[];
} {
  const issues: FaqImportIssue[] = [];
  if (typeof input !== 'object' || input === null) {
    return { entry: null, issues: [issue('faq', 'INVALID_ITEM', 'FAQ 必须是对象')] };
  }
  const raw = input as Record<string, unknown>;
  const question = rawText(raw.question)?.trim() ?? '';
  if (question.length === 0) {
    issues.push(issue('question', 'QUESTION_REQUIRED', '标准问不能为空'));
  } else if (question.length > 500) {
    issues.push(issue('question', 'QUESTION_TOO_LONG', '标准问不能超过 500 字'));
  }

  const arrays: Record<'similarQuestions' | 'negativeQuestions' | 'answers', string[]> = {
    similarQuestions: [],
    negativeQuestions: [],
    answers: [],
  };
  for (const field of ['similarQuestions', 'negativeQuestions', 'answers'] as const) {
    const value = raw[field] === undefined && field !== 'answers' ? [] : raw[field];
    const parsed = parseStringArray(value, field, issues);
    if (parsed === null) continue;
    arrays[field] = parsed.map((value) => value.trim()).filter((value) => value.length > 0);
  }
  if (arrays.answers.length === 0) {
    issues.push(issue('answers', 'ANSWER_REQUIRED', FAQ_ANSWER_REQUIRED_MESSAGE));
  }

  const strategyRaw = raw.answerStrategy;
  const strategyText = isBlank(strategyRaw) ? 'all' : rawText(strategyRaw)?.trim().toLowerCase();
  const answerStrategy = strategyText === 'all' || strategyText === 'random' ? strategyText : null;
  if (answerStrategy === null) {
    issues.push(issue('answerStrategy', 'INVALID_STRATEGY', 'answerStrategy 只能是 all 或 random'));
  }
  const isRecommended = isBlank(raw.isRecommended) ? true : parseBoolean(raw.isRecommended);
  if (isRecommended === undefined) {
    issues.push(issue('isRecommended', 'INVALID_BOOLEAN', 'isRecommended 只能是 true 或 false'));
  }
  const enabled = isBlank(raw.enabled) ? true : parseBoolean(raw.enabled);
  if (enabled === undefined) {
    issues.push(issue('enabled', 'INVALID_BOOLEAN', 'enabled 只能是 true 或 false'));
  }

  const questionKey = normalizeFaqQuestion(question);
  const positiveKeys = new Set<string>([questionKey]);
  const similarQuestions: string[] = [];
  for (const value of arrays.similarQuestions) {
    if (value.length > 500) {
      issues.push(
        issue(
          'similarQuestions',
          'DROPPED_INVALID',
          `相似问超过 500 字已忽略：${value.slice(0, 30)}`,
        ),
      );
      continue;
    }
    const key = normalizeFaqQuestion(value);
    if (key === questionKey) {
      issues.push(
        issue('similarQuestions', 'DROPPED_DUPLICATE', `相似问与标准问相同已忽略：${value}`),
      );
      continue;
    }
    if (positiveKeys.has(key)) {
      issues.push(issue('similarQuestions', 'DROPPED_DUPLICATE', `相似问重复已忽略：${value}`));
      continue;
    }
    positiveKeys.add(key);
    similarQuestions.push(value);
  }
  const negativeQuestions: string[] = [];
  const negativeKeys = new Set<string>();
  for (const value of arrays.negativeQuestions) {
    if (value.length > 500) {
      issues.push(
        issue(
          'negativeQuestions',
          'DROPPED_INVALID',
          `反例超过 500 字已忽略：${value.slice(0, 30)}`,
        ),
      );
      continue;
    }
    const key = normalizeFaqQuestion(value);
    if (positiveKeys.has(key)) {
      issues.push(
        issue('negativeQuestions', 'DROPPED_OVERLAP', `反例与正向问相同已忽略：${value}`),
      );
      continue;
    }
    if (negativeKeys.has(key)) {
      issues.push(issue('negativeQuestions', 'DROPPED_DUPLICATE', `反例重复已忽略：${value}`));
      continue;
    }
    negativeKeys.add(key);
    negativeQuestions.push(value);
  }
  if (similarQuestions.length > 50) {
    issues.push(issue('similarQuestions', 'TOO_MANY_QUESTIONS', '相似问不能超过 50 条'));
  }
  if (negativeQuestions.length > 50) {
    issues.push(issue('negativeQuestions', 'TOO_MANY_QUESTIONS', '反例不能超过 50 条'));
  }
  const answers: string[] = [];
  const answerKeys = new Set<string>();
  for (const value of arrays.answers) {
    if (value.length > 20_000) {
      issues.push(issue('answers', 'DROPPED_INVALID', '超过 20000 字的答案已忽略'));
      continue;
    }
    if (answerKeys.has(value)) {
      issues.push(issue('answers', 'DROPPED_DUPLICATE', `答案重复已忽略：${value.slice(0, 30)}`));
      continue;
    }
    answerKeys.add(value);
    answers.push(value);
  }
  if (answers.length === 0 && !issues.some((entry) => entry.field === 'answers')) {
    issues.push(issue('answers', 'ANSWER_REQUIRED', FAQ_ANSWER_REQUIRED_MESSAGE));
  }

  if (
    question.length === 0 ||
    question.length > 500 ||
    arrays.answers.length === 0 ||
    answers.length === 0 ||
    similarQuestions.length > 50 ||
    negativeQuestions.length > 50 ||
    answerStrategy === null ||
    isRecommended === undefined ||
    enabled === undefined
  ) {
    return { entry: null, issues };
  }
  return {
    entry: {
      question,
      similarQuestions,
      negativeQuestions,
      answers,
      answerStrategy,
      isRecommended,
      enabled,
    },
    issues,
  };
}

interface RawRow {
  row: number;
  value: Record<string, unknown>;
}

function finishParsedRows(rawRows: RawRow[]): FaqParsedRow[] {
  const parsed = rawRows.map((raw) => {
    const problems = raw.value.__problems;
    const normalized = normalizeFaqEntry(raw.value);
    if (Array.isArray(problems) && problems.length > 0) {
      return {
        row: raw.row,
        entry: null,
        issues: [
          issue('row', 'INVALID_CELL', `单元格不合法：${problems.join('；')}`),
          ...normalized.issues,
        ],
      };
    }
    return { row: raw.row, entry: normalized.entry, issues: normalized.issues };
  });
  assertParsedTotalBytes(parsed);
  return parsed;
}

function assertParsedTotalBytes(parsed: FaqParsedRow[]): void {
  const totalBytes = parsed.reduce((sum, row) => {
    if (!row.entry) return sum;
    return (
      sum +
      [
        row.entry.question,
        ...row.entry.similarQuestions,
        ...row.entry.negativeQuestions,
        ...row.entry.answers,
      ].reduce((inner, value) => inner + Buffer.byteLength(value, 'utf8'), 0)
    );
  }, 0);
  if (totalBytes > FAQ_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', 'FAQ 导入归一化后正文超过 2MiB 上限');
  }
}

export async function parseFaqImport(input: {
  format: FaqImportFormat;
  content: string;
}): Promise<FaqParsedRow[]> {
  if (input.format !== 'xlsx' && Buffer.byteLength(input.content, 'utf8') > FAQ_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', 'FAQ 导入内容超过 2MiB 上限');
  }
  const rawRows =
    input.format === 'json'
      ? parseJsonRows(input.content)
      : input.format === 'csv'
        ? parseCsvRows(input.content)
        : await parseXlsxRows(input.content);
  if (rawRows.length === 0) fail('INVALID_INPUT', 'FAQ 导入内容为空');
  if (rawRows.length > FAQ_MAX_ITEMS) {
    fail('PAYLOAD_TOO_LARGE', `FAQ 导入最多 ${FAQ_MAX_ITEMS} 条`);
  }
  return finishParsedRows(rawRows);
}

function parseJsonRows(content: string): RawRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    fail('INVALID_INPUT', 'FAQ JSON 无法解析');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    fail('INVALID_INPUT', 'FAQ JSON 必须是 { items: [...] }');
  }
  return (payload as { items: unknown[] }).items.map((value, index) => ({
    row: index + 1,
    value:
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : { question: value },
  }));
}

function csvHeader(content: string): string[] {
  try {
    const [first] = parseCsv(content, {
      bom: true,
      to_line: 1,
      skip_empty_lines: true,
    }) as string[][];
    return first ?? [];
  } catch {
    fail('INVALID_INPUT', 'FAQ CSV 无法解析');
  }
}

function assertHeader(header: string[]): void {
  const missing = FAQ_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) fail('INVALID_INPUT', `FAQ 缺少列：${missing.join(', ')}`);
  const unknown = header.filter((column) => !(FAQ_COLUMNS as readonly string[]).includes(column));
  if (unknown.length > 0) fail('INVALID_INPUT', `FAQ 包含未知列：${unknown.join(', ')}`);
}

function parseCsvRows(content: string): RawRow[] {
  assertHeader(csvHeader(content));
  let records: Array<Record<string, string>> = [];
  try {
    records = parseCsv(content, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
  } catch {
    fail('INVALID_INPUT', 'FAQ CSV 无法解析');
  }
  return records.map((record, index) => ({ row: index + 1, value: record }));
}

async function readXlsxEntries(data: Buffer): Promise<Map<string, ZipFileEntry>> {
  try {
    return await decodeZipEntries(data, FAQ_XLSX_ZIP_LIMITS);
  } catch (err) {
    if (isAppError(err)) {
      if (err.message.includes('解压后总大小')) {
        fail('PAYLOAD_TOO_LARGE', 'FAQ xlsx 解压后超过 32MiB 上限');
      }
      throw err;
    }
    fail('INVALID_INPUT', 'FAQ xlsx 无法解压');
  }
}

function decodeXlsxBase64(content: string): Buffer {
  const compact = content.replace(/\s+/g, '');
  const data = Buffer.from(compact, 'base64');
  // Buffer.from 对非法字符很宽容；用重编码确认输入确实是完整 base64。
  if (
    data.length === 0 ||
    data.toString('base64').replace(/=+$/u, '') !== compact.replace(/=+$/u, '')
  ) {
    fail('INVALID_INPUT', 'FAQ xlsx content 必须是 base64');
  }
  if (data.length > FAQ_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', 'FAQ xlsx 文件超过 2MiB 上限');
  }
  return data;
}

type XmlRecord = Record<string, unknown>;
type SharedString = { text: string } | { rich: true };
type MergedRange = { startRow: number; endRow: number; startCol: number; endCol: number };
type ParsedWorksheet = {
  rowsByNumber: Map<number, Map<number, XmlRecord>>;
  mergedRanges: MergedRange[];
};

function asXmlRecord(value: unknown): XmlRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlRecord)
    : null;
}

function asXmlList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function xmlLocalName(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : key.slice(colon + 1);
}

function xmlChild(node: XmlRecord, name: string): unknown {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@') || key.startsWith('?') || key === '#text') continue;
    if (xmlLocalName(key) === name) return value;
  }
  return undefined;
}

function xmlAttr(node: XmlRecord, name: string, namespaced = false): string | undefined {
  if (!namespaced) {
    const value = node[`@${name}`];
    return typeof value === 'string' ? value : undefined;
  }
  const rPrefixed = node[`@r:${name}`];
  if (typeof rPrefixed === 'string') return rPrefixed;
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@') || key.startsWith('@xmlns')) continue;
    if (xmlLocalName(key.slice(1)) === name && typeof value === 'string') return value;
  }
  return undefined;
}

function xmlText(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = asXmlRecord(value);
  if (record && typeof record['#text'] === 'string') return record['#text'];
  return '';
}

function parseXmlEntry(entry: ZipFileEntry): XmlRecord {
  let raw: string;
  try {
    raw = strictUtf8.decode(entry.data);
  } catch {
    fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  }
  let parsed: unknown;
  try {
    parsed = Bun.XML.parse(raw);
  } catch {
    fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  }
  const root = asXmlRecord(parsed);
  if (!root) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  return root;
}

function resolveWorkbookTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/');
  const raw = normalized.startsWith('/') ? normalized.slice(1) : `xl/${normalized}`;
  const parts: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

function parseCellAddress(ref: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  const letters = match[1];
  const digits = match[2];
  if (!letters || !digits) return null;
  const col = columnLettersToIndex(letters);
  const row = Number(digits);
  if (!Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(col) || col < 1) return null;
  return { row, col };
}

function parseMergedRanges(worksheet: XmlRecord): MergedRange[] {
  const mergeCells = asXmlRecord(xmlChild(worksheet, 'mergeCells'));
  if (!mergeCells) return [];
  const ranges: MergedRange[] = [];
  for (const item of asXmlList(xmlChild(mergeCells, 'mergeCell'))) {
    const node = asXmlRecord(item);
    const ref = node ? xmlAttr(node, 'ref') : undefined;
    if (!ref) continue;
    const [startRef, endRef = startRef] = ref.split(':');
    const start = startRef ? parseCellAddress(startRef) : null;
    const end = endRef ? parseCellAddress(endRef) : null;
    if (!start || !end) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
    ranges.push({
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endCol: Math.max(start.col, end.col),
    });
  }
  return ranges;
}

function parseSharedStrings(
  entries: Map<string, ZipFileEntry>,
  targetPath: string,
): SharedString[] {
  const entry = entries.get(targetPath);
  if (!entry) return [];
  const doc = parseXmlEntry(entry);
  const rawSst = xmlChild(doc, 'sst');
  if (typeof rawSst === 'string' && rawSst.trim() === '') return [];
  const sst = asXmlRecord(rawSst);
  if (!sst) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  return asXmlList(xmlChild(sst, 'si')).map((item): SharedString => {
    const si = asXmlRecord(item);
    if (!si) return { text: '' };
    if (xmlChild(si, 'r') !== undefined) return { rich: true };
    const t = xmlChild(si, 't');
    return { text: t === undefined ? '' : xmlText(t) };
  });
}

function parseWorksheet(entry: ZipFileEntry): ParsedWorksheet {
  const doc = parseXmlEntry(entry);
  const worksheet = asXmlRecord(xmlChild(doc, 'worksheet'));
  if (!worksheet) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  const rowsByNumber = new Map<number, Map<number, XmlRecord>>();
  const sheetData = asXmlRecord(xmlChild(worksheet, 'sheetData'));
  let nextRow = 1;
  for (const rowItem of asXmlList(sheetData ? xmlChild(sheetData, 'row') : undefined)) {
    const rowNode = asXmlRecord(rowItem);
    if (!rowNode) continue;
    const rowAttr = xmlAttr(rowNode, 'r');
    if (rowAttr !== undefined && !/^\d+$/.test(rowAttr)) {
      fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
    }
    const rowNum = rowAttr !== undefined ? Number(rowAttr) : nextRow;
    if (!Number.isSafeInteger(rowNum) || rowNum < 1) {
      fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
    }
    nextRow = rowNum + 1;
    let cells = rowsByNumber.get(rowNum);
    if (!cells) {
      cells = new Map();
      rowsByNumber.set(rowNum, cells);
    }
    let nextCol = 1;
    for (const cellItem of asXmlList(xmlChild(rowNode, 'c'))) {
      const cellNode = asXmlRecord(cellItem);
      if (!cellNode) continue;
      const ref = xmlAttr(cellNode, 'r');
      let colNum = nextCol;
      if (ref !== undefined) {
        const addr = parseCellAddress(ref);
        if (!addr) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
        colNum = addr.col;
      }
      nextCol = colNum + 1;
      cells.set(colNum, cellNode);
    }
  }
  return { rowsByNumber, mergedRanges: parseMergedRanges(worksheet) };
}

function hasNonEmptyCell(sheet: ParsedWorksheet): boolean {
  for (const cells of sheet.rowsByNumber.values()) {
    for (const cell of cells.values()) {
      if (xmlChild(cell, 'f') !== undefined) return true;
      const v = xmlChild(cell, 'v');
      if (v !== undefined && xmlText(v) !== '') return true;
      const isNode = asXmlRecord(xmlChild(cell, 'is'));
      if (
        isNode &&
        (xmlChild(isNode, 'r') !== undefined || xmlText(xmlChild(isNode, 't')) !== '')
      ) {
        return true;
      }
    }
  }
  return false;
}

function cellText(
  cell: XmlRecord | undefined,
  merged: boolean,
  sharedStrings: readonly SharedString[],
): { text: string } | { problem: string } {
  if (merged) return { problem: '合并单元格' };
  if (!cell) return { text: '' };
  if (xmlChild(cell, 'f') !== undefined) return { problem: '只支持字符串或布尔常量单元格' };
  const v = xmlChild(cell, 'v');
  const inline = xmlChild(cell, 'is');
  if (v === undefined && inline === undefined) return { text: '' };
  const type = xmlAttr(cell, 't');
  if (type === 's') {
    if (v === undefined) return { text: '' };
    const rawIndex = xmlText(v).trim();
    if (!/^\d+$/.test(rawIndex)) return { problem: '只支持字符串或布尔常量单元格' };
    const entry = sharedStrings[Number(rawIndex)];
    if (!entry || 'rich' in entry) return { problem: '只支持字符串或布尔常量单元格' };
    return { text: entry.text };
  }
  if (type === 'inlineStr') {
    const isNode = asXmlRecord(inline);
    if (!isNode) return { text: typeof inline === 'string' ? inline : '' };
    if (xmlChild(isNode, 'r') !== undefined) return { problem: '只支持字符串或布尔常量单元格' };
    const t = xmlChild(isNode, 't');
    return { text: t === undefined ? '' : xmlText(t) };
  }
  if (type === 'str') {
    return { text: v === undefined ? '' : xmlText(v) };
  }
  if (type === 'b') {
    if (v === undefined) return { text: '' };
    const raw = xmlText(v).trim();
    if (raw === '1' || raw === 'true') return { text: 'true' };
    if (raw === '0' || raw === 'false') return { text: 'false' };
    return { problem: '只支持字符串或布尔常量单元格' };
  }
  return { problem: '只支持字符串或布尔常量单元格' };
}

async function parseXlsxRows(content: string): Promise<RawRow[]> {
  const data = decodeXlsxBase64(content);
  const entries = await readXlsxEntries(data);

  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) fail('INVALID_INPUT', 'FAQ xlsx 没有工作表');
  const workbookDoc = parseXmlEntry(workbookEntry);
  const workbook = asXmlRecord(xmlChild(workbookDoc, 'workbook'));
  if (!workbook) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  const sheetsContainer = asXmlRecord(xmlChild(workbook, 'sheets'));
  const sheetRefs = asXmlList(sheetsContainer ? xmlChild(sheetsContainer, 'sheet') : undefined)
    .map((item) => asXmlRecord(item))
    .filter((item): item is XmlRecord => item !== null)
    .map((item) => ({
      name: xmlAttr(item, 'name') ?? '',
      relId: xmlAttr(item, 'id', true),
    }));
  if (sheetRefs.length === 0) fail('INVALID_INPUT', 'FAQ xlsx 没有工作表');

  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (!relsEntry) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  const relsDoc = parseXmlEntry(relsEntry);
  const relationships = asXmlRecord(xmlChild(relsDoc, 'Relationships'));
  if (!relationships) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
  const relTargets = new Map<string, string>();
  let sharedStringsTarget = 'xl/sharedStrings.xml';
  for (const item of asXmlList(xmlChild(relationships, 'Relationship'))) {
    const rel = asXmlRecord(item);
    if (!rel) continue;
    const id = xmlAttr(rel, 'Id');
    const target = xmlAttr(rel, 'Target');
    const relType = xmlAttr(rel, 'Type');
    if (!id || !target) continue;
    const resolved = resolveWorkbookTarget(target);
    relTargets.set(id, resolved);
    if (relType?.endsWith('/sharedStrings')) sharedStringsTarget = resolved;
  }

  const parsedSheets = sheetRefs.map((sheetRef) => {
    const target = sheetRef.relId ? relTargets.get(sheetRef.relId) : undefined;
    const sheetEntry = target ? entries.get(target) : undefined;
    if (!sheetEntry) fail('INVALID_INPUT', 'FAQ xlsx 无法解析');
    return { name: sheetRef.name, sheet: parseWorksheet(sheetEntry) };
  });

  const [first, ...rest] = parsedSheets;
  if (!first) fail('INVALID_INPUT', 'FAQ xlsx 没有工作表');
  const extras = rest.filter((item) => hasNonEmptyCell(item.sheet)).map((item) => item.name);
  if (extras.length > 0) {
    fail('INVALID_INPUT', `FAQ xlsx 只允许第一张工作表，额外非空工作表：${extras.join(', ')}`);
  }

  const sharedStrings = parseSharedStrings(entries, sharedStringsTarget);
  const firstSheet = first.sheet;
  const headerCells = firstSheet.rowsByNumber.get(1);
  const header: string[] = [];
  let headerProblem = firstSheet.mergedRanges.some(
    (range) => range.startRow <= 1 && range.endRow >= 1,
  );
  if (headerCells && !headerProblem) {
    const sortedCols = [...headerCells.keys()].sort((a, b) => a - b);
    for (const col of sortedCols) {
      const cell = headerCells.get(col);
      if (!cell) continue;
      if (
        xmlChild(cell, 'f') === undefined &&
        xmlChild(cell, 'v') === undefined &&
        xmlChild(cell, 'is') === undefined
      ) {
        continue;
      }
      const parsed = cellText(cell, false, sharedStrings);
      if ('problem' in parsed) {
        headerProblem = true;
        break;
      }
      header.push(parsed.text.trim());
    }
  }
  if (headerProblem) {
    fail('INVALID_INPUT', 'FAQ xlsx 表头不允许公式、富文本或合并单元格');
  }
  if (
    header.length !== FAQ_COLUMNS.length ||
    header.some((column, index) => column !== FAQ_COLUMNS[index])
  ) {
    fail('INVALID_INPUT', `FAQ xlsx 表头必须依次为：${FAQ_COLUMNS.join(', ')}`);
  }

  const rowNumbers = new Set<number>();
  for (const rowNumber of firstSheet.rowsByNumber.keys()) {
    if (rowNumber >= 2) rowNumbers.add(rowNumber);
  }
  const seenMerged = new Set<string>();
  const mergedColMaskByRow = new Map<number, number>();
  for (const range of firstSheet.mergedRanges) {
    if (range.endRow < 2 || range.startCol > FAQ_COLUMNS.length || range.endCol < 1) continue;
    const colStart = Math.max(1, range.startCol);
    const colEnd = Math.min(FAQ_COLUMNS.length, range.endCol);
    const mask = ((1 << (colEnd - colStart + 1)) - 1) << (colStart - 1);
    const startRow = Math.max(2, range.startRow);
    const key = `${startRow}:${range.endRow}:${mask}`;
    if (seenMerged.has(key)) continue;
    seenMerged.add(key);
    for (let rowNumber = startRow; rowNumber <= range.endRow; rowNumber += 1) {
      mergedColMaskByRow.set(rowNumber, (mergedColMaskByRow.get(rowNumber) ?? 0) | mask);
      rowNumbers.add(rowNumber);
      if (mergedColMaskByRow.size > FAQ_MAX_ITEMS) {
        fail('PAYLOAD_TOO_LARGE', `FAQ 导入最多 ${FAQ_MAX_ITEMS} 条`);
      }
    }
  }

  const rows: RawRow[] = [];
  for (const rowNumber of [...rowNumbers].sort((a, b) => a - b)) {
    const rowCells = firstSheet.rowsByNumber.get(rowNumber);
    const mergedMask = mergedColMaskByRow.get(rowNumber) ?? 0;
    const value: Record<string, unknown> = {};
    const problems: string[] = [];
    let nonEmpty = false;
    for (const [index, column] of FAQ_COLUMNS.entries()) {
      const colNumber = index + 1;
      const cell = cellText(
        rowCells?.get(colNumber),
        (mergedMask & (1 << index)) !== 0,
        sharedStrings,
      );
      if ('problem' in cell) {
        problems.push(`${column}: ${cell.problem}`);
        continue;
      }
      if (cell.text.trim().length > 0) nonEmpty = true;
      value[column] = cell.text;
    }
    if (!nonEmpty && problems.length === 0) continue;
    if (problems.length > 0) value.__problems = problems;
    rows.push({ row: rows.length + 1, value });
    if (rows.length > FAQ_MAX_ITEMS) break;
  }
  return rows;
}

function positiveKeys(entry: FaqEntry): string[] {
  return [entry.question, ...entry.similarQuestions].map(normalizeFaqQuestion);
}

function flagsKey(entry: FaqTransferEntry): string {
  return `${entry.answerStrategy}|${entry.isRecommended}|${entry.enabled}`;
}

function mergeSimilarAndNegative(
  base: FaqEntry,
  row: FaqEntry,
): { similarQuestions: string[]; negativeQuestions: string[]; issues: FaqImportIssue[] } {
  const issues: FaqImportIssue[] = [];
  const allPositives = new Set(
    positiveKeys({
      ...base,
      similarQuestions: [...base.similarQuestions, ...row.similarQuestions],
    }),
  );
  const merge = (field: 'similarQuestions' | 'negativeQuestions'): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of [...base[field], ...row[field]]) {
      const key = normalizeFaqQuestion(value);
      if (seen.has(key)) continue;
      seen.add(key);
      if (field === 'negativeQuestions' && allPositives.has(key)) {
        issues.push(issue(field, 'DROPPED_OVERLAP', `反例与正向问相同已忽略：${value}`));
        continue;
      }
      result.push(value);
    }
    return result;
  };
  return {
    similarQuestions: merge('similarQuestions'),
    negativeQuestions: merge('negativeQuestions'),
    issues,
  };
}

export function planFaqImport(input: {
  mode: FaqImportMode;
  rows: FaqParsedRow[];
  existing: FaqExistingEntry[];
  newDocumentId: () => string;
}): FaqImportPlan {
  const results: FaqImportPlanRow[] = [];
  const drafts: FaqImportDraft[] = [];
  const existingByHash = new Map<string, { entry: FaqExistingEntry; faq: FaqEntry }>();
  const existingPositives = new Set<string>();
  for (const stored of input.existing) {
    existingByHash.set(faqContentHash(stored.faq), { entry: stored, faq: stored.faq });
    for (const key of positiveKeys(stored.faq)) existingPositives.add(key);
  }
  const seen = new Map<string, { flags: string }>();
  const seenPositives = new Set<string>();

  for (const row of input.rows) {
    if (!row.entry) {
      results.push({ row: row.row, status: 'failed', operation: null, issues: row.issues });
      continue;
    }
    const entry = row.entry;
    const hash = faqContentHash(entry);
    const flags = flagsKey(entry);
    const positives = positiveKeys(entry);
    const status: FaqImportRowStatus = row.issues.length > 0 ? 'partial_failed' : 'success';
    const reject = (code: string, message: string): void => {
      results.push({
        row: row.row,
        status: 'failed',
        operation: null,
        issues: [...row.issues, issue('faq', code, message)],
      });
    };

    const duplicateInBatch = seen.get(hash);
    if (duplicateInBatch) {
      if (duplicateInBatch.flags === flags) {
        results.push({ row: row.row, status: 'skipped', operation: 'skip', issues: row.issues });
      } else {
        reject('BATCH_CONFLICT', '批内同一正文但运营标记不同，后者不覆盖');
      }
      continue;
    }
    if (positives.some((key) => seenPositives.has(key))) {
      reject('QUESTION_CONFLICT', '批内正向问重复，后者不覆盖');
      continue;
    }

    if (input.mode === 'append') {
      const existing = existingByHash.get(hash);
      if (existing) {
        if (
          existing.entry.enabled === entry.enabled &&
          existing.faq.answerStrategy === entry.answerStrategy &&
          existing.faq.isRecommended === entry.isRecommended
        ) {
          results.push({
            row: row.row,
            status: 'skipped',
            operation: 'skip',
            documentId: existing.entry.documentId,
            issues: row.issues,
          });
        } else {
          const merged = mergeSimilarAndNegative(existing.faq, entry);
          const mergedEntry: FaqEntry = {
            ...entry,
            question: existing.faq.question,
            similarQuestions: merged.similarQuestions,
            negativeQuestions: merged.negativeQuestions,
          };
          drafts.push({
            operation: 'merge',
            documentId: existing.entry.documentId,
            faq: mergedEntry,
            enabled: entry.enabled,
          });
          const mergedIssues = [...row.issues, ...merged.issues];
          results.push({
            row: row.row,
            status: mergedIssues.length > 0 ? 'partial_failed' : 'success',
            operation: 'merge',
            documentId: existing.entry.documentId,
            expectedVersionId: existing.entry.publishedVersionId,
            issues: mergedIssues,
          });
        }
      } else if (positives.some((key) => existingPositives.has(key))) {
        reject('QUESTION_CONFLICT', '正向问与库内已有 FAQ 重复；修改答案请走逐条编辑');
      } else {
        const documentId = input.newDocumentId();
        drafts.push({ operation: 'add', documentId, faq: entry, enabled: entry.enabled });
        results.push({
          row: row.row,
          status,
          operation: 'add',
          documentId,
          expectedVersionId: null,
          issues: row.issues,
        });
      }
    } else {
      const documentId = input.newDocumentId();
      drafts.push({ operation: 'add', documentId, faq: entry, enabled: entry.enabled });
      results.push({
        row: row.row,
        status,
        operation: 'add',
        documentId,
        expectedVersionId: null,
        issues: row.issues,
      });
    }
    seen.set(hash, { flags });
    for (const key of positives) seenPositives.add(key);
  }

  const counts = {
    total: input.rows.length,
    success: results.filter((result) => result.status === 'success').length,
    failed: results.filter((result) => result.status === 'failed').length,
    partialFailed: results.filter((result) => result.status === 'partial_failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    added: results.filter((result) => result.operation === 'add').length,
    merged: results.filter((result) => result.operation === 'merge').length,
  };
  return { counts, results, drafts };
}

export function newFaqImportBatchId(): string {
  return `kfib_${crypto.randomUUID()}`;
}

function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeFaqExport(format: 'json' | 'csv', items: FaqTransferEntry[]): string {
  if (items.length > FAQ_MAX_ITEMS) {
    fail('PAYLOAD_TOO_LARGE', `FAQ 导出最多 ${FAQ_MAX_ITEMS} 条，请缩小范围`);
  }
  if (format === 'json') return JSON.stringify({ items }, null, 2);
  const lines = [
    FAQ_COLUMNS.join(','),
    ...items.map((item) =>
      [
        item.question,
        JSON.stringify(item.similarQuestions),
        JSON.stringify(item.negativeQuestions),
        JSON.stringify(item.answers),
        item.answerStrategy,
        String(item.isRecommended),
        String(item.enabled),
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return `\uFEFF${lines.join('\n')}\n`;
}
