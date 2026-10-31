import type { KnowledgeFaqTransferEntry, KnowledgeSearchHit } from '@agentport/shared';
import { Workbook } from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  type FaqExistingEntry,
  type FaqParsedRow,
  faqContentHash,
  faqInputSchema,
  normalizeFaqEntry,
  normalizeFaqQuestion,
  parseFaqImport,
  planFaqImport,
  serializeFaqExport,
} from '../src/features/knowledge/faq.js';
import { evaluateRetrieval } from '../src/features/knowledge/retrieval-evaluation.js';

const faq: KnowledgeFaqTransferEntry = {
  question: '如何重置密码？',
  similarQuestions: ['忘记密码怎么办', 'How do I reset it?'],
  negativeQuestions: ['如何删除账号？'],
  answers: ['在设置页点击重置。', '也可以联系管理员。'],
  answerStrategy: 'all',
  isRecommended: true,
  enabled: true,
};

const tricky: KnowledgeFaqTransferEntry = {
  question: '联系人，邮箱是什么？',
  similarQuestions: ['包含"引号"的问题'],
  negativeQuestions: [],
  answers: ['第一行, 带逗号\n第二行"带引号"'],
  answerStrategy: 'random',
  isRecommended: false,
  enabled: false,
};

async function xlsx(items: string[][], extraSheet = false): Promise<string> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('FAQ');
  for (const row of items) sheet.addRow(row);
  if (extraSheet) workbook.addWorksheet('额外').addRow(['不应存在']);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString('base64');
}

/** 只改本地头里的 compressedSize，中央目录保持真实值，复现 local/central 大小不一致。 */
function patchLocalCompressedSize(archive: Buffer, name: string, size: number): Buffer {
  const output = Buffer.from(archive);
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = output.indexOf(signature);
  while (offset !== -1) {
    if (offset + 30 > output.length) break;
    const nameLength = output.readUInt16LE(offset + 26);
    const entryName = output.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (entryName === name) {
      output.writeUInt32LE(size, offset + 18);
      return output;
    }
    offset = output.indexOf(signature, offset + 4);
  }
  throw new Error(`local header not found: ${name}`);
}

const header = [
  'question',
  'similarQuestions',
  'negativeQuestions',
  'answers',
  'answerStrategy',
  'isRecommended',
  'enabled',
];

function row(entry: KnowledgeFaqTransferEntry): string[] {
  return [
    entry.question,
    JSON.stringify(entry.similarQuestions),
    JSON.stringify(entry.negativeQuestions),
    JSON.stringify(entry.answers),
    entry.answerStrategy,
    String(entry.isRecommended),
    String(entry.enabled),
  ];
}

function existing(
  entry: KnowledgeFaqTransferEntry,
  documentId = 'kdoc_existing',
): FaqExistingEntry {
  return {
    documentId,
    faq: entry,
    enabled: entry.enabled,
    latestDraftVersionId: 'kdv_draft',
    publishedVersionId: 'kdv_published',
    updatedAt: '2026-10-31T00:00:00.000Z',
  };
}

function plan(rows: FaqParsedRow[], existingEntries: FaqExistingEntry[] = []) {
  let index = 0;
  return planFaqImport({
    mode: 'append',
    rows,
    existing: existingEntries,
    newDocumentId: () => `kdoc_new_${index++}`,
  });
}

describe('FAQ normalization and matching', () => {
  it('normalizes URL, case, width, boundary punctuation, traditional and Chinese spaces', () => {
    expect(normalizeFaqQuestion('  Ｈｏｗ   to reset？ ')).toBe('how to reset');
    expect(normalizeFaqQuestion('看 https://example.com/a 这个')).toBe('看这个');
    expect(normalizeFaqQuestion('“密码 重置！”')).toBe('密码重置');
    expect(normalizeFaqQuestion('密碼重置')).toBe('密码重置');
    expect(normalizeFaqQuestion('忘记密码？')).toBe(normalizeFaqQuestion('忘記密碼'));
  });

  it('drops answer-strategy and recommendation flags from the content hash', () => {
    expect(faqContentHash({ ...faq, answerStrategy: 'random', isRecommended: false })).toBe(
      faqContentHash(faq),
    );
    expect(faqContentHash({ ...faq, similarQuestions: [...faq.similarQuestions].reverse() })).toBe(
      faqContentHash(faq),
    );
  });

  it('normalizes every question in the content hash', () => {
    // 繁简、全角、URL、数组顺序都不算内容变化，相似问与反例同样归一化。
    expect(
      faqContentHash({
        ...faq,
        similarQuestions: [
          'Ｈｏｗ ｄｏ Ｉ ｒｅｓｅｔ ｉｔ！ https://example.com/x',
          '忘記密碼怎麼辦',
        ],
        negativeQuestions: ['如何刪除賬號'],
      }),
    ).toBe(faqContentHash(faq));
  });

  it('drops duplicates and negative overlap as partial issues', () => {
    const normalized = normalizeFaqEntry({
      ...faq,
      similarQuestions: ['忘记密码怎么办', '如何重置密码?'],
      negativeQuestions: ['如何重置密码', '如何删除账号？', '如何删除账号'],
    });
    expect(normalized.entry?.similarQuestions).toEqual(['忘记密码怎么办']);
    expect(normalized.entry?.negativeQuestions).toEqual(['如何删除账号？']);
    expect(normalized.issues.map((item) => item.code)).toEqual([
      'DROPPED_DUPLICATE',
      'DROPPED_OVERLAP',
      'DROPPED_DUPLICATE',
    ]);
  });

  it('dedupes trimmed answers in original order and keeps the hash consistent', () => {
    const normalized = normalizeFaqEntry({ ...faq, answers: [' 甲 ', '甲', '乙', '   '] });
    expect(normalized.entry?.answers).toEqual(['甲', '乙']);
    expect(normalized.issues).toContainEqual(
      expect.objectContaining({ field: 'answers', code: 'DROPPED_DUPLICATE' }),
    );
    expect(faqContentHash({ ...faq, answers: ['甲', '甲', '乙'] })).toBe(
      faqContentHash({ ...faq, answers: ['乙', '甲'] }),
    );
  });

  it('fails rows over 50 after cleaning and counts deduped entries', () => {
    const over = normalizeFaqEntry({
      ...faq,
      similarQuestions: Array.from({ length: 51 }, (_, index) => `相似问${index}`),
    });
    expect(over.entry).toBeNull();
    expect(over.issues).toContainEqual(
      expect.objectContaining({ field: 'similarQuestions', code: 'TOO_MANY_QUESTIONS' }),
    );

    const negativeOver = normalizeFaqEntry({
      ...faq,
      negativeQuestions: Array.from({ length: 51 }, (_, index) => `反例${index}`),
    });
    expect(negativeOver.entry).toBeNull();

    const deduped = normalizeFaqEntry({
      ...faq,
      similarQuestions: [...Array.from({ length: 50 }, (_, index) => `问题${index}`), '问题0'],
    });
    expect(deduped.entry?.similarQuestions).toHaveLength(50);
    expect(deduped.issues).toContainEqual(
      expect.objectContaining({ field: 'similarQuestions', code: 'DROPPED_DUPLICATE' }),
    );
  });

  it('rejects invalid strategy and booleans per row', () => {
    const normalized = normalizeFaqEntry({ ...faq, answerStrategy: 'sometimes', enabled: 'yes' });
    expect(normalized.entry).toBeNull();
    expect(normalized.issues.map((item) => item.field)).toEqual(['answerStrategy', 'enabled']);
  });

  it('CRUD entry schema only checks raw types before cleaning enforces hard limits', () => {
    const cleanable = faqInputSchema.safeParse({
      ...faq,
      similarQuestions: ['  ', '忘记密码'],
      negativeQuestions: Array.from({ length: 51 }, () => faq.question),
    });
    expect(cleanable.success).toBe(true);
    expect(faqInputSchema.safeParse({ ...faq, question: 123 }).success).toBe(false);
    expect(faqInputSchema.safeParse({ ...faq, answers: ['ok', 5] }).success).toBe(false);
  });
});

describe('FAQ import/export roundtrip', () => {
  it('roundtrips JSON and CSV including flags', async () => {
    const json = serializeFaqExport('json', [faq, tricky]);
    await expect(parseFaqImport({ format: 'json', content: json })).resolves.toEqual([
      { row: 1, entry: faq, issues: [] },
      { row: 2, entry: tricky, issues: [] },
    ]);
    const csv = serializeFaqExport('csv', [faq, tricky]);
    expect(csv.startsWith('﻿')).toBe(true);
    await expect(parseFaqImport({ format: 'csv', content: csv })).resolves.toEqual([
      { row: 1, entry: faq, issues: [] },
      { row: 2, entry: tricky, issues: [] },
    ]);
  });

  it('defaults optional flags and reports malformed array cells per row', async () => {
    const defaults = await parseFaqImport({
      format: 'csv',
      content: [header.join(','), 'q,"[]","[]","[""a""]",,,'].join('\n'),
    });
    expect(defaults[0]?.entry).toMatchObject({
      answerStrategy: 'all',
      isRecommended: true,
      enabled: true,
    });
    const malformed = await parseFaqImport({
      format: 'csv',
      content: `${header.join(',')}\nq,not-json,"[]","[""a""]",all,true,true`,
    });
    expect(malformed[0]?.entry).toMatchObject({ similarQuestions: [] });
    expect(malformed[0]?.issues[0]).toMatchObject({ field: 'similarQuestions' });
  });

  it('cleans omitted optional question arrays to empty and matches explicit []', async () => {
    const base = { question: '省略可选字段？', answers: ['答案'] };
    const omitted = await parseFaqImport({
      format: 'json',
      content: JSON.stringify({ items: [base] }),
    });
    expect(omitted).toEqual([
      {
        row: 1,
        entry: {
          question: '省略可选字段？',
          similarQuestions: [],
          negativeQuestions: [],
          answers: ['答案'],
          answerStrategy: 'all',
          isRecommended: true,
          enabled: true,
        },
        issues: [],
      },
    ]);
    const explicit = await parseFaqImport({
      format: 'json',
      content: JSON.stringify({
        items: [{ ...base, similarQuestions: [], negativeQuestions: [] }],
      }),
    });
    expect(explicit).toEqual(omitted);
    expect(plan(omitted).counts).toMatchObject({ success: 1, partialFailed: 0, failed: 0 });
  });

  it('still requires answers and rejects genuinely invalid optional arrays', async () => {
    const missing = await parseFaqImport({
      format: 'json',
      content: JSON.stringify({ items: [{ question: '缺答案？' }] }),
    });
    expect(missing[0]?.entry).toBeNull();
    expect(missing[0]?.issues).toContainEqual(
      expect.objectContaining({ field: 'answers', code: 'ANSWER_REQUIRED' }),
    );

    const invalid = await parseFaqImport({
      format: 'json',
      content: JSON.stringify({
        items: [{ question: '坏类型？', similarQuestions: {}, answers: ['答案'] }],
      }),
    });
    expect(invalid[0]?.entry).toMatchObject({ similarQuestions: [] });
    expect(invalid[0]?.issues).toContainEqual(
      expect.objectContaining({ field: 'similarQuestions', code: 'INVALID_JSON_ARRAY' }),
    );
    expect(plan(invalid).results[0]?.status).toBe('partial_failed');
  });

  it('parses xlsx constant cells and rejects formulas/non-empty extra sheets', async () => {
    const content = await xlsx([header, row(faq), row(tricky)]);
    const parsed = await parseFaqImport({ format: 'xlsx', content });
    expect(parsed.map((item) => item.entry)).toEqual([faq, tricky]);

    const formula = new Workbook();
    const sheet = formula.addWorksheet('FAQ');
    sheet.addRow(header);
    sheet.addRow(row(faq));
    sheet.getCell('A2').value = { formula: '1+1', result: 2 };
    const formulaContent = Buffer.from(await formula.xlsx.writeBuffer()).toString('base64');
    const rejected = await parseFaqImport({ format: 'xlsx', content: formulaContent });
    expect(rejected[0]?.entry).toBeNull();
    expect(rejected[0]?.issues[0]?.code).toBe('INVALID_CELL');

    await expect(
      parseFaqImport({ format: 'xlsx', content: await xlsx([header, row(faq)], true) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enforces actual decompressed bytes before loading xlsx', async () => {
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(33 * 1024 * 1024) });
    await expect(
      parseFaqImport({ format: 'xlsx', content: Buffer.from(bomb).toString('base64') }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }, 30_000);

  it('rejects local/central size mismatch before ExcelJS loads the workbook', async () => {
    const workbook = new Workbook();
    workbook.addWorksheet('FAQ').addRow(header);
    const entries = unzipSync(Buffer.from(await workbook.xlsx.writeBuffer()));
    entries['first.txt'] = new Uint8Array(33 * 1024 * 1024);
    const archive = Buffer.from(zipSync(entries));
    expect(archive.length).toBeLessThan(2 * 1024 * 1024);
    // fflate 的流式预检按本地头只看 2 字节；中央目录仍指向真实的 33MiB 输出。
    const forged = patchLocalCompressedSize(archive, 'first.txt', 2);
    await expect(
      parseFaqImport({ format: 'xlsx', content: forged.toString('base64') }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }, 30_000);
});

describe('FAQ import planning', () => {
  it('adds, skips identical rows and merges changed flags', () => {
    const added = plan([{ row: 1, entry: faq, issues: [] }]);
    expect(added.counts).toMatchObject({ added: 1, success: 1 });
    expect(added.drafts[0]).toMatchObject({ operation: 'add', documentId: 'kdoc_new_0', faq });

    const skipped = plan([{ row: 1, entry: faq, issues: [] }], [existing(faq)]);
    expect(skipped.counts).toMatchObject({ skipped: 1 });
    expect(skipped.drafts).toEqual([]);

    const merged = plan(
      [{ row: 1, entry: { ...faq, answerStrategy: 'random' }, issues: [] }],
      [existing(faq)],
    );
    expect(merged.counts).toMatchObject({ merged: 1 });
    expect(merged.drafts[0]).toMatchObject({
      operation: 'merge',
      documentId: 'kdoc_existing',
      faq: { question: faq.question, answerStrategy: 'random' },
    });
  });

  it('rejects a positive-question conflict and duplicate batch rows', () => {
    const conflict = plan(
      [{ row: 1, entry: { ...faq, answers: ['新答案'] }, issues: [] }],
      [existing(faq)],
    );
    expect(conflict.counts).toMatchObject({ failed: 1 });
    expect(conflict.results[0]?.issues.at(-1)).toMatchObject({ code: 'QUESTION_CONFLICT' });

    const duplicated = plan([
      { row: 1, entry: faq, issues: [] },
      { row: 2, entry: faq, issues: [] },
    ]);
    expect(duplicated.counts).toMatchObject({ success: 1, skipped: 1 });
  });

  it('validates replace only inside the batch', () => {
    const replace = planFaqImport({
      mode: 'replace',
      rows: [{ row: 1, entry: tricky, issues: [] }],
      existing: [existing(faq)],
      newDocumentId: () => 'kdoc_new_0',
    });
    expect(replace.counts).toMatchObject({ added: 1, failed: 0 });
    expect(replace.results[0]?.operation).toBe('add');
  });

  it('counts total as the four row states combined', () => {
    const result = plan([
      { row: 1, entry: faq, issues: [] },
      { row: 2, entry: null, issues: [{ field: 'question', code: 'X', message: 'x' }] },
      { row: 3, entry: { ...faq, similarQuestions: ['x'] }, issues: [] },
    ]);
    const counts = result.counts;
    expect(counts.total).toBe(
      counts.success + counts.failed + counts.partialFailed + counts.skipped,
    );
    expect(counts.added + counts.merged).toBe(counts.success + counts.partialFailed);
  });

  it('marks over-limit rows failed without producing drafts', () => {
    const normalized = normalizeFaqEntry({
      ...faq,
      similarQuestions: Array.from({ length: 51 }, (_, index) => `超限问题${index}`),
    });
    const result = plan([{ row: 1, entry: normalized.entry, issues: normalized.issues }]);
    expect(result.counts).toMatchObject({ total: 1, failed: 1, added: 0, merged: 0 });
    expect(result.drafts).toEqual([]);
  });
});

function hit(target: KnowledgeSearchHit['target'], chunkId: string): KnowledgeSearchHit {
  return {
    chunkId,
    documentId: 'kdoc_x',
    versionId: 'kdv_x',
    target,
    targetVersionId: 'kdv_x',
    title: '标题',
    heading: null,
    quote: '引用',
    pageFrom: null,
    pageTo: null,
    locator: null,
    parentContent: null,
    sourceUrl: null,
    score: 1,
    scoreKind: 'rrf',
    scores: { keyword: 1, vector: null, rrf: 1, rerank: null },
    image: null,
    faq: null,
  };
}

describe('retrieval evaluation', () => {
  it('computes Recall@k, MRR and chunk recall', async () => {
    const now = [0, 10, 100, 130, 200, 220][Symbol.iterator]();
    const report = await evaluateRetrieval({
      cases: [
        { q: 'q1', expectedTargets: [{ kind: 'document', id: 'd1' }] },
        { q: 'q2', expectedTargets: [{ kind: 'faq', id: 'f1' }] },
        { q: 'q3', expectedTargets: [{ kind: 'wiki', id: 'w1' }], expectedChunkIds: ['c9', 'c8'] },
      ],
      limit: 5,
      rerank: false,
      minVectorScore: 0.3,
      now: () => now.next().value ?? 0,
      search: async (query) => {
        if (query.q === 'q1') {
          return {
            hits: [
              hit({ kind: 'document', id: 'other' }, 'c1'),
              hit({ kind: 'document', id: 'd1' }, 'c2'),
            ],
            degraded: false,
            warnings: [],
          };
        }
        if (query.q === 'q2') {
          return { hits: [], degraded: true, warnings: [] };
        }
        return {
          hits: [hit({ kind: 'wiki', id: 'w1' }, 'c8')],
          degraded: false,
          warnings: [],
        };
      },
    });

    expect(report.results.map((result) => result.recallAtK)).toEqual([1, 0, 1]);
    expect(report.results.map((result) => result.reciprocalRank)).toEqual([0.5, 0, 1]);
    expect(report.results[1]).toMatchObject({ hit: false, degraded: true });
    expect(report.results[2]?.chunkRecallAtK).toBe(0.5);
    expect(report.recallAtK).toBeCloseTo(2 / 3);
    expect(report.mrr).toBeCloseTo(0.5);
    expect(report.chunkRecallAtK).toBe(0.5);
  });

  it('dedupes expected targets and rejects empty expectations', async () => {
    const report = await evaluateRetrieval({
      cases: [
        {
          q: 'q',
          expectedTargets: [
            { kind: 'document', id: 'd1' },
            { kind: 'document', id: 'd1' },
          ],
        },
      ],
      limit: 5,
      rerank: false,
      minVectorScore: 0.3,
      search: async () => ({
        hits: [hit({ kind: 'document', id: 'd1' }, 'c1')],
        degraded: false,
        warnings: [],
      }),
    });
    expect(report.results[0]?.recallAtK).toBe(1);
    await expect(
      evaluateRetrieval({
        cases: [{ q: 'q', expectedTargets: [] }],
        limit: 5,
        rerank: false,
        minVectorScore: 0.3,
        search: async () => ({ hits: [], degraded: false, warnings: [] }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
