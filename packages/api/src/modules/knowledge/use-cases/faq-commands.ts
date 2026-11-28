import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AppError,
  fail,
  isAppError,
  knowledgeVersionMarkdownPath,
  sha256Hex,
} from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import type {
  KnowledgeDocumentStatus,
  KnowledgeFaq,
  KnowledgeFaqImportIssue,
  KnowledgeFaqImportResponse,
  KnowledgeFaqImportResult,
  KnowledgeFaqImportState,
  KnowledgeJobPayload,
  ResourceAccessFilter,
} from '@agentport/shared';
import { knowledgeFaqImportMetadataSchema } from '@agentport/shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type PageQuery, pageOptions, requireCursorPage } from '../../../http/pagination.js';
import {
  FAQ_MAX_BYTES,
  type FaqExistingEntry,
  type FaqInput,
  type FaqTransferEntry,
  newFaqImportBatchId,
  normalizeFaqEntry,
  normalizeFaqQuestion,
  parseFaqImport,
  planFaqImport,
  serializeFaqExport,
} from '../faq.js';
import { searchKnowledge } from '../retrieval.js';
import {
  createJob,
  enqueueKnowledgeJobAfterCommit,
  enqueueKnowledgeJobsAfterCommit,
  storeBlob,
} from '../service.js';
import {
  assertBodyBytes,
  assertFolderInBase,
  type DocumentRow,
  type KnowledgeDeps,
  notFound,
  type VersionRow,
} from './shared.js';

const FAQ_IMPORT_BODY_LIMIT = 3 * 1024 * 1024;

function faqMarkdown(faq: KnowledgeFaq): string {
  return [`# ${faq.question}`, ...faq.answers.filter((answer) => answer.trim().length > 0)].join(
    '\n\n',
  );
}

function toFaqDocument(row: DocumentRow, tags: string[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    folderId: row.folderId,
    title: row.title,
    contentKind: row.contentKind,
    status: row.status,
    disabledReason: row.disabledReason,
    currentVersionId: row.currentVersionId,
    tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toFaqVersion(row: VersionRow, isCurrent: boolean) {
  return {
    id: row.id,
    documentId: row.documentId,
    version: row.version,
    origin: row.origin,
    parentVersionId: row.parentVersionId,
    metadata: row.metadata,
    faq: row.faq,
    isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadFaqDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (document?.contentKind !== 'faq' || document.sourceType !== 'manual') notFound('FAQ');
  return document;
}

async function latestFaqDraftVersion(
  deps: KnowledgeDeps,
  documentId: string,
  currentVersionId: string | null,
) {
  const [row] = await deps.db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(
      and(
        eq(schema.knowledgeDocumentVersions.documentId, documentId),
        currentVersionId === null
          ? undefined
          : sql`${schema.knowledgeDocumentVersions.id} <> ${currentVersionId}`,
        sql`${schema.knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
      ),
    )
    .orderBy(desc(schema.knowledgeDocumentVersions.version))
    .limit(1);
  return row ?? null;
}

function isDraftFaqVersion(document: DocumentRow, version: VersionRow): boolean {
  return version.id !== document.currentVersionId && version.metadata?.publication === 'draft';
}

function faqEnabledForVersion(document: DocumentRow, version: VersionRow): boolean {
  if (isDraftFaqVersion(document, version)) {
    const imported = knowledgeFaqImportMetadataSchema.safeParse(version.metadata?.faqImport);
    if (imported.success) return imported.data.enabled;
  }
  return document.status !== 'disabled' && document.disabledReason === null;
}

function cleanFaqInput(input: FaqInput): {
  faq: KnowledgeFaq;
  issues: KnowledgeFaqImportIssue[];
} {
  const normalized = normalizeFaqEntry(input);
  if (!normalized.entry) {
    fail('INVALID_INPUT', normalized.issues[0]?.message ?? 'FAQ 内容不合法');
  }
  const entry = normalized.entry;
  return {
    faq: {
      question: entry.question,
      similarQuestions: entry.similarQuestions,
      negativeQuestions: entry.negativeQuestions,
      answers: entry.answers,
      answerStrategy: entry.answerStrategy,
      isRecommended: entry.isRecommended,
    },
    issues: normalized.issues,
  };
}

async function loadFaqVersionState(
  db: KnowledgeDeps['db'],
  documents: DocumentRow[],
): Promise<{
  versionById: Map<string, VersionRow>;
  draftByDocument: Map<string, VersionRow>;
}> {
  if (documents.length === 0) {
    return {
      versionById: new Map(),
      draftByDocument: new Map(),
    };
  }
  const versions = await db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(
      and(
        inArray(
          schema.knowledgeDocumentVersions.documentId,
          documents.map((document) => document.id),
        ),
        isNotNull(schema.knowledgeDocumentVersions.faq),
      ),
    )
    .orderBy(desc(schema.knowledgeDocumentVersions.version));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const draftByDocument = new Map<string, VersionRow>();
  for (const version of versions) {
    if (version.metadata.publication !== 'draft') continue;
    const document = documentById.get(version.documentId);
    if (!document || version.id === document.currentVersionId) continue;
    if (!draftByDocument.has(version.documentId)) draftByDocument.set(version.documentId, version);
  }
  return { versionById, draftByDocument };
}

async function loadExistingFaqEntries(
  deps: KnowledgeDeps,
  baseId: string,
): Promise<FaqExistingEntry[]> {
  const documents = await deps.db
    .select()
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.baseId, baseId),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
      ),
    )
    .orderBy(schema.knowledgeDocuments.id);
  if (documents.length === 0) return [];
  const { versionById, draftByDocument } = await loadFaqVersionState(deps.db, documents);
  return documents.flatMap((document) => {
    const draft = draftByDocument.get(document.id) ?? null;
    const published = document.currentVersionId
      ? versionById.get(document.currentVersionId)
      : undefined;
    const current = draft ?? published;
    if (!current?.faq) return [];
    return [
      {
        documentId: document.id,
        faq: current.faq,
        enabled: faqEnabledForVersion(document, current),
        latestDraftVersionId: draft?.id ?? null,
        publishedVersionId: document.currentVersionId,
        updatedAt: document.updatedAt.toISOString(),
      },
    ];
  });
}

function existingState(entry: FaqExistingEntry): KnowledgeFaqImportState {
  return {
    documentId: entry.documentId,
    currentVersionId: entry.publishedVersionId,
    latestDraftVersionId: entry.latestDraftVersionId,
    updatedAt: entry.updatedAt,
  };
}

function positiveKeysOf(faq: KnowledgeFaq): string[] {
  return [faq.question, ...faq.similarQuestions].map(normalizeFaqQuestion);
}

async function assertNoPositiveConflict(
  deps: KnowledgeDeps,
  baseId: string,
  faq: KnowledgeFaq,
  options: { ignoreDocumentId?: string } = {},
): Promise<void> {
  const existing = await loadExistingFaqEntries(deps, baseId);
  const incoming = new Set(positiveKeysOf(faq));
  for (const entry of existing) {
    if (entry.documentId === options.ignoreDocumentId) continue;
    const conflict = positiveKeysOf(entry.faq).find((key) => incoming.has(key));
    if (conflict) fail('CONFLICT', 'FAQ 正向问已存在，请修改问题或答案');
  }
}

interface WriteFaqVersionInput {
  base: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>;
  document: DocumentRow;
  faq: KnowledgeFaq;
  title: string;
  tags: string[] | undefined;
  parentVersionId: string | null;
  auditAction: string;
}

async function writeVersionFiles(
  deps: KnowledgeDeps,
  documentId: string,
  versionId: string,
  markdown: string,
  faqJson: string,
): Promise<void> {
  const markdownPath = knowledgeVersionMarkdownPath(
    deps.config.KNOWLEDGE_DIR,
    documentId,
    versionId,
  );
  await storeBlob(deps.config.KNOWLEDGE_DIR, Buffer.from(faqJson, 'utf8'));
  await mkdir(dirname(markdownPath), { recursive: true });
  await Bun.write(markdownPath, markdown);
}

async function writeFaqVersion(deps: KnowledgeDeps, input: WriteFaqVersionInput) {
  if (input.tags !== undefined) {
    const tags =
      input.tags.length === 0
        ? []
        : (await repo.knowledge.upsertTags(deps.db, input.base.id, input.tags)).map(
            (tag) => tag.id,
          );
    await repo.knowledge.setDocumentTags(deps.db, input.document.id, tags);
  }
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const originalFilename = `${input.title}.faq.json`;
  const mimeType = 'application/json';
  const blobSha = sha256Hex(faqJson);
  const markdownSha256 = sha256Hex(markdown);
  await writeVersionFiles(deps, input.document.id, versionId, markdown, faqJson);
  const payload: KnowledgeJobPayload = {
    type: 'ingest',
    documentId: input.document.id,
    publish: 'draft',
    versionId,
    input: {
      blobSha256: blobSha,
      filename: originalFilename,
      mimeType,
      expectedCurrentVersionId: input.parentVersionId,
    },
  };
  const { version, job } = await deps.db.transaction(async (tx) => {
    const job = await createJob(tx, {
      baseId: input.base.id,
      documentId: input.document.id,
      payload,
    });
    const version = await repo.knowledge.createVersion(tx, {
      id: versionId,
      documentId: input.document.id,
      blobSha256: blobSha,
      markdownSha256,
      originalFilename,
      mimeType,
      sizeBytes: Buffer.byteLength(faqJson, 'utf8'),
      sourceRevision: null,
      origin: 'faq',
      parentVersionId: input.parentVersionId,
      metadata: { publication: 'draft', indexingJobId: job.id },
      faq: input.faq,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: input.base.embeddingProfileId,
    });
    return { version, job };
  });
  await enqueueKnowledgeJobAfterCommit(deps.log, job);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: input.auditAction,
    target: input.document.id,
    input: { title: input.title, question: input.faq.question },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { version, jobId: job.id };
}

interface CreateFaqInput extends Omit<WriteFaqVersionInput, 'document'> {
  folderId: string | null;
}

async function createFaqDraft(deps: KnowledgeDeps, input: CreateFaqInput) {
  await repo.governance.assertKnowledgeDocumentQuota(deps.db, input.base.id);
  const document = await repo.knowledge.createDocument(deps.db, {
    baseId: input.base.id,
    folderId: input.folderId,
    title: input.title,
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'application/json',
    sizeBytes: Buffer.byteLength(JSON.stringify(input.faq), 'utf8'),
    contentKind: 'faq',
    metadata: { originalFilename: `${input.title}.faq.json` },
  });
  let result: Awaited<ReturnType<typeof writeFaqVersion>>;
  try {
    result = await writeFaqVersion(deps, { ...input, document });
  } catch (err) {
    await repo.knowledge.deleteDocument(deps.db, document.id).catch(() => undefined);
    throw err;
  }
  await repo.governance.notifyKnowledgeDocumentQuota(deps.db, input.base.id);
  return { document, ...result };
}

async function publishFaqVersion(
  deps: KnowledgeDeps,
  document: DocumentRow,
  versionId: string,
  expectedVersionId: string | null,
) {
  if (document.currentVersionId !== expectedVersionId) {
    fail('CONFLICT_STALE', 'FAQ 版本已变化，请刷新后重试');
  }
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version || version.documentId !== document.id || version.faq === null) {
    fail('NOT_FOUND', '版本不存在或不属于该 FAQ');
  }
  const [indexJob] = await deps.db
    .select({ status: schema.knowledgeJobs.status })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.documentId, document.id),
        eq(schema.knowledgeJobs.type, 'ingest'),
        sql`${schema.knowledgeJobs.payload} ->> 'versionId' = ${versionId}`,
      ),
    )
    .orderBy(desc(schema.knowledgeJobs.createdAt), desc(schema.knowledgeJobs.id))
    .limit(1);
  if (indexJob?.status !== 'succeeded') {
    fail('CONFLICT', 'FAQ 草稿索引尚未完成，完成后再发布');
  }
  const [chunkCount] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.versionId, versionId));
  if (!chunkCount || chunkCount.count === 0) {
    fail('CONFLICT', 'FAQ 草稿索引尚未就绪，完成后再发布');
  }
  const updated = await repo.knowledge.setCurrentVersion(
    deps.db,
    document.id,
    versionId,
    undefined,
    {
      expectedCurrentVersionId: expectedVersionId,
    },
  );
  if (!updated) fail('CONFLICT', 'FAQ 已停用、批次草稿或版本不可发布，请刷新后重试');
  return updated;
}

async function setFaqEnabled(deps: KnowledgeDeps, document: DocumentRow, enabled: boolean) {
  const status = enabled ? (document.currentVersionId ? 'ready' : 'pending') : 'disabled';
  const updated = await repo.knowledge.updateDocument(deps.db, document.id, {
    status,
    disabledReason: enabled ? null : 'manual',
  });
  if (!updated) fail('NOT_FOUND', 'FAQ 不存在，可能已被删除');
  return updated;
}

async function prepareImportDraft(
  deps: KnowledgeDeps,
  input: {
    operation: 'add' | 'merge';
    documentId: string;
    faq: KnowledgeFaq;
    enabled: boolean;
  },
): Promise<repo.knowledge.FaqImportDraftInput> {
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const blobSha = sha256Hex(faqJson);
  await writeVersionFiles(deps, input.documentId, versionId, markdown, faqJson);
  return {
    ...input,
    version: {
      id: versionId,
      blobSha256: blobSha,
      markdownSha256: sha256Hex(markdown),
      originalFilename: `${input.faq.question.slice(0, 300)}.faq.json`,
      mimeType: 'application/json',
      sizeBytes: Buffer.byteLength(faqJson, 'utf8'),
      sourceRevision: null,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
    },
    ...(input.operation === 'add'
      ? { title: input.faq.question.slice(0, 300), folderId: null }
      : {}),
  };
}

export async function listFaqs(
  deps: KnowledgeDeps,
  id: string,
  query: PageQuery & {
    q?: string | undefined;
    status?: KnowledgeDocumentStatus | undefined;
    folderId?: string | undefined;
    isRecommended?: boolean | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const page = requireCursorPage(
    await repo.knowledge.listFaqDocuments(deps.db, {
      ...pageOptions(query),
      baseId: base.id,
      ...(query.folderId === undefined
        ? {}
        : { folderId: query.folderId === 'null' ? null : query.folderId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.isRecommended === undefined ? {} : { isRecommended: query.isRecommended }),
    }),
  );
  const ids = page.items.map((row) => row.id);
  const [tags, versions] = await Promise.all([
    repo.knowledge.getDocumentTagNames(deps.db, ids),
    ids.length === 0
      ? Promise.resolve([] as VersionRow[])
      : deps.db
          .select()
          .from(schema.knowledgeDocumentVersions)
          .where(
            and(
              inArray(schema.knowledgeDocumentVersions.documentId, ids),
              isNotNull(schema.knowledgeDocumentVersions.faq),
            ),
          )
          .orderBy(desc(schema.knowledgeDocumentVersions.version)),
  ]);
  const latest = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!latest.has(version.documentId)) latest.set(version.documentId, version);
  }
  return {
    items: page.items.map((row) => ({
      ...toFaqDocument(row, tags.get(row.id) ?? []),
      faq: latest.get(row.id)?.faq ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}

async function activeFaqBase(deps: KnowledgeDeps, id: string) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
  return base;
}

export async function createFaq(
  deps: KnowledgeDeps,
  id: string,
  body: {
    title?: string | undefined;
    faq: FaqInput;
    folderId: string | null;
    tags: string[];
  },
) {
  const base = await activeFaqBase(deps, id);
  await assertFolderInBase(deps, base.id, body.folderId);
  const cleaned = cleanFaqInput(body.faq);
  await assertNoPositiveConflict(deps, base.id, cleaned.faq);
  const result = await createFaqDraft(deps, {
    base,
    faq: cleaned.faq,
    title: body.title ?? cleaned.faq.question.slice(0, 300),
    folderId: body.folderId,
    tags: body.tags,
    parentVersionId: null,
    auditAction: 'knowledge.faq.created',
  });
  return {
    documentId: result.document.id,
    jobId: result.jobId,
    ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
  };
}

async function faqDetail(deps: KnowledgeDeps, document: DocumentRow) {
  const [published, draft, tags] = await Promise.all([
    document.currentVersionId
      ? repo.knowledge.getVersion(deps.db, document.currentVersionId)
      : null,
    latestFaqDraftVersion(deps, document.id, document.currentVersionId),
    repo.knowledge.getDocumentTagNames(deps.db, [document.id]),
  ]);
  return {
    document: toFaqDocument(document, tags.get(document.id) ?? []),
    draftVersion: draft ? toFaqVersion(draft, false) : null,
    publishedVersion: published
      ? toFaqVersion(published, published.id === document.currentVersionId)
      : null,
    faq: draft?.faq ?? published?.faq ?? null,
  };
}

export async function getFaq(deps: KnowledgeDeps, documentId: string) {
  const document = await loadFaqDocument(deps, documentId);
  return faqDetail(deps, document);
}

export async function faqDrafts(
  deps: KnowledgeDeps,
  documentIds: string[],
  access: ResourceAccessFilter,
) {
  const scope = repo.access.resourceScopeWhere(
    access,
    schema.knowledgeBases.id,
    schema.knowledgeBases.ownerBusinessId,
  );
  const documents = await deps.db
    .select({
      id: schema.knowledgeDocuments.id,
      baseId: schema.knowledgeBases.id,
      currentVersionId: schema.knowledgeDocuments.currentVersionId,
    })
    .from(schema.knowledgeDocuments)
    .innerJoin(
      schema.knowledgeBases,
      eq(schema.knowledgeDocuments.baseId, schema.knowledgeBases.id),
    )
    .where(
      and(
        inArray(schema.knowledgeDocuments.id, documentIds),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
        eq(schema.knowledgeDocuments.sourceType, 'manual'),
        scope,
      ),
    );
  if (documents.length === 0) return [];
  const versions = await deps.db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(
      and(
        inArray(
          schema.knowledgeDocumentVersions.documentId,
          documents.map((document) => document.id),
        ),
        sql`${schema.knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
      ),
    )
    .orderBy(desc(schema.knowledgeDocumentVersions.version));
  const currentVersions = new Map(
    documents.map((document) => [document.id, document.currentVersionId]),
  );
  const latest = new Map<string, VersionRow>();
  for (const version of versions) {
    if (version.id === currentVersions.get(version.documentId)) continue;
    if (!latest.has(version.documentId)) latest.set(version.documentId, version);
  }
  return documents.map((document) => {
    const draft = latest.get(document.id);
    return {
      documentId: document.id,
      baseId: document.baseId,
      draft: draft ? toFaqVersion(draft, false) : null,
    };
  });
}

export async function updateFaq(
  deps: KnowledgeDeps,
  documentId: string,
  body: {
    title?: string | undefined;
    faq: FaqInput;
    folderId?: string | null | undefined;
    tags?: string[] | undefined;
    expectedVersionId: string;
  },
) {
  const document = await loadFaqDocument(deps, documentId);
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
  const draft = await latestFaqDraftVersion(deps, document.id, document.currentVersionId);
  const expectedVersionId = draft?.id ?? document.currentVersionId;
  if (expectedVersionId !== body.expectedVersionId) {
    throw new AppError('CONFLICT_STALE', 'FAQ 已被修改，请刷新后重试');
  }
  await assertFolderInBase(deps, base.id, body.folderId ?? document.folderId);
  const cleaned = cleanFaqInput(body.faq);
  await assertNoPositiveConflict(deps, base.id, cleaned.faq, { ignoreDocumentId: document.id });
  const result = await writeFaqVersion(deps, {
    base,
    document,
    faq: cleaned.faq,
    title: body.title ?? document.title,
    tags: body.tags,
    parentVersionId: body.expectedVersionId,
    auditAction: 'knowledge.faq.updated',
  });
  const documentPatch: { title?: string; folderId?: string | null } = {};
  if (body.title !== undefined) documentPatch.title = body.title;
  if (body.folderId !== undefined) documentPatch.folderId = body.folderId;
  if (Object.keys(documentPatch).length > 0) {
    await repo.knowledge.updateDocument(deps.db, document.id, documentPatch);
  }
  return {
    documentId: document.id,
    jobId: result.jobId,
    ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
  };
}

export async function deleteFaq(deps: KnowledgeDeps, documentId: string): Promise<void> {
  const document = await loadFaqDocument(deps, documentId);
  await repo.knowledge.deleteDocument(deps.db, document.id);
}

export async function publishFaq(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await loadFaqDocument(deps, documentId);
  const updated = await publishFaqVersion(deps, document, body.versionId, body.expectedVersionId);
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [updated.id]);
  return toFaqDocument(updated, tags.get(updated.id) ?? []);
}

export async function setFaqStatus(deps: KnowledgeDeps, documentId: string, enabled: boolean) {
  const document = await loadFaqDocument(deps, documentId);
  const updated = await setFaqEnabled(deps, document, enabled);
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [updated.id]);
  return toFaqDocument(updated, tags.get(updated.id) ?? []);
}

export async function faqBatch(
  deps: KnowledgeDeps,
  id: string,
  input: {
    action: 'publish' | 'enable' | 'disable' | 'delete';
    items: Array<{
      documentId: string;
      versionId?: string | undefined;
      expectedVersionId?: string | null | undefined;
    }>;
    importBatchId?: string | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.importBatchId !== undefined) {
    if (input.action !== 'publish' || input.items.length > 500) {
      throw new AppError('INVALID_INPUT', '导入批次只能整批发布，最多 500 条');
    }
    const published = await repo.knowledge.publishFaqImport(deps.db, {
      baseId: base.id,
      importBatchId: input.importBatchId,
      items: input.items.map((item) => {
        if (item.versionId === undefined || item.expectedVersionId === undefined) {
          fail('INVALID_INPUT', '发布需要 versionId 与 expectedVersionId');
        }
        return {
          documentId: item.documentId,
          versionId: item.versionId,
          expectedVersionId: item.expectedVersionId,
        };
      }),
    });
    return {
      results: published.map((document) => ({
        documentId: document.id,
        status: 'succeeded' as const,
      })),
    };
  }
  if (input.items.length > 100) {
    throw new AppError('INVALID_INPUT', '普通批量操作最多 100 条');
  }
  const results: Array<{
    documentId: string;
    status: 'succeeded' | 'failed';
    code?: string | undefined;
    message?: string | undefined;
  }> = [];
  const documents = await repo.knowledge
    .getDocumentsByIds(
      deps.db,
      input.items.map((item) => item.documentId),
    )
    .catch(() => new Map<string, repo.knowledge.KnowledgeDocumentRow>());
  for (const item of input.items) {
    const document = documents.get(item.documentId);
    if (!document || document.baseId !== base.id || document.contentKind !== 'faq') {
      results.push({
        documentId: item.documentId,
        status: 'failed',
        code: 'NOT_FOUND',
        message: 'FAQ 不存在或不属于该知识库',
      });
      continue;
    }
    try {
      if (input.action === 'publish') {
        if (item.versionId === undefined || item.expectedVersionId === undefined) {
          fail('INVALID_INPUT', '发布需要 versionId 与 expectedVersionId');
        }
        const updated = await publishFaqVersion(
          deps,
          document,
          item.versionId,
          item.expectedVersionId,
        );
        documents.set(updated.id, updated);
      } else if (input.action === 'delete') {
        if (!(await repo.knowledge.deleteDocument(deps.db, document.id))) {
          results.push({
            documentId: document.id,
            status: 'failed',
            code: 'NOT_FOUND',
            message: 'FAQ 不存在或不属于该知识库',
          });
          continue;
        }
      } else {
        await setFaqEnabled(deps, document, input.action === 'enable');
      }
      results.push({ documentId: document.id, status: 'succeeded' });
    } catch (err) {
      results.push({
        documentId: document.id,
        status: 'failed',
        code: isAppError(err) ? err.code : 'INTERNAL_ERROR',
        message: isAppError(err) ? err.message : '操作失败',
      });
    }
  }
  return { results };
}

export async function importFaqs(
  deps: KnowledgeDeps,
  id: string,
  input: {
    format: 'json' | 'csv' | 'xlsx';
    content: string;
    mode: 'append' | 'replace';
    dryRun: boolean;
  },
): Promise<KnowledgeFaqImportResponse> {
  const base = await activeFaqBase(deps, id);
  assertBodyBytes(input.content, FAQ_IMPORT_BODY_LIMIT);
  const rows = await parseFaqImport({ format: input.format, content: input.content });
  const existing = await loadExistingFaqEntries(deps, base.id);
  const plan = planFaqImport({
    mode: input.mode,
    rows,
    existing,
    newDocumentId: () => newId('knowledgeDocument'),
  });
  const response: KnowledgeFaqImportResponse = {
    dryRun: input.dryRun,
    mode: input.mode,
    committed: false,
    importBatchId: null as string | null,
    counts: plan.counts,
    results: plan.results,
  };
  if (input.dryRun) return response;
  if (plan.counts.failed > 0) return response;
  if (plan.drafts.length === 0) {
    if (input.mode === 'replace') {
      throw new AppError('INVALID_INPUT', '替换批次为空，未执行删除');
    }
    return response;
  }
  await repo.governance.assertKnowledgeDocumentQuota(
    deps.db,
    base.id,
    plan.drafts.filter((draft) => draft.operation === 'add').length,
  );
  const importBatchId = newFaqImportBatchId();
  const existingById = new Map(existing.map((entry) => [entry.documentId, entry]));
  const targets =
    input.mode === 'replace'
      ? existing
      : plan.drafts.flatMap((draft) => {
          const entry = existingById.get(draft.documentId);
          return entry ? [entry] : [];
        });
  const prepared: repo.knowledge.FaqImportDraftInput[] = [];
  for (const draft of plan.drafts) {
    prepared.push(
      await prepareImportDraft(deps, {
        operation: draft.operation,
        documentId: draft.documentId,
        faq: draft.faq,
        enabled: draft.enabled,
      }),
    );
  }
  const saved = await repo.knowledge.saveFaqImportDrafts(deps.db, {
    baseId: base.id,
    importBatchId,
    mode: input.mode,
    expectedState: targets.map(existingState),
    drafts: prepared,
  });
  const jobs = new Map(saved.items.map((item) => [item.documentId, item]));
  await enqueueKnowledgeJobsAfterCommit(
    deps.log,
    saved.items.map((item) => ({ id: item.jobId })),
  );
  await repo.governance.notifyKnowledgeDocumentQuota(deps.db, base.id);
  const results: KnowledgeFaqImportResult[] = plan.results.map((result) => {
    const item = result.documentId ? jobs.get(result.documentId) : undefined;
    return item
      ? { ...result, expectedVersionId: item.expectedVersionId, jobId: item.jobId }
      : result;
  });
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.faq.imported',
    target: base.id,
    input: { importBatchId, mode: input.mode, counts: plan.counts },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { ...response, committed: true, importBatchId, results };
}

export async function testFaqs(
  deps: KnowledgeDeps,
  id: string,
  body: {
    q: string;
    limit: number;
    rerank: boolean;
    minVectorScore: number;
    onlyRecommended: boolean;
    faqPriority: boolean;
    faqDirectAnswerThreshold: number;
  },
) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  return searchKnowledge(
    deps.db,
    id,
    {
      q: body.q,
      kinds: ['faq'],
      folders: [],
      tags: [],
      limit: body.limit,
      rerank: body.rerank,
      minVectorScore: body.minVectorScore,
      diagnostics: false,
      onlyRecommended: body.onlyRecommended,
      faqPriority: body.faqPriority,
      faqDirectAnswerThreshold: body.faqDirectAnswerThreshold,
    },
    { secretKey: deps.config.APP_SECRET_KEY },
  );
}

export async function exportFaqs(
  deps: KnowledgeDeps,
  id: string,
  query: { format: 'json' | 'csv'; version: 'published' | 'draft' },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const documents = await deps.db
    .select()
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.baseId, base.id),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
      ),
    )
    .orderBy(desc(schema.knowledgeDocuments.createdAt), desc(schema.knowledgeDocuments.id))
    .limit(501);
  if (documents.length > 500) {
    throw new AppError('CONFLICT', 'FAQ 超过 500 条，无法一次导出');
  }
  const { versionById, draftByDocument } = await loadFaqVersionState(deps.db, documents);
  const items = documents.flatMap((document) => {
    const published = document.currentVersionId
      ? versionById.get(document.currentVersionId)
      : undefined;
    const draft = draftByDocument.get(document.id);
    const version = query.version === 'published' ? published : (draft ?? published);
    if (!version?.faq) return [];
    return [
      {
        ...version.faq,
        enabled: faqEnabledForVersion(document, version),
      } satisfies FaqTransferEntry,
    ];
  });
  const content = serializeFaqExport(query.format, items);
  if (Buffer.byteLength(content, 'utf8') > FAQ_MAX_BYTES) {
    throw new AppError('CONFLICT', 'FAQ 导出内容超过 2MiB，请缩小范围');
  }
  return {
    content,
    contentType: query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    filename: `faqs.${query.format}`,
  };
}
