import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeFaq, KnowledgeFaqTransferEntry } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFaqImport, serializeFaqExport } from '../src/features/knowledge/faq.js';
import {
  type FastifyInstance,
  infraReady,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;

const faqA: KnowledgeFaq = {
  question: '如何重置密码？',
  similarQuestions: ['忘记密码怎么办'],
  negativeQuestions: ['如何删除账号？'],
  answers: ['在设置页重置。', '也可以联系管理员。'],
  answerStrategy: 'all',
  isRecommended: true,
};

const faqB: KnowledgeFaq = {
  question: '联系人，邮箱是什么？',
  similarQuestions: [],
  negativeQuestions: [],
  answers: ['support@example.com'],
  answerStrategy: 'random',
  isRecommended: false,
};

const itemA: KnowledgeFaqTransferEntry = { ...faqA, enabled: true };
const itemB: KnowledgeFaqTransferEntry = { ...faqB, enabled: false };

describe.skipIf(!ready)('knowledge FAQ routes', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  async function createProfile() {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('faq-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    profileIds.push(id);
    return id;
  }

  async function createBase() {
    const res = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: {
        slug: unique('faq-kb'),
        name: 'FAQ 库',
        embeddingProfileId: await createProfile(),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    baseIds.push(id);
    return id;
  }

  async function createFaq(baseId: string, entry: KnowledgeFaqTransferEntry) {
    return inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
      payload: { faq: entry },
    });
  }

  type Detail = {
    document: { id: string; baseId: string; status: string; currentVersionId: string | null };
    draftVersion: { id: string; faq: KnowledgeFaq } | null;
    publishedVersion: { id: string; faq: KnowledgeFaq } | null;
    faq: KnowledgeFaq | null;
  };

  async function detail(documentId: string): Promise<Detail> {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Detail>();
  }

  /** 模拟 worker 索引结果：写入 leaf、把 job 标成功，再允许批发布。 */
  async function finishFaqJob(documentId: string, versionId?: string, jobId?: string) {
    const body = await detail(documentId);
    const draftVersionId = versionId || body.draftVersion?.id;
    expect(draftVersionId, 'draft version missing').toBeTruthy();
    const chunkId = `kchk_faq${Math.random().toString(36).slice(2, 10)}`;
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
       values ($1, $2, $3, $4, 0, 'text', $5, $5, $6::jsonb)`,
      [
        chunkId,
        body.document.baseId,
        documentId,
        draftVersionId,
        'faq keyword marker',
        JSON.stringify({ answerOrdinal: 0, faqRole: 'standard' }),
      ],
    );
    await app.pool.query(
      `update knowledge_jobs set status = 'succeeded', ended_at = now()
       where document_id = $1 and ($2::text is null or id = $2)`,
      [documentId, jobId ?? null],
    );
    return draftVersionId;
  }

  async function searchFaq(baseId: string, q: string, extra: Record<string, unknown> = {}) {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/test`,
      headers: { cookie },
      payload: { q, limit: 10, ...extra },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      hits: Array<{ chunkId: string; target: { kind: string; id: string } }>;
      degraded: boolean;
    }>();
  }

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-faq-routes-'));
    app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
    cookie = await loginCookie(app);
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

  it('requires auth on every FAQ route', async () => {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseIds[0] ?? 'kb_x'}/faqs`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a draft FAQ without touching the online pointer or enabling search', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, faqA);
    expect(created.statusCode, created.body).toBe(202);
    const { documentId, jobId } = created.json<{ documentId: string; jobId: string }>();

    const body = await detail(documentId);
    expect(body.document).toMatchObject({ status: 'pending', currentVersionId: null });
    expect(body.publishedVersion).toBeNull();
    expect(body.draftVersion?.faq).toEqual(faqA);
    expect(body.faq).toEqual(faqA);

    const job = await app.pool.query<{ type: string; payload: Record<string, unknown> }>(
      'select type, payload from knowledge_jobs where id = $1',
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({
      type: 'ingest',
      payload: { publish: 'draft', versionId: body.draftVersion?.id },
    });

    await finishFaqJob(documentId, body.draftVersion?.id ?? '', jobId);
    const hits = await searchFaq(baseId, 'faq');
    expect(hits.hits).toEqual([]);
  });

  it('rejects duplicate normalized positive questions', async () => {
    const baseId = await createBase();
    expect((await createFaq(baseId, faqA)).statusCode).toBe(202);
    const duplicate = await createFaq(baseId, { ...faqA, answers: ['不同答案'] });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json<{ code: string }>().code).toBe('CONFLICT');
  });

  it('updates only with the expected draft version and publishes explicitly', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, faqA);
    const { documentId } = created.json<{ documentId: string }>();
    const first = await detail(documentId);
    const firstVersionId = first.draftVersion?.id ?? '';

    const missingExpected = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: { faq: faqA },
    });
    expect(missingExpected.statusCode, missingExpected.body).toBe(400);

    const stale = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: { faq: faqA, expectedVersionId: 'kdv_missing' },
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const updatedFaq: KnowledgeFaq = {
      ...faqA,
      answers: ['只保留第一条。'],
      answerStrategy: 'random',
      isRecommended: false,
    };
    const updated = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: { faq: updatedFaq, expectedVersionId: firstVersionId },
    });
    expect(updated.statusCode, updated.body).toBe(202);
    const afterUpdate = await detail(documentId);
    expect(afterUpdate.document).toMatchObject({ status: 'pending', currentVersionId: null });
    expect(afterUpdate.draftVersion?.faq).toEqual(updatedFaq);

    const versionId = afterUpdate.draftVersion?.id ?? '';
    const updateJob = await app.pool.query<{ payload: { versionId?: string } }>(
      'select payload from knowledge_jobs where document_id = $1 order by created_at desc limit 1',
      [documentId],
    );
    // 更新必须创建指向新草稿版本的任务，不能只让 worker 取 latest。
    expect(updateJob.rows[0]?.payload.versionId).toBe(versionId);
    await finishFaqJob(documentId, versionId);
    const publish = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json()).toMatchObject({ status: 'ready', currentVersionId: versionId });

    const afterPublish = await detail(documentId);
    expect(afterPublish.publishedVersion?.faq).toEqual(updatedFaq);
    expect(afterPublish.faq).toEqual(updatedFaq);
    const hits = await searchFaq(baseId, 'faq');
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]).toMatchObject({ target: { kind: 'faq', id: documentId } });
    expect(hits.degraded).toBe(true);

    const recommended = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs?isRecommended=false`,
      headers: { cookie },
    });
    expect(
      recommended.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id),
    ).toEqual([documentId]);
    const recommendedTrue = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs?isRecommended=true`,
      headers: { cookie },
    });
    expect(recommendedTrue.json<{ items: unknown[] }>().items).toEqual([]);

    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/faqs/${documentId}/status`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    expect((await searchFaq(baseId, 'faq')).hits).toEqual([]);

    const enabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/faqs/${documentId}/status`,
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(enabled.json()).toMatchObject({ status: 'ready', disabledReason: null });
    expect((await searchFaq(baseId, 'faq')).hits).toHaveLength(1);
  });

  it('publishes only after the draft index job succeeded; partial chunks do not count', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, faqA);
    const { documentId } = created.json<{ documentId: string }>();
    const draft = await detail(documentId);
    const versionId = draft.draftVersion?.id ?? '';
    expect(versionId).toBeTruthy();

    // 失败任务会留下 partial chunks：有块但 job 未成功时仍拒绝发布。
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
       values ($1, $2, $3, $4, 0, 'text', 'partial', 'partial', '{}'::jsonb)`,
      [
        `kchk_partial${Math.random().toString(36).slice(2, 10)}`,
        draft.document.baseId,
        documentId,
        versionId,
      ],
    );
    const notReady = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(notReady.statusCode, notReady.body).toBe(409);
    expect(notReady.json<{ code: string }>().code).toBe('CONFLICT');

    await app.pool.query(
      `update knowledge_jobs set status = 'failed', ended_at = now() where document_id = $1`,
      [documentId],
    );
    const failed = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(failed.statusCode, failed.body).toBe(409);

    await app.pool.query(
      `update knowledge_jobs set status = 'succeeded', ended_at = now() where document_id = $1`,
      [documentId],
    );
    const ready = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', currentVersionId: versionId });
  });

  it('rejects publishing a draft whose own indexing job is missing or mismatched', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, faqA);
    const { documentId, jobId } = created.json<{ documentId: string; jobId: string }>();
    const draft = await detail(documentId);
    const versionId = draft.draftVersion?.id ?? '';
    await finishFaqJob(documentId, versionId, jobId);

    // 借另一篇 FAQ 的成功任务：任务归属不同文档，不能给本版本上线。
    const other = await createFaq(baseId, faqB);
    const otherBody = other.json<{ documentId: string; jobId: string }>();
    const otherDraft = await detail(otherBody.documentId);
    await finishFaqJob(otherBody.documentId, otherDraft.draftVersion?.id ?? '', otherBody.jobId);
    await app.pool.query(
      `update knowledge_document_versions
         set metadata = metadata || jsonb_build_object('indexingJobId', $2::text)
       where id = $1`,
      [versionId, otherBody.jobId],
    );
    const foreign = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(foreign.statusCode, foreign.body).toBe(409);

    // 任务归属正确但输入快照与版本不一致，同样拒绝。
    await app.pool.query(
      `update knowledge_document_versions
         set metadata = metadata || jsonb_build_object('indexingJobId', $2::text)
       where id = $1`,
      [versionId, jobId],
    );
    await app.pool.query(
      `update knowledge_jobs set payload = jsonb_set(payload, '{input,blobSha256}', '"deadbeef"')
       where id = $1`,
      [jobId],
    );
    const mismatched = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId: null },
    });
    expect(mismatched.statusCode, mismatched.body).toBe(409);
    expect(mismatched.json<{ code: string }>().code).toBe('CONFLICT');
  });

  it('dry-runs, imports drafts, publishes the batch and roundtrips export', async () => {
    const baseId = await createBase();
    const content = serializeFaqExport('json', [itemA, itemB]);
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: false },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    const body = imported.json<{
      committed: boolean;
      importBatchId: string;
      counts: Record<string, number>;
      results: Array<{
        row: number;
        status: string;
        operation: string;
        documentId: string;
        jobId: string;
      }>;
    }>();
    expect(body).toMatchObject({
      committed: true,
      counts: { total: 2, success: 2, added: 2, failed: 0, skipped: 0 },
    });
    expect(body.results.map((result) => result.operation)).toEqual(['add', 'add']);

    const draftExport = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs/export?format=csv&version=draft`,
      headers: { cookie },
    });
    expect(draftExport.statusCode, draftExport.body).toBe(200);
    const exported = await parseFaqImport({ format: 'csv', content: draftExport.body });
    expect(exported.map((row) => row.entry)).toEqual(expect.arrayContaining([itemA, itemB]));

    const publishedEmpty = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs/export?format=json&version=published`,
      headers: { cookie },
    });
    expect(JSON.parse(publishedEmpty.body)).toEqual({ items: [] });

    const items = [];
    for (const result of body.results) {
      const versionId = await finishFaqJob(result.documentId, '', result.jobId);
      items.push({ documentId: result.documentId, versionId, expectedVersionId: null });
    }
    const batch = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/batch`,
      headers: { cookie },
      payload: { action: 'publish', items, importBatchId: body.importBatchId },
    });
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json<{ results: Array<{ status: string }> }>().results).toEqual([
      { documentId: items[0]?.documentId, status: 'succeeded' },
      { documentId: items[1]?.documentId, status: 'succeeded' },
    ]);
    // enabled=false 的导入条目发布后立即停用，不参与检索。
    expect((await detail(items[1]?.documentId ?? '')).document).toMatchObject({
      status: 'disabled',
      disabledReason: 'manual',
      currentVersionId: items[1]?.versionId,
    });

    const publishedExport = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs/export?format=json&version=published`,
      headers: { cookie },
    });
    expect(JSON.parse(publishedExport.body).items).toEqual(expect.arrayContaining([itemA, itemB]));
    expect(JSON.parse(publishedExport.body).items).toHaveLength(2);

    // 同一内容再次 append：全部 skipped，不产生新草稿。
    const repeated = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: false },
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({
      committed: false,
      counts: { total: 2, skipped: 2, added: 0 },
    });
  });

  it('imports JSON rows that omit optional question arrays in dry-run and commit', async () => {
    const baseId = await createBase();
    const content = JSON.stringify({
      items: [
        {
          question: '省略相似问和反例？',
          answers: ['省略的可选数组按空数组导入'],
          answerStrategy: 'all',
          isRecommended: true,
          enabled: true,
        },
      ],
    });

    const dryRun = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: true },
    });
    expect(dryRun.statusCode, dryRun.body).toBe(200);
    expect(dryRun.json()).toMatchObject({
      dryRun: true,
      committed: false,
      counts: { total: 1, success: 1, partialFailed: 0, failed: 0 },
    });
    expect(
      dryRun.json<{ results: Array<{ status: string; issues: unknown[] }> }>().results,
    ).toEqual([expect.objectContaining({ status: 'success', issues: [] })]);

    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: false },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    expect(imported.json()).toMatchObject({
      committed: true,
      counts: { total: 1, success: 1, partialFailed: 0, failed: 0 },
    });
    const [result] = imported.json<{ results: Array<{ documentId: string }> }>().results;
    expect((await detail(result?.documentId ?? '')).faq).toMatchObject({
      question: '省略相似问和反例？',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['省略的可选数组按空数组导入'],
      answerStrategy: 'all',
      isRecommended: true,
    });
  });

  it('dry-run writes nothing and failed rows block the whole batch', async () => {
    const baseId = await createBase();
    expect((await createFaq(baseId, faqA)).statusCode).toBe(202);
    const content = serializeFaqExport('json', [itemB, { ...itemA, answers: ['新答案'] }]);
    const dryRun = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: true },
    });
    expect(dryRun.statusCode, dryRun.body).toBe(200);
    expect(dryRun.json()).toMatchObject({
      dryRun: true,
      committed: false,
      importBatchId: null,
      counts: { total: 2, success: 1, failed: 1 },
    });
    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const real = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: false },
    });
    expect(real.statusCode, real.body).toBe(200);
    expect(real.json()).toMatchObject({ committed: false, counts: { failed: 1 } });
    const after = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
    });
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('keeps the old FAQ set until a full replace batch publishes', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, faqA);
    const { documentId } = created.json<{ documentId: string }>();
    const first = await detail(documentId);
    await finishFaqJob(documentId, first.draftVersion?.id ?? '');
    await inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId: first.draftVersion?.id, expectedVersionId: null },
    });

    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: {
        format: 'json',
        content: serializeFaqExport('json', [itemB]),
        mode: 'replace',
        dryRun: false,
      },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    const body = imported.json<{
      importBatchId: string;
      results: Array<{ documentId: string; jobId: string }>;
    }>();
    const stillThere = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
    });
    expect(stillThere.statusCode).toBe(200);

    const versionId = await finishFaqJob(
      body.results[0]?.documentId ?? '',
      '',
      body.results[0]?.jobId,
    );
    const wrongBatch = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/batch`,
      headers: { cookie },
      payload: {
        action: 'publish',
        items: [{ documentId: body.results[0]?.documentId, versionId, expectedVersionId: null }],
        importBatchId: 'kfib_wrong',
      },
    });
    expect(wrongBatch.statusCode, wrongBatch.body).toBe(409);
    expect((await detail(documentId)).document.currentVersionId).toBe(first.draftVersion?.id);

    const published = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/batch`,
      headers: { cookie },
      payload: {
        action: 'publish',
        items: [{ documentId: body.results[0]?.documentId, versionId, expectedVersionId: null }],
        importBatchId: body.importBatchId,
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    const old = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
    });
    expect(old.statusCode).toBe(404);
  });

  it('rejects 51 distinct questions on CRUD and fails the entire real import with zero writes', async () => {
    const baseId = await createBase();
    const over: KnowledgeFaqTransferEntry = {
      question: '超限问题',
      similarQuestions: Array.from({ length: 51 }, (_, index) => `相似问${index}`),
      negativeQuestions: [],
      answers: ['答案'],
      answerStrategy: 'all',
      isRecommended: true,
      enabled: true,
    };
    const rejected = await createFaq(baseId, over);
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const real = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: {
        format: 'json',
        content: JSON.stringify({ items: [itemA, over] }),
        mode: 'append',
        dryRun: false,
      },
    });
    expect(real.statusCode, real.body).toBe(200);
    expect(real.json()).toMatchObject({
      committed: false,
      counts: { total: 2, failed: 1 },
    });
    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
    const jobs = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from knowledge_jobs where base_id = $1',
      [baseId],
    );
    expect(jobs.rows[0]?.count).toBe(0);
  });

  it('applies the shared cleaning rules to FAQ create and update', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, {
      ...faqA,
      question: '密码重置',
      similarQuestions: ['忘记密码？', '忘記密碼'],
      negativeQuestions: ['密碼重置', '如何删除账号？'],
      answers: [' 甲 ', '甲', '乙', '   '],
    });
    expect(created.statusCode, created.body).toBe(202);
    const { documentId } = created.json<{ documentId: string }>();
    expect(created.json<{ issues?: Array<{ field: string; code: string }> }>().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'similarQuestions', code: 'DROPPED_DUPLICATE' }),
        expect.objectContaining({ field: 'negativeQuestions', code: 'DROPPED_OVERLAP' }),
        expect.objectContaining({ field: 'answers', code: 'DROPPED_DUPLICATE' }),
      ]),
    );
    const first = await detail(documentId);
    expect(first.draftVersion?.faq).toEqual({
      question: '密码重置',
      similarQuestions: ['忘记密码？'],
      negativeQuestions: ['如何删除账号？'],
      answers: ['甲', '乙'],
      answerStrategy: faqA.answerStrategy,
      isRecommended: faqA.isRecommended,
    });

    const updated = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: {
        faq: {
          ...faqA,
          question: '密碼重設',
          negativeQuestions: ['密码重设'],
          answers: ['丙', '丙'],
        },
        expectedVersionId: first.draftVersion?.id,
      },
    });
    expect(updated.statusCode, updated.body).toBe(202);
    const after = await detail(documentId);
    expect(after.draftVersion?.faq).toMatchObject({
      question: '密碼重設',
      negativeQuestions: [],
      answers: ['丙'],
    });
  });

  it('applies the same cleaning to over-limit arrays on create, update and JSON import', async () => {
    const repeatedSimilar = Array.from({ length: 51 }, () => '重复相似问');
    const overlappingNegatives = Array.from({ length: 51 }, () => '密码重置');
    const raw: KnowledgeFaqTransferEntry = {
      question: '密码重置',
      similarQuestions: ['  ', '忘记密码', ...repeatedSimilar],
      negativeQuestions: ['  ', ...overlappingNegatives],
      answers: ['  在设置页重置  ', '在设置页重置', '   '],
      answerStrategy: 'all',
      isRecommended: true,
      enabled: true,
    };
    const expected: KnowledgeFaq = {
      question: '密码重置',
      similarQuestions: ['忘记密码', '重复相似问'],
      negativeQuestions: [],
      answers: ['在设置页重置'],
      answerStrategy: 'all',
      isRecommended: true,
    };

    const crudBase = await createBase();
    const created = await createFaq(crudBase, raw);
    expect(created.statusCode, created.body).toBe(202);
    const { documentId } = created.json<{ documentId: string }>();
    expect(created.json<{ issues?: Array<{ field: string; code: string }> }>().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'similarQuestions', code: 'DROPPED_DUPLICATE' }),
        expect.objectContaining({ field: 'negativeQuestions', code: 'DROPPED_OVERLAP' }),
        expect.objectContaining({ field: 'answers', code: 'DROPPED_DUPLICATE' }),
      ]),
    );
    const first = await detail(documentId);
    expect(first.draftVersion?.faq).toEqual(expected);

    const updated = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: {
        faq: { ...raw, similarQuestions: [...raw.similarQuestions, '忘记密码'] },
        expectedVersionId: first.draftVersion?.id,
      },
    });
    expect(updated.statusCode, updated.body).toBe(202);
    expect((await detail(documentId)).draftVersion?.faq).toEqual(expected);

    const importBase = await createBase();
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${importBase}/faqs/import`,
      headers: { cookie },
      payload: {
        format: 'json',
        content: JSON.stringify({ items: [raw] }),
        mode: 'append',
        dryRun: false,
      },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    expect(imported.json()).toMatchObject({
      committed: true,
      counts: { total: 1, added: 1, failed: 0, partialFailed: 1 },
    });
    const [result] = imported.json<{ results: Array<{ documentId: string }> }>().results;
    expect((await detail(result?.documentId ?? '')).faq).toMatchObject(expected);
  });

  it('rejects genuinely non-string questions and answers at every entry', async () => {
    const baseId = await createBase();
    const created = await createFaq(baseId, itemA);
    expect(created.statusCode, created.body).toBe(202);
    const { documentId } = created.json<{ documentId: string }>();
    const draft = await detail(documentId);

    const badQuestion = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
      payload: { faq: { ...itemA, question: 123 } },
    });
    expect(badQuestion.statusCode, badQuestion.body).toBe(400);
    expect(badQuestion.json<{ code: string }>().code).toBe('INVALID_INPUT');

    const badAnswer = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: {
        faq: { ...itemA, answers: ['ok', 5] },
        expectedVersionId: draft.draftVersion?.id,
      },
    });
    expect(badAnswer.statusCode, badAnswer.body).toBe(400);
    expect((await detail(documentId)).draftVersion?.faq).toEqual(faqA);

    const importBase = await createBase();
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${importBase}/faqs/import`,
      headers: { cookie },
      payload: {
        format: 'json',
        content: JSON.stringify({
          items: [
            { ...itemA, question: 123 },
            { ...itemA, answers: ['ok', 5] },
          ],
        }),
        mode: 'append',
        dryRun: false,
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({
      committed: false,
      counts: { total: 2, failed: 2 },
    });
    const list = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${importBase}/faqs`,
      headers: { cookie },
    });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('uses document status for published import entries in export and append dedupe', async () => {
    const baseId = await createBase();
    const content = serializeFaqExport('json', [itemA]);
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: false },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    const body = imported.json<{
      importBatchId: string;
      results: Array<{ documentId: string; jobId: string }>;
    }>();
    const [result] = body.results;
    const versionId = await finishFaqJob(result?.documentId ?? '', '', result?.jobId);
    const published = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/batch`,
      headers: { cookie },
      payload: {
        action: 'publish',
        importBatchId: body.importBatchId,
        items: [{ documentId: result?.documentId, versionId, expectedVersionId: null }],
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    const disabled = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/faqs/${result?.documentId}/status`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    // 模拟发布路径只改指针、没把 metadata 改成 published 的情况：仍以真实指针为准。
    await app.pool.query(
      `update knowledge_document_versions set metadata = metadata || '{"publication":"draft"}'::jsonb where id = $1`,
      [versionId],
    );

    for (const version of ['published', 'draft']) {
      const exported = await inject(app, {
        method: 'GET',
        url: `/api/knowledge/bases/${baseId}/faqs/export?format=json&version=${version}`,
        headers: { cookie },
      });
      expect(exported.statusCode, exported.body).toBe(200);
      expect(JSON.parse(exported.body).items).toEqual([{ ...itemA, enabled: false }]);
    }

    const again = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'json', content, mode: 'append', dryRun: true },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      counts: { total: 1, merged: 1, skipped: 0, failed: 0 },
    });
  });

  it('supports xlsx import through the same route', async () => {
    const baseId = await createBase();
    const { Workbook } = await import('exceljs');
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('FAQ');
    sheet.addRow([
      'question',
      'similarQuestions',
      'negativeQuestions',
      'answers',
      'answerStrategy',
      'isRecommended',
      'enabled',
    ]);
    sheet.addRow([
      itemB.question,
      '[]',
      '[]',
      JSON.stringify(itemB.answers),
      'random',
      'false',
      'true',
    ]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: { format: 'xlsx', content, mode: 'append', dryRun: true },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({ counts: { total: 1, success: 1, added: 1 } });
  });
});
