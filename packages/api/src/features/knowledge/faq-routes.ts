import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail, isAppError } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import {
  type KnowledgeFaq,
  type KnowledgeFaqImportIssue,
  type KnowledgeFaqImportResult,
  type KnowledgeFaqImportState,
  type KnowledgeJobPayload,
  knowledgeFaqImportInputSchema,
  knowledgeFaqImportMetadataSchema,
} from '@agentport/shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { problem, reject, toAppError } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf, authorizeObject } from '../access.js';
import {
  FAQ_MAX_BYTES,
  type FaqExistingEntry,
  type FaqInput,
  type FaqTransferEntry,
  faqInputSchema,
  newFaqImportBatchId,
  normalizeFaqEntry,
  normalizeFaqQuestion,
  parseFaqImport,
  planFaqImport,
  serializeFaqExport,
} from './faq.js';
import { searchKnowledge } from './retrieval.js';
import { createJob, enqueueKnowledgeJob } from './service.js';

const baseParams = z.object({ id: z.string().min(1) });
const faqParams = z.object({ documentId: z.string().min(1) });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const listQuery = pageQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed', 'disabled']).optional(),
  folderId: z.string().optional(),
  isRecommended: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const faqCreateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  faq: faqInputSchema,
  folderId: z.string().min(1).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});
const faqUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  faq: faqInputSchema,
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  expectedVersionId: z.string().min(1),
});

const publishSchema = z.object({
  versionId: z.string().min(1),
  expectedVersionId: z.string().min(1).nullable(),
});
const statusSchema = z.object({ enabled: z.boolean() });
const batchSchema = z.object({
  action: z.enum(['publish', 'enable', 'disable', 'delete']),
  items: z
    .array(
      z.object({
        documentId: z.string().min(1),
        versionId: z.string().min(1).optional(),
        expectedVersionId: z.string().min(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  importBatchId: z.string().min(1).optional(),
});
const exportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  version: z.enum(['published', 'draft']).default('published'),
});
const testSchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  minVectorScore: z.number().min(-1).max(1).default(0.3),
  onlyRecommended: z.boolean().default(false),
  faqPriority: z.boolean().default(false),
  faqDirectAnswerThreshold: z.number().min(-1).max(1).default(0.9),
});

type DocumentRow = typeof schema.knowledgeDocuments.$inferSelect;
type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

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

async function loadFaqDocument(
  app: FastifyInstance,
  documentId: string,
  reply: FastifyReply,
): Promise<DocumentRow | null> {
  const document = await repo.knowledge.getDocument(app.db, documentId);
  if (document?.contentKind !== 'faq' || document.sourceType !== 'manual') {
    reject(reply, 'NOT_FOUND', 'FAQ 不存在，可能已被删除');
    return null;
  }
  return document;
}

async function latestVersion(app: FastifyInstance, documentId: string): Promise<VersionRow | null> {
  const [row] = await app.db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(eq(schema.knowledgeDocumentVersions.documentId, documentId))
    .orderBy(desc(schema.knowledgeDocumentVersions.version))
    .limit(1);
  return row ?? null;
}

function isPublishedFaqVersion(document: DocumentRow, version: VersionRow): boolean {
  return version.id === document.currentVersionId || version.metadata?.publication === 'published';
}

/** 只有未发布的导入草稿使用目标 enabled；已发布一律回到文档当前启停状态。 */
function faqEnabledForVersion(document: DocumentRow, version: VersionRow): boolean {
  if (!isPublishedFaqVersion(document, version)) {
    const imported = knowledgeFaqImportMetadataSchema.safeParse(version.metadata?.faqImport);
    if (imported.success) return imported.data.enabled;
  }
  return document.status !== 'disabled' && document.disabledReason === null;
}

/** CRUD 与导入共用同一清洗入口；输入已由 handler schema 校验原始类型，内部不再 safeParse。 */
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

/** 导入判重读取每篇 FAQ 的最新草稿（无则发布版），与 A 的 expectedState 同源。 */
async function loadExistingFaqEntries(
  app: FastifyInstance,
  baseId: string,
): Promise<FaqExistingEntry[]> {
  const documents = await app.db
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
  const versions = await app.db
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
  const latestByDocument = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!latestByDocument.has(version.documentId)) {
      latestByDocument.set(version.documentId, version);
    }
  }
  return documents.flatMap((document) => {
    const latest = latestByDocument.get(document.id);
    const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : null;
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

/** 单条 FAQ 冲突：任一正向问与其他 FAQ 归一化后相同。 */
function positiveKeysOf(faq: KnowledgeFaq): string[] {
  return [faq.question, ...faq.similarQuestions].map(normalizeFaqQuestion);
}

async function assertNoPositiveConflict(
  app: FastifyInstance,
  baseId: string,
  faq: KnowledgeFaq,
  options: { ignoreDocumentId?: string } = {},
): Promise<void> {
  const existing = await loadExistingFaqEntries(app, baseId);
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
  requestId: string;
  actor: string;
  log: FastifyInstance['log'];
  auditAction: string;
}

/** 草稿版本 = 带 faq 的快照 + ingest(publish=draft)；线上指针不动。 */
async function writeFaqVersion(
  app: FastifyInstance,
  input: WriteFaqVersionInput,
): Promise<{ version: VersionRow; jobId: string }> {
  if (input.tags !== undefined) {
    const tags =
      input.tags.length === 0
        ? []
        : (await repo.knowledge.upsertTags(app.db, input.base.id, input.tags)).map((tag) => tag.id);
    await repo.knowledge.setDocumentTags(app.db, input.document.id, tags);
  }
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const originalFilename = `${input.title}.faq.json`;
  const mimeType = 'application/json';
  const blobSha = sha256(faqJson);
  const markdownSha256 = sha256(markdown);
  // 文件按预分配版本号先写完整；版本与它自己的索引任务同事务落库，发布守卫才能按任务输入核对。
  await writeVersionFiles(app, input.document.id, versionId, blobSha, markdown, faqJson);
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
  const { version, job } = await app.db.transaction(async (tx) => {
    // 任务先建，版本的 metadata 才能记下自己的 indexingJobId。
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
  await enqueueKnowledgeJob(job);
  await writeAudit(app.db, input.log, {
    actor: input.actor,
    action: input.auditAction,
    target: input.document.id,
    input: { title: input.title, question: input.faq.question },
    status: 'ok',
    requestId: input.requestId,
  });
  return { version, jobId: job.id };
}

async function writeVersionFiles(
  app: FastifyInstance,
  documentId: string,
  versionId: string,
  blobSha: string,
  markdown: string,
  faqJson: string,
): Promise<void> {
  const blobPath = join(app.config.KNOWLEDGE_DIR, 'blobs', blobSha.slice(0, 2), blobSha);
  const markdownPath = join(app.config.KNOWLEDGE_DIR, 'docs', documentId, versionId, 'markdown.md');
  await mkdir(dirname(blobPath), { recursive: true });
  await writeFile(blobPath, faqJson);
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown);
}

interface CreateFaqInput extends Omit<WriteFaqVersionInput, 'document'> {
  folderId: string | null;
}

/** 新建 FAQ 文档后写首个草稿；任一步失败都不留半成品。 */
async function createFaqDraft(
  app: FastifyInstance,
  input: CreateFaqInput,
): Promise<{ document: DocumentRow; version: VersionRow; jobId: string }> {
  const document = await repo.knowledge.createDocument(app.db, {
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
  try {
    const result = await writeFaqVersion(app, { ...input, document });
    return { document, ...result };
  } catch (err) {
    await repo.knowledge.deleteDocument(app.db, document.id).catch(() => undefined);
    throw err;
  }
}

async function publishFaqVersion(
  app: FastifyInstance,
  document: DocumentRow,
  versionId: string,
  expectedVersionId: string | null,
): Promise<DocumentRow> {
  if ((document.currentVersionId ?? null) !== expectedVersionId) {
    fail('CONFLICT_STALE', 'FAQ 版本已变化，请刷新后重试');
  }
  const version = await repo.knowledge.getVersion(app.db, versionId);
  if (!version || version.documentId !== document.id || version.faq === null) {
    fail('NOT_FOUND', '版本不存在或不属于该 FAQ');
  }
  // 索引任务成功才算就绪；失败任务会留下 partial chunks，不能用「有块」代替。
  const [indexJob] = await app.db
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
  const [chunkCount] = await app.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.versionId, versionId));
  if (!chunkCount || chunkCount.count === 0) {
    fail('CONFLICT', 'FAQ 草稿索引尚未就绪，完成后再发布');
  }
  // 切指针同事务核对文档归属、停用、模型空间与批次导入限制；FAQ 无外部来源。
  const updated = await repo.knowledge.setCurrentVersion(app.db, document.id, versionId);
  if (!updated) fail('CONFLICT', 'FAQ 已停用、批次草稿或版本不可发布，请刷新后重试');
  return updated;
}

async function setFaqEnabled(
  app: FastifyInstance,
  document: DocumentRow,
  enabled: boolean,
): Promise<DocumentRow> {
  const status = enabled ? (document.currentVersionId ? 'ready' : 'pending') : 'disabled';
  const updated = await repo.knowledge.updateDocument(app.db, document.id, {
    status,
    disabledReason: enabled ? null : 'manual',
  });
  if (!updated) fail('NOT_FOUND', 'FAQ 不存在，可能已被删除');
  return updated;
}

interface PreparedDraft {
  draft: {
    operation: 'add' | 'merge';
    documentId: string;
    faq: KnowledgeFaq;
    enabled: boolean;
    version: {
      id: string;
      blobSha256: string;
      markdownSha256: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      sourceRevision: null;
      parseStatus: 'parsed';
      pageMap: [];
      images: [];
      embeddingProfileId: string;
    };
    title?: string;
    folderId?: string | null;
  };
}

/** 文件在事务前写完整；repo 事务只落 DB（契约 A 的明确边界）。 */
async function prepareImportDraft(
  app: FastifyInstance,
  base: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>,
  input: {
    operation: 'add' | 'merge';
    documentId: string;
    faq: KnowledgeFaq;
    enabled: boolean;
  },
): Promise<PreparedDraft> {
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const blobSha = sha256(faqJson);
  await writeVersionFiles(app, input.documentId, versionId, blobSha, markdown, faqJson);
  return {
    draft: {
      ...input,
      version: {
        id: versionId,
        blobSha256: blobSha,
        markdownSha256: sha256(markdown),
        originalFilename: `${input.faq.question.slice(0, 300)}.faq.json`,
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(faqJson, 'utf8'),
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        embeddingProfileId: base.embeddingProfileId,
      },
      ...(input.operation === 'add'
        ? { title: input.faq.question.slice(0, 300), folderId: null }
        : {}),
    },
  };
}

export function registerFaqRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  const loadActiveBase = async (id: string, reply: FastifyReply) => {
    const base = await repo.knowledge.getBase(app.db, id);
    if (!base) {
      reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      return null;
    }
    if (base.status !== 'active') {
      reject(reply, 'CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
      return null;
    }
    return base;
  };

  const folderIssue = async (baseId: string, folderId: string | null): Promise<boolean> => {
    if (!folderId) return false;
    const folder = await repo.knowledge.getFolder(app.db, folderId);
    return !folder || folder.baseId !== baseId;
  };

  const detail = async (document: DocumentRow) => {
    const [published, latest, tags] = await Promise.all([
      document.currentVersionId
        ? repo.knowledge.getVersion(app.db, document.currentVersionId)
        : null,
      latestVersion(app, document.id),
      repo.knowledge.getDocumentTagNames(app.db, [document.id]),
    ]);
    // 指针与 published 标记任一成立即已发布；不能只靠 latest != current 推断。
    const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : null;
    return {
      document: toFaqDocument(document, tags.get(document.id) ?? []),
      draftVersion: draft ? toFaqVersion(draft, false) : null,
      publishedVersion: published
        ? toFaqVersion(published, published.id === document.currentVersionId)
        : null,
      // 顶层始终是最新草稿；没有草稿才回落到发布版。
      faq: draft?.faq ?? published?.faq ?? null,
    };
  };

  app.get(
    '/api/knowledge/bases/:id/faqs',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: baseParams, querystring: listQuery },
    },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      await authorizeObject(app, request, 'knowledge.read', { objectId: base.id }, '对象不存在');
      const filters = [
        eq(schema.knowledgeDocuments.baseId, base.id),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
      ];
      if (request.query.folderId !== undefined) {
        filters.push(
          request.query.folderId === 'null'
            ? sql`${schema.knowledgeDocuments.folderId} is null`
            : eq(schema.knowledgeDocuments.folderId, request.query.folderId),
        );
      }
      if (request.query.status) {
        filters.push(eq(schema.knowledgeDocuments.status, request.query.status));
      }
      if (request.query.q) {
        filters.push(sql`${schema.knowledgeDocuments.title} ilike ${`%${request.query.q}%`}`);
      }
      if (request.query.isRecommended !== undefined) {
        filters.push(sql`coalesce((
          select v.faq ->> 'isRecommended'
          from knowledge_document_versions v
          where v.document_id = ${schema.knowledgeDocuments.id} and v.faq is not null
          order by v.version desc limit 1
        ), 'true') = ${String(request.query.isRecommended)}`);
      }
      const limit = Math.min(Math.max(request.query.limit ?? 50, 1), 200);
      if (request.query.cursor) {
        filters.push(
          sql`(${schema.knowledgeDocuments.updatedAt}, ${schema.knowledgeDocuments.id}) < (
            select b.updated_at, b.id from knowledge_documents b where b.id = ${request.query.cursor}
          )`,
        );
      }
      const rows = await app.db
        .select()
        .from(schema.knowledgeDocuments)
        .where(and(...filters))
        .orderBy(desc(schema.knowledgeDocuments.updatedAt), desc(schema.knowledgeDocuments.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const ids = items.map((row) => row.id);
      const [tags, versions] = await Promise.all([
        repo.knowledge.getDocumentTagNames(app.db, ids),
        ids.length === 0
          ? Promise.resolve([] as VersionRow[])
          : app.db
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
        items: items.map((row) => ({
          ...toFaqDocument(row, tags.get(row.id) ?? []),
          faq: latest.get(row.id)?.faq ?? null,
        })),
        nextCursor: rows.length > limit ? (items[limit - 1]?.id ?? null) : null,
      };
    },
  );

  app.post(
    '/api/knowledge/bases/:id/faqs',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } },
      schema: { params: baseParams, body: faqCreateSchema },
    },
    async (request, reply) => {
      const base = await loadActiveBase(request.params.id, reply);
      if (!base) return;
      await authorizeObject(
        app,
        request,
        'knowledge.content.manage',
        { objectId: base.id },
        '对象不存在',
      );
      if (await folderIssue(base.id, request.body.folderId)) {
        return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
      }
      try {
        const cleaned = cleanFaqInput(request.body.faq);
        await assertNoPositiveConflict(app, base.id, cleaned.faq);
        const result = await createFaqDraft(app, {
          base,
          faq: cleaned.faq,
          title: request.body.title ?? cleaned.faq.question.slice(0, 300),
          folderId: request.body.folderId,
          tags: request.body.tags,
          parentVersionId: null,
          requestId: request.id,
          actor: actorOf(request),
          log: request.log,
          auditAction: 'knowledge.faq.created',
        });
        return reply.status(202).send({
          documentId: result.document.id,
          jobId: result.jobId,
          ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.get(
    '/api/knowledge/faqs/:documentId',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
      schema: { params: faqParams },
    },
    async (request, reply) => {
      const document = await loadFaqDocument(app, request.params.documentId, reply);
      if (!document) return;
      await authorizeObject(
        app,
        request,
        'knowledge.read',
        { objectId: document.id },
        '对象不存在',
      );
      return detail(document);
    },
  );

  app.put(
    '/api/knowledge/faqs/:documentId',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } },
      schema: { params: faqParams, body: faqUpdateSchema },
    },
    async (request, reply) => {
      const document = await loadFaqDocument(app, request.params.documentId, reply);
      if (!document) return;
      await authorizeObject(
        app,
        request,
        'knowledge.content.manage',
        { objectId: document.id },
        '对象不存在',
      );
      const base = await repo.knowledge.getBase(app.db, document.baseId);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      await authorizeObject(
        app,
        request,
        'knowledge.content.manage',
        { objectId: base.id },
        '对象不存在',
      );
      if (base.status !== 'active')
        return reject(reply, 'CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
      const latest = await latestVersion(app, document.id);
      const latestIsDraft = latest !== null && !isPublishedFaqVersion(document, latest);
      const expectedVersionId = latestIsDraft ? latest.id : (document.currentVersionId ?? null);
      if (expectedVersionId !== request.body.expectedVersionId) {
        return reject(reply, 'CONFLICT_STALE', 'FAQ 已被修改，请刷新后重试');
      }
      if (await folderIssue(base.id, request.body.folderId ?? document.folderId)) {
        return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
      }
      try {
        const cleaned = cleanFaqInput(request.body.faq);
        await assertNoPositiveConflict(app, base.id, cleaned.faq, {
          ignoreDocumentId: document.id,
        });
        const result = await writeFaqVersion(app, {
          base,
          document,
          faq: cleaned.faq,
          title: request.body.title ?? document.title,
          tags: request.body.tags,
          parentVersionId: request.body.expectedVersionId,
          requestId: request.id,
          actor: actorOf(request),
          log: request.log,
          auditAction: 'knowledge.faq.updated',
        });
        const documentPatch: { title?: string; folderId?: string | null } = {};
        if (request.body.title !== undefined) documentPatch.title = request.body.title;
        if (request.body.folderId !== undefined) documentPatch.folderId = request.body.folderId;
        if (Object.keys(documentPatch).length > 0) {
          await repo.knowledge.updateDocument(app.db, document.id, documentPatch);
        }
        return reply.status(202).send({
          documentId: document.id,
          jobId: result.jobId,
          ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.delete(
    '/api/knowledge/faqs/:documentId',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } },
      schema: { params: faqParams },
    },
    async (request, reply) => {
      const document = await loadFaqDocument(app, request.params.documentId, reply);
      if (!document) return;
      await authorizeObject(
        app,
        request,
        'knowledge.content.manage',
        { objectId: document.id },
        '对象不存在',
      );
      await repo.knowledge.deleteDocument(app.db, document.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/knowledge/faqs/:documentId/publish',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.publish' } },
      schema: { params: faqParams, body: publishSchema },
    },
    async (request, reply) => {
      const document = await loadFaqDocument(app, request.params.documentId, reply);
      if (!document) return;
      await authorizeObject(
        app,
        request,
        'knowledge.publish',
        { objectId: document.id },
        '对象不存在',
      );
      try {
        const updated = await publishFaqVersion(
          app,
          document,
          request.body.versionId,
          request.body.expectedVersionId,
        );
        const tags = await repo.knowledge.getDocumentTagNames(app.db, [updated.id]);
        return toFaqDocument(updated, tags.get(updated.id) ?? []);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.patch(
    '/api/knowledge/faqs/:documentId/status',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } },
      schema: { params: faqParams, body: statusSchema },
    },
    async (request, reply) => {
      const document = await loadFaqDocument(app, request.params.documentId, reply);
      if (!document) return;
      await authorizeObject(
        app,
        request,
        'knowledge.content.manage',
        { objectId: document.id },
        '对象不存在',
      );
      try {
        const updated = await setFaqEnabled(app, document, request.body.enabled);
        const tags = await repo.knowledge.getDocumentTagNames(app.db, [updated.id]);
        return toFaqDocument(updated, tags.get(updated.id) ?? []);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/api/knowledge/bases/:id/faqs/batch',
    {
      config: { access: { kind: 'authenticated' } },
      schema: { params: baseParams, body: batchSchema },
      preHandler: async (request, reply) => {
        await app
          .requirePermission(
            request.body.action === 'publish' ? 'knowledge.publish' : 'knowledge.content.manage',
          )
          .call(app, request, reply, () => undefined);
      },
    },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      await authorizeObject(
        app,
        request,
        request.body.action === 'publish' ? 'knowledge.publish' : 'knowledge.content.manage',
        { objectId: base.id },
        '对象不存在',
      );
      if (request.body.importBatchId !== undefined) {
        if (request.body.action !== 'publish' || request.body.items.length > 500) {
          return reject(reply, 'INVALID_INPUT', '导入批次只能整批发布，最多 500 条');
        }
        try {
          const published = await repo.knowledge.publishFaqImport(app.db, {
            baseId: base.id,
            importBatchId: request.body.importBatchId,
            items: request.body.items.map((item) => {
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
              status: 'succeeded',
            })),
          };
        } catch (err) {
          const appError = toAppError(err);
          const results: KnowledgeFaqImportResult[] = request.body.items.map((item, index) => ({
            row: index + 1,
            status: 'failed',
            operation: null,
            documentId: item.documentId,
            issues: [{ field: 'batch', code: appError.code, message: appError.message }],
          }));
          return reply.status(appError.status).send({ ...problem(request.id, appError), results });
        }
      }
      if (request.body.items.length > 100) {
        return reject(reply, 'INVALID_INPUT', '普通批量操作最多 100 条');
      }
      const results: Array<{
        documentId: string;
        status: 'succeeded' | 'failed';
        code?: string;
        message?: string;
      }> = [];
      for (const item of request.body.items) {
        const document = await repo.knowledge
          .getDocument(app.db, item.documentId)
          .catch(() => null);
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
          if (request.body.action === 'publish') {
            if (item.versionId === undefined || item.expectedVersionId === undefined) {
              fail('INVALID_INPUT', '发布需要 versionId 与 expectedVersionId');
            }
            await publishFaqVersion(app, document, item.versionId, item.expectedVersionId);
          } else if (request.body.action === 'delete') {
            await repo.knowledge.deleteDocument(app.db, document.id);
          } else {
            await setFaqEnabled(app, document, request.body.action === 'enable');
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
    },
  );

  app.post(
    '/api/knowledge/bases/:id/faqs/import',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.import' } },
      bodyLimit: 3 * 1024 * 1024,
      schema: { params: baseParams, body: knowledgeFaqImportInputSchema },
    },
    async (request, reply) => {
      const base = await loadActiveBase(request.params.id, reply);
      if (!base) return;
      await authorizeObject(app, request, 'knowledge.import', { objectId: base.id }, '对象不存在');
      try {
        const rows = await parseFaqImport({
          format: request.body.format,
          content: request.body.content,
        });
        const existing = await loadExistingFaqEntries(app, base.id);
        const plan = planFaqImport({
          mode: request.body.mode,
          rows,
          existing,
          newDocumentId: () => newId('knowledgeDocument'),
        });
        const response = {
          dryRun: request.body.dryRun,
          mode: request.body.mode,
          committed: false,
          importBatchId: null as string | null,
          counts: plan.counts,
          results: plan.results,
        };
        if (request.body.dryRun) return reply.status(200).send(response);
        if (plan.counts.failed > 0) return reply.status(200).send(response);
        if (plan.drafts.length === 0) {
          if (request.body.mode === 'replace') {
            return reject(reply, 'INVALID_INPUT', '替换批次为空，未执行删除');
          }
          return reply.status(200).send(response);
        }

        const importBatchId = newFaqImportBatchId();
        const existingById = new Map(existing.map((entry) => [entry.documentId, entry]));
        const targets =
          request.body.mode === 'replace'
            ? existing
            : plan.drafts.flatMap((draft) => {
                const entry = existingById.get(draft.documentId);
                return entry ? [entry] : [];
              });
        const prepared: PreparedDraft[] = [];
        for (const draft of plan.drafts) {
          prepared.push(
            await prepareImportDraft(app, base, {
              operation: draft.operation,
              documentId: draft.documentId,
              faq: draft.faq,
              enabled: draft.enabled,
            }),
          );
        }

        let saved: Awaited<ReturnType<typeof repo.knowledge.saveFaqImportDrafts>>;
        try {
          saved = await repo.knowledge.saveFaqImportDrafts(app.db, {
            baseId: base.id,
            importBatchId,
            mode: request.body.mode,
            expectedState: targets.map(existingState),
            drafts: prepared.map((item) => item.draft),
          });
        } catch (err) {
          if (isAppError(err)) return reject(reply, err.code, err.message);
          throw err;
        }

        const jobs = new Map(saved.items.map((item) => [item.documentId, item]));
        for (const item of saved.items) {
          // 投递失败不影响已提交的事务；queued job 由既有 reconcile 补投。
          await enqueueKnowledgeJob({ id: item.jobId }).catch((err: unknown) => {
            request.log.warn({ err, jobId: item.jobId }, 'FAQ 导入任务入队失败，等待对账补投');
          });
        }
        const results = plan.results.map((result) => {
          const item = result.documentId ? jobs.get(result.documentId) : undefined;
          return item
            ? {
                ...result,
                expectedVersionId: item.expectedVersionId,
                jobId: item.jobId,
              }
            : result;
        });
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
          action: 'knowledge.faq.imported',
          target: base.id,
          input: { importBatchId, mode: request.body.mode, counts: plan.counts },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(202).send({
          ...response,
          committed: true,
          importBatchId,
          results,
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.get(
    '/api/knowledge/bases/:id/faqs/export',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.export' } },
      schema: { params: baseParams, querystring: exportQuery },
    },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      await authorizeObject(app, request, 'knowledge.export', { objectId: base.id }, '对象不存在');
      const documents = await app.db
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
        return reject(reply, 'CONFLICT', 'FAQ 超过 500 条，无法一次导出');
      }
      const ids = documents.map((document) => document.id);
      const versions =
        ids.length === 0
          ? []
          : await app.db
              .select()
              .from(schema.knowledgeDocumentVersions)
              .where(
                and(
                  inArray(schema.knowledgeDocumentVersions.documentId, ids),
                  isNotNull(schema.knowledgeDocumentVersions.faq),
                ),
              )
              .orderBy(desc(schema.knowledgeDocumentVersions.version));
      const versionById = new Map(versions.map((version) => [version.id, version]));
      const latestByDocument = new Map<string, VersionRow>();
      for (const version of versions) {
        if (!latestByDocument.has(version.documentId)) {
          latestByDocument.set(version.documentId, version);
        }
      }
      const items = documents.flatMap((document) => {
        const latest = latestByDocument.get(document.id);
        const published = document.currentVersionId
          ? versionById.get(document.currentVersionId)
          : undefined;
        const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : undefined;
        const version = request.query.version === 'published' ? published : (draft ?? published);
        if (!version?.faq) return [];
        // 导出永远是完整答案，不做 random 抽样；启停只按指针/metadata 判定是否已发布。
        return [
          {
            ...version.faq,
            enabled: faqEnabledForVersion(document, version),
          } satisfies FaqTransferEntry,
        ];
      });
      try {
        const content = serializeFaqExport(request.query.format, items);
        if (Buffer.byteLength(content, 'utf8') > FAQ_MAX_BYTES) {
          return reject(reply, 'CONFLICT', 'FAQ 导出内容超过 2MiB，请缩小范围');
        }
        return reply
          .type(request.query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json')
          .header('Content-Disposition', `attachment; filename="faqs.${request.query.format}"`)
          .send(content);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/api/knowledge/bases/:id/faqs/test',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } },
      schema: { params: baseParams, body: testSchema },
    },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id))) {
        return reject(reply, 'NOT_FOUND', '知识库不存在，可能已被删除');
      }
      await authorizeObject(
        app,
        request,
        'knowledge.execute',
        { objectId: request.params.id },
        '对象不存在',
      );
      try {
        return await searchKnowledge(
          app.db,
          request.params.id,
          {
            q: request.body.q,
            kinds: ['faq'],
            folders: [],
            tags: [],
            limit: request.body.limit,
            rerank: request.body.rerank,
            minVectorScore: request.body.minVectorScore,
            diagnostics: false,
            onlyRecommended: request.body.onlyRecommended,
            faqPriority: request.body.faqPriority,
            faqDirectAnswerThreshold: request.body.faqDirectAnswerThreshold,
          },
          { secretKey: app.config.APP_SECRET_KEY },
        );
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );
}
