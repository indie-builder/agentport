import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  AppError,
  diffLinesOrdered,
  inspectKnowledgeAudio,
  knowledgeVersionDir,
  knowledgeVersionImagesDir,
  knowledgeVersionMarkdownPath,
  segmentForSearch,
  sha256Hex,
} from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import type { KnowledgeDocumentStatus } from '@agentport/shared';
import { KNOWLEDGE_DOCUMENT_MAX_BYTES, knowledgeImageChunkMetadataSchema } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import { isPgCode } from '../../../http/errors.js';
import { invalidCursor, requireCursorPage } from '../../../http/pagination.js';
import { createJob, documentWire, enqueueKnowledgeJobAfterCommit, storeBlob } from '../service.js';
import { getVersionMarkdown } from './binary.js';
import {
  assertBodyBytes,
  collectChunks,
  copyVersionImages,
  type DocumentRow,
  enqueue,
  fileTitle,
  type KnowledgeDeps,
  notFound,
  type PageQuery,
  pageOptions,
  type VersionRow,
} from './shared.js';

type ChunkRow = NonNullable<
  Awaited<ReturnType<typeof repo.knowledge.listChunkSummaries>>
>['items'][number];

export const KNOWLEDGE_UPLOAD_BODY_LIMIT = 48 * 1024 * 1024;

function toChunk(row: ChunkRow) {
  return {
    id: row.id,
    documentId: row.documentId,
    versionId: row.versionId,
    ordinal: row.ordinal,
    parentOrdinal: row.parentOrdinal,
    indexRole: row.indexRole,
    kind: row.kind,
    heading: row.heading,
    content: row.content,
    enabled: row.enabled,
    editedByUser: row.editedByUser,
    pageFrom: row.pageFrom,
    pageTo: row.pageTo,
    locator: row.locator,
    metadata: row.metadata,
  };
}

function toDocumentVersion(row: VersionRow, currentVersionId: string | null) {
  return {
    id: row.id,
    documentId: row.documentId,
    version: row.version,
    origin: row.origin,
    parentVersionId: row.parentVersionId,
    metadata: row.metadata,
    faq: row.faq,
    sourceRevision: row.sourceRevision,
    parseStatus: row.parseStatus,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    isCurrent: row.id === currentVersionId,
    createdAt: row.createdAt.toISOString(),
  };
}

function decodeBase64(value: string): Buffer | null {
  const data = Buffer.from(value, 'base64');
  if (data.length === 0) return null;
  return data.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? data : null;
}

function relativePathParts(raw: string): string[] | null {
  if (raw.includes('\\')) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  if ([...raw].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts;
}

async function folderForPath(
  db: Database,
  baseId: string,
  rootFolderId: string | null,
  parts: string[],
): Promise<string | null> {
  let parentId = rootFolderId;
  let parentPath = '';
  if (rootFolderId !== null) {
    const root = await repo.knowledge.getFolder(db, rootFolderId);
    if (!root || root.baseId !== baseId) throw new Error('root folder missing');
    parentPath = root.path;
  }
  for (const name of parts) {
    const path = `${parentPath}/${name}`;
    const existing = await db
      .select({ id: schema.knowledgeFolders.id })
      .from(schema.knowledgeFolders)
      .where(
        and(eq(schema.knowledgeFolders.baseId, baseId), eq(schema.knowledgeFolders.path, path)),
      )
      .limit(1);
    if (existing[0]) {
      parentId = existing[0].id;
    } else {
      try {
        const created = await repo.knowledge.createFolder(db, { baseId, parentId, name, path });
        parentId = created.id;
      } catch (err) {
        if (!isPgCode(err, '23505')) throw err;
        const [row] = await db
          .select({ id: schema.knowledgeFolders.id })
          .from(schema.knowledgeFolders)
          .where(
            and(eq(schema.knowledgeFolders.baseId, baseId), eq(schema.knowledgeFolders.path, path)),
          )
          .limit(1);
        if (!row) throw err;
        parentId = row.id;
      }
    }
    parentPath = path;
  }
  return parentId;
}

function preparedVersionInput(
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
  versionId: string,
  markdown: string,
): repo.knowledge.EditDocumentChunksInput['preparedVersion'] {
  return {
    id: versionId,
    blobSha256: current.blobSha256,
    markdownSha256: sha256Hex(Buffer.from(markdown, 'utf8')),
    originalFilename: current.originalFilename,
    mimeType: current.mimeType,
    sizeBytes: current.sizeBytes,
    sourceRevision: current.sourceRevision,
    metadata: {},
    faq: null,
    parseStatus: current.parseStatus,
    pageMap: current.pageMap,
    images: current.images,
    embeddingProfileId: current.embeddingProfileId,
  };
}

async function prepareVersionFiles(
  config: Config,
  documentId: string,
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
  versionId: string,
  markdown: string,
): Promise<string> {
  const dir = knowledgeVersionDir(config.KNOWLEDGE_DIR, documentId, versionId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      knowledgeVersionMarkdownPath(config.KNOWLEDGE_DIR, documentId, versionId),
      markdown,
      'utf8',
    );
    await copyVersionImages(
      knowledgeVersionImagesDir(config.KNOWLEDGE_DIR, documentId, current.id),
      knowledgeVersionImagesDir(config.KNOWLEDGE_DIR, documentId, versionId),
      current.images,
    );
    return dir;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function discardUncommittedVersion(
  db: Database,
  dir: string,
  versionId: string,
): Promise<void> {
  try {
    if (await repo.knowledge.getVersion(db, versionId)) return;
  } catch {
    return;
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function enqueueChunkReindex(
  deps: KnowledgeDeps,
  baseId: string,
  documentId: string,
): Promise<string> {
  const job = await createJob(deps.db, {
    baseId,
    documentId,
    payload: {
      type: 'reindex',
      baseId,
      documentIds: [documentId],
      chunksOnly: true,
      confirmOverwriteManualChunks: false,
    },
  });
  await enqueueKnowledgeJobAfterCommit(deps.log, job);
  return job.id;
}

export async function listDocuments(
  deps: KnowledgeDeps,
  id: string,
  query: PageQuery & {
    folderId?: string | undefined;
    tag?: string | undefined;
    status?: KnowledgeDocumentStatus | undefined;
    q?: string | undefined;
    sort?: 'updated' | 'created' | 'title' | undefined;
    order?: 'asc' | 'desc' | undefined;
  },
) {
  const { folderId, tag, status, q, sort, order, ...rest } = query;
  const page = requireCursorPage(
    await repo.knowledge.listDocuments(deps.db, {
      ...pageOptions(rest),
      baseId: id,
      contentKind: 'document',
      ...(folderId === undefined ? {} : { folderId: folderId === 'null' ? null : folderId }),
      ...(tag === undefined ? {} : { tag }),
      ...(status === undefined ? {} : { status }),
      ...(q === undefined ? {} : { q }),
      ...(sort === undefined ? {} : { sort }),
      ...(order === undefined ? {} : { order }),
    }),
  );
  const tags = await repo.knowledge.getDocumentTagNames(
    deps.db,
    page.items.map((row) => row.id),
  );
  return {
    items: page.items.map((row) => documentWire(row, tags.get(row.id) ?? [])),
    nextCursor: page.nextCursor,
  };
}

export async function listImageAssets(
  deps: KnowledgeDeps,
  id: string,
  query: PageQuery & { q?: string | undefined },
) {
  const page = requireCursorPage(
    await repo.knowledge.listImageAssets(deps.db, id, {
      ...pageOptions(query),
      ...(query.q === undefined ? {} : { q: query.q }),
    }),
  );
  return {
    items: page.items.map((row) => ({
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      versionId: row.versionId,
      name: row.name,
      mimeType: row.mimeType,
      page: row.page,
      caption: row.caption,
      ocrText: row.ocrText,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

async function documentWithTags(deps: KnowledgeDeps, row: DocumentRow) {
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [row.id]);
  return documentWire(row, tags.get(row.id) ?? []);
}

export async function uploadDocument(
  deps: KnowledgeDeps,
  id: string,
  body: {
    filename: string;
    mimeType: string;
    dataBase64: string;
    title?: string | undefined;
    folderId: string | null;
    relativePath?: string | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  assertBodyBytes(body.dataBase64, KNOWLEDGE_UPLOAD_BODY_LIMIT);
  const data = decodeBase64(body.dataBase64);
  if (!data) throw new AppError('INVALID_INPUT', 'dataBase64 不是合法的 base64');
  if (data.length > KNOWLEDGE_DOCUMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '文件解码后超过 32MiB 上限');
  }
  const audio = await inspectKnowledgeAudio({
    data,
    filename: body.filename,
    mimeType: body.mimeType,
  });
  if (audio) {
    if (base.status !== 'active') throw new AppError('CONFLICT', '知识库未启用，不能上传音频');
    if (!base.asrProfileId) {
      throw new AppError('CONFLICT', '知识库未绑定音频转录模型，不能上传音频');
    }
    const asrProfile = await repo.knowledge.getModelProfileWithSecret(deps.db, base.asrProfileId);
    if (asrProfile?.kind !== 'asr' || !asrProfile.enabled) {
      throw new AppError('CONFLICT', '知识库绑定的音频转录模型不存在或已禁用');
    }
  }
  const mimeType = audio?.mimeType ?? body.mimeType;
  if (body.folderId) {
    const folder = await repo.knowledge.getFolder(deps.db, body.folderId);
    if (!folder || folder.baseId !== base.id) {
      throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
    }
  }
  let folderId = body.folderId;
  let title = body.title ?? fileTitle(body.filename);
  if (body.relativePath !== undefined) {
    const parts = relativePathParts(body.relativePath);
    if (!parts) {
      throw new AppError(
        'INVALID_INPUT',
        'relativePath 必须是安全的相对路径（不能是绝对路径、.. 或空段）',
      );
    }
    folderId =
      parts.length > 1
        ? await folderForPath(deps.db, base.id, body.folderId, parts.slice(0, -1))
        : body.folderId;
    const filename = parts.at(-1);
    if (filename === undefined) throw new AppError('INVALID_INPUT', 'relativePath 缺少文件名');
    title = body.title ?? fileTitle(filename);
  }
  await repo.governance.assertKnowledgeDocumentQuota(deps.db, base.id);
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, data);
  const document = await repo.knowledge.createDocument(deps.db, {
    baseId: base.id,
    folderId,
    title,
    sourceType: 'upload',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType,
    sizeBytes: data.length,
    metadata: {
      originalFilename: body.filename,
      ...(body.relativePath === undefined ? {} : { relativePath: body.relativePath }),
    },
  });
  await repo.knowledge.updateDocument(deps.db, document.id, { contentHash: sha });
  const job = await enqueue(
    deps,
    { type: 'ingest', documentId: document.id, publish: 'automatic' },
    { baseId: base.id, documentId: document.id },
  );
  await repo.governance.notifyKnowledgeDocumentQuota(deps.db, base.id);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.document.uploaded',
    target: document.id,
    input: { filename: body.filename, sizeBytes: data.length },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { documentId: document.id, jobId: job.id };
}

export async function getDocument(deps: KnowledgeDeps, documentId: string) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  return documentWithTags(deps, row);
}

export async function generateDocumentSummary(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  if (document.status === 'disabled' || document.disabledReason !== null) {
    throw new AppError('CONFLICT', '文档已停用，不能生成摘要');
  }
  const versionId = document.currentVersionId;
  if (!versionId) throw new AppError('CONFLICT', '文档还没有可用版本，不能生成摘要');
  const job = await deps.db.transaction(async (tx) => {
    await repo.knowledge.beginDocumentSummary(tx, document.id, versionId, 'pending');
    return createJob(tx, {
      baseId: document.baseId,
      documentId: document.id,
      payload: {
        type: 'summary',
        baseId: document.baseId,
        documentId: document.id,
        versionId,
      },
    });
  });
  await enqueueKnowledgeJobAfterCommit(deps.log, job);
  return { jobId: job.id };
}

export async function generateDocumentTags(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  if (document.status === 'disabled' || document.disabledReason !== null) {
    throw new AppError('CONFLICT', '文档已停用，不能生成标签');
  }
  if (!document.currentVersionId) {
    throw new AppError('CONFLICT', '文档还没有可用版本，不能生成标签');
  }
  if (!(await repo.knowledge.isDocumentReadable(deps.db, document.id))) {
    throw new AppError('CONFLICT', '文档当前不可读，不能生成标签');
  }
  const job = await enqueue(
    deps,
    { type: 'tag_generate', baseId: document.baseId, documentId: document.id },
    { baseId: document.baseId, documentId: document.id },
  );
  return { jobId: job.id };
}

type UpdateDocumentBody = {
  title?: string | undefined;
  folderId?: string | null | undefined;
  status?: 'ready' | 'disabled' | undefined;
  tags?: string[] | undefined;
};

function sameTagSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function changedDocumentFields(
  current: DocumentRow,
  body: UpdateDocumentBody,
  currentTags: string[],
): string[] {
  const fields: string[] = [];
  if (body.title !== undefined && body.title !== current.title) fields.push('title');
  if (body.folderId !== undefined && body.folderId !== current.folderId) fields.push('folderId');
  if (body.status !== undefined && body.status !== current.status) fields.push('status');
  if (body.tags !== undefined && !sameTagSet(body.tags, currentTags)) fields.push('tags');
  return fields;
}

export async function updateDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: UpdateDocumentBody,
) {
  const current = await repo.knowledge.getDocument(deps.db, documentId);
  if (!current) notFound('文档');
  const { tags, ...patch } = body;
  if (current.status === 'disabled' && patch.status === 'ready' && current.sourceConnectionId) {
    if (!(await repo.knowledge.sourceScopeAllowsDocumentById(deps.db, current.id))) {
      throw new AppError('CONFLICT', '来源授权已失效，需成功同步重新确认范围后才能启用');
    }
  }
  if (patch.folderId) {
    const folder = await repo.knowledge.getFolder(deps.db, patch.folderId);
    if (!folder || folder.baseId !== current.baseId) {
      throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
    }
  }
  if (current.status === 'disabled' && patch.status === 'ready') {
    const chunks = current.currentVersionId
      ? requireCursorPage(
          await repo.knowledge.listChunkSummaries(deps.db, current.currentVersionId, { limit: 1 }),
        )
      : null;
    if (!chunks || chunks.items.length === 0) {
      throw new AppError('CONFLICT', '当前版本没有可用分块，请先重新摄取');
    }
  }
  const currentTags =
    tags === undefined
      ? []
      : ((await repo.knowledge.getDocumentTagNames(deps.db, [current.id])).get(current.id) ?? []);
  const fields = changedDocumentFields(current, body, currentTags);
  if (tags !== undefined && patch.status === undefined && fields.length === 0) {
    return documentWithTags(deps, current);
  }
  const row = await repo.knowledge.updateDocument(deps.db, current.id, {
    ...patch,
    ...(patch.status === 'disabled' ? { disabledReason: 'manual' } : {}),
    ...(patch.status === 'ready' ? { disabledReason: null } : {}),
  });
  if (!row) notFound('文档');
  if (patch.status === 'disabled' && current.status !== 'disabled') {
    await repo.knowledge.markWikiStaleByDocument(deps.db, row.id);
  }
  if (tags !== undefined && fields.includes('tags')) {
    await repo.knowledge.reconcileDocumentTags(deps.db, row.id, current.baseId, tags);
  }
  if (fields.length > 0) {
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.document.updated',
      target: row.id,
      input: { baseId: row.baseId, fields },
      status: 'ok',
      requestId: deps.requestId,
    });
  }
  return documentWithTags(deps, row);
}

export async function deleteDocument(deps: KnowledgeDeps, documentId: string) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  const wikiPagesMarkedStale = await repo.knowledge.markWikiStaleByDocument(deps.db, row.id);
  await repo.knowledge.deleteDocument(deps.db, row.id);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.document.deleted',
    target: row.id,
    input: { wikiPagesMarkedStale },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { wikiPagesMarkedStale };
}

export async function reprocessDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { confirmOverwriteManualChunks: boolean },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  if (row.status === 'disabled' || row.disabledReason !== null) {
    throw new AppError('CONFLICT', '文档已停用，不能通过重解析恢复；请先完成来源同步或显式启用');
  }
  if (await repo.knowledge.hasUnpublishedDraft(deps.db, row)) {
    throw new AppError('CONFLICT', '文档存在未发布的草稿，请先发布或放弃草稿后再重解析');
  }
  if (row.currentVersionId) {
    const manualChunkCount = await repo.knowledge.countEditedChunks(deps.db, row.currentVersionId);
    if (manualChunkCount > 0 && !body.confirmOverwriteManualChunks) {
      throw new AppError(
        'CONFLICT',
        `存在 ${manualChunkCount} 个人工编辑的分块，重解析会丢弃这些修改；请确认后重试`,
      );
    }
  }
  const job = await enqueue(
    deps,
    {
      type: 'reindex',
      baseId: row.baseId,
      documentIds: [row.id],
      chunksOnly: false,
      confirmOverwriteManualChunks: body.confirmOverwriteManualChunks,
    },
    { baseId: row.baseId, documentId: row.id },
  );
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.document.reprocessed',
    target: row.id,
    input: { baseId: row.baseId },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { jobId: job.id };
}

export async function listChunks(
  deps: KnowledgeDeps,
  documentId: string,
  query: PageQuery & { versionId?: string | undefined },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  const versionId = query.versionId ?? row.currentVersionId;
  if (!versionId) {
    if (query.cursor !== undefined) invalidCursor();
    return { items: [], nextCursor: null };
  }
  if (versionId !== row.currentVersionId) {
    const version = await repo.knowledge.getVersion(deps.db, versionId);
    if (!version || version.documentId !== row.id) {
      throw new AppError('INVALID_INPUT', '版本不存在或不属于该文档');
    }
  }
  const page = requireCursorPage(
    await repo.knowledge.listChunkSummaries(deps.db, versionId, pageOptions(query)),
  );
  return { items: page.items.map(toChunk), nextCursor: page.nextCursor };
}

function editableChunkDocument(document: DocumentRow): boolean {
  if (document.contentKind === 'document') return true;
  throw new AppError('CONFLICT', 'FAQ/Wiki 内部索引不能直接编辑分块，请使用各自入口');
}

async function currentVersionForChunk(
  deps: KnowledgeDeps,
  chunk: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getChunk>>>,
  expectedVersionId: string,
) {
  const document = await repo.knowledge.getDocument(deps.db, chunk.documentId);
  if (!document) notFound('文档');
  editableChunkDocument(document);
  if (
    !document.currentVersionId ||
    chunk.versionId !== document.currentVersionId ||
    expectedVersionId !== document.currentVersionId
  ) {
    throw new AppError('CONFLICT_STALE', '只能修改当前版本的分块，请刷新后重试');
  }
  const version = await repo.knowledge.getVersion(deps.db, document.currentVersionId);
  if (!version) throw new AppError('CONFLICT', '文档当前版本已失效');
  return { document, version };
}

export async function createChunk(
  deps: KnowledgeDeps,
  documentId: string,
  body: {
    expectedVersionId: string;
    kind: 'text' | 'table' | 'image';
    heading: string | null;
    content: string;
    enabled: boolean;
  },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  editableChunkDocument(row);
  if (!row.currentVersionId) throw new AppError('CONFLICT', '文档还没有可用版本');
  if (body.expectedVersionId !== row.currentVersionId) {
    throw new AppError('CONFLICT_STALE', '文档版本已变化，请刷新后重试');
  }
  const current = await repo.knowledge.getVersion(deps.db, row.currentVersionId);
  if (!current) throw new AppError('CONFLICT', '文档当前版本已失效');
  const currentChunks = await collectChunks(deps.db, current.id);
  const added = {
    kind: body.kind,
    heading: body.heading,
    content: body.content,
    searchText: segmentForSearch(body.content),
    embedding: null,
    tokenCount: 0,
    metadata: {},
    enabled: body.enabled,
  };
  const markdown = [...currentChunks.map((chunk) => chunk.content), added.content].join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(deps.config, row.id, current, versionId, markdown);
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: row.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'add', chunk: added },
      preparedVersion: preparedVersionInput(current, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  const jobId = await enqueueChunkReindex(deps, row.baseId, row.id);
  return {
    document: await documentWithTags(deps, result.document),
    chunk: result.chunk ? toChunk(result.chunk) : null,
    jobId,
  };
}

export async function updateChunk(
  deps: KnowledgeDeps,
  chunkId: string,
  body: {
    expectedVersionId: string;
    content?: string | undefined;
    heading?: string | null | undefined;
    enabled?: boolean | undefined;
  },
) {
  const current = await repo.knowledge.getChunk(deps.db, chunkId);
  if (!current) notFound('分块');
  const imageMetadata = knowledgeImageChunkMetadataSchema.safeParse(current.metadata);
  if (
    imageMetadata.success &&
    imageMetadata.data.imageRole === 'vector' &&
    (body.content !== undefined || body.heading !== undefined)
  ) {
    throw new AppError('CONFLICT', '图片向量分块只能启停，正文来自原图描述，不能手改');
  }
  const target = await currentVersionForChunk(deps, current, body.expectedVersionId);
  const chunks = await collectChunks(deps.db, target.version.id);
  const index = chunks.findIndex((chunk) => chunk.id === current.id);
  if (index < 0) notFound('分块');
  const content = body.content;
  const contentChanged = content !== undefined && content !== current.content;
  const headingChanged = body.heading !== undefined && body.heading !== current.heading;
  const patch = {
    ...(contentChanged ? { content, searchText: segmentForSearch(content), embedding: null } : {}),
    ...(headingChanged ? { heading: body.heading ?? null } : {}),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
  };
  const nextChunks = chunks.map((chunk) =>
    chunk.id === current.id
      ? {
          content: body.content ?? chunk.content,
          heading: headingChanged ? (body.heading ?? null) : chunk.heading,
        }
      : chunk,
  );
  const markdown = nextChunks.map((chunk) => chunk.content).join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(
    deps.config,
    target.document.id,
    target.version,
    versionId,
    markdown,
  );
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: target.document.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'update', chunkId: current.id, patch },
      preparedVersion: preparedVersionInput(target.version, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  const jobId = contentChanged
    ? await enqueueChunkReindex(deps, target.document.baseId, target.document.id)
    : null;
  return {
    document: await documentWithTags(deps, result.document),
    chunk: result.chunk ? toChunk(result.chunk) : null,
    jobId,
  };
}

export async function deleteChunk(
  deps: KnowledgeDeps,
  chunkId: string,
  body: { expectedVersionId: string },
) {
  const chunk = await repo.knowledge.getChunk(deps.db, chunkId);
  if (!chunk) notFound('分块');
  const target = await currentVersionForChunk(deps, chunk, body.expectedVersionId);
  const chunks = (await collectChunks(deps.db, target.version.id)).filter(
    (row) => row.id !== chunk.id,
  );
  const markdown = chunks.map((row) => row.content).join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(
    deps.config,
    target.document.id,
    target.version,
    versionId,
    markdown,
  );
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: target.document.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'delete', chunkId: chunk.id },
      preparedVersion: preparedVersionInput(target.version, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  return {
    document: await documentWithTags(deps, result.document),
    chunk: null,
    jobId: null,
  };
}

export async function listVersions(deps: KnowledgeDeps, documentId: string, query: PageQuery) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  const page = requireCursorPage(
    await repo.knowledge.listDocumentVersions(deps.db, document.id, pageOptions(query)),
  );
  return {
    items: page.items.map((row) => toDocumentVersion(row, document.currentVersionId)),
    nextCursor: page.nextCursor,
  };
}

export async function documentDiff(
  deps: KnowledgeDeps,
  documentId: string,
  query: { fromVersionId: string; toVersionId: string },
) {
  const [document, from, to] = await Promise.all([
    repo.knowledge.getDocument(deps.db, documentId),
    repo.knowledge.getVersion(deps.db, query.fromVersionId),
    repo.knowledge.getVersion(deps.db, query.toVersionId),
  ]);
  if (!document || document.status === 'disabled' || document.disabledReason !== null) {
    notFound('文档');
  }
  if (!from || !to || from.documentId !== documentId || to.documentId !== documentId) {
    notFound('版本');
  }
  if (from.parseStatus === 'parse_failed' || to.parseStatus === 'parse_failed') {
    throw new AppError('INVALID_INPUT', '该版本正文不可用，无法对比');
  }
  const [fromMarkdown, toMarkdown] = await Promise.all([
    getVersionMarkdown(deps, from.id),
    getVersionMarkdown(deps, to.id),
  ]);
  const { added, removed } = diffLinesOrdered(fromMarkdown.markdown, toMarkdown.markdown);
  return {
    fromVersionId: from.id,
    toVersionId: to.id,
    addedLines: added,
    removedLines: removed,
  };
}

export async function rollbackDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  const version = await repo.knowledge.getVersion(deps.db, body.versionId);
  if (!version || version.documentId !== document.id) {
    throw new AppError('NOT_FOUND', '版本不存在或不属于该文档');
  }
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  if (version.embeddingProfileId !== base.embeddingProfileId) {
    throw new AppError('CONFLICT', '该版本来自不同 embedding 空间，需重建后才能切换');
  }
  const row = await repo.knowledge.activateDocumentVersion(deps.db, {
    documentId: document.id,
    versionId: version.id,
    expectedVersionId: body.expectedVersionId,
  });
  return documentWithTags(deps, row);
}
