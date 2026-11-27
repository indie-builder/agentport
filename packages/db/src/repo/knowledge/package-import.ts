import { eq } from 'drizzle-orm';
import type { Database } from '../../client.js';
import {
  knowledgeBases,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentTags,
  knowledgeDocumentVersions,
  knowledgeFolders,
  knowledgeTags,
  knowledgeWikiPages,
  knowledgeWikiSources,
  knowledgeWikiVersions,
} from '../../schema.js';
import { assertKnowledgeDocumentQuota } from '../governance/budgets.js';
import { upsertManagedServer } from '../servers.js';
import {
  INSERT_CHUNK,
  type KnowledgeBaseRow,
  type KnowledgeChunkRow,
  type KnowledgeDocumentRow,
  type KnowledgeVersionRow,
  type KnowledgeWikiPageRow,
  type KnowledgeWikiVersionRow,
} from './shared.js';

export interface ImportKnowledgePackageInput {
  baseId: string;
  serverId: string;
  ownerBusinessId: string | null;
  base: {
    slug: string;
    name: string;
    description: string;
    status: KnowledgeBaseRow['status'];
    settings: KnowledgeBaseRow['settings'];
    embeddingProfileId: string;
    rerankProfileId: string | null;
    asrProfileId: string | null;
  };
  folders: Array<{
    id: string;
    parentId: string | null;
    name: string;
    path: string;
  }>;
  tags: Array<{
    id: string;
    name: string;
  }>;
  documents: Array<{
    id: string;
    folderId: string | null;
    title: string;
    sourceType: KnowledgeDocumentRow['sourceType'];
    sourceId: string | null;
    sourceUrl: string | null;
    sourcePath: string | null;
    mimeType: string;
    sizeBytes: number;
    status: KnowledgeDocumentRow['status'];
    contentKind: KnowledgeDocumentRow['contentKind'];
    disabledReason: KnowledgeDocumentRow['disabledReason'];
    currentVersionId: string | null;
    contentHash: string | null;
    metadata: Record<string, unknown>;
    lastSyncedAt: Date | null;
    tagIds: string[];
    versions: Array<{
      id: string;
      version: number;
      origin: KnowledgeVersionRow['origin'];
      parentVersionId: string | null;
      metadata: Record<string, unknown>;
      faq: KnowledgeVersionRow['faq'];
      blobSha256: string;
      markdownSha256: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      sourceRevision: string | null;
      parseStatus: KnowledgeVersionRow['parseStatus'];
      pageMap: KnowledgeVersionRow['pageMap'];
      images: KnowledgeVersionRow['images'];
      chunks: Array<{
        id: string;
        ordinal: number;
        parentOrdinal: number | null;
        indexRole: KnowledgeChunkRow['indexRole'];
        kind: KnowledgeChunkRow['kind'];
        heading: string | null;
        content: string;
        searchText: string;
        enabled: boolean;
        editedByUser: boolean;
        pageFrom: number | null;
        pageTo: number | null;
        locator: KnowledgeChunkRow['locator'];
        tokenCount: number;
        metadata: Record<string, unknown>;
      }>;
    }>;
  }>;
  wikiPages: Array<{
    id: string;
    slug: string;
    title: string;
    parentId: string | null;
    position: number;
    status: KnowledgeWikiPageRow['status'];
    currentVersionId: string | null;
    versions: Array<{
      id: string;
      version: number;
      markdown: string;
      sourceChunkIds: string[];
      model: string;
      generatedBy: KnowledgeWikiVersionRow['generatedBy'];
    }>;
    sources: Array<{
      documentId: string | null;
      versionId: string | null;
      chunkId: string | null;
      stale: boolean;
    }>;
  }>;
}

export async function importKnowledgePackage(
  db: Database,
  input: ImportKnowledgePackageInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    await upsertManagedServer(tx, {
      kind: 'knowledge',
      resourceId: input.baseId,
      slug: input.base.slug,
      ownerBusinessId: input.ownerBusinessId,
      serverId: input.serverId,
    });
    await tx.insert(knowledgeBases).values({
      id: input.baseId,
      slug: input.base.slug,
      name: input.base.name,
      description: input.base.description,
      status: input.base.status,
      serverId: input.serverId,
      embeddingProfileId: input.base.embeddingProfileId,
      rerankProfileId: input.base.rerankProfileId,
      asrProfileId: input.base.asrProfileId,
      settings: input.base.settings,
      ownerBusinessId: input.ownerBusinessId,
    });
    await assertKnowledgeDocumentQuota(tx, input.baseId, input.documents.length);

    for (const folder of [...input.folders].sort((a, b) => a.path.length - b.path.length)) {
      await tx.insert(knowledgeFolders).values({
        id: folder.id,
        baseId: input.baseId,
        parentId: folder.parentId,
        name: folder.name,
        path: folder.path,
      });
    }
    if (input.tags.length > 0) {
      await tx.insert(knowledgeTags).values(
        input.tags.map((tag) => ({
          id: tag.id,
          baseId: input.baseId,
          name: tag.name,
        })),
      );
    }

    for (const document of input.documents) {
      await tx.insert(knowledgeDocuments).values({
        id: document.id,
        baseId: input.baseId,
        folderId: document.folderId,
        title: document.title,
        sourceType: document.sourceType,
        sourceId: document.sourceId,
        sourceUrl: document.sourceUrl,
        sourcePath: document.sourcePath,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        status: document.status,
        contentKind: document.contentKind,
        disabledReason: document.disabledReason,
        sourceConnectionId: null,
        currentVersionId: null,
        contentHash: document.contentHash,
        metadata: document.metadata,
        lastSyncedAt: document.lastSyncedAt,
      });
      for (const version of document.versions) {
        await tx.insert(knowledgeDocumentVersions).values({
          id: version.id,
          documentId: document.id,
          version: version.version,
          origin: version.origin,
          parentVersionId: null,
          metadata: version.metadata,
          faq: version.faq,
          blobSha256: version.blobSha256,
          markdownSha256: version.markdownSha256,
          originalFilename: version.originalFilename,
          mimeType: version.mimeType,
          sizeBytes: version.sizeBytes,
          sourceRevision: version.sourceRevision,
          parseStatus: version.parseStatus,
          pageMap: version.pageMap,
          images: version.images,
          embeddingProfileId: input.base.embeddingProfileId,
        });
        for (let offset = 0; offset < version.chunks.length; offset += INSERT_CHUNK) {
          const batch = version.chunks.slice(offset, offset + INSERT_CHUNK);
          await tx.insert(knowledgeChunks).values(
            batch.map((chunk) => ({
              id: chunk.id,
              baseId: input.baseId,
              documentId: document.id,
              versionId: version.id,
              folderId: document.folderId,
              ordinal: chunk.ordinal,
              parentOrdinal: chunk.parentOrdinal,
              indexRole: chunk.indexRole,
              kind: chunk.kind,
              heading: chunk.heading,
              content: chunk.content,
              searchText: chunk.searchText,
              embedding: null,
              enabled: chunk.enabled,
              editedByUser: chunk.editedByUser,
              pageFrom: chunk.pageFrom,
              pageTo: chunk.pageTo,
              locator: chunk.locator,
              tokenCount: chunk.tokenCount,
              metadata: chunk.metadata,
            })),
          );
        }
      }
      for (const version of document.versions) {
        if (version.parentVersionId === null) continue;
        await tx
          .update(knowledgeDocumentVersions)
          .set({ parentVersionId: version.parentVersionId })
          .where(eq(knowledgeDocumentVersions.id, version.id));
      }
      if (document.currentVersionId !== null) {
        await tx
          .update(knowledgeDocuments)
          .set({ currentVersionId: document.currentVersionId })
          .where(eq(knowledgeDocuments.id, document.id));
      }
      if (document.tagIds.length > 0) {
        await tx
          .insert(knowledgeDocumentTags)
          .values(document.tagIds.map((tagId) => ({ documentId: document.id, tagId })));
      }
    }

    for (const page of input.wikiPages) {
      await tx.insert(knowledgeWikiPages).values({
        id: page.id,
        baseId: input.baseId,
        slug: page.slug,
        title: page.title,
        parentId: null,
        position: page.position,
        status: page.status,
        currentVersionId: null,
      });
      for (const version of page.versions) {
        await tx.insert(knowledgeWikiVersions).values({
          id: version.id,
          pageId: page.id,
          version: version.version,
          markdown: version.markdown,
          sourceChunkIds: version.sourceChunkIds,
          model: version.model,
          generatedBy: version.generatedBy,
        });
      }
      if (page.currentVersionId !== null) {
        await tx
          .update(knowledgeWikiPages)
          .set({ currentVersionId: page.currentVersionId })
          .where(eq(knowledgeWikiPages.id, page.id));
      }
      if (page.sources.length > 0) {
        await tx.insert(knowledgeWikiSources).values(
          page.sources.map((source) => ({
            pageId: page.id,
            documentId: source.documentId,
            versionId: source.versionId,
            chunkId: source.chunkId,
            stale: source.stale,
          })),
        );
      }
    }
    for (const page of input.wikiPages) {
      if (page.parentId === null) continue;
      await tx
        .update(knowledgeWikiPages)
        .set({ parentId: page.parentId })
        .where(eq(knowledgeWikiPages.id, page.id));
    }
  });
}
