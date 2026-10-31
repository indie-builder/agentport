import { createHash, randomUUID } from 'node:crypto';
import { fail, isAppError } from '@agentport/core';
import {
  type KnowledgeFaq,
  type KnowledgeFaqImportIssue,
  type KnowledgeFaqImportResult,
  type KnowledgeFaqTransferEntry,
} from '@agentport/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import type { Workbook as ExcelWorkbook } from 'exceljs';
import ExcelJS from 'exceljs';
import { Converter } from 'opencc-js';
import { z } from 'zod';
import { decodeZipEntries, inspectZipEntries, type ZipReadLimits } from '../agent-package-zip.js';

/** 批量导入/导出上限：完整处理或明确报错，不静默截断。 */
export const FAQ_MAX_ITEMS = 500;
export const FAQ_MAX_BYTES = 2 * 1024 * 1024;
/** xlsx 实际解压总字节上限（含 XML/共享字符串），解析前按中央目录与实际输出双重校验。 */
export const FAQ_MAX_XLSX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

/** 与知识包共用中央目录校验和实际解压上限，不信本地头或完整 load 后的声明。 */
const FAQ_XLSX_ZIP_LIMITS: ZipReadLimits = {
  maxEntries: 100,
  maxUncompressedBytes: FAQ_MAX_XLSX_DECOMPRESSED_BYTES,
};
const { Workbook } = ExcelJS;

/** 契约：answerStrategy/isRecommended 由 shared 的 KnowledgeFaq 承载。 */
export type FaqEntry = KnowledgeFaq;
export type FaqTransferEntry = KnowledgeFaqTransferEntry;
export type FaqImportIssue = KnowledgeFaqImportIssue;
export type FaqImportRowStatus = KnowledgeFaqImportResult['status'];
export type FaqImportOperation = KnowledgeFaqImportResult['operation'];

/**
 * CRUD 入口只校验原始 JSON 类型；可清洗的空白/重复/超量数组交给 normalizeFaqEntry
 * 在同一边界统一清洗并执行归一化后的 50 条与长度硬限。
 */
export const faqInputSchema = z.object({
  question: z.string(),
  similarQuestions: z.array(z.string()).default([]),
  negativeQuestions: z.array(z.string()).default([]),
  answers: z.array(z.string()),
  answerStrategy: z.string().optional(),
  isRecommended: z.boolean().optional(),
});

export type FaqInput = z.infer<typeof faqInputSchema>;

export const FAQ_COLUMNS = [
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
  /** 最新草稿；没有草稿时为 null。 */
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

export interface FaqImportDraft {
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
// 只去掉首尾标点；中间标点是问题的语义，不能被归一化掉。
const BOUNDARY_PUNCTUATION =
  /^[\s?.!,;:'"()[\]{}<>，。！？；：、（）【】《》“”‘’]+|[\s?.!,;:'"()[\]{}<>，。！？；：、（）【】《》“”‘’]+$/g;
const HAN_SPACE = /(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu;

const toSimplified = Converter({ from: 't', to: 'cn' });

/**
 * FAQ 问题归一化：仅用于「规范化后完全相同」的反例排除与重名检测，
 * 不做同义词、分词或向量比较。
 * 顺序照契约：trim → 去 URL → 小写 → 繁转简 → 去首尾标点 → 全角转半角 → 中文间去空格。
 */
export function normalizeFaqQuestion(value: string): string {
  return toSimplified(value.trim().replace(URL_PATTERN, ' ').toLowerCase())
    .replace(BOUNDARY_PUNCTUATION, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(HAN_SPACE, '')
    .trim();
}

/**
 * 内容哈希：数组顺序不影响结果，运营标记不计入。
 * 问句按归一化后比较，繁简/全角/URL/空白差异不算内容变化；答案保持本轮契约。
 * append 的「同一内容已存在」判断与去重都以它为准。
 */
export function faqContentHash(faq: FaqEntry): string {
  const sortedUnique = (values: string[]): string[] =>
    [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
  const normalizedUnique = (values: string[]): string[] =>
    [...new Set(values.map(normalizeFaqQuestion).filter((value) => value.length > 0))].sort();
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeFaqQuestion(faq.question),
        normalizedUnique(faq.similarQuestions),
        normalizedUnique(faq.negativeQuestions),
        sortedUnique(faq.answers),
      ]),
    )
    .digest('hex');
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

/** 单条 FAQ 入口清洗：trim/去空、去重、剔除与正向问重叠的反例；返回可入库条目。 */
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
    // 省略可选数组等同显式 []（与 shared/CRUD 契约一致）；answers 仍要求显式给出。
    const value = raw[field] === undefined && field !== 'answers' ? [] : raw[field];
    const parsed = parseStringArray(value, field, issues);
    if (parsed === null) continue;
    arrays[field] = parsed.map((value) => value.trim()).filter((value) => value.length > 0);
  }
  if (arrays.answers.length === 0) {
    issues.push(issue('answers', 'ANSWER_REQUIRED', '至少需要一条非空答案'));
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
    issues.push(issue('answers', 'ANSWER_REQUIRED', '至少需要一条非空答案'));
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

/** 文件级失败直接抛错；行级问题保留在 parsed rows 中由导入结果逐行说明。 */
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
    // header 用同一解析器单独读一行，引号/换行才按 CSV 规范处理。
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

/** 中央目录校验结构/声明上限，再按同一边界实际解压；不接收本地头或事后 load 的尺寸。 */
function assertXlsxArchive(data: Buffer): void {
  try {
    inspectZipEntries(data, FAQ_XLSX_ZIP_LIMITS);
    decodeZipEntries(data, FAQ_XLSX_ZIP_LIMITS);
  } catch (err) {
    if (isAppError(err)) {
      // 知识包解析把容量超限报成 INVALID_INPUT；FAQ 导入对外保持 413 语义。
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

function cellText(cell: {
  isMerged: boolean;
  value: unknown;
}): { text: string } | { problem: string } {
  if (cell.isMerged) return { problem: '合并单元格' };
  const value = cell.value;
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false' };
  return { problem: '只支持字符串或布尔常量单元格' };
}

async function parseXlsxRows(content: string): Promise<RawRow[]> {
  const data = decodeXlsxBase64(content);
  assertXlsxArchive(data);

  const workbook = new Workbook();
  // ExcelJS 的类型自带旧版 Buffer 定义，与仓库 Node 类型的泛型 Buffer 不兼容；运行时都是字节。
  await workbook.xlsx.load(data as unknown as Parameters<ExcelWorkbook['xlsx']['load']>[0]);
  const [sheet] = workbook.worksheets;
  if (!sheet) fail('INVALID_INPUT', 'FAQ xlsx 没有工作表');
  const extras = workbook.worksheets.filter((item) => item !== sheet && item.actualRowCount > 0);
  if (extras.length > 0) {
    fail(
      'INVALID_INPUT',
      `FAQ xlsx 只允许第一张工作表，额外非空工作表：${extras.map((item) => item.name).join(', ')}`,
    );
  }
  const header: string[] = [];
  let headerProblem = false;
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    const parsed = cellText(cell);
    if ('problem' in parsed) {
      headerProblem = true;
      return;
    }
    header.push(parsed.text.trim());
  });
  if (headerProblem) {
    fail('INVALID_INPUT', 'FAQ xlsx 表头不允许公式、富文本或合并单元格');
  }
  if (
    header.length !== FAQ_COLUMNS.length ||
    header.some((column, index) => column !== FAQ_COLUMNS[index])
  ) {
    fail('INVALID_INPUT', `FAQ xlsx 表头必须依次为：${FAQ_COLUMNS.join(', ')}`);
  }

  const rows: RawRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const value: Record<string, unknown> = {};
    const problems: string[] = [];
    let nonEmpty = false;
    for (const [index, column] of FAQ_COLUMNS.entries()) {
      const cell = cellText(row.getCell(index + 1));
      if ('problem' in cell) {
        problems.push(`${column}: ${cell.problem}`);
        continue;
      }
      if (cell.text.trim().length > 0) nonEmpty = true;
      value[column] = cell.text;
    }
    // 空行不是数据行，不计入 500 行上限。
    if (!nonEmpty && problems.length === 0) continue;
    if (problems.length > 0) value.__problems = problems;
    rows.push({ row: rows.length + 1, value });
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

/**
 * append/replace 的统一计划：判重、合并、逐行结果与统计都在这里。
 * 不写 DB、不调用 embedding；真实导入与 dryRun 共用同一份计划。
 */
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

/** 批次标识不是业务实体，只用于把一次导入的版本串起来。 */
export function newFaqImportBatchId(): string {
  return `kfib_${randomUUID()}`;
}

function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 导出与导入同形状：JSON 为 {items}，CSV 固定七列，可原样往返。 */
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
