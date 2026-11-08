import { type KnowledgeContract, knowledgeContract } from '@agentport/contract/knowledge';

import type { KnowledgeFaqImportResult } from '@agentport/shared';
import { implement, ORPCError, type Router } from '@orpc/server';
import { requirePermission } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { problem, toAppError } from '../../http/errors.js';
import * as useCases from './use-cases.js';
import { depsOf } from './use-cases.js';

const os = implement(knowledgeContract).$context<RequestContext>();

export const knowledgeRouter: Router<KnowledgeContract, RequestContext> = os.router({
  bases: {
    list: os.bases.list.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listBases(depsOf(context), input.query);
    }),
    create: os.bases.create.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.create');
      return useCases.createBase(depsOf(context), input.body);
    }),
    get: os.bases.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.getBase(depsOf(context), input.params.id);
    }),
    summary: os.bases.summary.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.getBaseSummary(depsOf(context), input.params.id);
    }),
    activity: os.bases.activity.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listBaseActivity(depsOf(context), input.params.id, input.query);
    }),
    chunkPreview: os.bases.chunkPreview.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.previewChunks(depsOf(context), input.params.id, input.body);
    }),
    update: os.bases.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.update');
      return useCases.updateBase(depsOf(context), input.params.id, input.body);
    }),
    remove: os.bases.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.delete');
      await useCases.deleteBase(depsOf(context), input.params.id);
    }),
    duplicate: os.bases.duplicate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.create');
      return useCases.duplicateBase(depsOf(context), input.params.id, input.body);
    }),
    folders: os.bases.folders.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listFolders(depsOf(context), input.params.id, input.query);
    }),
    createFolder: os.bases.createFolder.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.createFolder(depsOf(context), input.params.id, input.body);
    }),
    tags: os.bases.tags.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listTags(depsOf(context), input.params.id);
    }),
    createTag: os.bases.createTag.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.createTag(depsOf(context), input.params.id, input.body.name);
    }),
    documents: os.bases.documents.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listDocuments(depsOf(context), input.params.id, input.query);
    }),
    upload: os.bases.upload.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.uploadDocument(depsOf(context), input.params.id, input.body);
    }),
    createManual: os.bases.createManual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.createManualDocument(depsOf(context), input.params.id, input.body);
    }),
    createUrl: os.bases.createUrl.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.createUrlDocument(depsOf(context), input.params.id, input.body);
    }),
    search: os.bases.search.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      return useCases.searchBase(depsOf(context), input.params.id, input.query);
    }),
    rebuild: os.bases.rebuild.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');

      return useCases.rebuildBase(depsOf(context), input.params.id, input.body);
    }),
    batch: os.bases.batch.handler(async ({ input, context }) => {
      const permissionId =
        input.body.action === 'reprocess' ? 'knowledge.execute' : 'knowledge.content.manage';
      await requirePermission(context, permissionId);

      return useCases.batchDocuments(depsOf(context), input.params.id, input.body);
    }),
    sources: os.bases.sources.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listSources(depsOf(context), input.params.id, input.query);
    }),
    createSource: os.bases.createSource.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');

      return useCases.createSource(
        depsOf(context),
        input.params.id,
        input.body as unknown as Parameters<typeof useCases.createSource>[2],
      );
    }),
    wikiPages: os.bases.wikiPages.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listWikiPages(depsOf(context), input.params.id, input.query);
    }),
    createWikiPage: os.bases.createWikiPage.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.createWikiPage(depsOf(context), input.params.id, input.body);
    }),
    faqs: os.bases.faqs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listFaqs(depsOf(context), input.params.id, input.query);
    }),
    createFaq: os.bases.createFaq.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.createFaq(depsOf(context), input.params.id, input.body);
    }),
    faqBatch: os.bases.faqBatch.handler(async ({ input, context }) => {
      const permissionId =
        input.body.action === 'publish' ? 'knowledge.publish' : 'knowledge.content.manage';
      await requirePermission(context, permissionId);

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

      const body = await useCases.importFaqs(depsOf(context), input.params.id, input.body);
      return { status: body.committed ? 202 : 200, body };
    }),
    testFaqs: os.bases.testFaqs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');

      return useCases.testFaqs(depsOf(context), input.params.id, input.body);
    }),
    evaluate: os.bases.evaluate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');

      return useCases.evaluateBase(depsOf(context), input.params.id, input.body);
    }),
  },
  folders: {
    remove: os.folders.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await useCases.deleteFolder(depsOf(context), input.params.folderId);
    }),
    update: os.folders.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.updateFolder(depsOf(context), input.params.folderId, input.body);
    }),
  },
  tags: {
    update: os.tags.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.renameTag(depsOf(context), input.params.tagId, input.body.name);
    }),
    remove: os.tags.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      await useCases.deleteTag(depsOf(context), input.params.tagId);
    }),
  },
  documents: {
    get: os.documents.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.getDocument(depsOf(context), input.params.documentId);
    }),
    update: os.documents.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.updateDocument(depsOf(context), input.params.documentId, input.body);
    }),
    remove: os.documents.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.deleteDocument(depsOf(context), input.params.documentId);
    }),
    reprocess: os.documents.reprocess.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      return useCases.reprocessDocument(depsOf(context), input.params.documentId, input.body);
    }),
    chunks: os.documents.chunks.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listChunks(depsOf(context), input.params.documentId, input.query);
    }),
    createChunk: os.documents.createChunk.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.createChunk(depsOf(context), input.params.documentId, input.body);
    }),
    versions: os.documents.versions.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listVersions(depsOf(context), input.params.documentId, input.query);
    }),
    rollback: os.documents.rollback.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.rollbackDocument(depsOf(context), input.params.documentId, input.body);
    }),
    manual: os.documents.manual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.getManualDocument(depsOf(context), input.params.documentId);
    }),
    saveManual: os.documents.saveManual.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.saveManualDraft(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.documents.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.publishManualDocument(depsOf(context), input.params.documentId, input.body);
    }),
  },
  chunks: {
    update: os.chunks.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.updateChunk(depsOf(context), input.params.chunkId, input.body);
    }),
    remove: os.chunks.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');
      return useCases.deleteChunk(depsOf(context), input.params.chunkId, input.body);
    }),
  },
  versions: {
    details: os.versions.details.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.getVersionDetails(depsOf(context), input.params.versionId);
    }),
  },
  sources: {
    update: os.sources.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');

      return useCases.updateSource(depsOf(context), input.params.sourceId, input.body);
    }),
    remove: os.sources.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');

      return useCases.deleteSource(depsOf(context), input.params.sourceId, input.query.documents);
    }),
    test: os.sources.test.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.sources.manage');

      return useCases.testSource(depsOf(context), input.params.sourceId);
    }),
    sync: os.sources.sync.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');

      return useCases.syncSource(depsOf(context), input.params.sourceId);
    }),
    runs: os.sources.runs.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listSourceRuns(depsOf(context), input.params.sourceId, input.query);
    }),
    runItems: os.sources.runItems.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

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

      return useCases.getWikiPage(depsOf(context), input.params.pageId, input.query);
    }),
    update: os.wiki.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.updateWikiPage(depsOf(context), input.params.pageId, input.body);
    }),
    generate: os.wiki.generate.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');

      return useCases.generateWiki(depsOf(context), input.params.pageId, input.body);
    }),
    versions: os.wiki.versions.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.listWikiVersions(depsOf(context), input.params.pageId, input.query);
    }),
    links: os.wiki.links.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.wikiLinks(depsOf(context), input.params.pageId);
    }),
    diff: os.wiki.diff.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.wikiDiff(depsOf(context), input.params.pageId, input.query);
    }),
    publish: os.wiki.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.publishWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
    rollback: os.wiki.rollback.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.rollbackWiki(depsOf(context), input.params.pageId, input.body.versionId);
    }),
  },
  faqs: {
    remove: os.faqs.remove.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      await useCases.deleteFaq(depsOf(context), input.params.documentId);
    }),
    get: os.faqs.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');

      return useCases.getFaq(depsOf(context), input.params.documentId);
    }),
    update: os.faqs.update.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.updateFaq(depsOf(context), input.params.documentId, input.body);
    }),
    publish: os.faqs.publish.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.publish');

      return useCases.publishFaq(depsOf(context), input.params.documentId, input.body);
    }),
    status: os.faqs.status.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.content.manage');

      return useCases.setFaqStatus(depsOf(context), input.params.documentId, input.body.enabled);
    }),
  },
  jobs: {
    list: os.jobs.list.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.listJobs(depsOf(context), input.query);
    }),
    get: os.jobs.get.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.read');
      return useCases.getJob(depsOf(context), input.params.jobId);
    }),
    retry: os.jobs.retry.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      return useCases.retryJob(depsOf(context), input.params.jobId);
    }),
    cancel: os.jobs.cancel.handler(async ({ input, context }) => {
      await requirePermission(context, 'knowledge.execute');
      return useCases.cancelJob(depsOf(context), input.params.jobId);
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
