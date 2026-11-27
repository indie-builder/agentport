import { type KnowledgeContract, knowledgeContract } from '@agentport/contract/knowledge';

import { AppError } from '@agentport/core';
import { logEvent } from '@agentport/core/logger';
import type { KnowledgeFaqImportResult } from '@agentport/shared';
import { implement, ORPCError, type Router } from '@orpc/server';
import { requirePermission, resourceAccessFilter } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { problem, toAppError } from '../../http/errors.js';
import {
  authorizeBase,
  authorizeChunk,
  authorizeDocument,
  authorizeFolder,
  authorizeJob,
  authorizeSource,
  authorizeTag,
  authorizeVersion,
  authorizeWikiPage,
} from './access.js';
import {
  createBase,
  deleteBase,
  duplicateBase,
  getBase,
  getBaseSummary,
  listBaseActivity,
  listBases,
  listPins,
  previewChunks,
  setPin,
  updateBase,
} from './use-cases/bases.js';
import { getVersionDetails } from './use-cases/binary.js';
import {
  createChunk,
  deleteChunk,
  deleteDocument,
  documentDiff,
  generateDocumentSummary,
  generateDocumentTags,
  getDocument,
  listChunks,
  listDocuments,
  listImageAssets,
  listVersions,
  reprocessDocument,
  rollbackDocument,
  updateChunk,
  updateDocument,
  uploadDocument,
} from './use-cases/documents.js';
import { evaluateBase } from './use-cases/evaluation.js';
import {
  createFaq,
  deleteFaq,
  faqBatch,
  faqDrafts,
  getFaq,
  importFaqs,
  listFaqs,
  publishFaq,
  setFaqStatus,
  testFaqs,
  updateFaq,
} from './use-cases/faq-commands.js';
import {
  createFolder,
  createTag,
  deleteFolder,
  deleteTag,
  listFolders,
  listTags,
  renameTag,
  updateFolder,
} from './use-cases/folders-tags.js';
import { cancelJob, getJob, listJobs, retryJob } from './use-cases/jobs.js';
import {
  createManualDocument,
  createUrlDocument,
  getManualDocument,
  publishManualDocument,
  saveManualDraft,
} from './use-cases/manual-documents.js';
import {
  createModelProfile,
  deleteModelProfile,
  listModelProfiles,
  testModelProfile,
  updateModelProfile,
} from './use-cases/model-profiles.js';
import { batchDocuments, rebuildBase, searchBase } from './use-cases/search.js';
import { depsOf } from './use-cases/shared.js';
import {
  createSource,
  deleteSource,
  listSourceRunItems,
  listSourceRuns,
  listSources,
  syncSource,
  testSource,
  updateSource,
} from './use-cases/sources.js';
import {
  createWikiPage,
  generateWiki,
  getWikiPage,
  listWikiPages,
  listWikiVersions,
  publishWiki,
  rollbackWiki,
  updateWikiPage,
  wikiDiff,
  wikiGraph,
  wikiLinks,
} from './use-cases/wiki.js';

const os = implement(knowledgeContract).$context<RequestContext>();

export const knowledgeRouter: Router<KnowledgeContract, RequestContext> = os.router({
  bases: {
    pins: os.bases.pins.handler(async ({ context }) => {
      return listPins(depsOf(context));
    }),
    setPin: os.bases.setPin.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return setPin(depsOf(context), base, input.body.pinned);
    }),
    list: os.bases.list.handler(async ({ input, context }) => {
      const access = await resourceAccessFilter(
        context,
        'knowledge.read',
        'knowledge_base',
        'read',
      );
      return listBases(depsOf(context), input.query, access);
    }),
    create: os.bases.create.handler(async ({ input, context }) => {
      return createBase(depsOf(context), input.body);
    }),
    get: os.bases.get.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return getBase(base);
    }),
    summary: os.bases.summary.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return getBaseSummary(depsOf(context), input.params.id);
    }),
    activity: os.bases.activity.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listBaseActivity(depsOf(context), base, input.query);
    }),
    chunkPreview: os.bases.chunkPreview.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return previewChunks(base, input.body);
    }),
    update: os.bases.update.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.update', 'manage');
      return updateBase(depsOf(context), base, input.body);
    }),
    remove: os.bases.remove.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.delete', 'manage');
      await deleteBase(depsOf(context), base);
    }),
    duplicate: os.bases.duplicate.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return duplicateBase(depsOf(context), base, input.body);
    }),
    folders: os.bases.folders.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listFolders(depsOf(context), base);
    }),
    createFolder: os.bases.createFolder.handler(async ({ input, context }) => {
      const base = await authorizeBase(
        context,
        input.params.id,
        'knowledge.content.manage',
        'manage',
      );
      return createFolder(depsOf(context), base, input.body);
    }),
    tags: os.bases.tags.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listTags(depsOf(context), input.params.id);
    }),
    createTag: os.bases.createTag.handler(async ({ input, context }) => {
      const base = await authorizeBase(
        context,
        input.params.id,
        'knowledge.content.manage',
        'manage',
      );
      return createTag(depsOf(context), base, input.body.name);
    }),
    documents: os.bases.documents.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listDocuments(depsOf(context), input.params.id, input.query);
    }),
    images: os.bases.images.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listImageAssets(depsOf(context), input.params.id, input.query);
    }),
    upload: os.bases.upload.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return uploadDocument(depsOf(context), input.params.id, input.body);
    }),
    createManual: os.bases.createManual.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return createManualDocument(depsOf(context), input.params.id, input.body);
    }),
    createUrl: os.bases.createUrl.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return createUrlDocument(depsOf(context), input.params.id, input.body);
    }),
    search: os.bases.search.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return searchBase(depsOf(context), input.params.id, input.query);
    }),
    rebuild: os.bases.rebuild.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return rebuildBase(depsOf(context), input.params.id, input.body);
    }),
    batch: os.bases.batch.handler(async ({ input, context }) => {
      const permissionId =
        input.body.action === 'reprocess' ? 'knowledge.execute' : 'knowledge.content.manage';
      await requirePermission(context, permissionId);
      await authorizeBase(
        context,
        input.params.id,
        permissionId,
        input.body.action === 'reprocess' ? 'read' : 'manage',
      );
      return batchDocuments(depsOf(context), input.params.id, input.body);
    }),
    sources: os.bases.sources.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listSources(depsOf(context), input.params.id, input.query);
    }),
    createSource: os.bases.createSource.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.sources.manage', 'manage');
      return createSource(
        depsOf(context),
        input.params.id,
        input.body as unknown as Parameters<typeof createSource>[2],
      );
    }),
    wikiPages: os.bases.wikiPages.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listWikiPages(depsOf(context), input.params.id, input.query);
    }),
    createWikiPage: os.bases.createWikiPage.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return createWikiPage(depsOf(context), input.params.id, input.body);
    }),
    wikiGraph: os.bases.wikiGraph.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return wikiGraph(depsOf(context), input.params.id);
    }),
    faqs: os.bases.faqs.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return listFaqs(depsOf(context), input.params.id, input.query);
    }),
    createFaq: os.bases.createFaq.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return createFaq(depsOf(context), input.params.id, input.body);
    }),
    faqBatch: os.bases.faqBatch.handler(async ({ input, context }) => {
      const permissionId =
        input.body.action === 'publish' ? 'knowledge.publish' : 'knowledge.content.manage';
      await requirePermission(context, permissionId);
      await authorizeBase(context, input.params.id, permissionId, 'manage');

      try {
        const body = await faqBatch(depsOf(context), input.params.id, input.body);
        return { status: 200, body };
      } catch (err) {
        if (input.body.importBatchId === undefined) throw err;
        const appError = toAppError(err);
        const body = problem(context.requestId, appError);
        if (body.status >= 500) {
          logEvent(context.log, 'unhandled error', { code: body.code }, 'error', { err });
        } else if (body.status !== 401) {
          context.log.warn({ err, code: body.code }, 'request rejected');
        }
        const results: KnowledgeFaqImportResult[] = input.body.items.map((item, index) => ({
          row: index + 1,
          status: 'failed',
          operation: null,
          documentId: item.documentId,
          issues: [{ field: 'batch', code: appError.code, message: body.message }],
        }));
        throw new ORPCError(appError.code, {
          status: appError.status,
          message: body.message,
          data: { ...body, results },
          cause: err,
        });
      }
    }),
    importFaqs: os.bases.importFaqs.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.import', 'manage');

      const body = await importFaqs(depsOf(context), input.params.id, input.body);
      return { status: body.committed ? 202 : 200, body };
    }),
    testFaqs: os.bases.testFaqs.handler(async ({ input, context }) => {
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return testFaqs(depsOf(context), input.params.id, input.body);
    }),
    evaluate: os.bases.evaluate.handler(async ({ input, context }) => {
      const base = await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return evaluateBase(depsOf(context), base, input.body);
    }),
  },
  folders: {
    remove: os.folders.remove.handler(async ({ input, context }) => {
      await authorizeFolder(context, input.params.folderId, 'knowledge.content.manage', 'manage');
      await deleteFolder(depsOf(context), input.params.folderId);
    }),
    update: os.folders.update.handler(async ({ input, context }) => {
      await authorizeFolder(context, input.params.folderId, 'knowledge.content.manage', 'manage');
      return updateFolder(depsOf(context), input.params.folderId, input.body);
    }),
  },
  tags: {
    update: os.tags.update.handler(async ({ input, context }) => {
      await authorizeTag(context, input.params.tagId, 'knowledge.content.manage', 'manage');
      return renameTag(depsOf(context), input.params.tagId, input.body.name);
    }),
    remove: os.tags.remove.handler(async ({ input, context }) => {
      const tag = await authorizeTag(
        context,
        input.params.tagId,
        'knowledge.content.manage',
        'manage',
      );
      await deleteTag(depsOf(context), tag);
    }),
  },
  documents: {
    get: os.documents.get.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return getDocument(depsOf(context), input.params.documentId);
    }),
    update: os.documents.update.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return updateDocument(depsOf(context), input.params.documentId, input.body);
    }),
    remove: os.documents.remove.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return deleteDocument(depsOf(context), input.params.documentId);
    }),
    reprocess: os.documents.reprocess.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.execute', 'read');
      return reprocessDocument(depsOf(context), input.params.documentId, input.body);
    }),
    summary: os.documents.summary.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return generateDocumentSummary(depsOf(context), input.params.documentId);
    }),
    tagsGenerate: os.documents.tagsGenerate.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return generateDocumentTags(depsOf(context), input.params.documentId);
    }),
    chunks: os.documents.chunks.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return listChunks(depsOf(context), input.params.documentId, input.query);
    }),
    createChunk: os.documents.createChunk.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return createChunk(depsOf(context), input.params.documentId, input.body);
    }),
    versions: os.documents.versions.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return listVersions(depsOf(context), input.params.documentId, input.query);
    }),
    diff: os.documents.diff.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return documentDiff(depsOf(context), input.params.documentId, input.query);
    }),
    rollback: os.documents.rollback.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return rollbackDocument(depsOf(context), input.params.documentId, input.body);
    }),
    manual: os.documents.manual.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return getManualDocument(depsOf(context), input.params.documentId);
    }),
    saveManual: os.documents.saveManual.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return saveManualDraft(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.documents.publish.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return publishManualDocument(depsOf(context), input.params.documentId, input.body);
    }),
  },
  chunks: {
    update: os.chunks.update.handler(async ({ input, context }) => {
      await authorizeChunk(context, input.params.chunkId, 'knowledge.content.manage', 'manage');
      return updateChunk(depsOf(context), input.params.chunkId, input.body);
    }),
    remove: os.chunks.remove.handler(async ({ input, context }) => {
      await authorizeChunk(context, input.params.chunkId, 'knowledge.content.manage', 'manage');
      return deleteChunk(depsOf(context), input.params.chunkId, input.body);
    }),
  },
  versions: {
    details: os.versions.details.handler(async ({ input, context }) => {
      const { version } = await authorizeVersion(
        context,
        input.params.versionId,
        'knowledge.read',
        'read',
      );
      return getVersionDetails(version);
    }),
  },
  sources: {
    update: os.sources.update.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return updateSource(depsOf(context), input.params.sourceId, input.body);
    }),
    remove: os.sources.remove.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return deleteSource(depsOf(context), input.params.sourceId, input.query.documents);
    }),
    test: os.sources.test.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return testSource(depsOf(context), input.params.sourceId);
    }),
    sync: os.sources.sync.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.execute', 'read');
      return syncSource(depsOf(context), input.params.sourceId);
    }),
    runs: os.sources.runs.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.read', 'read');
      return listSourceRuns(depsOf(context), input.params.sourceId, input.query);
    }),
    runItems: os.sources.runItems.handler(async ({ input, context }) => {
      await authorizeSource(context, input.params.sourceId, 'knowledge.read', 'read');
      return listSourceRunItems(
        depsOf(context),
        input.params.sourceId,
        input.params.syncRunId,
        input.query,
      );
    }),
  },
  wiki: {
    get: os.wiki.get.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return getWikiPage(depsOf(context), input.params.pageId, input.query);
    }),
    update: os.wiki.update.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return updateWikiPage(depsOf(context), input.params.pageId, input.body);
    }),
    generate: os.wiki.generate.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.execute', 'read');
      return generateWiki(depsOf(context), input.params.pageId, input.body);
    }),
    versions: os.wiki.versions.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return listWikiVersions(depsOf(context), input.params.pageId, input.query);
    }),
    links: os.wiki.links.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return wikiLinks(depsOf(context), input.params.pageId);
    }),
    diff: os.wiki.diff.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return wikiDiff(depsOf(context), input.params.pageId, input.query);
    }),
    publish: os.wiki.publish.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return publishWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
    rollback: os.wiki.rollback.handler(async ({ input, context }) => {
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return rollbackWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
  },
  faqs: {
    drafts: os.faqs.drafts.handler(async ({ input, context }) => {
      const access = await resourceAccessFilter(
        context,
        'knowledge.read',
        'knowledge_base',
        'read',
      );
      const drafts = await faqDrafts(depsOf(context), input.body.documentIds, access);
      await Promise.all(
        [...new Set(drafts.map((draft) => draft.baseId))].map((baseId) =>
          authorizeBase(context, baseId, 'knowledge.read', 'read'),
        ),
      );
      return drafts.map(({ documentId, draft }) => ({ documentId, draft }));
    }),
    remove: os.faqs.remove.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      await deleteFaq(depsOf(context), input.params.documentId);
    }),
    get: os.faqs.get.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return getFaq(depsOf(context), input.params.documentId);
    }),
    update: os.faqs.update.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return updateFaq(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.faqs.publish.handler(async ({ input, context }) => {
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return publishFaq(depsOf(context), input.params.documentId, input.body);
    }),
    status: os.faqs.status.handler(async ({ input, context }) => {
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return setFaqStatus(depsOf(context), input.params.documentId, input.body.enabled);
    }),
  },
  jobs: {
    list: os.jobs.list.handler(async ({ input, context }) => {
      const baseId = input.query.baseId;
      if (baseId !== undefined) {
        await authorizeBase(context, baseId, 'knowledge.read', 'read');
      }
      const access =
        baseId === undefined
          ? await resourceAccessFilter(context, 'knowledge.read', 'knowledge_base', 'read')
          : undefined;
      return listJobs(depsOf(context), input.query, access);
    }),
    get: os.jobs.get.handler(async ({ input, context }) => {
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.read', 'read');
      return getJob(job);
    }),
    retry: os.jobs.retry.handler(async ({ input, context }) => {
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.execute', 'read');
      if (job.type === 'summary' || job.type === 'tag_generate') {
        await requirePermission(context, 'knowledge.content.manage');
        if (job.documentId === null) {
          throw new AppError('CONFLICT', '任务缺少目标文档，无法重试');
        }
        await authorizeDocument(context, job.documentId, 'knowledge.content.manage', 'manage');
      }
      return retryJob(depsOf(context), job);
    }),
    cancel: os.jobs.cancel.handler(async ({ input, context }) => {
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.execute', 'read');
      return cancelJob(depsOf(context), job);
    }),
  },
  modelProfiles: {
    remove: os.modelProfiles.remove.handler(async ({ input, context }) => {
      await deleteModelProfile(depsOf(context), input.params.profileId);
    }),
    list: os.modelProfiles.list.handler(async ({ input, context }) => {
      await requirePermission(
        context,
        input.query.view === 'selection' ? 'knowledge.read' : 'knowledge.models.manage',
      );
      return listModelProfiles(depsOf(context), input.query.view);
    }),
    create: os.modelProfiles.create.handler(async ({ input, context }) => {
      return createModelProfile(depsOf(context), input.body);
    }),
    update: os.modelProfiles.update.handler(async ({ input, context }) => {
      return updateModelProfile(depsOf(context), input.params.profileId, input.body);
    }),
    test: os.modelProfiles.test.handler(async ({ input, context }) => {
      return testModelProfile(depsOf(context), input.params.profileId);
    }),
  },
});
