import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type {
  KnowledgeSearchQuery,
  KnowledgeSearchResult,
  KnowledgeSearchWarning,
  KnowledgeTarget,
} from '@agentport/shared';
import { knowledgeTargetSchema } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { searchKnowledge } from './retrieval.js';

export const EVALUATION_MAX_CASES = 100;
export const EVALUATION_MAX_BYTES = 1024 * 1024;

export interface RetrievalEvaluationCase {
  q: string;
  expectedTargets: KnowledgeTarget[];
  expectedChunkIds?: string[] | undefined;
}

export interface RetrievalEvaluationCaseResult {
  q: string;
  hit: boolean;
  recallAtK: number;
  reciprocalRank: number;
  chunkRecallAtK: number | null;
  elapsedMs: number;
  degraded: boolean;
  warnings: KnowledgeSearchWarning[];
}

export interface RetrievalEvaluationReport {
  results: RetrievalEvaluationCaseResult[];
  recallAtK: number;
  mrr: number;
  chunkRecallAtK: number | null;
}

function targetKey(target: KnowledgeTarget): string {
  return `${target.kind}:${target.id}`;
}

function dedupe<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 逐条调用同一 searchKnowledge；Recall 按去重后的期望 target 计算，
 * MRR 取第一条命中 target 的排名。没有期望 chunk 时不报 chunkRecallAtK。
 */
export async function evaluateRetrieval(input: {
  cases: RetrievalEvaluationCase[];
  limit: number;
  rerank: boolean;
  minVectorScore: number;
  search: (query: KnowledgeSearchQuery) => Promise<KnowledgeSearchResult>;
  now?: () => number;
}): Promise<RetrievalEvaluationReport> {
  if (input.cases.length === 0) fail('INVALID_INPUT', '评估至少需要一条样本');
  if (input.cases.length > EVALUATION_MAX_CASES) {
    fail('PAYLOAD_TOO_LARGE', `评估最多 ${EVALUATION_MAX_CASES} 条样本`);
  }
  const now = input.now ?? Date.now;
  const results: RetrievalEvaluationCaseResult[] = [];

  for (const testCase of input.cases) {
    if (testCase.expectedTargets.length === 0) {
      fail('INVALID_INPUT', `样本「${testCase.q}」没有期望目标`);
    }
    const expectedTargets = dedupe(testCase.expectedTargets, targetKey);
    const expectedKeys = new Set(expectedTargets.map(targetKey));
    const expectedChunks =
      testCase.expectedChunkIds === undefined ? null : [...new Set(testCase.expectedChunkIds)];

    const startedAt = now();
    const result = await input.search({
      q: testCase.q,
      kinds: ['document', 'faq', 'wiki'],
      folders: [],
      tags: [],
      limit: input.limit,
      rerank: input.rerank,
      minVectorScore: input.minVectorScore,
      diagnostics: false,
      onlyRecommended: false,
      faqPriority: false,
      faqDirectAnswerThreshold: 0.9,
    });
    const elapsedMs = Math.max(0, now() - startedAt);

    let firstRank: number | null = null;
    const matched = new Set<string>();
    result.hits.forEach((hit, index) => {
      const key = targetKey(hit.target);
      if (!expectedKeys.has(key)) return;
      matched.add(key);
      if (firstRank === null) firstRank = index + 1;
    });

    const hitChunkIds = new Set(result.hits.map((hit) => hit.chunkId));
    const chunkRecallAtK =
      expectedChunks === null || expectedChunks.length === 0
        ? null
        : expectedChunks.filter((chunkId) => hitChunkIds.has(chunkId)).length /
          expectedChunks.length;

    results.push({
      q: testCase.q,
      hit: matched.size > 0,
      recallAtK: matched.size / expectedKeys.size,
      reciprocalRank: firstRank === null ? 0 : 1 / firstRank,
      chunkRecallAtK,
      elapsedMs,
      degraded: result.degraded,
      warnings: result.warnings,
    });
  }

  const chunkValues = results.flatMap((result) =>
    result.chunkRecallAtK === null ? [] : [result.chunkRecallAtK],
  );
  return {
    results,
    recallAtK: mean(results.map((result) => result.recallAtK)),
    mrr: mean(results.map((result) => result.reciprocalRank)),
    chunkRecallAtK: chunkValues.length === 0 ? null : mean(chunkValues),
  };
}

const baseParams = z.object({ id: z.string().min(1) });
const evaluationCaseSchema = z.object({
  q: z.string().trim().min(1).max(500),
  expectedTargets: z.array(knowledgeTargetSchema).min(1).max(50),
  expectedChunkIds: z.array(z.string().min(1)).max(100).optional(),
});
const evaluationBodySchema = z.object({
  cases: z.array(evaluationCaseSchema).min(1).max(EVALUATION_MAX_CASES),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  minVectorScore: z.number().min(-1).max(1).default(0.3),
});

export function registerRetrievalEvaluationRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.post(
    '/api/knowledge/bases/:id/retrieval-evaluations',
    {
      preHandler: [rawApp.requireAuth],
      schema: { params: baseParams, body: evaluationBodySchema },
    },
    async (request, reply) => {
      const baseId = request.params.id;
      if (!(await repo.knowledge.getBase(app.db, baseId))) {
        return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      }
      if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > EVALUATION_MAX_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '评估内容超过 1MiB 上限');
      }

      // 期望目标必须真实存在且属于该库；跨库或不存在都按输入错误拒绝，不返回别库对象。
      for (const testCase of request.body.cases) {
        for (const target of testCase.expectedTargets) {
          if (target.kind === 'wiki') {
            const page = await repo.knowledge.getWikiPage(app.db, target.id);
            if (!page || page.baseId !== baseId) {
              return reject(reply, 'INVALID_INPUT', `期望 Wiki 页面不属于该知识库：${target.id}`);
            }
            continue;
          }
          const document = await repo.knowledge.getDocument(app.db, target.id);
          const expectedKind = target.kind === 'faq' ? 'faq' : 'document';
          if (!document || document.baseId !== baseId || document.contentKind !== expectedKind) {
            return reject(reply, 'INVALID_INPUT', `期望目标不属于该知识库：${target.id}`);
          }
        }
        for (const chunkId of testCase.expectedChunkIds ?? []) {
          const chunk = await repo.knowledge.getChunk(app.db, chunkId);
          if (!chunk || chunk.baseId !== baseId) {
            return reject(reply, 'INVALID_INPUT', `期望分块不属于该知识库：${chunkId}`);
          }
        }
      }

      try {
        return await evaluateRetrieval({
          cases: request.body.cases,
          limit: request.body.limit,
          rerank: request.body.rerank,
          minVectorScore: request.body.minVectorScore,
          search: (query) =>
            searchKnowledge(app.db, baseId, query, { secretKey: app.config.APP_SECRET_KEY }),
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );
}
