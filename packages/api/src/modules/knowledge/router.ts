import { type KnowledgeContract, knowledgeContract } from '@agentport/contract/knowledge';

import { AppError } from '@agentport/core';
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
import * as useCases from './use-cases.js';
import { depsOf } from './use-cases.js';

const os = implement(knowledgeContract).$context<RequestContext>();

export const knowledgeRouter: Router<KnowledgeContract, RequestContext> = os.router({
  bases: {
    pins: os.bases.pins.handler(async ({ context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listPins(depsOf(context));
    }),
    setPin: os.bases.setPin.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.setPin(depsOf(context), input.params.id, input.body.pinned);
    }),
    list: os.bases.list.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      const access = await resourceAccessFilter(
        context,
        'knowledge.read',
        'knowledge_base',
        'read',
      );
      return useCases.listBases(depsOf(context), input.query, access);
    }),
    create: os.bases.create.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.create');
      return useCases.createBase(depsOf(context), input.body);
    }),
    get: os.bases.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.getBase(depsOf(context), input.params.id);
    }),
    summary: os.bases.summary.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.getBaseSummary(depsOf(context), input.params.id);
    }),
    activity: os.bases.activity.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listBaseActivity(depsOf(context), input.params.id, input.query);
    }),
    chunkPreview: os.bases.chunkPreview.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.previewChunks(depsOf(context), input.params.id, input.body);
    }),
    update: os.bases.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.update');
      await authorizeBase(context, input.params.id, 'knowledge.update', 'manage');
      return useCases.updateBase(depsOf(context), input.params.id, input.body);
    }),
    remove: os.bases.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.delete');
      await authorizeBase(context, input.params.id, 'knowledge.delete', 'manage');
      await useCases.deleteBase(depsOf(context), input.params.id);
    }),
    duplicate: os.bases.duplicate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.create');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.duplicateBase(depsOf(context), input.params.id, input.body);
    }),
    folders: os.bases.folders.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listFolders(depsOf(context), input.params.id);
    }),
    createFolder: os.bases.createFolder.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createFolder(depsOf(context), input.params.id, input.body);
    }),
    tags: os.bases.tags.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listTags(depsOf(context), input.params.id);
    }),
    createTag: os.bases.createTag.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createTag(depsOf(context), input.params.id, input.body.name);
    }),
    documents: os.bases.documents.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listDocuments(depsOf(context), input.params.id, input.query);
    }),
    images: os.bases.images.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listImageAssets(depsOf(context), input.params.id, input.query);
    }),
    upload: os.bases.upload.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.uploadDocument(depsOf(context), input.params.id, input.body);
    }),
    createManual: os.bases.createManual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createManualDocument(depsOf(context), input.params.id, input.body);
    }),
    createUrl: os.bases.createUrl.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createUrlDocument(depsOf(context), input.params.id, input.body);
    }),
    search: os.bases.search.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return useCases.searchBase(depsOf(context), input.params.id, input.query);
    }),
    rebuild: os.bases.rebuild.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return useCases.rebuildBase(depsOf(context), input.params.id, input.body);
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
      return useCases.batchDocuments(depsOf(context), input.params.id, input.body);
    }),
    sources: os.bases.sources.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listSources(depsOf(context), input.params.id, input.query);
    }),
    createSource: os.bases.createSource.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');
      await authorizeBase(context, input.params.id, 'knowledge.sources.manage', 'manage');
      return useCases.createSource(
        depsOf(context),
        input.params.id,
        input.body as unknown as Parameters<typeof useCases.createSource>[2],
      );
    }),
    wikiPages: os.bases.wikiPages.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listWikiPages(depsOf(context), input.params.id, input.query);
    }),
    createWikiPage: os.bases.createWikiPage.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createWikiPage(depsOf(context), input.params.id, input.body);
    }),
    faqs: os.bases.faqs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeBase(context, input.params.id, 'knowledge.read', 'read');
      return useCases.listFaqs(depsOf(context), input.params.id, input.query);
    }),
    createFaq: os.bases.createFaq.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeBase(context, input.params.id, 'knowledge.content.manage', 'manage');
      return useCases.createFaq(depsOf(context), input.params.id, input.body);
    }),
    faqBatch: os.bases.faqBatch.handler(async ({ input, context }) => {
      const permissionId =
        input.body.action === 'publish' ? 'knowledge.publish' : 'knowledge.content.manage';
      await requirePermission(context, permissionId);
      await authorizeBase(context, input.params.id, permissionId, 'manage');

      try {
        const body = await useCases.faqBatch(depsOf(context), input.params.id, input.body);
        return { status: 200, body };
      } catch (err) {
        if (input.body.importBatchId === undefined) throw err;
        const appError = toAppError(err);
        const results: KnowledgeFaqImportResult[] = input.body.items.map((item, index) => ({
          row: index + 1,
          status: 'failed',
          operation: null,
          documentId: item.documentId,
          issues: [{ field: 'batch', code: appError.code, message: appError.message }],
        }));
        throw new ORPCError(appError.code, {
          status: appError.status,
          message: appError.message,
          data: { ...problem(context.requestId, appError), results },
          cause: err,
        });
      }
    }),
    importFaqs: os.bases.importFaqs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.import');
      await authorizeBase(context, input.params.id, 'knowledge.import', 'manage');

      const body = await useCases.importFaqs(depsOf(context), input.params.id, input.body);
      return { status: body.committed ? 202 : 200, body };
    }),
    testFaqs: os.bases.testFaqs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return useCases.testFaqs(depsOf(context), input.params.id, input.body);
    }),
    evaluate: os.bases.evaluate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeBase(context, input.params.id, 'knowledge.execute', 'read');
      return useCases.evaluateBase(depsOf(context), input.params.id, input.body);
    }),
  },
  folders: {
    remove: os.folders.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeFolder(context, input.params.folderId, 'knowledge.content.manage', 'manage');
      await useCases.deleteFolder(depsOf(context), input.params.folderId);
    }),
    update: os.folders.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeFolder(context, input.params.folderId, 'knowledge.content.manage', 'manage');
      return useCases.updateFolder(depsOf(context), input.params.folderId, input.body);
    }),
  },
  tags: {
    update: os.tags.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeTag(context, input.params.tagId, 'knowledge.content.manage', 'manage');
      return useCases.renameTag(depsOf(context), input.params.tagId, input.body.name);
    }),
    remove: os.tags.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeTag(context, input.params.tagId, 'knowledge.content.manage', 'manage');
      await useCases.deleteTag(depsOf(context), input.params.tagId);
    }),
  },
  documents: {
    get: os.documents.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.getDocument(depsOf(context), input.params.documentId);
    }),
    update: os.documents.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.updateDocument(depsOf(context), input.params.documentId, input.body);
    }),
    remove: os.documents.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.deleteDocument(depsOf(context), input.params.documentId);
    }),
    reprocess: os.documents.reprocess.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeDocument(context, input.params.documentId, 'knowledge.execute', 'read');
      return useCases.reprocessDocument(depsOf(context), input.params.documentId, input.body);
    }),
    summary: os.documents.summary.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.generateDocumentSummary(depsOf(context), input.params.documentId);
    }),
    tagsGenerate: os.documents.tagsGenerate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.generateDocumentTags(depsOf(context), input.params.documentId);
    }),
    chunks: os.documents.chunks.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.listChunks(depsOf(context), input.params.documentId, input.query);
    }),
    createChunk: os.documents.createChunk.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.createChunk(depsOf(context), input.params.documentId, input.body);
    }),
    versions: os.documents.versions.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.listVersions(depsOf(context), input.params.documentId, input.query);
    }),
    diff: os.documents.diff.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.documentDiff(depsOf(context), input.params.documentId, input.query);
    }),
    rollback: os.documents.rollback.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return useCases.rollbackDocument(depsOf(context), input.params.documentId, input.body);
    }),
    manual: os.documents.manual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.getManualDocument(depsOf(context), input.params.documentId);
    }),
    saveManual: os.documents.saveManual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.saveManualDraft(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.documents.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return useCases.publishManualDocument(depsOf(context), input.params.documentId, input.body);
    }),
  },
  chunks: {
    update: os.chunks.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeChunk(context, input.params.chunkId, 'knowledge.content.manage', 'manage');
      return useCases.updateChunk(depsOf(context), input.params.chunkId, input.body);
    }),
    remove: os.chunks.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeChunk(context, input.params.chunkId, 'knowledge.content.manage', 'manage');
      return useCases.deleteChunk(depsOf(context), input.params.chunkId, input.body);
    }),
  },
  versions: {
    details: os.versions.details.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeVersion(context, input.params.versionId, 'knowledge.read', 'read');
      return useCases.getVersionDetails(depsOf(context), input.params.versionId);
    }),
  },
  sources: {
    update: os.sources.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return useCases.updateSource(depsOf(context), input.params.sourceId, input.body);
    }),
    remove: os.sources.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return useCases.deleteSource(depsOf(context), input.params.sourceId, input.query.documents);
    }),
    test: os.sources.test.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');
      await authorizeSource(context, input.params.sourceId, 'knowledge.sources.manage', 'manage');
      return useCases.testSource(depsOf(context), input.params.sourceId);
    }),
    sync: os.sources.sync.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeSource(context, input.params.sourceId, 'knowledge.execute', 'read');
      return useCases.syncSource(depsOf(context), input.params.sourceId);
    }),
    runs: os.sources.runs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeSource(context, input.params.sourceId, 'knowledge.read', 'read');
      return useCases.listSourceRuns(depsOf(context), input.params.sourceId, input.query);
    }),
    runItems: os.sources.runItems.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeSource(context, input.params.sourceId, 'knowledge.read', 'read');
      return useCases.listSourceRunItems(
        depsOf(context),
        input.params.sourceId,
        input.params.syncRunId,
        input.query,
      );
    }),
  },
  wiki: {
    get: os.wiki.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return useCases.getWikiPage(depsOf(context), input.params.pageId, input.query);
    }),
    update: os.wiki.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return useCases.updateWikiPage(depsOf(context), input.params.pageId, input.body);
    }),
    generate: os.wiki.generate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.execute', 'read');
      return useCases.generateWiki(depsOf(context), input.params.pageId, input.body);
    }),
    versions: os.wiki.versions.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return useCases.listWikiVersions(depsOf(context), input.params.pageId, input.query);
    }),
    links: os.wiki.links.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return useCases.wikiLinks(depsOf(context), input.params.pageId);
    }),
    diff: os.wiki.diff.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.read', 'read');
      return useCases.wikiDiff(depsOf(context), input.params.pageId, input.query);
    }),
    publish: os.wiki.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return useCases.publishWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
    rollback: os.wiki.rollback.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeWikiPage(context, input.params.pageId, 'knowledge.publish', 'manage');
      return useCases.rollbackWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
  },
  faqs: {
    remove: os.faqs.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      await useCases.deleteFaq(depsOf(context), input.params.documentId);
    }),
    get: os.faqs.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      await authorizeDocument(context, input.params.documentId, 'knowledge.read', 'read');
      return useCases.getFaq(depsOf(context), input.params.documentId);
    }),
    update: os.faqs.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.updateFaq(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.faqs.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');
      await authorizeDocument(context, input.params.documentId, 'knowledge.publish', 'manage');
      return useCases.publishFaq(depsOf(context), input.params.documentId, input.body);
    }),
    status: os.faqs.status.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await authorizeDocument(
        context,
        input.params.documentId,
        'knowledge.content.manage',
        'manage',
      );
      return useCases.setFaqStatus(depsOf(context), input.params.documentId, input.body.enabled);
    }),
  },
  jobs: {
    list: os.jobs.list.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      const baseId = input.query.baseId;
      if (baseId !== undefined) {
        await authorizeBase(context, baseId, 'knowledge.read', 'read');
      }
      const access =
        baseId === undefined
          ? await resourceAccessFilter(context, 'knowledge.read', 'knowledge_base', 'read')
          : undefined;
      return useCases.listJobs(depsOf(context), input.query, access);
    }),
    get: os.jobs.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.read', 'read');
      return useCases.getJob(job);
    }),
    retry: os.jobs.retry.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.execute', 'read');
      if (job.type === 'summary') {
        await requirePermission(context, 'knowledge.content.manage');
        if (job.documentId === null) {
          throw new AppError('CONFLICT', '摘要任务缺少目标文档，无法重试');
        }
        await authorizeDocument(context, job.documentId, 'knowledge.content.manage', 'manage');
      }
      return useCases.retryJob(depsOf(context), job);
    }),
    cancel: os.jobs.cancel.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      const job = await authorizeJob(context, input.params.jobId, 'knowledge.execute', 'read');
      return useCases.cancelJob(depsOf(context), job);
    }),
  },
  modelProfiles: {
    remove: os.modelProfiles.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.models.manage');
      await useCases.deleteModelProfile(depsOf(context), input.params.profileId);
    }),
    list: os.modelProfiles.list.handler(async ({ input, context }) => {
      await requirePermission(
        context,
        input.query.view === 'selection' ? 'knowledge.read' : 'knowledge.models.manage',
      );
      return useCases.listModelProfiles(depsOf(context), input.query.view);
    }),
    create: os.modelProfiles.create.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.models.manage');
      return useCases.createModelProfile(depsOf(context), input.body);
    }),
    update: os.modelProfiles.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.models.manage');
      return useCases.updateModelProfile(depsOf(context), input.params.profileId, input.body);
    }),
    test: os.modelProfiles.test.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.models.manage');
      return useCases.testModelProfile(depsOf(context), input.params.profileId);
    }),
  },
});
