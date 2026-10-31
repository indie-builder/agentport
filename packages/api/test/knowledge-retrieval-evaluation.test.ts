import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFaq } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const faq: KnowledgeFaq = {
  question: '离线评估问题',
  similarQuestions: [],
  negativeQuestions: [],
  answers: ['离线评估答案'],
};

describe.skipIf(!ready)('retrieval evaluation route', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];
  let baseId = '';
  let faqId = '';
  let chunkId = '';

  async function createBase() {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('eval-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    profileIds.push(profile.json<{ id: string }>().id);
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: {
        slug: unique('eval-kb'),
        name: '评估库',
        embeddingProfileId: profile.json<{ id: string }>().id,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    baseIds.push(res.json<{ id: string }>().id);
    return res.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-eval-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
    baseId = await createBase();
    const created = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
      payload: { faq },
    });
    expect(created.statusCode, created.body).toBe(202);
    faqId = created.json<{ documentId: string }>().documentId;
    const detail = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/faqs/${faqId}`,
      headers: { cookie },
    });
    const versionId = detail.json<{ draftVersion: { id: string } }>().draftVersion.id;
    chunkId = `kchk_eval${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text)
       values ($1, $2, $3, $4, 0, 'text', 'eval keyword marker', 'eval keyword marker')`,
      [chunkId, baseId, faqId, versionId],
    );
    await app.pool.query(
      `update knowledge_jobs set status = 'succeeded', ended_at = now() where document_id = $1`,
      [faqId],
    );
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${faqId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(publish.statusCode, publish.body).toBe(200);
  });

  afterAll(async () => {
    if (baseIds.length > 0) {
      await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    }
    if (profileIds.length > 0) {
      await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
        profileIds,
      ]);
    }
    await app.close();
    await rm(knowledgeDir, { recursive: true, force: true });
  });

  it('runs every case through the same search and reports Recall/MRR', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/retrieval-evaluations`,
      headers: { cookie },
      payload: {
        cases: [
          {
            q: 'eval',
            expectedTargets: [{ kind: 'faq', id: faqId }],
            expectedChunkIds: [chunkId],
          },
          { q: '不存在的词', expectedTargets: [{ kind: 'faq', id: faqId }] },
        ],
        limit: 5,
        rerank: false,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      results: Array<{
        q: string;
        hit: boolean;
        recallAtK: number;
        reciprocalRank: number;
        chunkRecallAtK: number | null;
        elapsedMs: number;
        degraded: boolean;
        warnings: unknown[];
      }>;
      recallAtK: number;
      mrr: number;
      chunkRecallAtK: number | null;
    }>();
    expect(body.results.map((result) => result.hit)).toEqual([true, false]);
    expect(body.results.map((result) => result.recallAtK)).toEqual([1, 0]);
    expect(body.results[0]?.chunkRecallAtK).toBe(1);
    expect(body.results[1]?.chunkRecallAtK).toBeNull();
    expect(body.recallAtK).toBe(0.5);
    expect(body.mrr).toBe(0.5);
    expect(body.chunkRecallAtK).toBe(1);
    expect(body.results.every((result) => result.degraded)).toBe(true);
  });

  it('rejects cross-base targets, empty expectations and unknown bases', async () => {
    const otherBase = await createBase();
    const crossBase = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${otherBase}/retrieval-evaluations`,
      headers: { cookie },
      payload: {
        cases: [{ q: 'eval', expectedTargets: [{ kind: 'faq', id: faqId }] }],
      },
    });
    expect(crossBase.statusCode, crossBase.body).toBe(400);
    expect(crossBase.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const empty = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${otherBase}/retrieval-evaluations`,
      headers: { cookie },
      payload: { cases: [{ q: 'eval', expectedTargets: [] }] },
    });
    expect(empty.statusCode, empty.body).toBe(400);

    const missingBase = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases/kb_missing/retrieval-evaluations',
      headers: { cookie },
      payload: { cases: [{ q: 'eval', expectedTargets: [{ kind: 'faq', id: faqId }] }] },
    });
    expect(missingBase.statusCode).toBe(404);
  });
});
