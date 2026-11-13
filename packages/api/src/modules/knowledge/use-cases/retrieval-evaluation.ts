import { AppError } from '@agentport/core';
import { repo } from '@agentport/db';
import type { KnowledgeTarget } from '@agentport/shared';
import { searchKnowledge } from '../retrieval.js';
import {
  EVALUATION_MAX_BYTES,
  evaluateRetrieval,
  type RetrievalEvaluationReport,
} from '../retrieval-evaluation.js';
import { type KnowledgeDeps, notFound } from './shared.js';

// ---- retrieval evaluation -------------------------------------------------

export async function evaluateBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    cases: Array<{
      q: string;
      expectedTargets: KnowledgeTarget[];
      expectedChunkIds?: string[] | undefined;
    }>;
    limit: number;
    rerank: boolean;
    minVectorScore: number;
  },
): Promise<RetrievalEvaluationReport> {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > EVALUATION_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '评估内容超过 1MiB 上限');
  }
  for (const testCase of body.cases) {
    for (const target of testCase.expectedTargets) {
      if (target.kind === 'wiki') {
        const page = await repo.knowledge.getWikiPage(deps.db, target.id);
        if (!page || page.baseId !== id) {
          throw new AppError('INVALID_INPUT', `期望 Wiki 页面不属于该知识库：${target.id}`);
        }
        continue;
      }
      const document = await repo.knowledge.getDocument(deps.db, target.id);
      const expectedKind = target.kind === 'faq' ? 'faq' : 'document';
      if (!document || document.baseId !== id || document.contentKind !== expectedKind) {
        throw new AppError('INVALID_INPUT', `期望目标不属于该知识库：${target.id}`);
      }
    }
    for (const chunkId of testCase.expectedChunkIds ?? []) {
      const chunk = await repo.knowledge.getChunk(deps.db, chunkId);
      if (!chunk || chunk.baseId !== id) {
        throw new AppError('INVALID_INPUT', `期望分块不属于该知识库：${chunkId}`);
      }
    }
  }
  return evaluateRetrieval({
    cases: body.cases,
    limit: body.limit,
    rerank: body.rerank,
    minVectorScore: body.minVectorScore,
    search: (query) =>
      searchKnowledge(deps.db, id, query, { secretKey: deps.config.APP_SECRET_KEY }),
  });
}
