import { mkdir, rm } from 'node:fs/promises';
import {
  AppError,
  isAppError,
  knowledgeDocumentDir,
  knowledgeVersionDir,
  knowledgeVersionImagesDir,
  knowledgeVersionMarkdownPath,
  sha256Hex,
} from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import type { KnowledgeSearchQuery, KnowledgeSearchResult } from '@agentport/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { searchKnowledge } from '../retrieval.js';
import { deleteDocument, reprocessDocument, updateDocument } from './documents.js';
import {
  assertFolderInBase,
  collectChunks,
  copyVersionImages,
  type DocumentRow,
  enqueue,
  type FullChunkRow,
  type KnowledgeDeps,
  notFound,
} from './shared.js';

function cloneChunk(chunk: FullChunkRow): repo.knowledge.NewChunk {
  return {
    ordinal: chunk.ordinal,
    kind: chunk.kind,
    heading: chunk.heading,
    content: chunk.content,
    searchText: chunk.searchText,
    embedding: chunk.embedding,
    pageFrom: chunk.pageFrom,
    pageTo: chunk.pageTo,
    tokenCount: chunk.tokenCount,
    metadata: chunk.metadata,
    parentOrdinal: chunk.parentOrdinal,
    indexRole: chunk.indexRole,
    locator: chunk.locator,
    enabled: chunk.enabled,
    editedByUser: chunk.editedByUser,
  };
}

export async function searchBase(
  deps: KnowledgeDeps,
  id: string,
  query: KnowledgeSearchQuery,
): Promise<KnowledgeSearchResult> {
  return searchKnowledge(deps.db, id, query, {
    secretKey: deps.config.APP_SECRET_KEY,
  });
}

export async function rebuildBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    documentIds?: string[] | undefined;
    chunksOnly: boolean;
    confirmOverwriteManualChunks: boolean;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const ids = body.documentIds ? [...new Set(body.documentIds)] : null;
  if (ids && ids.length > 0) {
    const rows = await deps.db
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, base.id),
          inArray(schema.knowledgeDocuments.id, ids),
        ),
      );
    if (rows.length !== ids.length) {
      throw new AppError('INVALID_INPUT', '存在不属于该知识库的文档');
    }
  }
  if (!body.chunksOnly && !body.confirmOverwriteManualChunks) {
    const [edited] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.knowledgeChunks)
      .innerJoin(
        schema.knowledgeDocuments,
        eq(schema.knowledgeDocuments.id, schema.knowledgeChunks.documentId),
      )
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, base.id),
          eq(schema.knowledgeChunks.editedByUser, true),
          eq(schema.knowledgeChunks.versionId, schema.knowledgeDocuments.currentVersionId),
          ...(ids && ids.length > 0 ? [inArray(schema.knowledgeDocuments.id, ids)] : []),
        ),
      );
    const editedCount = edited?.count ?? 0;
    if (editedCount > 0) {
      throw new AppError(
        'CONFLICT',
        `存在 ${editedCount} 个人工编辑的分块，完整重建会丢弃这些修改；请确认后重试`,
      );
    }
  }
  const job = await enqueue(
    deps,
    {
      type: 'reindex',
      baseId: base.id,
      ...(body.documentIds ? { documentIds: body.documentIds } : {}),
      chunksOnly: body.chunksOnly,
      confirmOverwriteManualChunks: body.confirmOverwriteManualChunks,
    },
    { baseId: base.id, documentId: null },
  );
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.rebuilt',
    target: base.id,
    input: {
      chunksOnly: body.chunksOnly,
      confirmOverwriteManualChunks: body.confirmOverwriteManualChunks,
    },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { jobId: job.id };
}

type BatchResult = {
  documentId: string;
  status: 'succeeded' | 'failed';
  newDocumentId?: string | undefined;
  jobId?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
};

async function copyDocument(deps: KnowledgeDeps, document: DocumentRow): Promise<string> {
  if (document.contentKind === 'wiki') {
    throw new AppError('CONFLICT', 'Wiki 索引文档不能复制为普通文档');
  }
  const version = document.currentVersionId
    ? await repo.knowledge.getVersion(deps.db, document.currentVersionId)
    : null;
  if (!version) throw new AppError('CONFLICT', '文档还没有成功解析的版本，无法复制');
  if (
    document.sourceConnectionId !== null &&
    !(await repo.knowledge.sourceScopeAllowsDocumentById(deps.db, document.id))
  ) {
    throw new AppError('CONFLICT', '来源授权已失效，不能复制该文档');
  }
  await repo.governance.assertKnowledgeDocumentQuota(deps.db, document.baseId);
  const chunks = await collectChunks(deps.db, version.id);
  const newDocumentId = newId('knowledgeDocument');
  const newVersionId = newId('knowledgeVersion');
  const knowledgeDir = deps.config.KNOWLEDGE_DIR;
  const targetDir = knowledgeVersionDir(knowledgeDir, newDocumentId, newVersionId);
  await mkdir(targetDir, { recursive: true });
  try {
    const markdown =
      (await Bun.file(knowledgeVersionMarkdownPath(knowledgeDir, document.id, version.id))
        .text()
        .catch(() => null)) ?? chunks.map((chunk) => chunk.content).join('\n\n');
    await Bun.write(
      knowledgeVersionMarkdownPath(knowledgeDir, newDocumentId, newVersionId),
      markdown,
    );
    await copyVersionImages(
      knowledgeVersionImagesDir(knowledgeDir, document.id, version.id),
      knowledgeVersionImagesDir(knowledgeDir, newDocumentId, newVersionId),
      version.images ?? [],
    );
    const tags =
      (await repo.knowledge.getDocumentTagNames(deps.db, [document.id])).get(document.id) ?? [];
    await deps.db.transaction(async (tx) => {
      await tx.insert(schema.knowledgeDocuments).values({
        id: newDocumentId,
        baseId: document.baseId,
        folderId: document.folderId,
        title: document.title,
        sourceType: 'manual',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        status:
          document.status === 'disabled' ? 'disabled' : chunks.length > 0 ? 'ready' : 'pending',
        contentKind: document.contentKind,
        disabledReason: document.status === 'disabled' ? document.disabledReason : null,
        sourceConnectionId: null,
        currentVersionId: newVersionId,
        contentHash: version.blobSha256,
        metadata: { originalFilename: version.originalFilename },
        lastSyncedAt: null,
      });
      await tx.insert(schema.knowledgeDocumentVersions).values({
        id: newVersionId,
        documentId: newDocumentId,
        version: 1,
        blobSha256: version.blobSha256,
        markdownSha256: sha256Hex(Buffer.from(markdown, 'utf8')),
        originalFilename: version.originalFilename,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        sourceRevision: null,
        parseStatus: version.parseStatus,
        pageMap: version.pageMap,
        images: version.images,
        embeddingProfileId: version.embeddingProfileId,
        origin: 'manual',
        parentVersionId: null,
        metadata: version.metadata,
        faq: version.faq,
      });
      await repo.knowledge.insertChunks(tx, {
        baseId: document.baseId,
        documentId: newDocumentId,
        versionId: newVersionId,
        folderId: document.folderId,
        chunks: chunks.map(cloneChunk),
      });
      if (tags.length > 0) {
        const rows = await repo.knowledge.upsertTags(tx, document.baseId, tags);
        await tx
          .insert(schema.knowledgeDocumentTags)
          .values(rows.map((tag) => ({ documentId: newDocumentId, tagId: tag.id })));
      }
      await repo.audit.writeAuditInTx(tx, {
        actor: deps.actor,
        action: 'knowledge.document.copied',
        target: newDocumentId,
        input: { baseId: document.baseId, sourceDocumentId: document.id },
        status: 'ok',
        requestId: deps.requestId,
      });
    });
  } catch (err) {
    await rm(knowledgeDocumentDir(deps.config.KNOWLEDGE_DIR, newDocumentId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw err;
  }
  await repo.governance
    .notifyKnowledgeDocumentQuota(deps.db, document.baseId)
    .catch((err: unknown) =>
      deps.log.warn({ err, documentId: newDocumentId }, 'knowledge copy quota notification failed'),
    );
  return newDocumentId;
}

export async function batchDocuments(
  deps: KnowledgeDeps,
  id: string,
  input: {
    documentIds: string[];
    action: 'move' | 'copy' | 'tag' | 'delete' | 'reprocess';
    folderId?: string | null | undefined;
    tags?: string[] | undefined;
    tagMode?: 'add' | 'remove' | 'replace' | undefined;
    confirmOverwriteManualChunks: boolean;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.action === 'move') {
    if (input.folderId === undefined) {
      throw new AppError('INVALID_INPUT', '移动文档需要 folderId（根目录传 null）');
    }
    if (input.folderId !== null) {
      await assertFolderInBase(deps, base.id, input.folderId);
    }
  }
  if (input.action === 'tag' && (!input.tags || !input.tagMode)) {
    throw new AppError('INVALID_INPUT', '批量标签需要 tags 与 tagMode');
  }
  const results: BatchResult[] = [];
  const documents = await repo.knowledge.getDocumentsByIds(deps.db, input.documentIds);
  for (const documentId of input.documentIds) {
    const document = documents.get(documentId);
    if (!document) {
      results.push({ documentId, status: 'failed', code: 'NOT_FOUND', message: '文档不存在' });
      continue;
    }
    if (document.baseId !== base.id) {
      results.push({
        documentId,
        status: 'failed',
        code: 'INVALID_INPUT',
        message: '文档不属于该知识库',
      });
      continue;
    }
    try {
      if (input.action === 'move') {
        await updateDocument(deps, document.id, { folderId: input.folderId ?? null });
        results.push({ documentId, status: 'succeeded' });
      } else if (input.action === 'copy') {
        results.push({
          documentId,
          status: 'succeeded',
          newDocumentId: await copyDocument(deps, document),
        });
      } else if (input.action === 'tag') {
        const tags = input.tags ?? [];
        const currentNames =
          input.tagMode === 'replace'
            ? []
            : ((await repo.knowledge.getDocumentTagNames(deps.db, [document.id])).get(
                document.id,
              ) ?? []);
        const names =
          input.tagMode === 'replace'
            ? tags
            : input.tagMode === 'remove'
              ? currentNames.filter((name) => !tags.includes(name))
              : [...new Set([...currentNames, ...tags])];
        await updateDocument(deps, document.id, { tags: names });
        results.push({ documentId, status: 'succeeded' });
      } else if (input.action === 'delete') {
        await deleteDocument(deps, document.id);
        results.push({ documentId, status: 'succeeded' });
      } else {
        const job = await reprocessDocument(deps, document.id, {
          confirmOverwriteManualChunks: input.confirmOverwriteManualChunks,
        });
        results.push({ documentId, status: 'succeeded', jobId: job.jobId });
      }
    } catch (err) {
      results.push({
        documentId,
        status: 'failed',
        code: isAppError(err) ? err.code : 'INTERNAL_ERROR',
        message: isAppError(err) ? err.message : '操作失败',
      });
      if (!isAppError(err)) deps.log.error({ err, documentId }, 'knowledge batch item failed');
    }
  }
  return { results };
}
