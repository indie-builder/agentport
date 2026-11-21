import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runKnowledgeTagging, type TaggingQueryFn } from '../src/knowledge/tagging.js';

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;

let knowledgeDir = '';
const baseIds: string[] = [];
const profileIds: string[] = [];
const serverIds: string[] = [];

beforeEach(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-tagging-'));
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

function successQuery(result: string, captured: Captured[] = []): TaggingQueryFn {
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

async function makeDocument(
  content: string,
): Promise<{ baseId: string; documentId: string; versionId: string; profileId: string }> {
  const id = suffix();
  const serverId = newId('server');
  await db
    .insert(schema.servers)
    .values({ id: serverId, name: `kb-tagging-${id}`, kind: 'knowledge', config: {} });
  serverIds.push(serverId);
  const profileId = newId('knowledgeModelProfile');
  await db.insert(schema.knowledgeModelProfiles).values({
    id: profileId,
    kind: 'embedding',
    name: `emb-tagging-${id}`,
    endpointUrl: 'http://127.0.0.1:1',
    model: 'test',
    dimensions: 1024,
    enabled: true,
  });
  profileIds.push(profileId);
  const base = await repo.knowledge.createBase(db, {
    slug: `kb-tagging-${id}`,
    name: `kb tagging ${id}`,
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
    title: 'tagging.md',
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
    originalFilename: 'tagging.md',
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
  return { baseId: base.id, documentId: document.id, versionId: version.id, profileId };
}

async function startTagJob(documentId: string) {
  const document = await repo.knowledge.getDocument(db, documentId);
  if (!document) throw new Error('document missing');
  const job = await repo.knowledge.createJob(db, {
    type: 'tag_generate',
    baseId: document.baseId,
    documentId,
    sourceId: null,
    payload: { type: 'tag_generate', baseId: document.baseId, documentId },
  });
  const claimed = await repo.knowledge.claimJob(db, job.id);
  if (!claimed) throw new Error('job not claimed');
  return claimed;
}

function deps(queryFn: TaggingQueryFn) {
  return {
    db,
    config: { KNOWLEDGE_DIR: knowledgeDir, KNOWLEDGE_SUMMARY_MODEL: 'tagging-test-model' },
    signal: new AbortController().signal,
    queryFn,
  };
}

describe('runKnowledgeTagging', () => {
  it('writes auto tags, keeps manual tags, and replaces previous auto tags', async () => {
    const seeded = await makeDocument('第一段正文。\n\n第二段正文。');
    const [manual] = await repo.knowledge.upsertTags(db, seeded.baseId, ['人工标签']);
    await repo.knowledge.setDocumentTags(db, seeded.documentId, [manual.id]);

    const captured: Captured[] = [];
    await runKnowledgeTagging(
      await startTagJob(seeded.documentId),
      deps(successQuery('```json\n["自动一","自动二","人工标签"]\n```', captured)),
    );

    const generated = await repo.knowledge.getDocumentTagRows(db, seeded.documentId);
    expect(generated).toHaveLength(3);
    const generatedByName = new Map(generated.map((row) => [row.name, row.origin]));
    expect(generatedByName.get('人工标签')).toBe('manual');
    expect(generatedByName.get('自动一')).toBe('auto');
    expect(generatedByName.get('自动二')).toBe('auto');

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toMatchObject({
      model: 'tagging-test-model',
      tools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.1,
    });
    expect(captured[0]?.prompt).toContain('第一段正文。');
    expect(captured[0]?.prompt).toContain('3-8');

    await runKnowledgeTagging(
      await startTagJob(seeded.documentId),
      deps(successQuery('["自动三"]')),
    );

    const regenerated = await repo.knowledge.getDocumentTagRows(db, seeded.documentId);
    expect(regenerated).toHaveLength(2);
    const regeneratedByName = new Map(regenerated.map((row) => [row.name, row.origin]));
    expect(regeneratedByName.get('人工标签')).toBe('manual');
    expect(regeneratedByName.get('自动三')).toBe('auto');
    expect(regeneratedByName.has('自动一')).toBe(false);
    expect(regeneratedByName.has('自动二')).toBe(false);
  });

  it('throws and leaves tags unchanged when the SDK returns invalid JSON', async () => {
    const seeded = await makeDocument('正文。');
    const [manual] = await repo.knowledge.upsertTags(db, seeded.baseId, ['人工标签']);
    await repo.knowledge.setDocumentTags(db, seeded.documentId, [manual.id]);
    await runKnowledgeTagging(
      await startTagJob(seeded.documentId),
      deps(successQuery('["旧自动"]')),
    );
    const before = await repo.knowledge.getDocumentTagRows(db, seeded.documentId);
    expect(before).toHaveLength(2);

    await expect(
      runKnowledgeTagging(await startTagJob(seeded.documentId), deps(successQuery('不是 JSON'))),
    ).rejects.toThrow();

    expect(await repo.knowledge.getDocumentTagRows(db, seeded.documentId)).toEqual(before);
  });
});
