import { randomBytes } from 'node:crypto';
import {
  type KnowledgeFaq,
  type KnowledgeLocator,
  knowledgeBaseSettingsSchema,
} from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/client.js';
import { newId } from '../src/id.js';
import * as knowledge from '../src/repo/knowledge.js';
import * as servers from '../src/repo/servers.js';
import { schema } from '../src/schema.js';

const { db, pool } = createDb(process.env.DATABASE_URL ?? '');
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const baseIds: string[] = [];
const profileIds: string[] = [];
const serverIds: string[] = [];
let profileId = '';

afterEach(async () => {
  if (baseIds.length > 0) {
    await pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    baseIds.length = 0;
  }
  if (profileIds.length > 0) {
    await pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
      profileIds,
    ]);
    profileIds.length = 0;
  }
  if (serverIds.length > 0) {
    await pool.query('delete from servers where id = any($1::text[])', [serverIds]);
    serverIds.length = 0;
  }
  profileId = '';
});

afterAll(async () => {
  await pool.end();
});

const suffix = () => randomBytes(6).toString('hex');

function pgCode(error: unknown): string | undefined {
  const direct = (error as { code?: string }).code;
  if (direct) return direct;
  return (error as { cause?: { code?: string } }).cause?.code;
}

async function createAsrProfile(
  overrides: Partial<knowledge.CreateModelProfileInput> = {},
): Promise<knowledge.KnowledgeModelProfileRow> {
  const profile = await knowledge.createModelProfile(db, {
    kind: 'asr',
    name: `asr-${suffix()}`,
    endpointUrl: 'http://127.0.0.1:1/v1/audio/transcriptions',
    model: 'whisper-1',
    dimensions: null,
    secretsEncrypted: null,
    enabled: true,
    ...overrides,
  });
  profileIds.push(profile.id);
  return profile;
}

async function seedBase(): Promise<string> {
  const id = suffix();
  if (!profileId) {
    const profile = await knowledge.createModelProfile(db, {
      kind: 'embedding',
      name: `foundation-${id}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'test',
      dimensions: 1024,
      secretsEncrypted: null,
      enabled: true,
    });
    profileId = profile.id;
    profileIds.push(profile.id);
  }
  const server = await servers.createServer(db, {
    name: `foundation-${id}`,
    kind: 'knowledge' as never,
    description: '',
    config: {},
    secretsEncrypted: null,
  });
  serverIds.push(server.id);
  const base = await knowledge.createBase(db, {
    slug: `foundation-${id}`,
    name: 'Foundation',
    description: '',
    serverId: server.id,
    embeddingProfileId: profileId,
    rerankProfileId: null,
    settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
  });
  baseIds.push(base.id);
  return base.id;
}

interface RangeSeed {
  kind: 'gitlab_project';
  externalId: string;
  ref?: string | null;
  paths?: string[];
  enabled?: boolean;
}

async function seedSource(
  baseId: string,
  ranges: RangeSeed[],
  status: knowledge.KnowledgeSourceRow['status'] = 'active',
) {
  const source = await knowledge.createSource(db, {
    baseId,
    type: 'gitlab',
    name: `source-${suffix()}`,
    config: {},
    secretsEncrypted: null,
    syncCron: null,
  });
  if (status !== 'active') {
    await knowledge.updateSource(db, source.id, { status });
  }
  const rows = await knowledge.replaceRanges(
    db,
    source.id,
    ranges.map((range) => ({
      kind: range.kind,
      externalId: range.externalId,
      ref: range.ref ?? null,
      paths: range.paths ?? [],
      enabled: range.enabled ?? true,
    })),
  );
  return { source, ranges: rows };
}

async function snapshotFor(sourceId: string): Promise<knowledge.SourceReadSnapshot> {
  const result = await knowledge.getSourceReadSnapshot(db, sourceId);
  if (!result) throw new Error('source missing');
  return result.snapshot;
}

async function attachSourceRanges(
  document: knowledge.KnowledgeDocumentRow,
  sourceId: string,
  rangeIds: string[],
): Promise<knowledge.KnowledgeDocumentRow | null> {
  return knowledge.setDocumentSourceRanges(db, document.id, rangeIds, await snapshotFor(sourceId), {
    title: document.title,
    sourceUrl: document.sourceUrl,
    sourcePath: document.sourcePath,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    metadata: document.metadata,
  });
}

function versionInput(
  documentId: string,
  overrides: Partial<knowledge.CreateVersionInput> = {},
): knowledge.CreateVersionInput {
  return {
    documentId,
    blobSha256: 'a'.repeat(64),
    markdownSha256: 'b'.repeat(64),
    originalFilename: 'doc.md',
    mimeType: 'text/markdown',
    sizeBytes: 10,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: profileId,
    ...overrides,
  };
}

function preparedVersion(
  overrides: Partial<knowledge.EditDocumentChunksInput['preparedVersion']> = {},
): knowledge.EditDocumentChunksInput['preparedVersion'] {
  return {
    id: newId('knowledgeVersion'),
    blobSha256: 'c'.repeat(64),
    markdownSha256: 'd'.repeat(64),
    originalFilename: 'edit.md',
    mimeType: 'text/markdown',
    sizeBytes: 10,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
    embeddingProfileId: profileId,
    ...overrides,
  };
}

function faqDraftVersion(): knowledge.FaqImportDraftInput['version'] {
  return {
    id: newId('knowledgeVersion'),
    blobSha256: 'e'.repeat(64),
    markdownSha256: 'f'.repeat(64),
    originalFilename: 'faq.json',
    mimeType: 'application/json',
    sizeBytes: 10,
    sourceRevision: null,
    parseStatus: 'parsed',
    pageMap: [],
    images: [],
  };
}

async function finishFaqJob(jobId: string): Promise<void> {
  await knowledge.claimJob(db, jobId);
  await knowledge.finishJob(db, jobId, { status: 'succeeded' });
}

/** 生产草稿由 draft ingest 任务建版本；测试也走真实任务，不伪造空关联。 */
async function draftVersionWithJob(
  baseId: string,
  document: knowledge.KnowledgeDocumentRow,
  options: {
    parentVersionId?: string | null;
    jobStatus?: 'succeeded' | 'cancelled';
    jobDocumentId?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<{ version: knowledge.KnowledgeVersionRow; job: knowledge.KnowledgeJobRow }> {
  const parentVersionId = options.parentVersionId ?? null;
  const jobDocumentId = options.jobDocumentId ?? document.id;
  const job = await knowledge.createJob(db, {
    type: 'ingest',
    baseId,
    documentId: jobDocumentId,
    sourceId: null,
    payload: {
      type: 'ingest',
      documentId: jobDocumentId,
      publish: 'draft',
      input: {
        blobSha256: '1'.repeat(64),
        filename: 'draft.md',
        mimeType: 'text/markdown',
        expectedCurrentVersionId: parentVersionId,
      },
    },
  });
  await knowledge.claimJob(db, job.id);
  await knowledge.finishJob(db, job.id, { status: options.jobStatus ?? 'succeeded' });
  const version = await knowledge.createVersion(
    db,
    versionInput(document.id, {
      blobSha256: '1'.repeat(64),
      originalFilename: 'draft.md',
      mimeType: 'text/markdown',
      parentVersionId,
      metadata: {
        publication: 'draft',
        indexingJobId: job.id,
        ...(options.metadata ?? {}),
      },
    }),
  );
  return { version, job };
}

interface ChunkSeed {
  content: string;
  kind?: 'text' | 'table' | 'image';
  heading?: string | null;
  pageFrom?: number | null;
  pageTo?: number | null;
  locator?: KnowledgeLocator | null;
  parentOrdinal?: number | null;
  indexRole?: 'leaf' | 'parent';
}

interface SeedDocumentOptions {
  sourceType?: knowledge.KnowledgeDocumentRow['sourceType'];
  sourceId?: string | null;
  sourcePath?: string | null;
  sourceConnectionId?: string | null;
  contentKind?: knowledge.KnowledgeDocumentRow['contentKind'];
  chunks?: ChunkSeed[];
  faq?: KnowledgeFaq | null;
  origin?: knowledge.KnowledgeVersionRow['origin'];
  metadata?: Record<string, unknown>;
}

async function seedDocument(
  baseId: string,
  options: SeedDocumentOptions = {},
): Promise<{
  document: knowledge.KnowledgeDocumentRow;
  version: knowledge.KnowledgeVersionRow;
  chunks: knowledge.KnowledgeChunkRow[];
}> {
  const document = await knowledge.createDocument(db, {
    baseId,
    folderId: null,
    title: `doc-${suffix()}`,
    sourceType: options.sourceType ?? 'manual',
    sourceId: options.sourceId ?? null,
    sourceUrl: null,
    sourcePath: options.sourcePath ?? null,
    sourceConnectionId: options.sourceConnectionId ?? null,
    contentKind: options.contentKind,
    mimeType: 'text/markdown',
    sizeBytes: 10,
  });
  const version = await knowledge.createVersion(
    db,
    versionInput(document.id, {
      ...(options.faq === undefined ? {} : { faq: options.faq }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    }),
  );
  const chunks = await knowledge.insertChunks(db, {
    baseId,
    documentId: document.id,
    versionId: version.id,
    folderId: null,
    chunks: (options.chunks ?? [{ content: `body ${suffix()}` }]).map((chunk, ordinal) => ({
      ordinal,
      kind: chunk.kind ?? 'text',
      heading: chunk.heading ?? null,
      content: chunk.content,
      searchText: chunk.content,
      embedding: null,
      pageFrom: chunk.pageFrom ?? null,
      pageTo: chunk.pageTo ?? null,
      locator: chunk.locator ?? null,
      parentOrdinal: chunk.parentOrdinal ?? null,
      indexRole: chunk.indexRole ?? 'leaf',
      tokenCount: 1,
    })),
  });
  const published = await knowledge.setCurrentVersion(db, document.id, version.id);
  return { document: published ?? document, version, chunks };
}

async function linkWikiSource(pageId: string, chunk: knowledge.KnowledgeChunkRow): Promise<void> {
  await db.insert(schema.knowledgeWikiSources).values({
    pageId,
    documentId: chunk.documentId,
    versionId: chunk.versionId,
    chunkId: chunk.id,
    stale: false,
  });
}

/** 等真实 PG 进入锁等待：返回被指定 blocker 阻塞的后端，不用固定 sleep 猜时序。 */
async function waitForBlockedBackends(
  blockerPid: number | number[],
  expected: number,
  excludePids: number[] = [],
): Promise<number[]> {
  const blockers = Array.isArray(blockerPid) ? blockerPid : [blockerPid];
  const deadline = Date.now() + 5_000;
  for (;;) {
    const blocked = await pool.query<{ pid: number }>(
      `select pid from pg_stat_activity
        where wait_event_type = 'Lock'
          and pg_blocking_pids(pid) && $1::int[]
          and not (pid = any($2::int[]))`,
      [blockers, excludePids],
    );
    if (blocked.rows.length >= expected) return blocked.rows.map((row) => row.pid);
    if (Date.now() > deadline) {
      throw new Error(`等待 ${expected} 个后端阻塞在 ${blockers.join(',')} 超时`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!ready)('knowledge foundation contract A', () => {
  it('replaceSourceScope 立即撤权、重叠范围保留、人工停用原因不被覆盖', async () => {
    const baseId = await seedBase();
    const { source, ranges } = await seedSource(baseId, [
      { kind: 'gitlab_project', externalId: 'group/a' },
      { kind: 'gitlab_project', externalId: 'group/b', paths: ['/docs'] },
    ]);
    const firstRange = ranges[0];
    const secondRange = ranges[1];
    if (!firstRange || !secondRange) throw new Error('ranges missing');

    const onlyFirst = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'item-a',
      sourcePath: '/a.md',
      sourceConnectionId: source.id,
    });
    await attachSourceRanges(onlyFirst.document, source.id, [firstRange.id]);
    // setCurrentVersion 需在归属写入后重新走一次：先删后建会保留旧状态。
    await knowledge.setCurrentVersion(db, onlyFirst.document.id, onlyFirst.version.id);

    const overlap = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'item-ab',
      sourcePath: '/docs/ab.md',
      sourceConnectionId: source.id,
    });
    await attachSourceRanges(overlap.document, source.id, [firstRange.id, secondRange.id]);
    await knowledge.setCurrentVersion(db, overlap.document.id, overlap.version.id);

    const pathMiss = await knowledge.createDocument(db, {
      baseId,
      folderId: null,
      title: 'outside path',
      sourceType: 'gitlab',
      sourceId: 'item-out',
      sourceUrl: null,
      sourcePath: '/other/out.md',
      sourceConnectionId: source.id,
      mimeType: 'text/markdown',
      sizeBytes: 1,
    });
    // 条目路径未被所选范围覆盖时拒绝归属，绝不先挂上再指望授权查询兜底。
    await expect(attachSourceRanges(pathMiss, source.id, [secondRange.id])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    const manual = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'item-manual',
      sourcePath: '/manual.md',
      sourceConnectionId: source.id,
    });
    await attachSourceRanges(manual.document, source.id, [firstRange.id]);
    await knowledge.updateDocument(db, manual.document.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });

    const pending = await knowledge.createDocument(db, {
      baseId,
      folderId: null,
      title: 'pending',
      sourceType: 'gitlab',
      sourceId: 'item-pending',
      sourceUrl: null,
      sourcePath: '/pending.md',
      sourceConnectionId: source.id,
      mimeType: 'text/markdown',
      sizeBytes: 1,
    });
    await attachSourceRanges(pending, source.id, [firstRange.id]);

    expect(await knowledge.getReadableDocument(db, baseId, onlyFirst.document.id)).not.toBeNull();
    expect(await knowledge.getReadableDocument(db, baseId, overlap.document.id)).not.toBeNull();
    // 路径不在 range paths 内时本地即可证明越界。
    expect(await knowledge.getReadableDocument(db, baseId, pathMiss.id)).toBeNull();

    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `stale-${suffix()}`,
      title: 'Stale page',
    });
    const draft = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# stale',
      sourceChunkIds: [onlyFirst.chunks[0]?.id ?? ''],
      model: 'test',
      generatedBy: 'sdk',
    });
    if (!draft) throw new Error('wiki draft missing');
    await db
      .update(schema.knowledgeWikiPages)
      .set({ currentVersionId: draft.id, status: 'published' })
      .where(eq(schema.knowledgeWikiPages.id, page.id));
    if (onlyFirst.chunks[0]) await linkWikiSource(page.id, onlyFirst.chunks[0]);

    const result = await knowledge.replaceSourceScope(db, source.id, {
      ranges: [
        {
          kind: 'gitlab_project',
          externalId: 'group/b',
          ref: null,
          paths: ['/docs'],
          enabled: true,
        },
      ],
    });

    expect(result.ranges.map((row) => row.id)).toEqual([secondRange.id]);
    expect(result.disabledDocumentIds.sort()).toEqual(
      [onlyFirst.document.id, pathMiss.id, manual.document.id, pending.id].sort(),
    );
    expect(result.disabledDocumentIds).not.toContain(overlap.document.id);
    expect((await knowledge.getDocument(db, onlyFirst.document.id))?.disabledReason).toBe('range');
    expect((await knowledge.getDocument(db, manual.document.id))?.disabledReason).toBe('manual');
    expect((await knowledge.getDocument(db, pending.id))?.status).toBe('disabled');
    expect((await knowledge.getDocument(db, overlap.document.id))?.status).toBe('ready');
    expect(await knowledge.getReadableDocument(db, baseId, overlap.document.id)).not.toBeNull();
    expect(await knowledge.getReadableDocument(db, baseId, onlyFirst.document.id)).toBeNull();
    expect((await knowledge.getWikiPage(db, page.id))?.status).toBe('stale');

    // 来源停用/认证失败同样不可读；恢复只能靠新的成功同步重新证明。
    await knowledge.replaceSourceScope(db, source.id, { status: 'auth_error' });
    expect(await knowledge.getReadableDocument(db, baseId, overlap.document.id)).toBeNull();
    expect((await knowledge.getDocument(db, overlap.document.id))?.disabledReason).toBe('remote');
    await knowledge.replaceSourceScope(db, source.id, { status: 'paused' });
    expect((await knowledge.getDocument(db, overlap.document.id))?.disabledReason).toBe('remote');
    await knowledge.updateDocument(db, overlap.document.id, {
      status: 'ready',
      disabledReason: null,
    });
    expect(await knowledge.getReadableDocument(db, baseId, overlap.document.id)).not.toBeNull();
  });

  it('发布守卫核版本归属/当前指针/来源授权，回退不改停用状态', async () => {
    const baseId = await seedBase();
    const { source, ranges } = await seedSource(baseId, [
      { kind: 'gitlab_project', externalId: 'guard' },
    ]);
    const range = ranges[0];
    if (!range) throw new Error('range missing');
    const seeded = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'guard:1',
      sourcePath: '/guard.md',
      sourceConnectionId: source.id,
    });
    await attachSourceRanges(seeded.document, source.id, [range.id]);
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, seeded.version.id),
    ).not.toBeNull();

    const base = await knowledge.getBase(db, baseId);
    if (!base) throw new Error('base missing');
    const job = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId: seeded.document.id,
      sourceId: null,
      payload: { type: 'ingest', documentId: seeded.document.id },
    });
    await knowledge.claimJob(db, job.id);
    const guard = {
      jobId: job.id,
      baseId,
      embeddingProfileId: base.embeddingProfileId,
      imageProcessingJson: JSON.stringify(
        knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing,
      ),
      expectedCurrentVersionId: seeded.version.id,
      sourceSnapshot: await snapshotFor(source.id),
    };
    const second = await knowledge.createVersion(db, versionInput(seeded.document.id));
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard),
    ).not.toBeNull();
    const third = await knowledge.createVersion(db, versionInput(seeded.document.id));
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, third.id, {
        ...guard,
        expectedCurrentVersionId: seeded.version.id,
      }),
    ).toBeNull();

    // 跨文档版本拒绝，即使不带守卫。
    const other = await seedDocument(baseId, { chunks: [{ content: 'other' }] });
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, other.version.id, {
        ...guard,
        expectedCurrentVersionId: second.id,
      }),
    ).toBeNull();

    await expect(
      knowledge.activateDocumentVersion(db, {
        documentId: seeded.document.id,
        versionId: third.id,
        expectedVersionId: seeded.version.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    await expect(
      knowledge.activateDocumentVersion(db, {
        documentId: seeded.document.id,
        versionId: other.version.id,
        expectedVersionId: second.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rolledBack = await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: seeded.version.id,
      expectedVersionId: second.id,
    });
    expect(rolledBack.currentVersionId).toBe(seeded.version.id);
    expect(rolledBack.status).toBe('ready');

    // 不同 embedding 模型空间的版本不能回退，必须重建。
    const otherProfile = await knowledge.createModelProfile(db, {
      kind: 'embedding',
      name: `foundation-other-${suffix()}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'other',
      dimensions: 1024,
      secretsEncrypted: null,
      enabled: true,
    });
    profileIds.push(otherProfile.id);
    const foreignVersion = await knowledge.createVersion(
      db,
      versionInput(seeded.document.id, { embeddingProfileId: otherProfile.id }),
    );
    await expect(
      knowledge.activateDocumentVersion(db, {
        documentId: seeded.document.id,
        versionId: foreignVersion.id,
        expectedVersionId: rolledBack.currentVersionId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 来源失权时任何发布都拒绝。
    await knowledge.replaceSourceScope(db, source.id, { status: 'disabled' });
    const fourth = await knowledge.createVersion(db, versionInput(seeded.document.id));
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, fourth.id, {
        ...guard,
        expectedCurrentVersionId: seeded.version.id,
      }),
    ).toBeNull();
    expect(await knowledge.setCurrentVersion(db, seeded.document.id, fourth.id)).toBeNull();

    // 人工停用的文档不能靠发布恢复。
    const manualDoc = await seedDocument(baseId, { chunks: [{ content: 'manual' }] });
    await knowledge.updateDocument(db, manualDoc.document.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });
    const manualNext = await knowledge.createVersion(db, versionInput(manualDoc.document.id));
    expect(await knowledge.setCurrentVersion(db, manualDoc.document.id, manualNext.id)).toBeNull();
  });

  it('editDocumentChunks 生成不可变新版本，重映射父序号并清空人工定位', async () => {
    const baseId = await seedBase();
    const locator: KnowledgeLocator = {
      pageFrom: 2,
      pageTo: 2,
      startOffset: 10,
      endOffset: 20,
      headingPath: ['A'],
    };
    const seeded = await seedDocument(baseId, {
      chunks: [
        { content: 'root', pageFrom: 2, pageTo: 2, locator, indexRole: 'parent' },
        {
          content: 'child',
          pageFrom: 2,
          pageTo: 2,
          locator,
          parentOrdinal: 0,
        },
        { content: 'tail' },
      ],
    });
    const root = seeded.chunks[0];
    const child = seeded.chunks[1];
    if (!root || !child) throw new Error('chunks missing');

    const prepared = preparedVersion();
    const edited = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: seeded.version.id,
      mutation: {
        type: 'update',
        chunkId: child.id,
        patch: { content: 'manual child', searchText: 'manual child', embedding: null },
      },
      preparedVersion: prepared,
    });

    expect(edited.document.currentVersionId).toBe(prepared.id);
    expect(edited.chunk).toMatchObject({
      content: 'manual child',
      editedByUser: true,
      pageFrom: null,
      pageTo: null,
      locator: null,
      parentOrdinal: 0,
    });
    expect(edited.chunk?.metadata.originalChunkId).toBe(child.id);

    const oldChunks = await knowledge.listChunks(db, seeded.version.id);
    expect(oldChunks.items.map((chunk) => chunk.content)).toEqual(['root', 'child', 'tail']);
    expect(oldChunks.items[1]?.editedByUser).toBe(false);
    expect(oldChunks.items[1]?.locator).toEqual(locator);
    expect(oldChunks.items[1]?.pageFrom).toBe(2);

    const newVersionId = edited.document.currentVersionId;
    if (!newVersionId) throw new Error('new version missing');
    const newVersion = await knowledge.getVersion(db, newVersionId);
    expect(newVersion?.origin).toBe('manual');
    expect(newVersion?.parentVersionId).toBe(seeded.version.id);
    const newChunks = await knowledge.listChunkSummaries(db, newVersionId);
    expect(newChunks.items.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
    expect(newChunks.items[1]?.parentOrdinal).toBe(0);
    expect(newChunks.items[0]?.locator).toEqual(locator);

    // 纯 enabled 修改保留定位，也不把块标成人工改正文。
    const newRoot = newChunks.items.find((chunk) => chunk.content === 'root');
    if (!newRoot) throw new Error('new root missing');
    const toggled = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: newVersionId,
      mutation: { type: 'update', chunkId: newRoot.id, patch: { enabled: false } },
      preparedVersion: preparedVersion(),
    });
    const toggledChunks = await knowledge.listChunkSummaries(
      db,
      toggled.document.currentVersionId ?? '',
    );
    const toggledRoot = toggledChunks.items.find((chunk) => chunk.content === 'root');
    expect(toggledRoot).toMatchObject({
      enabled: false,
      locator,
      pageFrom: 2,
      editedByUser: false,
    });

    // 删除父块后子块保留内容，但父序号失效置空；旧版本仍完整。
    if (!toggledRoot) throw new Error('toggled root missing');
    const deleted = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: toggled.document.currentVersionId ?? '',
      mutation: { type: 'delete', chunkId: toggledRoot.id },
      preparedVersion: preparedVersion(),
    });
    expect(deleted.chunk).toBeNull();
    const afterDelete = await knowledge.listChunkSummaries(
      db,
      deleted.document.currentVersionId ?? '',
    );
    expect(afterDelete.items.map((chunk) => chunk.content)).toEqual(['manual child', 'tail']);
    expect(afterDelete.items[0]?.parentOrdinal).toBeNull();
    const firstVersionChunks = await knowledge.listChunks(db, seeded.version.id);
    expect(firstVersionChunks.items).toHaveLength(3);
  });

  it('Wiki 草稿不发布、发布核来源、diff/结构与已发布可读', async () => {
    const baseId = await seedBase();
    const sourceDoc = await seedDocument(baseId, {
      chunks: [{ content: 'wiki source alpha' }],
    });
    const sourceChunk = sourceDoc.chunks[0];
    if (!sourceChunk) throw new Error('source chunk missing');
    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `page-${suffix()}`,
      title: 'Page',
    });

    const draft = await knowledge.saveWikiDraft(db, page.id, {
      markdown: 'a\nb\na',
      sourceChunkIds: [sourceChunk.id],
      model: 'sdk',
      generatedBy: 'sdk',
    });
    if (!draft) throw new Error('draft missing');
    const afterDraft = await knowledge.getWikiPage(db, page.id);
    expect(afterDraft?.currentVersionId).toBeNull();
    expect(afterDraft?.status).toBe('draft');
    expect(await knowledge.getReadableWikiPage(db, baseId, page.id)).toBeNull();

    await knowledge.publishWikiVersion(db, page.id, draft.id);
    const publishedPage = await knowledge.getWikiPage(db, page.id);
    expect(publishedPage?.currentVersionId).toBe(draft.id);
    expect(publishedPage?.status).toBe('published');
    expect((await knowledge.getReadableWikiPage(db, baseId, page.id))?.version.id).toBe(draft.id);
    const listed = await knowledge.listReadableWikiPages(db, baseId);
    expect(listed.items.map((item) => item.page.id)).toContain(page.id);

    const next = await knowledge.saveWikiDraft(db, page.id, {
      markdown: 'a\nb\nb',
      sourceChunkIds: [sourceChunk.id],
      model: 'manual',
      generatedBy: 'manual',
      expectedVersion: draft.id,
    });
    if (!next) throw new Error('next draft missing');
    expect((await knowledge.getWikiPage(db, page.id))?.currentVersionId).toBe(draft.id);
    expect((await knowledge.getReadableWikiPage(db, baseId, page.id))?.version.markdown).toBe(
      'a\nb\na',
    );
    await knowledge.publishWikiVersion(db, page.id, next.id);
    expect((await knowledge.getReadableWikiPage(db, baseId, page.id))?.version.markdown).toBe(
      'a\nb\nb',
    );

    const diff = await knowledge.getWikiVersionDiff(db, page.id, draft.id, next.id);
    expect(diff).toMatchObject({
      addedLines: ['b'],
      removedLines: ['a'],
      addedSourceChunkIds: [],
      removedSourceChunkIds: [],
    });

    const child = await knowledge.createWikiPage(db, {
      baseId,
      slug: `child-${suffix()}`,
      title: 'Child',
    });
    const structured = await knowledge.updateWikiPageStructure(db, child.id, {
      parentId: page.id,
      position: 3,
      expectedVersionId: null,
    });
    expect(structured).toMatchObject({ parentId: page.id, position: 3 });

    // 结构与正文同事务：expectedVersion 失配时标题也不得先落库。
    const withStructure = await knowledge.saveWikiDraft(db, page.id, {
      markdown: 'a\nb\nc',
      sourceChunkIds: [sourceChunk.id],
      model: 'manual',
      generatedBy: 'manual',
      expectedVersion: next.id,
      structure: { title: 'Renamed', position: 7 },
    });
    if (!withStructure) throw new Error('structured draft missing');
    expect(await knowledge.getWikiPage(db, page.id)).toMatchObject({
      title: 'Renamed',
      position: 7,
    });
    await expect(
      knowledge.saveWikiDraft(db, page.id, {
        markdown: 'should not land',
        sourceChunkIds: [sourceChunk.id],
        model: 'manual',
        generatedBy: 'manual',
        expectedVersion: next.id,
        structure: { title: 'ShouldNotApply' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    expect((await knowledge.getWikiPage(db, page.id))?.title).toBe('Renamed');
    await expect(
      knowledge.updateWikiPageStructure(db, page.id, {
        parentId: child.id,
        expectedVersionId: withStructure.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 来源文档撤权后不可读，并且引用它的草稿不能发布。
    await knowledge.updateDocument(db, sourceDoc.document.id, {
      status: 'disabled',
      disabledReason: 'manual',
    });
    expect(await knowledge.getReadableWikiPage(db, baseId, page.id)).toBeNull();
    await expect(knowledge.publishWikiVersion(db, page.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(knowledge.rollbackWikiPage(db, page.id, draft.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('Wiki 版本列表按 version 倒序：created_at 倒挂时首项仍是最新版本', async () => {
    const baseId = await seedBase();
    const sourceDoc = await seedDocument(baseId, {
      chunks: [{ content: 'wiki version order source' }],
    });
    const chunkId = sourceDoc.chunks[0]?.id;
    if (!chunkId) throw new Error('source chunk missing');
    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `order-${suffix()}`,
      title: 'Order',
    });
    const otherPage = await knowledge.createWikiPage(db, {
      baseId,
      slug: `order-other-${suffix()}`,
      title: 'Order other',
    });

    // created_at 取事务开始时间：早开晚写会让版本号更大的行拿到更早的时间。
    const versionRow = (
      id: string,
      pageId: string,
      version: number,
      createdAt: string,
    ): typeof schema.knowledgeWikiVersions.$inferInsert => ({
      id,
      pageId,
      version,
      markdown: `v${version}`,
      sourceChunkIds: version === 1 && pageId === otherPage.id ? [] : [chunkId],
      model: 'manual',
      generatedBy: 'manual',
      createdAt: new Date(createdAt),
    });
    const v1 = newId('knowledgeWikiVersion');
    const v2 = newId('knowledgeWikiVersion');
    const v3 = newId('knowledgeWikiVersion');
    const foreign = newId('knowledgeWikiVersion');
    await db
      .insert(schema.knowledgeWikiVersions)
      .values([
        versionRow(v1, page.id, 1, '2026-01-03T00:00:00Z'),
        versionRow(v2, page.id, 2, '2026-01-02T00:00:00Z'),
        versionRow(v3, page.id, 3, '2026-01-01T00:00:00Z'),
        versionRow(foreign, otherPage.id, 1, '2026-01-04T00:00:00Z'),
      ]);

    const first = await knowledge.listWikiVersions(db, page.id, { limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([v3]);
    const second = await knowledge.listWikiVersions(db, page.id, {
      limit: 1,
      cursor: first.nextCursor,
    });
    const third = await knowledge.listWikiVersions(db, page.id, {
      limit: 1,
      cursor: second.nextCursor,
    });
    expect([...first.items, ...second.items, ...third.items].map((row) => row.id)).toEqual([
      v3,
      v2,
      v1,
    ]);
    expect(third.nextCursor).toBeNull();

    // 首项即最新版本，直接拿它当 expectedVersion 不应 409。
    const latestId = first.items[0]?.id;
    if (!latestId) throw new Error('latest version missing');
    const updated = await knowledge.updateWikiPageStructure(db, page.id, {
      position: 4,
      expectedVersionId: latestId,
    });
    expect(updated?.position).toBe(4);

    // 其他页面的游标不能借来翻页，按未知游标语义返回空页。
    const crossed = await knowledge.listWikiVersions(db, page.id, {
      limit: 1,
      cursor: foreign,
    });
    expect(crossed.items).toEqual([]);
    expect(crossed.nextCursor).toBeNull();
  });

  it('FAQ/版本 wire 字段、同步逐项记录与可读列表/分页', async () => {
    const baseId = await seedBase();
    const faq: KnowledgeFaq = {
      question: '如何重置密码？',
      similarQuestions: ['忘记密码怎么办'],
      negativeQuestions: ['如何开发票'],
      answers: ['打开设置页重置。', '联系管理员。'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const faqDoc = await seedDocument(baseId, {
      contentKind: 'faq',
      faq,
      origin: 'faq',
      chunks: [{ content: '如何重置密码？', indexRole: 'parent' }],
    });
    const faqVersion = await knowledge.getVersion(db, faqDoc.version.id);
    expect(faqVersion?.faq).toEqual(faq);
    expect(faqVersion?.origin).toBe('faq');
    expect(await knowledge.getReadableDocument(db, baseId, faqDoc.document.id)).not.toBeNull();

    const versions = await knowledge.listDocumentVersions(db, faqDoc.document.id);
    expect(versions.items[0]).toMatchObject({
      id: faqDoc.version.id,
      isCurrent: true,
      origin: 'faq',
      parentVersionId: null,
    });

    const wikiIndex = await seedDocument(baseId, {
      contentKind: 'wiki',
      chunks: [{ content: 'wiki index' }],
    });
    const readableDocs = await knowledge.listReadableDocuments(db, baseId);
    expect(readableDocs.items.map((document) => document.id)).toContain(faqDoc.document.id);
    expect(readableDocs.items.map((document) => document.id)).not.toContain(wikiIndex.document.id);

    const faqOnly = await knowledge.listDocuments(db, { baseId, contentKind: 'faq' });
    expect(faqOnly.items.map((document) => document.id)).toEqual([faqDoc.document.id]);
    const ordinary = await knowledge.listDocuments(db, { baseId, contentKind: 'document' });
    expect(ordinary.items.map((document) => document.id)).not.toContain(faqDoc.document.id);
    expect(ordinary.items.map((document) => document.id)).not.toContain(wikiIndex.document.id);

    const { source } = await seedSource(baseId, [{ kind: 'gitlab_project', externalId: 'sync' }]);
    const run = await knowledge.createSyncRun(db, source.id, {});
    const item = await knowledge.recordSyncItem(db, {
      syncRunId: run.id,
      sourceId: source.id,
      rangeId: null,
      externalId: 'item-1',
      documentId: null,
      status: 'failed',
      code: 'UNSUPPORTED',
      message: '对象类型不支持',
      retryable: false,
    });
    expect(item.id).toMatch(/^ksit_/);
    const listed = await knowledge.listSyncItems(db, run.id, { status: 'failed' });
    expect(listed.items.map((row) => row.id)).toEqual([item.id]);

    // 外部来源 paused 仍可读；来源删除后立即不可读。
    const { source: source2, ranges } = await seedSource(baseId, [
      { kind: 'gitlab_project', externalId: 'paused' },
    ]);
    const range = ranges[0];
    if (!range) throw new Error('range missing');
    const external = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'paused:1',
      sourcePath: '/paused.md',
      sourceConnectionId: source2.id,
    });
    await attachSourceRanges(external.document, source2.id, [range.id]);
    await knowledge.setCurrentVersion(db, external.document.id, external.version.id);
    await knowledge.updateSource(db, source2.id, { status: 'paused' });
    expect(await knowledge.getReadableDocument(db, baseId, external.document.id)).not.toBeNull();
    await knowledge.disableDocumentsBySource(db, source2.id);
    expect(await knowledge.getReadableDocument(db, baseId, external.document.id)).toBeNull();
    expect((await knowledge.getDocument(db, external.document.id))?.disabledReason).toBe('source');
  });

  it('FAQ 批次导入整批落草稿，replace 发布前不删旧集合', async () => {
    const baseId = await seedBase();
    const oldFaq: KnowledgeFaq = {
      question: '旧问题',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['旧答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const oldDoc = await seedDocument(baseId, {
      contentKind: 'faq',
      faq: oldFaq,
      origin: 'faq',
      chunks: [{ content: oldFaq.question }],
    });
    const expectedState = [
      {
        documentId: oldDoc.document.id,
        currentVersionId: oldDoc.version.id,
        latestDraftVersionId: null,
        updatedAt: oldDoc.document.updatedAt.toISOString(),
      },
    ];

    const newDocumentId = newId('knowledgeDocument');
    const newVersion = faqDraftVersion();
    const newFaq: KnowledgeFaq = {
      question: '新问题',
      similarQuestions: ['新别名'],
      negativeQuestions: [],
      answers: ['新答案一', '新答案二'],
      answerStrategy: 'random',
      isRecommended: false,
    };
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_replace',
      mode: 'replace',
      expectedState,
      drafts: [
        {
          operation: 'add',
          documentId: newDocumentId,
          faq: newFaq,
          enabled: true,
          version: newVersion,
        },
      ],
    });
    expect(saved.items).toMatchObject([
      { documentId: newDocumentId, expectedVersionId: null, jobId: saved.items[0]?.jobId },
    ]);

    const draftDocument = await knowledge.getDocument(db, newDocumentId);
    expect(draftDocument).toMatchObject({
      contentKind: 'faq',
      status: 'pending',
      currentVersionId: null,
    });
    const draftVersion = await knowledge.getVersion(db, newVersion.id);
    expect(draftVersion?.faq).toEqual(newFaq);
    expect(draftVersion?.metadata).toMatchObject({
      publication: 'draft',
      faqImport: { batchId: 'kfimp_replace', mode: 'replace' },
    });
    // 旧集合在草稿就绪前完整保留。
    expect(await knowledge.getDocument(db, oldDoc.document.id)).not.toBeNull();
    // 批次草稿不能逐条手工发布。
    expect(await knowledge.setCurrentVersion(db, newDocumentId, newVersion.id)).toBeNull();

    // 快照变化时整批拒绝，不留下第二份草稿。
    const staleState = expectedState[0];
    if (!staleState) throw new Error('expected state missing');
    const rejectedDocumentId = newId('knowledgeDocument');
    await expect(
      knowledge.saveFaqImportDrafts(db, {
        baseId,
        importBatchId: 'kfimp_replace',
        mode: 'replace',
        expectedState: [{ ...staleState, updatedAt: '2000-01-01T00:00:00.000Z' }],
        drafts: [
          {
            operation: 'add',
            documentId: rejectedDocumentId,
            faq: newFaq,
            enabled: true,
            version: faqDraftVersion(),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    expect(await knowledge.getDocument(db, rejectedDocumentId)).toBeNull();

    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: newDocumentId,
      versionId: newVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: newFaq.question,
          content: newFaq.answers.join('\n\n'),
          searchText: newFaq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });

    const published = await knowledge.publishFaqImport(db, {
      baseId,
      importBatchId: 'kfimp_replace',
      items: [{ documentId: newDocumentId, versionId: newVersion.id, expectedVersionId: null }],
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: newDocumentId,
      currentVersionId: newVersion.id,
      status: 'ready',
    });
    // replace 显式发布成功后才删除旧集合。
    expect(await knowledge.getDocument(db, oldDoc.document.id)).toBeNull();
  });

  it('FAQ append 合并草稿只切对应条目并应用 enabled', async () => {
    const baseId = await seedBase();
    const originalFaq: KnowledgeFaq = {
      question: '如何导出？',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['旧答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const seeded = await seedDocument(baseId, {
      contentKind: 'faq',
      faq: originalFaq,
      origin: 'faq',
      chunks: [{ content: originalFaq.question }],
    });
    const mergeVersion = faqDraftVersion();
    const mergedFaq: KnowledgeFaq = {
      ...originalFaq,
      answers: ['新答案一', '新答案二'],
      answerStrategy: 'random',
      isRecommended: false,
    };
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_append',
      mode: 'append',
      expectedState: [
        {
          documentId: seeded.document.id,
          currentVersionId: seeded.version.id,
          latestDraftVersionId: null,
          updatedAt: seeded.document.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'merge',
          documentId: seeded.document.id,
          faq: mergedFaq,
          enabled: false,
          version: mergeVersion,
        },
      ],
    });
    // 草稿保存不移动线上指针。
    expect((await knowledge.getDocument(db, seeded.document.id))?.currentVersionId).toBe(
      seeded.version.id,
    );
    expect((await knowledge.getVersion(db, mergeVersion.id))?.parentVersionId).toBe(
      seeded.version.id,
    );
    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: seeded.document.id,
      versionId: mergeVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: mergedFaq.question,
          content: mergedFaq.answers.join('\n\n'),
          searchText: mergedFaq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    const published = await knowledge.publishFaqImport(db, {
      baseId,
      importBatchId: 'kfimp_append',
      items: [
        {
          documentId: seeded.document.id,
          versionId: mergeVersion.id,
          expectedVersionId: seeded.version.id,
        },
      ],
    });
    expect(published[0]).toMatchObject({
      currentVersionId: mergeVersion.id,
      status: 'disabled',
      disabledReason: 'manual',
    });
  });

  it('FAQ 批发布要求提交 expected 同时匹配持久值与当前线上版本', async () => {
    const baseId = await seedBase();
    const faq: KnowledgeFaq = {
      question: '回退问题',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['旧答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const seeded = await seedDocument(baseId, {
      contentKind: 'faq',
      faq,
      origin: 'faq',
      chunks: [{ content: faq.question, indexRole: 'parent' }],
    });
    // P0 是历史版本，P1 为导入时的线上版本。
    const p1 = await knowledge.createVersion(
      db,
      versionInput(seeded.document.id, { faq, origin: 'faq' }),
    );
    expect(await knowledge.setCurrentVersion(db, seeded.document.id, p1.id)).not.toBeNull();
    const current = await knowledge.getDocument(db, seeded.document.id);
    if (!current) throw new Error('document missing');

    const mergeVersion = faqDraftVersion();
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_expected_rollback',
      mode: 'append',
      expectedState: [
        {
          documentId: seeded.document.id,
          currentVersionId: p1.id,
          latestDraftVersionId: null,
          updatedAt: current.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'merge',
          documentId: seeded.document.id,
          faq: { ...faq, answers: ['新答案'] },
          enabled: true,
          version: mergeVersion,
        },
      ],
    });
    expect(saved.items[0]).toMatchObject({
      documentId: seeded.document.id,
      expectedVersionId: p1.id,
    });
    expect((await knowledge.getVersion(db, mergeVersion.id))?.metadata.faqImport).toMatchObject({
      batchId: 'kfimp_expected_rollback',
      expectedVersionId: p1.id,
    });

    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: seeded.document.id,
      versionId: mergeVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: faq.question,
          content: '新答案',
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });

    // 导入后回退到 P0；持久 expected 仍是 P1。
    await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: seeded.version.id,
      expectedVersionId: p1.id,
    });
    const publish = (expectedVersionId: string | null) => () =>
      knowledge.publishFaqImport(db, {
        baseId,
        importBatchId: 'kfimp_expected_rollback',
        items: [{ documentId: seeded.document.id, versionId: mergeVersion.id, expectedVersionId }],
      });
    // 提交 P1 与当前线上版本不符；误提交 P0 与持久 expected 不符。两者都必须整批拒绝。
    await expect(publish(p1.id)()).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    await expect(publish(seeded.version.id)()).rejects.toMatchObject({
      code: 'CONFLICT_STALE',
    });

    // 回到 P1 后可正常整批发布。
    await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: p1.id,
      expectedVersionId: seeded.version.id,
    });
    const published = await publish(p1.id)();
    expect(published[0]?.currentVersionId).toBe(mergeVersion.id);
  });

  it('FAQ 新增 expected 为 null，旧草稿 parent 不冒充发布 expected', async () => {
    const baseId = await seedBase();
    const faq: KnowledgeFaq = {
      question: '期望值问题',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const addedDocumentId = newId('knowledgeDocument');
    const addedVersion = faqDraftVersion();
    const added = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_expected_add',
      mode: 'append',
      expectedState: [],
      drafts: [
        {
          operation: 'add',
          documentId: addedDocumentId,
          faq,
          enabled: true,
          version: addedVersion,
        },
      ],
    });
    expect(added.items[0]).toMatchObject({
      documentId: addedDocumentId,
      expectedVersionId: null,
    });
    expect((await knowledge.getVersion(db, addedVersion.id))?.metadata.faqImport).toMatchObject({
      expectedVersionId: null,
    });

    // 页面存在未发布草稿时，合并草稿 parent 指向它，但 expected 仍取线上版本。
    const seeded = await seedDocument(baseId, {
      contentKind: 'faq',
      faq,
      origin: 'faq',
      chunks: [{ content: faq.question, indexRole: 'parent' }],
    });
    const oldDraft = await knowledge.createVersion(
      db,
      versionInput(seeded.document.id, { metadata: { publication: 'draft' } }),
    );
    const current = await knowledge.getDocument(db, seeded.document.id);
    if (!current) throw new Error('document missing');
    const mergeVersion = faqDraftVersion();
    const merged = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_expected_parent',
      mode: 'append',
      expectedState: [
        {
          documentId: seeded.document.id,
          currentVersionId: seeded.version.id,
          latestDraftVersionId: oldDraft.id,
          updatedAt: current.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'merge',
          documentId: seeded.document.id,
          faq: { ...faq, answers: ['合并答案'] },
          enabled: true,
          version: mergeVersion,
        },
      ],
    });
    expect(merged.items[0]).toMatchObject({
      documentId: seeded.document.id,
      expectedVersionId: seeded.version.id,
    });
    const mergeStored = await knowledge.getVersion(db, mergeVersion.id);
    expect(mergeStored?.parentVersionId).toBe(oldDraft.id);
    expect(mergeStored?.metadata.faqImport).toMatchObject({
      expectedVersionId: seeded.version.id,
    });

    await finishFaqJob(merged.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: seeded.document.id,
      versionId: mergeVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: faq.question,
          content: '合并答案',
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    const publish = (expectedVersionId: string | null) => () =>
      knowledge.publishFaqImport(db, {
        baseId,
        importBatchId: 'kfimp_expected_parent',
        items: [{ documentId: seeded.document.id, versionId: mergeVersion.id, expectedVersionId }],
      });
    await expect(publish(oldDraft.id)()).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    const published = await publish(seeded.version.id)();
    expect(published[0]?.currentVersionId).toBe(mergeVersion.id);
  });

  it('FAQ 批发布采用本版本最近一次成功重试，不借其他版本或运行中任务', async () => {
    const baseId = await seedBase();
    const documentId = newId('knowledgeDocument');
    const version = faqDraftVersion();
    const faq: KnowledgeFaq = {
      question: '重试问题',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_retry',
      mode: 'append',
      expectedState: [],
      drafts: [{ operation: 'add', documentId, faq, enabled: true, version }],
    });
    const originalJobId = saved.items[0]?.jobId;
    if (!originalJobId) throw new Error('job missing');
    await knowledge.claimJob(db, originalJobId);
    await knowledge.finishJob(db, originalJobId, { status: 'failed' });
    await knowledge.insertChunks(db, {
      baseId,
      documentId,
      versionId: version.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: faq.question,
          content: faq.answers.join('\n\n'),
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    const publish =
      (versionId: string, importBatchId: string, expectedVersionId: string | null) => () =>
        knowledge.publishFaqImport(db, {
          baseId,
          importBatchId,
          items: [{ documentId, versionId, expectedVersionId }],
        });

    // 原任务 failed 时不能发布。
    await expect(publish(version.id, 'kfimp_retry', null)()).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // 另一版本的成功任务不能替本版本开门。
    const otherVersion = faqDraftVersion();
    const otherJob = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId,
      sourceId: null,
      payload: { type: 'ingest', documentId, publish: 'draft', versionId: otherVersion.id },
    });
    await knowledge.claimJob(db, otherJob.id);
    await knowledge.finishJob(db, otherJob.id, { status: 'succeeded' });
    await expect(publish(version.id, 'kfimp_retry', null)()).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // 同版本重试还没跑完时也不能发布。
    const retry = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId,
      sourceId: null,
      payload: { type: 'ingest', documentId, publish: 'draft', versionId: version.id },
    });
    await knowledge.claimJob(db, retry.id);
    await expect(publish(version.id, 'kfimp_retry', null)()).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await knowledge.finishJob(db, retry.id, { status: 'succeeded' });
    expect((await publish(version.id, 'kfimp_retry', null)())[0]).toMatchObject({
      id: documentId,
      currentVersionId: version.id,
    });

    // 取消后重试成功同理：取消的旧任务不会挡住新任务。
    const current = await knowledge.getDocument(db, documentId);
    if (!current) throw new Error('document missing');
    const nextVersion = faqDraftVersion();
    const nextSaved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_retry_cancel',
      mode: 'append',
      expectedState: [
        {
          documentId,
          currentVersionId: version.id,
          latestDraftVersionId: null,
          updatedAt: current.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'merge',
          documentId,
          faq: { ...faq, answers: ['新答案'] },
          enabled: true,
          version: nextVersion,
        },
      ],
    });
    const cancelledJobId = nextSaved.items[0]?.jobId;
    if (!cancelledJobId) throw new Error('job missing');
    await knowledge.requestCancel(db, cancelledJobId);
    await knowledge.insertChunks(db, {
      baseId,
      documentId,
      versionId: nextVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: faq.question,
          content: '新答案',
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    const retryAfterCancel = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId,
      sourceId: null,
      payload: { type: 'ingest', documentId, publish: 'draft', versionId: nextVersion.id },
    });
    await knowledge.claimJob(db, retryAfterCancel.id);
    await knowledge.finishJob(db, retryAfterCancel.id, { status: 'succeeded' });
    expect(
      (await publish(nextVersion.id, 'kfimp_retry_cancel', version.id)())[0]?.currentVersionId,
    ).toBe(nextVersion.id);
  });

  it('已正式批发布的 FAQ 版本可走通用切版与历史回退，未发布批次仍拒', async () => {
    const baseId = await seedBase();
    const documentId = newId('knowledgeDocument');
    const version = faqDraftVersion();
    const faq: KnowledgeFaq = {
      question: '通用切版',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_generic',
      mode: 'append',
      expectedState: [],
      drafts: [{ operation: 'add', documentId, faq, enabled: true, version }],
    });
    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId,
      versionId: version.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: faq.question,
          content: faq.answers.join('\n\n'),
          searchText: faq.question,
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    await knowledge.publishFaqImport(db, {
      baseId,
      importBatchId: 'kfimp_generic',
      items: [{ documentId, versionId: version.id, expectedVersionId: null }],
    });
    expect((await knowledge.getVersion(db, version.id))?.metadata.publication).toBe('published');

    // 已发布批次版本即便仍是当前版，也能经通用入口重放。
    expect((await knowledge.setCurrentVersion(db, documentId, version.id))?.currentVersionId).toBe(
      version.id,
    );

    // 历史版本可切回；未发布批草稿仍不能绕过整批发布。
    const next = await knowledge.createVersion(db, versionInput(documentId));
    await knowledge.setCurrentVersion(db, documentId, next.id);
    expect((await knowledge.setCurrentVersion(db, documentId, version.id))?.currentVersionId).toBe(
      version.id,
    );

    const draft = faqDraftVersion();
    const current = await knowledge.getDocument(db, documentId);
    if (!current) throw new Error('document missing');
    await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_draft_gate',
      mode: 'append',
      expectedState: [
        {
          documentId,
          currentVersionId: version.id,
          latestDraftVersionId: null,
          updatedAt: current.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'merge',
          documentId,
          faq: { ...faq, answers: ['草稿答案'] },
          enabled: true,
          version: draft,
        },
      ],
    });
    expect(await knowledge.setCurrentVersion(db, documentId, draft.id)).toBeNull();

    // profile 校验不因“已发布批次”放宽。
    const otherProfile = await knowledge.createModelProfile(db, {
      kind: 'embedding',
      name: `faq-generic-${suffix()}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'other',
      dimensions: 1024,
      secretsEncrypted: null,
      enabled: true,
    });
    profileIds.push(otherProfile.id);
    await knowledge.updateBase(db, baseId, { embeddingProfileId: otherProfile.id });
    expect(await knowledge.setCurrentVersion(db, documentId, version.id)).toBeNull();
  });

  it('发布标记持久化，FAQ 批次草稿不能逐条激活', async () => {
    const baseId = await seedBase();
    const seeded = await seedDocument(baseId, { chunks: [{ content: 'v1' }] });
    // 普通手写草稿的显式发布走同一入口，发布后立即获得持久标记。
    const { version: draft } = await draftVersionWithJob(baseId, seeded.document, {
      parentVersionId: seeded.version.id,
    });
    const activated = await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: draft.id,
      expectedVersionId: seeded.version.id,
    });
    expect(activated.currentVersionId).toBe(draft.id);
    expect((await knowledge.getVersion(db, draft.id))?.metadata.publication).toBe('published');

    // 原子发布同样把草稿标记翻成已发布；之后它不再是待发布草稿。
    const { version: draftTwo } = await draftVersionWithJob(baseId, seeded.document, {
      parentVersionId: draft.id,
    });
    await knowledge.setCurrentVersion(db, seeded.document.id, draftTwo.id);
    expect((await knowledge.getVersion(db, draftTwo.id))?.metadata.publication).toBe('published');

    const next = await knowledge.createVersion(db, versionInput(seeded.document.id));
    await knowledge.setCurrentVersion(db, seeded.document.id, next.id);
    const rolledBack = await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: draft.id,
      expectedVersionId: next.id,
    });
    expect(rolledBack.currentVersionId).toBe(draft.id);

    const faqDocumentId = newId('knowledgeDocument');
    const faqVersion = faqDraftVersion();
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_activation',
      mode: 'append',
      expectedState: [],
      drafts: [
        {
          operation: 'add',
          documentId: faqDocumentId,
          faq: {
            question: '激活测试',
            similarQuestions: [],
            negativeQuestions: [],
            answers: ['答案'],
            answerStrategy: 'all',
            isRecommended: true,
          },
          enabled: true,
          version: faqVersion,
        },
      ],
    });
    const job = await knowledge.getJob(db, saved.items[0]?.jobId ?? '');
    expect(job?.payload).toMatchObject({ type: 'ingest', versionId: faqVersion.id });
    // 批次草稿未正式批发布前，回退入口也不能逐条上线。
    await expect(
      knowledge.activateDocumentVersion(db, {
        documentId: faqDocumentId,
        versionId: faqVersion.id,
        expectedVersionId: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: faqDocumentId,
      versionId: faqVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: '激活测试',
          content: '答案',
          searchText: '激活测试',
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });
    await knowledge.publishFaqImport(db, {
      baseId,
      importBatchId: 'kfimp_activation',
      items: [{ documentId: faqDocumentId, versionId: faqVersion.id, expectedVersionId: null }],
    });
    expect((await knowledge.getVersion(db, faqVersion.id))?.metadata.publication).toBe('published');
    // 已正式批发布的历史 FAQ 版本仍可显式回退。
    const faqNext = await knowledge.createVersion(db, versionInput(faqDocumentId));
    await knowledge.setCurrentVersion(db, faqDocumentId, faqNext.id);
    const faqRollback = await knowledge.activateDocumentVersion(db, {
      documentId: faqDocumentId,
      versionId: faqVersion.id,
      expectedVersionId: faqNext.id,
    });
    expect(faqRollback.currentVersionId).toBe(faqVersion.id);
  });

  it('人工删除与纯启停写入版本事实并计入人工修改', async () => {
    const baseId = await seedBase();
    const seeded = await seedDocument(baseId, {
      chunks: [{ content: 'keep' }, { content: 'remove' }],
    });
    const [keep, remove] = seeded.chunks;
    if (!keep || !remove) throw new Error('chunks missing');

    const deleted = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: seeded.version.id,
      mutation: { type: 'delete', chunkId: remove.id },
      preparedVersion: preparedVersion(),
    });
    const afterDelete = deleted.document.currentVersionId ?? '';
    expect(await knowledge.countEditedChunks(db, afterDelete)).toBe(1);
    const remaining = await knowledge.listChunkSummaries(db, afterDelete);
    expect(remaining.items.map((chunk) => chunk.content)).toEqual(['keep']);
    // 未改动正文的叶块不能被顺手标成人工编辑。
    expect(remaining.items[0]?.editedByUser).toBe(false);
    expect((await knowledge.getVersion(db, afterDelete))?.metadata.manualChanges).toMatchObject({
      [remove.id]: 'deleted',
    });

    const keepId = remaining.items[0]?.id;
    if (!keepId) throw new Error('remaining chunk missing');
    const toggled = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: afterDelete,
      mutation: { type: 'update', chunkId: keepId, patch: { enabled: false } },
      preparedVersion: preparedVersion(),
    });
    const afterToggle = toggled.document.currentVersionId ?? '';
    expect(await knowledge.countEditedChunks(db, afterToggle)).toBe(1);
    const toggledChunks = await knowledge.listChunkSummaries(db, afterToggle);
    expect(toggledChunks.items[0]).toMatchObject({ enabled: false, editedByUser: false });
  });

  it('Wiki 发布与回退拒绝内部索引来源，SDK 无来源不可发布', async () => {
    const baseId = await seedBase();
    const index = await seedDocument(baseId, {
      contentKind: 'wiki',
      chunks: [{ content: 'wiki index body' }],
    });
    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `recursive-${suffix()}`,
      title: 'Recursive',
    });
    const fromIndex = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# recursive',
      sourceChunkIds: [index.chunks[0]?.id ?? ''],
      model: 'manual',
      generatedBy: 'manual',
    });
    if (!fromIndex) throw new Error('draft missing');
    await expect(knowledge.publishWikiVersion(db, page.id, fromIndex.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const sdkEmpty = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# sdk no source',
      sourceChunkIds: [],
      model: 'sdk',
      generatedBy: 'sdk',
    });
    if (!sdkEmpty) throw new Error('sdk draft missing');
    await expect(knowledge.publishWikiVersion(db, page.id, sdkEmpty.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // 回退不能把 SDK 空来源洗成人工版本后发布。
    await expect(knowledge.rollbackWikiPage(db, page.id, sdkEmpty.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const manualEmpty = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# manual no source',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    if (!manualEmpty) throw new Error('manual draft missing');
    expect(await knowledge.publishWikiVersion(db, page.id, manualEmpty.id)).not.toBeNull();

    const sourceDoc = await seedDocument(baseId, { chunks: [{ content: 'wiki source' }] });
    const sdkWithSource = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# sdk with source',
      sourceChunkIds: [sourceDoc.chunks[0]?.id ?? ''],
      model: 'sdk',
      generatedBy: 'sdk',
    });
    if (!sdkWithSource) throw new Error('sdk sourced draft missing');
    await knowledge.publishWikiVersion(db, page.id, sdkWithSource.id);
    const rolled = await knowledge.rollbackWikiPage(db, page.id, sdkWithSource.id);
    expect(rolled?.generatedBy).toBe('sdk');
  });

  it('FAQ 批发布在切指针/删旧集前整批校验库状态与 profile', async () => {
    const baseId = await seedBase();
    const oldFaq: KnowledgeFaq = {
      question: '旧问题',
      similarQuestions: [],
      negativeQuestions: [],
      answers: ['旧答案'],
      answerStrategy: 'all',
      isRecommended: true,
    };
    const oldDoc = await seedDocument(baseId, {
      contentKind: 'faq',
      faq: oldFaq,
      origin: 'faq',
      chunks: [{ content: oldFaq.question }],
    });
    const newDocumentId = newId('knowledgeDocument');
    const newVersion = faqDraftVersion();
    const saved = await knowledge.saveFaqImportDrafts(db, {
      baseId,
      importBatchId: 'kfimp_profile',
      mode: 'replace',
      expectedState: [
        {
          documentId: oldDoc.document.id,
          currentVersionId: oldDoc.version.id,
          latestDraftVersionId: null,
          updatedAt: oldDoc.document.updatedAt.toISOString(),
        },
      ],
      drafts: [
        {
          operation: 'add',
          documentId: newDocumentId,
          faq: {
            question: '新问题',
            similarQuestions: [],
            negativeQuestions: [],
            answers: ['新答案'],
            answerStrategy: 'all',
            isRecommended: true,
          },
          enabled: true,
          version: newVersion,
        },
      ],
    });
    await finishFaqJob(saved.items[0]?.jobId ?? '');
    await knowledge.insertChunks(db, {
      baseId,
      documentId: newDocumentId,
      versionId: newVersion.id,
      folderId: null,
      chunks: [
        {
          ordinal: 0,
          indexRole: 'parent',
          kind: 'text',
          heading: '新问题',
          content: '新答案',
          searchText: '新问题',
          embedding: null,
          pageFrom: null,
          pageTo: null,
          tokenCount: 1,
        },
      ],
    });

    const otherProfile = await knowledge.createModelProfile(db, {
      kind: 'embedding',
      name: `faq-profile-${suffix()}`,
      endpointUrl: 'http://127.0.0.1:1',
      model: 'other',
      dimensions: 1024,
      secretsEncrypted: null,
      enabled: true,
    });
    profileIds.push(otherProfile.id);
    const originalProfileId = (await knowledge.getBase(db, baseId))?.embeddingProfileId;
    if (!originalProfileId) throw new Error('base profile missing');
    await knowledge.updateBase(db, baseId, { embeddingProfileId: otherProfile.id });
    const publish = () =>
      knowledge.publishFaqImport(db, {
        baseId,
        importBatchId: 'kfimp_profile',
        items: [{ documentId: newDocumentId, versionId: newVersion.id, expectedVersionId: null }],
      });
    await expect(publish()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await knowledge.getDocument(db, newDocumentId))?.currentVersionId).toBeNull();
    expect(await knowledge.getDocument(db, oldDoc.document.id)).not.toBeNull();

    const base = await knowledge.getBase(db, baseId);
    if (!base) throw new Error('base missing');
    await knowledge.updateBase(db, baseId, {
      embeddingProfileId: originalProfileId,
      status: 'disabled',
    });
    await expect(publish()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await knowledge.getDocument(db, newDocumentId))?.currentVersionId).toBeNull();
    expect(await knowledge.getDocument(db, oldDoc.document.id)).not.toBeNull();

    await knowledge.updateBase(db, baseId, { status: 'active' });
    const published = await publish();
    expect(published[0]?.currentVersionId).toBe(newVersion.id);
    expect(await knowledge.getDocument(db, oldDoc.document.id)).toBeNull();
  });

  it('Wiki 发布与范围撤权按 source -> document -> page -> 关联顺序取锁', async () => {
    const baseId = await seedBase();
    const { source, ranges } = await seedSource(baseId, [
      { kind: 'gitlab_project', externalId: 'locks', paths: ['/docs'] },
    ]);
    const range = ranges[0];
    if (!range) throw new Error('range missing');
    const seeded = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'lock:1',
      sourcePath: '/docs/lock.md',
      sourceConnectionId: source.id,
    });
    await attachSourceRanges(seeded.document, source.id, [range.id]);
    await knowledge.setCurrentVersion(db, seeded.document.id, seeded.version.id);
    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `lock-${suffix()}`,
      title: 'Lock order',
    });
    const draft = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# lock',
      sourceChunkIds: [seeded.chunks[0]?.id ?? ''],
      model: 'manual',
      generatedBy: 'manual',
    });
    if (!draft) throw new Error('draft missing');

    // 1) 发布必须先等来源锁：范围撤权持有来源行锁时，发布不得抢在它前面动页面。
    const gate = await pool.connect();
    let publishing: Promise<unknown> | null = null;
    let revoking: Promise<unknown> | null = null;
    let committed = false;
    try {
      await gate.query('begin');
      const gatePid = (await gate.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      if (gatePid === undefined) throw new Error('gate pid missing');
      await gate.query('select id from knowledge_sources where id = $1 for update', [source.id]);
      publishing = knowledge.publishWikiVersion(db, page.id, draft.id);
      const [publishPid] = await waitForBlockedBackends(gatePid, 1);
      if (publishPid === undefined) throw new Error('publish pid missing');
      revoking = knowledge.replaceSourceScope(db, source.id, {
        ranges: [
          {
            kind: 'gitlab_project',
            externalId: 'locks',
            ref: null,
            paths: ['/docs'],
            enabled: true,
          },
        ],
      });
      // 排在后面的撤权可能被前一个等待者 soft-block，因此以任一 blocker 判断它确实阻塞。
      await waitForBlockedBackends([gatePid, publishPid], 1, [publishPid]);
      await gate.query('commit');
      committed = true;
      const [published, scoped] = await Promise.all([publishing, revoking]);
      expect(published).toMatchObject({ currentVersionId: draft.id });
      expect(scoped).toMatchObject({ disabledDocumentIds: [] });
    } finally {
      if (!committed) await gate.query('rollback').catch(() => undefined);
      gate.release();
      await Promise.allSettled([publishing, revoking]);
    }

    // 2) 撤权在锁住 Wiki 页之后才写来源关联；持页锁时不能已持有 wiki_sources 行锁。
    const pageGate = await pool.connect();
    let revokeOnly: Promise<unknown> | null = null;
    let pageCommitted = false;
    try {
      await pageGate.query('begin');
      const pageGatePid = (await pageGate.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]?.pid;
      if (pageGatePid === undefined) throw new Error('page gate pid missing');
      await pageGate.query('select id from knowledge_wiki_pages where id = $1 for update', [
        page.id,
      ]);
      revokeOnly = knowledge.replaceSourceScope(db, source.id, { ranges: [] });
      const [blockedPid] = await waitForBlockedBackends(pageGatePid, 1);
      if (blockedPid === undefined) throw new Error('blocked pid missing');
      const tupleLocks = await pool.query<{ count: number }>(
        `select count(*)::int as count
           from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = $1 and c.relname = 'knowledge_wiki_sources' and l.locktype = 'tuple'`,
        [blockedPid],
      );
      expect(tupleLocks.rows[0]?.count).toBe(0);
      await pageGate.query('commit');
      pageCommitted = true;
      await revokeOnly;
      expect((await knowledge.getWikiPage(db, page.id))?.status).toBe('stale');
    } finally {
      if (!pageCommitted) await pageGate.query('rollback').catch(() => undefined);
      pageGate.release();
      await Promise.allSettled([revokeOnly]);
    }
  });

  it('双来源交叉 Wiki 页并发撤权按全局页 ID 一次加锁，不死锁', async () => {
    const baseId = await seedBase();
    const sourceA = await seedSource(baseId, [{ kind: 'gitlab_project', externalId: 'cross-a' }]);
    const sourceB = await seedSource(baseId, [{ kind: 'gitlab_project', externalId: 'cross-b' }]);
    const rangeA = sourceA.ranges[0];
    const rangeB = sourceB.ranges[0];
    if (!rangeA || !rangeB) throw new Error('ranges missing');

    const seedLinked = async (sourceId: string, rangeId: string, externalId: string) => {
      const seeded = await seedDocument(baseId, {
        sourceType: 'gitlab',
        sourceId: externalId,
        sourcePath: `/${externalId}.md`,
        sourceConnectionId: sourceId,
      });
      await attachSourceRanges(seeded.document, sourceId, [rangeId]);
      const published = await knowledge.setCurrentVersion(
        db,
        seeded.document.id,
        seeded.version.id,
      );
      const chunk = seeded.chunks[0];
      if (!published || !chunk) throw new Error('seed failed');
      return { document: published, chunk };
    };

    const a1 = await seedLinked(sourceA.source.id, rangeA.id, 'cross-a1');
    const a2 = await seedLinked(sourceA.source.id, rangeA.id, 'cross-a2');
    const b1 = await seedLinked(sourceB.source.id, rangeB.id, 'cross-b1');
    const b2 = await seedLinked(sourceB.source.id, rangeB.id, 'cross-b2');

    const [lowPage, highPage] = [
      await knowledge.createWikiPage(db, { baseId, slug: `cross-${suffix()}`, title: 'cross 1' }),
      await knowledge.createWikiPage(db, { baseId, slug: `cross-${suffix()}`, title: 'cross 2' }),
    ].sort((left, right) => (left.id < right.id ? -1 : 1));
    if (!lowPage || !highPage) throw new Error('pages missing');

    const byId = (left: { document: { id: string } }, right: { document: { id: string } }) =>
      left.document.id < right.document.id ? -1 : 1;
    const aDocs = [a1, a2].sort(byId);
    const bDocs = [b1, b2].sort(byId);
    const linkPage = async (pageId: string, chunks: knowledge.KnowledgeChunkRow[]) => {
      const draft = await knowledge.saveWikiDraft(db, pageId, {
        markdown: '# cross',
        sourceChunkIds: chunks.map((chunk) => chunk.id),
        model: 'manual',
        generatedBy: 'manual',
      });
      if (!draft) throw new Error('draft missing');
      await knowledge.publishWikiVersion(db, pageId, draft.id);
    };
    // source A 的文档按 ID 先高页后低页，source B 相反；逐文档加锁会形成反向锁环。
    await linkPage(
      highPage.id,
      [aDocs[0]?.chunk, bDocs[1]?.chunk].filter((chunk) => chunk !== undefined),
    );
    await linkPage(
      lowPage.id,
      [aDocs[1]?.chunk, bDocs[0]?.chunk].filter((chunk) => chunk !== undefined),
    );

    const gate = await pool.connect();
    let revokeA: Promise<unknown> | null = null;
    let revokeB: Promise<unknown> | null = null;
    let committed = false;
    try {
      await gate.query('begin');
      const gatePid = (await gate.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      if (gatePid === undefined) throw new Error('gate pid missing');
      await gate.query('select id from knowledge_wiki_pages where id = $1 for update', [
        lowPage.id,
      ]);
      revokeA = knowledge.replaceSourceScope(db, sourceA.source.id, { ranges: [] });
      const [blockedPid] = await waitForBlockedBackends(gatePid, 1);
      if (blockedPid === undefined) throw new Error('blocked pid missing');
      // 必须从全局最小页 ID 开始等锁：等待最小页时，本事务不能已经持有高页（旧实现会）。
      const probeHighPage = await pool
        .query('select id from knowledge_wiki_pages where id = $1 for update nowait', [highPage.id])
        .then(
          () => 'free',
          (error: { code?: string }) => error.code,
        );
      expect(probeHighPage).toBe('free');
      revokeB = knowledge.replaceSourceScope(db, sourceB.source.id, { ranges: [] });
      await gate.query('commit');
      committed = true;
      const [scopedA, scopedB] = await Promise.all([revokeA, revokeB]);
      expect(scopedA).toMatchObject({
        disabledDocumentIds: expect.arrayContaining([a1.document.id, a2.document.id]),
      });
      expect(scopedB).toMatchObject({
        disabledDocumentIds: expect.arrayContaining([b1.document.id, b2.document.id]),
      });
      expect((await knowledge.getWikiPage(db, lowPage.id))?.status).toBe('stale');
      expect((await knowledge.getWikiPage(db, highPage.id))?.status).toBe('stale');
    } finally {
      if (!committed) await gate.query('rollback').catch(() => undefined);
      gate.release();
      await Promise.allSettled([revokeA, revokeB]);
    }
  });

  it('来源读取快照失效时 membership/发布/回退都拒绝且旧线上不变', async () => {
    const baseId = await seedBase();
    const { source, ranges } = await seedSource(baseId, [
      { kind: 'gitlab_project', externalId: 'snapshot', paths: ['/docs'] },
    ]);
    const range = ranges[0];
    if (!range) throw new Error('range missing');
    const seeded = await seedDocument(baseId, {
      sourceType: 'gitlab',
      sourceId: 'snapshot:1',
      sourcePath: '/docs/a.md',
      sourceConnectionId: source.id,
    });
    const patch = {
      title: seeded.document.title,
      sourceUrl: null,
      sourcePath: '/docs/a.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      metadata: seeded.document.metadata,
    };
    const readSnapshot = await snapshotFor(source.id);
    expect(
      await knowledge.setDocumentSourceRanges(
        db,
        seeded.document.id,
        [range.id],
        readSnapshot,
        patch,
      ),
    ).not.toBeNull();
    const first = await knowledge.setCurrentVersion(db, seeded.document.id, seeded.version.id);
    if (!first) throw new Error('first publish missing');
    const second = await knowledge.createVersion(db, versionInput(seeded.document.id));
    const guardSnapshot = await snapshotFor(source.id);
    const base = await knowledge.getBase(db, baseId);
    if (!base) throw new Error('base missing');
    const job = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId: seeded.document.id,
      sourceId: null,
      payload: { type: 'ingest', documentId: seeded.document.id },
    });
    await knowledge.claimJob(db, job.id);
    const guard = {
      jobId: job.id,
      baseId,
      embeddingProfileId: base.embeddingProfileId,
      imageProcessingJson: JSON.stringify(
        knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing,
      ),
      expectedCurrentVersionId: first.currentVersionId,
      sourceSnapshot: guardSnapshot,
    };
    const expectOnlineUnchanged = async () => {
      expect(await knowledge.getDocument(db, seeded.document.id)).toMatchObject({
        currentVersionId: first.currentVersionId,
        contentHash: seeded.version.blobSha256,
      });
    };

    // 旧 config：membership 与自动发布都零写。
    await knowledge.updateSource(db, source.id, { config: { repo: 'changed' } });
    expect(
      await knowledge.setDocumentSourceRanges(db, seeded.document.id, [range.id], readSnapshot, {
        ...patch,
        title: 'changed',
      }),
    ).toBeNull();
    expect(await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard)).toBeNull();
    await expectOnlineUnchanged();
    await knowledge.updateSource(db, source.id, { config: {} });

    // 旧凭证密文：不解密比较，密文原值变化即失效。
    await knowledge.updateSource(db, source.id, { secretsEncrypted: 'encrypted-v2' });
    expect(
      await knowledge.setDocumentSourceRanges(
        db,
        seeded.document.id,
        [range.id],
        readSnapshot,
        patch,
      ),
    ).toBeNull();
    expect(await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard)).toBeNull();
    await expectOnlineUnchanged();
    await knowledge.updateSource(db, source.id, { secretsEncrypted: null });

    // 同 ID 范围改 paths：按范围实际字段比较，不因 ID 未变放行。
    await knowledge.replaceRanges(db, source.id, [
      {
        kind: 'gitlab_project',
        externalId: 'snapshot',
        ref: null,
        paths: ['/other'],
        enabled: true,
      },
    ]);
    expect(
      await knowledge.setDocumentSourceRanges(
        db,
        seeded.document.id,
        [range.id],
        readSnapshot,
        patch,
      ),
    ).toBeNull();
    expect(await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard)).toBeNull();
    await expectOnlineUnchanged();
    await knowledge.replaceRanges(db, source.id, [
      {
        kind: 'gitlab_project',
        externalId: 'snapshot',
        ref: null,
        paths: ['/docs'],
        enabled: true,
      },
    ]);
    expect(
      await knowledge.setDocumentSourceRanges(
        db,
        seeded.document.id,
        [range.id],
        guardSnapshot,
        patch,
      ),
    ).not.toBeNull();
    const published = await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard);
    expect(published).toMatchObject({
      currentVersionId: second.id,
      contentHash: second.blobSha256,
    });

    // 范围撤权后回退旧版本同样拒绝，线上指针保持最新成功发布。
    await knowledge.replaceRanges(db, source.id, [
      {
        kind: 'gitlab_project',
        externalId: 'snapshot',
        ref: null,
        paths: ['/docs'],
        enabled: false,
      },
    ]);
    await expect(
      knowledge.activateDocumentVersion(db, {
        documentId: seeded.document.id,
        versionId: first.currentVersionId ?? '',
        expectedVersionId: second.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await knowledge.getDocument(db, seeded.document.id))?.currentVersionId).toBe(second.id);
  });

  it('普通草稿发布必须关联本版本已成功的索引任务', async () => {
    const baseId = await seedBase();
    const seeded = await seedDocument(baseId, { chunks: [{ content: 'published' }] });
    const document = seeded.document;
    const activate = (versionId: string) =>
      knowledge.activateDocumentVersion(db, {
        documentId: document.id,
        versionId,
        expectedVersionId: seeded.version.id,
      });

    // 缺关联：既不能显式激活，也不能经自动发布绕过。
    const unlinked = await knowledge.createVersion(
      db,
      versionInput(document.id, { metadata: { publication: 'draft' } }),
    );
    await expect(activate(unlinked.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await knowledge.setCurrentVersion(db, document.id, unlinked.id)).toBeNull();

    // 其它文档的成功任务不能冒充。
    const other = await seedDocument(baseId, { chunks: [{ content: 'other' }] });
    const { job: otherJob } = await draftVersionWithJob(baseId, other.document);
    const foreign = await knowledge.createVersion(
      db,
      versionInput(document.id, {
        parentVersionId: seeded.version.id,
        metadata: { publication: 'draft', indexingJobId: otherJob.id },
      }),
    );
    await expect(activate(foreign.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // 已取消的任务不能发布。
    const cancelled = await draftVersionWithJob(baseId, document, {
      parentVersionId: seeded.version.id,
      jobStatus: 'cancelled',
    });
    await expect(activate(cancelled.version.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // 成功任务但输入不是该版本（指纹/文件名不同）。
    const { job } = await draftVersionWithJob(baseId, document, {
      parentVersionId: seeded.version.id,
    });
    const mismatched = await knowledge.createVersion(
      db,
      versionInput(document.id, {
        blobSha256: '9'.repeat(64),
        originalFilename: 'other.md',
        parentVersionId: seeded.version.id,
        metadata: { publication: 'draft', indexingJobId: job.id },
      }),
    );
    await expect(activate(mismatched.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // 匹配的成功任务可以发布，指针与 contentHash 同事务更新。
    const matched = await draftVersionWithJob(baseId, document, {
      parentVersionId: seeded.version.id,
    });
    const published = await activate(matched.version.id);
    expect(published).toMatchObject({
      currentVersionId: matched.version.id,
      contentHash: matched.version.blobSha256,
    });
    expect((await knowledge.getVersion(db, matched.version.id))?.metadata.publication).toBe(
      'published',
    );
  });

  it('Wiki 发布 Tx 与索引文档/任务同事务回滚或提交', async () => {
    const baseId = await seedBase();
    const page = await knowledge.createWikiPage(db, {
      baseId,
      slug: `tx-${suffix()}`,
      title: 'Tx page',
    });
    const draft = await knowledge.saveWikiDraft(db, page.id, {
      markdown: '# tx',
      sourceChunkIds: [],
      model: 'manual',
      generatedBy: 'manual',
    });
    if (!draft) throw new Error('draft missing');
    const indexDocument = (tx: knowledge.Tx) =>
      knowledge.createDocument(tx, {
        baseId,
        folderId: null,
        title: page.title,
        sourceType: 'manual',
        sourceId: `wiki:${page.id}`,
        sourceUrl: null,
        sourcePath: null,
        mimeType: 'text/markdown',
        sizeBytes: 4,
        contentKind: 'wiki',
        metadata: { wikiPageId: page.id },
      });

    let rolledBackDocumentId = '';
    await expect(
      db.transaction(async (tx) => {
        await knowledge.publishWikiVersionTx(tx, page.id, draft.id);
        const index = await indexDocument(tx);
        rolledBackDocumentId = index.id;
        await knowledge.createJob(tx, {
          type: 'ingest',
          baseId,
          documentId: index.id,
          sourceId: null,
          payload: { type: 'ingest', documentId: index.id, publish: 'automatic' },
        });
        throw new Error('rollback wiki publish');
      }),
    ).rejects.toThrow('rollback wiki publish');
    expect((await knowledge.getWikiPage(db, page.id))?.currentVersionId).toBeNull();
    expect(await knowledge.getDocument(db, rolledBackDocumentId)).toBeNull();

    let committedDocumentId = '';
    let committedJobId = '';
    await db.transaction(async (tx) => {
      await knowledge.publishWikiVersionTx(tx, page.id, draft.id);
      const index = await indexDocument(tx);
      committedDocumentId = index.id;
      const job = await knowledge.createJob(tx, {
        type: 'ingest',
        baseId,
        documentId: index.id,
        sourceId: null,
        payload: { type: 'ingest', documentId: index.id, publish: 'automatic' },
      });
      committedJobId = job.id;
    });
    expect((await knowledge.getWikiPage(db, page.id))?.currentVersionId).toBe(draft.id);
    expect(await knowledge.getDocument(db, committedDocumentId)).not.toBeNull();
    expect(await knowledge.getJob(db, committedJobId)).not.toBeNull();
  });

  it('ASR profile kind 允许 null 维度，DB 拒绝错误维度/协议/图片能力', async () => {
    const asr = await createAsrProfile();
    expect(asr).toMatchObject({
      kind: 'asr',
      dimensions: null,
      embeddingProtocol: 'openai',
      imageInputEnabled: false,
    });

    const rejected = async (overrides: Partial<knowledge.CreateModelProfileInput>) => {
      let error: unknown;
      try {
        await createAsrProfile(overrides);
      } catch (caught) {
        error = caught;
      }
      expect(pgCode(error)).toBe('23514');
    };
    await rejected({ dimensions: 1024 });
    await rejected({ embeddingProtocol: 'cohere_v2' });
    await rejected({ imageInputEnabled: true });
  });

  it('知识库 ASR 绑定校验存在/kind/enabled，关闭用 null，被引用时禁止删除', async () => {
    const baseId = await seedBase();
    const asr = await createAsrProfile();
    const disabled = await createAsrProfile({ enabled: false });

    await expect(
      knowledge.updateBase(db, baseId, { asrProfileId: profileId }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      knowledge.updateBase(db, baseId, { asrProfileId: disabled.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      knowledge.updateBase(db, baseId, { asrProfileId: 'kmp_missing' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await knowledge.updateBase(db, baseId, { asrProfileId: asr.id })).toMatchObject({
      asrProfileId: asr.id,
    });

    let error: unknown;
    try {
      await db
        .delete(schema.knowledgeModelProfiles)
        .where(eq(schema.knowledgeModelProfiles.id, asr.id));
    } catch (caught) {
      error = caught;
    }
    // ON DELETE RESTRICT 在 PostgreSQL 报 23001，而不是 NO ACTION 的 23503。
    expect(pgCode(error)).toBe('23001');

    expect(await knowledge.updateBase(db, baseId, { asrProfileId: null })).toMatchObject({
      asrProfileId: null,
    });

    // 创建入口与更新同一条规则。
    const server = await servers.createServer(db, {
      name: `foundation-asr-${suffix()}`,
      kind: 'knowledge' as never,
      description: '',
      config: {},
      secretsEncrypted: null,
    });
    serverIds.push(server.id);
    await expect(
      knowledge.createBase(db, {
        slug: `foundation-asr-${suffix()}`,
        name: 'ASR',
        description: '',
        serverId: server.id,
        embeddingProfileId: profileId,
        rerankProfileId: null,
        asrProfileId: profileId,
        settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('音频发布守卫在 ASR 关闭或切换后拒绝，普通文档不依赖 ASR', async () => {
    const baseId = await seedBase();
    const asrA = await createAsrProfile();
    const asrB = await createAsrProfile();
    await knowledge.updateBase(db, baseId, { asrProfileId: asrA.id });
    const seeded = await seedDocument(baseId, { chunks: [{ content: 'audio body' }] });
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, seeded.version.id),
    ).not.toBeNull();

    const base = await knowledge.getBase(db, baseId);
    if (!base) throw new Error('base missing');
    const job = await knowledge.createJob(db, {
      type: 'ingest',
      baseId,
      documentId: seeded.document.id,
      sourceId: null,
      payload: { type: 'ingest', documentId: seeded.document.id },
    });
    await knowledge.claimJob(db, job.id);
    const guard = {
      jobId: job.id,
      baseId,
      embeddingProfileId: base.embeddingProfileId,
      imageProcessingJson: JSON.stringify(
        knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing,
      ),
      expectedCurrentVersionId: seeded.version.id,
      asrProfileId: asrA.id,
    };
    const second = await knowledge.createVersion(db, versionInput(seeded.document.id));
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, second.id, guard),
    ).not.toBeNull();

    const third = await knowledge.createVersion(db, versionInput(seeded.document.id));
    await knowledge.updateBase(db, baseId, { asrProfileId: asrB.id });
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, third.id, {
        ...guard,
        expectedCurrentVersionId: second.id,
      }),
    ).toBeNull();

    const fourth = await knowledge.createVersion(db, versionInput(seeded.document.id));
    await knowledge.updateBase(db, baseId, { asrProfileId: null });
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, fourth.id, {
        ...guard,
        expectedCurrentVersionId: second.id,
      }),
    ).toBeNull();

    // 普通文档的守卫不带 asrProfileId，不受当前 ASR 配置影响。
    const fifth = await knowledge.createVersion(db, versionInput(seeded.document.id));
    expect(
      await knowledge.setCurrentVersion(db, seeded.document.id, fifth.id, {
        ...guard,
        asrProfileId: undefined,
        expectedCurrentVersionId: second.id,
      }),
    ).not.toBeNull();
  });

  it('人工 COW 清空 audio.segments 并保留来源快照，回滚保留原 metadata', async () => {
    const baseId = await seedBase();
    const audio = {
      protocol: 'openai_transcriptions',
      profileName: 'local-whisper',
      model: 'whisper-1',
      durationMs: 2_500,
      segments: [
        { startOffset: 0, endOffset: 5, timeFromMs: 0, timeToMs: 1_000 },
        { startOffset: 7, endOffset: 12, timeFromMs: 1_000, timeToMs: 2_500 },
      ],
    };
    const seeded = await seedDocument(baseId, {
      metadata: { audio },
      chunks: [
        {
          content: 'hello',
          locator: { startOffset: 0, endOffset: 5, timeFromMs: 0, timeToMs: 1_000 },
        },
        {
          content: 'world',
          locator: { startOffset: 7, endOffset: 12, timeFromMs: 1_000, timeToMs: 2_500 },
        },
      ],
    });
    const first = seeded.chunks[0];
    if (!first) throw new Error('chunk missing');

    const prepared = preparedVersion();
    const edited = await knowledge.editDocumentChunks(db, {
      documentId: seeded.document.id,
      expectedVersionId: seeded.version.id,
      mutation: {
        type: 'update',
        chunkId: first.id,
        patch: { content: 'hello edited', searchText: 'hello edited', embedding: null },
      },
      preparedVersion: prepared,
    });
    const newVersion = await knowledge.getVersion(db, edited.document.currentVersionId ?? '');
    expect(newVersion?.metadata.audio).toEqual({ ...audio, segments: [] });
    expect(newVersion?.metadata.manualChanges).toEqual({ [first.id]: 'edited' });

    const newChunks = await knowledge.listChunkSummaries(
      db,
      edited.document.currentVersionId ?? '',
    );
    expect(newChunks.items[0]?.locator).toBeNull();
    expect(newChunks.items[1]?.locator).toEqual({
      startOffset: 7,
      endOffset: 12,
      timeFromMs: 1_000,
      timeToMs: 2_500,
    });

    await knowledge.activateDocumentVersion(db, {
      documentId: seeded.document.id,
      versionId: seeded.version.id,
      expectedVersionId: edited.document.currentVersionId,
    });
    const rolledBack = await knowledge.getVersion(db, seeded.version.id);
    expect(rolledBack?.metadata).toEqual({ audio });
  });
});
