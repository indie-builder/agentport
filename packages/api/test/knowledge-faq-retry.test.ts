import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, repo } from '@agentport/db';
import type {
  KnowledgeFaq,
  KnowledgeFaqTransferEntry,
  KnowledgeJobPayload,
} from '@agentport/shared';
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
  question: 'How do I reset the workspace credential?',
  similarQuestions: ['forgot my workspace key'],
  negativeQuestions: ['delete the workspace'],
  answers: ['Open settings and reset.'],
  answerStrategy: 'all',
  isRecommended: true,
};

const importedFaq: KnowledgeFaqTransferEntry = {
  question: 'What address reaches support?',
  similarQuestions: [],
  negativeQuestions: [],
  answers: ['support@example.com'],
  answerStrategy: 'all',
  isRecommended: false,
  enabled: true,
};

const otherImportedFaq: KnowledgeFaqTransferEntry = {
  question: 'Where is the billing portal?',
  similarQuestions: [],
  negativeQuestions: [],
  answers: ['https://billing.example.com'],
  answerStrategy: 'all',
  isRecommended: false,
  enabled: true,
};

interface FaqDetail {
  document: { id: string; status: string; currentVersionId: string | null };
  draftVersion: { id: string; metadata: Record<string, unknown> } | null;
  publishedVersion: { id: string; metadata: Record<string, unknown> } | null;
}

interface ImportResult {
  importBatchId: string;
  results: Array<{
    documentId?: string;
    jobId?: string;
    expectedVersionId?: string | null;
  }>;
}

describe.skipIf(!ready)('knowledge FAQ job retry', () => {
  let app: FastifyInstance;
  let cookie = '';
  let knowledgeDir = '';
  const baseIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-faq-retry-'));
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

  async function createBase(): Promise<string> {
    const profile = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'embedding',
        name: unique('retry-emb'),
        endpointUrl: 'http://127.0.0.1:1/embeddings',
        model: 'test',
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const profileId = profile.json<{ id: string }>().id;
    profileIds.push(profileId);

    const base = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/bases',
      headers: { cookie },
      payload: { slug: unique('retry-kb'), name: '重试知识库', embeddingProfileId: profileId },
    });
    expect(base.statusCode, base.body).toBe(201);
    const baseId = base.json<{ id: string }>().id;
    baseIds.push(baseId);
    return baseId;
  }

  async function createFaq(baseId: string, payload: KnowledgeFaq = faq) {
    const res = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs`,
      headers: { cookie },
      payload: { faq: payload },
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ documentId: string; jobId: string }>();
  }

  async function detail(documentId: string): Promise<FaqDetail> {
    const res = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FaqDetail>();
  }

  async function jobPayload(jobId: string): Promise<KnowledgeJobPayload> {
    const job = await repo.knowledge.getJob(app.db, jobId);
    if (!job) throw new Error(`job ${jobId} missing`);
    return job.payload;
  }

  /** 用真实终态入口收尾：先认领再按给定的合法终态结束，不直接改状态列。 */
  async function settleJob(jobId: string, status: 'failed' | 'succeeded') {
    const claimed = await repo.knowledge.claimJob(app.db, jobId);
    if (!claimed) throw new Error(`job ${jobId} is not queued`);
    const finished = await repo.knowledge.finishJob(app.db, jobId, { status });
    if (!finished) throw new Error(`job ${jobId} finish was refused`);
  }

  /** 模拟 worker 合法完成：写入索引块后把重试任务标成功。 */
  async function completeJob(jobId: string, documentId: string, versionId: string) {
    const claimed = await repo.knowledge.claimJob(app.db, jobId);
    if (!claimed) throw new Error(`job ${jobId} is not queued`);
    await app.pool.query(
      `insert into knowledge_chunks
         (id, base_id, document_id, version_id, ordinal, kind, content, search_text, metadata)
       values ($1, $2, $3, $4, 0, 'text', $5, $5, '{}'::jsonb)`,
      [newId('knowledgeChunk'), claimed.baseId, documentId, versionId, faq.question],
    );
    const finished = await repo.knowledge.finishJob(app.db, jobId, { status: 'succeeded' });
    if (!finished) throw new Error(`job ${jobId} finish was refused`);
  }

  async function retry(jobId: string) {
    return inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${jobId}/retry`,
      headers: { cookie },
    });
  }

  async function publish(documentId: string, versionId: string, expectedVersionId: string | null) {
    return inject(app, {
      method: 'POST',
      url: `/api/knowledge/faqs/${documentId}/publish`,
      headers: { cookie },
      payload: { versionId, expectedVersionId },
    });
  }

  it('retries a failed draft job into the same version and publishes only after that job succeeds', async () => {
    const baseId = await createBase();
    const { documentId, jobId } = await createFaq(baseId);
    const draft = await detail(documentId);
    const versionId = draft.draftVersion?.id;
    if (!versionId) throw new Error('FAQ draft missing');
    const originalPayload = await jobPayload(jobId);

    expect((await publish(documentId, versionId, null)).statusCode).toBe(409);
    await settleJob(jobId, 'failed');
    expect((await publish(documentId, versionId, null)).statusCode).toBe(409);

    await app.pool.query(
      `update knowledge_document_versions
         set metadata = metadata || '{"retryMarker":"keep"}'::jsonb
       where id = $1`,
      [versionId],
    );

    const retried = await retry(jobId);
    expect(retried.statusCode, retried.body).toBe(202);
    const retryJobId = retried.json<{ jobId: string }>().jobId;
    expect(retryJobId).not.toBe(jobId);
    expect(await jobPayload(retryJobId)).toEqual(originalPayload);

    const bound = await repo.knowledge.getVersion(app.db, versionId);
    expect(bound?.metadata).toMatchObject({
      publication: 'draft',
      indexingJobId: retryJobId,
      retryMarker: 'keep',
    });

    // 新任务还没成功时仍拒绝发布，不能因为换绑就放行。
    expect((await publish(documentId, versionId, null)).statusCode).toBe(409);

    await completeJob(retryJobId, documentId, versionId);

    const published = await publish(documentId, versionId, null);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ currentVersionId: string | null }>().currentVersionId).toBe(versionId);
    expect((await detail(documentId)).document.currentVersionId).toBe(versionId);
  });

  it('retries a cancelled draft job and rebinds the draft to the new job', async () => {
    const baseId = await createBase();
    const { documentId, jobId } = await createFaq(baseId);
    const versionId = (await detail(documentId)).draftVersion?.id;
    if (!versionId) throw new Error('FAQ draft missing');

    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${jobId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const retried = await retry(jobId);
    expect(retried.statusCode, retried.body).toBe(202);
    const retryJobId = retried.json<{ jobId: string }>().jobId;

    const bound = await repo.knowledge.getVersion(app.db, versionId);
    expect(bound?.metadata).toMatchObject({ publication: 'draft', indexingJobId: retryJobId });

    await completeJob(retryJobId, documentId, versionId);
    const published = await publish(documentId, versionId, null);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ currentVersionId: string | null }>().currentVersionId).toBe(versionId);
  });

  it('leaves published FAQ history out of the retry rebinding', async () => {
    const baseId = await createBase();
    const { documentId, jobId } = await createFaq(baseId);
    const firstDraft = (await detail(documentId)).draftVersion?.id;
    if (!firstDraft) throw new Error('first FAQ draft missing');
    await completeJob(jobId, documentId, firstDraft);
    const firstPublish = await publish(documentId, firstDraft, null);
    expect(firstPublish.statusCode, firstPublish.body).toBe(200);
    const publishedMetadata = (await repo.knowledge.getVersion(app.db, firstDraft))?.metadata;

    const updated = await inject(app, {
      method: 'PUT',
      url: `/api/knowledge/faqs/${documentId}`,
      headers: { cookie },
      payload: {
        faq: { ...faq, answers: ['Open settings and reset.', 'Ask an admin.'] },
        expectedVersionId: firstDraft,
      },
    });
    expect(updated.statusCode, updated.body).toBe(202);
    const updateJobId = updated.json<{ jobId: string }>().jobId;
    const secondDraft = (await detail(documentId)).draftVersion?.id;
    if (!secondDraft) throw new Error('second FAQ draft missing');
    await settleJob(updateJobId, 'failed');

    const retried = await retry(updateJobId);
    expect(retried.statusCode, retried.body).toBe(202);
    const retryJobId = retried.json<{ jobId: string }>().jobId;

    expect((await repo.knowledge.getVersion(app.db, secondDraft))?.metadata).toMatchObject({
      publication: 'draft',
      indexingJobId: retryJobId,
    });
    expect((await repo.knowledge.getVersion(app.db, firstDraft))?.metadata).toEqual(
      publishedMetadata,
    );
  });

  it('retries failed and cancelled FAQ import drafts and persists the new job id', async () => {
    const baseId = await createBase();
    const imported = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${baseId}/faqs/import`,
      headers: { cookie },
      payload: {
        format: 'json',
        content: JSON.stringify({ items: [importedFaq, otherImportedFaq] }),
        mode: 'append',
        dryRun: false,
      },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    const batch = imported.json<ImportResult>();
    const [failedEntry, cancelledEntry] = batch.results;
    if (
      !failedEntry?.documentId ||
      !failedEntry.jobId ||
      !cancelledEntry?.documentId ||
      !cancelledEntry.jobId
    ) {
      throw new Error('imported FAQ drafts missing');
    }
    const failedDetail = await detail(failedEntry.documentId);
    const cancelledDetail = await detail(cancelledEntry.documentId);
    const failedVersionId = failedDetail.draftVersion?.id;
    const cancelledVersionId = cancelledDetail.draftVersion?.id;
    if (!failedVersionId || !cancelledVersionId || !failedDetail.draftVersion) {
      throw new Error('imported FAQ versions missing');
    }
    const failedImport = failedDetail.draftVersion.metadata.faqImport;
    const cancelledImport = cancelledDetail.draftVersion?.metadata.faqImport;
    expect(failedImport).toBeDefined();
    expect(cancelledImport).toBeDefined();
    const importPayload = await jobPayload(failedEntry.jobId);
    expect(importPayload).toMatchObject({ type: 'ingest', versionId: failedVersionId });

    // 其它 metadata 不能被重试覆盖。
    await app.pool.query(
      `update knowledge_document_versions
         set metadata = metadata || '{"retryMarker":"keep"}'::jsonb
       where id = $1`,
      [failedVersionId],
    );

    await settleJob(failedEntry.jobId, 'failed');
    const cancelled = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/jobs/${cancelledEntry.jobId}/cancel`,
      headers: { cookie },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const failedRetry = await retry(failedEntry.jobId);
    expect(failedRetry.statusCode, failedRetry.body).toBe(202);
    const failedRetryJobId = failedRetry.json<{ jobId: string }>().jobId;
    const cancelledRetry = await retry(cancelledEntry.jobId);
    expect(cancelledRetry.statusCode, cancelledRetry.body).toBe(202);
    const cancelledRetryJobId = cancelledRetry.json<{ jobId: string }>().jobId;
    expect(failedRetryJobId).not.toBe(failedEntry.jobId);
    expect(cancelledRetryJobId).not.toBe(cancelledEntry.jobId);
    // 重试只换任务 ID 与草稿绑定，原 payload/version/input 原样复用。
    expect(await jobPayload(failedRetryJobId)).toEqual(importPayload);

    // 关闭再打开时组件只读详情；新 jobId 必须已持久化在草稿 metadata。
    const failedAfter = (await detail(failedEntry.documentId)).draftVersion;
    expect(failedAfter?.metadata).toMatchObject({
      publication: 'draft',
      faqImportJobId: failedRetryJobId,
      retryMarker: 'keep',
    });
    expect(failedAfter?.metadata.faqImport).toEqual(failedImport);
    expect(failedAfter?.metadata.indexingJobId).toBeUndefined();
    const cancelledAfter = (await detail(cancelledEntry.documentId)).draftVersion;
    expect(cancelledAfter?.metadata).toMatchObject({
      publication: 'draft',
      faqImportJobId: cancelledRetryJobId,
    });
    expect(cancelledAfter?.metadata.faqImport).toEqual(cancelledImport);
    expect(cancelledAfter?.metadata.indexingJobId).toBeUndefined();

    const batchPayload = {
      action: 'publish',
      importBatchId: batch.importBatchId,
      items: [
        {
          documentId: failedEntry.documentId,
          versionId: failedVersionId,
          expectedVersionId: failedEntry.expectedVersionId ?? null,
        },
        {
          documentId: cancelledEntry.documentId,
          versionId: cancelledVersionId,
          expectedVersionId: cancelledEntry.expectedVersionId ?? null,
        },
      ],
    };
    const publishBatch = () =>
      inject(app, {
        method: 'POST',
        url: `/api/knowledge/bases/${baseId}/faqs/batch`,
        headers: { cookie },
        payload: batchPayload,
      });

    // 新任务还没成功时整批发布仍拒绝，不能因为换绑就放行。
    const refused = await publishBatch();
    expect(refused.statusCode, refused.body).toBe(409);

    await completeJob(failedRetryJobId, failedEntry.documentId, failedVersionId);
    await completeJob(cancelledRetryJobId, cancelledEntry.documentId, cancelledVersionId);

    // 成功后再读详情，仍是持久化的重试任务 ID。
    expect((await detail(failedEntry.documentId)).draftVersion?.metadata.faqImportJobId).toBe(
      failedRetryJobId,
    );

    const published = await publishBatch();
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ results: Array<{ status: string }> }>().results).toHaveLength(2);
    const publishedFailed = await detail(failedEntry.documentId);
    expect(publishedFailed.document.currentVersionId).toBe(failedVersionId);
    expect(publishedFailed.publishedVersion?.metadata.faqImportJobId).toBe(failedRetryJobId);
    expect(publishedFailed.publishedVersion?.metadata.faqImport).toEqual(failedImport);
    expect((await detail(cancelledEntry.documentId)).document.currentVersionId).toBe(
      cancelledVersionId,
    );
  });
});
