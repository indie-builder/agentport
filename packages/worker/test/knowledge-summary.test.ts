import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runKnowledgeSummary, type SummaryQueryFn } from '../src/knowledge/summary.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

let knowledgeDir = '';
const baseIds: string[] = [];
const profileIds: string[] = [];
const serverIds: string[] = [];

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-summary-'));
});

afterEach(async () => {
  if (baseIds.length > 0) {
    await dbHandle.client.unsafe('delete from knowledge_bases where id = any($1::text[])', [
      dbHandle.client.array(baseIds, 'TEXT'),
    ]);
    baseIds.length = 0;
  }
  if (profileIds.length > 0) {
    await dbHandle.client.unsafe(
      'delete from knowledge_model_profiles where id = any($1::text[])',
      [dbHandle.client.array(profileIds, 'TEXT')],
    );
    profileIds.length = 0;
  }
  if (serverIds.length > 0) {
    await dbHandle.client.unsafe('delete from servers where id = any($1::text[])', [
      dbHandle.client.array(serverIds, 'TEXT'),
    ]);
    serverIds.length = 0;
  }
  await rm(knowledgeDir, { recursive: true, force: true });
});

afterAll(async () => {
  await dbHandle.client.close();
});

const suffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Captured = { prompt: string; options: Options };

function successQuery(result: string, captured: Captured[]): SummaryQueryFn {
  return ({ prompt, options }) => {
    captured.push({ prompt, options });
    return (async function* (): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result,
      } as unknown as SDKMessage;
    })();
  };
}

function failureQuery(message: string): SummaryQueryFn {
  return () =>
    (async function* (): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [message],
        result: '',
      } as unknown as SDKMessage;
    })();
}

async function makeDocument(
  content: string,
): Promise<{ documentId: string; versionId: string; profileId: string }> {
  const id = suffix();
  const serverId = newId('server');
  await db
    .insert(schema.servers)
    .values({ id: serverId, name: `kb-summary-${id}`, kind: 'knowledge', config: {} });
  serverIds.push(serverId);
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-summary-${id}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  profileIds.push(profileId);
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-summary-${id}`,
    name: `kb summary ${id}`,
    description: '',
    serverId,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 400, chunkOverlap: 40 },
  });
  baseIds.push(base.id);
  const document = await repo.knowledge.createDocument(db, {
    baseId: base.id,
    folderId: null,
    title: 'summary.md',
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'text/markdown',
    sizeBytes: content.length,
  });
  const version = await repo.knowledge.createVersion(db, {
    documentId: document.id,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: 'summary.md',
    mimeType: 'text/markdown',
    sizeBytes: content.length,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: profileId,
  });
  await repo.knowledge.setCurrentVersion(db, document.id, version.id);
  await repo.knowledge.insertChunks(db, {
    baseId: base.id,
    documentId: document.id,
    versionId: version.id,
    folderId: null,
    chunks: [
      {
        ordinal: 0,
        kind: 'text',
        heading: null,
        content,
        searchText: content,
        embedding: null,
        pageFrom: null,
        pageTo: null,
        tokenCount: 10,
      },
    ],
  });
  return { documentId: document.id, versionId: version.id, profileId };
}

async function startSummaryJob(documentId: string) {
  const document = await repo.knowledge.getDocument(db, documentId);
  if (!document) throw new Error('document missing');
  const job = await repo.knowledge.createJob(db, {
    type: 'summary',
    baseId: document.baseId,
    documentId,
    sourceId: null,
    payload: { type: 'summary', baseId: document.baseId, documentId },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return claimed;
}

function deps(queryFn?: SummaryQueryFn) {
  return {
    db,
    config: { KNOWLEDGE_DIR: knowledgeDir, KNOWLEDGE_SUMMARY_MODEL: 'summary-test-model' },
    signal: new AbortController().signal,
    ...(queryFn === undefined ? {} : { queryFn }),
  };
}

describe('runKnowledgeSummary', () => {
  it('writes the SDK summary back as ready for the summarized version', async () => {
    const seeded = await makeDocument('第一段正文。\n\n第二段正文。');
    const captured: Captured[] = [];

    await runKnowledgeSummary(
      await startSummaryJob(seeded.documentId),
      deps(successQuery('  这是摘要。 ', captured)),
    );

    const row = await repo.knowledge.getDocument(db, seeded.documentId);
    expect(row?.summary).toBe('这是摘要。');
    expect(row?.summaryStatus).toBe('ready');
    expect(row?.summaryVersionId).toBe(seeded.versionId);
    expect(row?.summaryGeneratedAt).toBeInstanceOf(Date);
    expect(row?.summaryError).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toMatchObject({
      model: 'summary-test-model',
      tools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.2,
    });
    expect(captured[0]?.prompt).toContain('第一段正文。');
    expect(captured[0]?.prompt).toContain('200 字');
  });

  it('writes failed and the error back when the SDK fails', async () => {
    const seeded = await makeDocument('正文。');

    await expect(
      runKnowledgeSummary(
        await startSummaryJob(seeded.documentId),
        deps(failureQuery('模型调用失败')),
      ),
    ).rejects.toThrow('模型调用失败');

    const row = await repo.knowledge.getDocument(db, seeded.documentId);
    expect(row?.summaryStatus).toBe('failed');
    expect(row?.summaryVersionId).toBe(seeded.versionId);
    expect(row?.summaryError).toContain('模型调用失败');
  });

  it('marks the document failed when the summary model is not configured', async () => {
    const seeded = await makeDocument('正文。');

    await expect(
      runKnowledgeSummary(await startSummaryJob(seeded.documentId), {
        db,
        config: { KNOWLEDGE_DIR: knowledgeDir },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('摘要模型未配置');

    const row = await repo.knowledge.getDocument(db, seeded.documentId);
    expect(row?.summaryStatus).toBe('failed');
    expect(row?.summaryError).toContain('KNOWLEDGE_SUMMARY_MODEL');
  });

  it('binds the summary to the generated version when a newer version becomes current', async () => {
    const seeded = await makeDocument('旧版本正文。');
    await runKnowledgeSummary(
      await startSummaryJob(seeded.documentId),
      deps(successQuery('旧版本摘要', [])),
    );
    const document = await repo.knowledge.getDocument(db, seeded.documentId);
    if (!document) throw new Error('document missing');
    const next = await repo.knowledge.createVersion(db, {
      documentId: document.id,
      blobSha256: 'c'.repeat(64),
      markdownSha256: 'd'.repeat(64),
      originalFilename: 'summary.md',
      mimeType: 'text/markdown',
      sizeBytes: 6,
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: seeded.profileId,
    });
    await repo.knowledge.setCurrentVersion(db, document.id, next.id);

    const row = await repo.knowledge.getDocument(db, seeded.documentId);
    expect(row?.currentVersionId).toBe(next.id);
    expect(row?.summaryVersionId).toBe(seeded.versionId);
    expect(row?.summaryVersionId).not.toBe(row?.currentVersionId);
  });
});
