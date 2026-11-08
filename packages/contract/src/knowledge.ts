import {
  cronSchema,
  httpUrlSchema,
  idParams,
  knowledgeBaseInputSchema,
  knowledgeBaseSchema,
  knowledgeBaseSettingsSchema,
  knowledgeBaseSummarySchema,
  knowledgeChunkSchema,
  knowledgeDocumentSchema,
  knowledgeDocumentStatusSchema,
  knowledgeDocumentVersionSchema,
  knowledgeFaqImportInputSchema,
  knowledgeFaqImportIssueSchema,
  knowledgeFaqImportResponseSchema,
  knowledgeFaqImportResultSchema,
  knowledgeFaqInputSchema,
  knowledgeFaqSchema,
  knowledgeJobSchema,
  knowledgeJobStatusSchema,
  knowledgeModelProfileSelectionSchema,
  knowledgeSearchQuerySchema,
  knowledgeSearchResultSchema,
  knowledgeSearchWarningSchema,
  knowledgeSourceInputSchema,
  knowledgeSourceRangeInputSchema,
  knowledgeSourceTypeSchema,
  knowledgeSyncItemSchema,
  knowledgeTargetKindSchema,
  knowledgeWikiLinksResultSchema,
  knowledgeWikiPageStatusSchema,
  knowledgeWikiVersionDiffSchema,
  slugSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
import { contractErrors, problemSchema } from './errors.js';

const folderParams = z.object({ folderId: z.string().min(1) });
const documentParams = z.object({ documentId: z.string().min(1) });
const chunkParams = z.object({ chunkId: z.string().min(1) });
const versionParams = z.object({ versionId: z.string().min(1) });
const jobParams = z.object({ jobId: z.string().min(1) });
const profileParams = z.object({ profileId: z.string().min(1) });
const sourceParams = z.object({ sourceId: z.string().min(1) });
const wikiPageParams = z.object({ pageId: z.string().min(1) });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const knowledgeFolderSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
});

export const knowledgeTagSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

export const knowledgeModelProfileSchema = z.object({
  id: z.string(),
  kind: z.enum(['embedding', 'rerank', 'asr']),
  name: z.string(),
  endpointUrl: z.string(),
  model: z.string(),
  dimensions: z.number().int().nullable(),
  embeddingProtocol: z.enum(['openai', 'cohere_v2']),
  imageInputEnabled: z.boolean(),
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const knowledgeSourceSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  type: knowledgeSourceTypeSchema.exclude(['upload', 'url', 'manual']),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  hasSecret: z.boolean(),
  status: z.enum(['active', 'paused', 'disabled', 'auth_error']),
  syncCron: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ranges: z.array(
    z.object({
      id: z.string(),
      kind: knowledgeSourceRangeInputSchema.shape.kind,
      externalId: z.string(),
      ref: z.string().nullable(),
      paths: z.array(z.string()),
      enabled: z.boolean(),
    }),
  ),
});

const knowledgeSyncRunSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: knowledgeJobStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  cursorBefore: z.record(z.string(), z.unknown()).nullable(),
  cursorAfter: z.record(z.string(), z.unknown()).nullable(),
  stats: z.object({
    listed: z.number(),
    created: z.number(),
    updated: z.number(),
    disabled: z.number(),
    failed: z.number(),
  }),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export const knowledgeWikiPageSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  slug: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  status: knowledgeWikiPageStatusSchema,
  currentVersionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const knowledgeWikiVersionSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  version: z.number().int(),
  markdown: z.string(),
  sourceChunkIds: z.array(z.string()),
  model: z.string().nullable(),
  generatedBy: z.string(),
  createdAt: z.string(),
});

export const knowledgeFaqDocumentSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  folderId: z.string().nullable(),
  title: z.string(),
  contentKind: knowledgeDocumentSchema.shape.contentKind,
  status: knowledgeDocumentStatusSchema,
  disabledReason: knowledgeDocumentSchema.shape.disabledReason,
  currentVersionId: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const knowledgeFaqVersionSchema = knowledgeDocumentVersionSchema.pick({
  id: true,
  documentId: true,
  version: true,
  origin: true,
  parentVersionId: true,
  metadata: true,
  faq: true,
  isCurrent: true,
  createdAt: true,
});

const knowledgeVersionDetailsSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sourceRevision: z.string().nullable(),
  parseStatus: z.enum(['parsed', 'parse_failed']),
  pageMap: z.array(z.record(z.string(), z.unknown())),
  images: z.array(
    z.object({
      name: z.string(),
      mimeType: z.string(),
      page: z.number().int().nullable(),
      warnings: z.array(z.string()).optional(),
    }),
  ),
  createdAt: z.string(),
});

const retrievalEvaluationReportSchema = z.object({
  results: z.array(
    z.object({
      q: z.string(),
      hit: z.boolean(),
      recallAtK: z.number(),
      reciprocalRank: z.number(),
      chunkRecallAtK: z.number().nullable(),
      elapsedMs: z.number(),
      degraded: z.boolean(),
      warnings: z.array(knowledgeSearchWarningSchema),
    }),
  ),
  recallAtK: z.number(),
  mrr: z.number(),
  chunkRecallAtK: z.number().nullable(),
});

const knowledgeBaseCreateSchema = knowledgeBaseInputSchema.extend({
  embeddingProfileId: z.string().min(1),
  rerankProfileId: z.string().min(1).nullable().default(null),
  asrProfileId: z.string().min(1).nullable().default(null),
  settings: knowledgeBaseSettingsSchema.prefault({
    chunkTokens: 800,
    chunkOverlap: 120,
    wikiAutoUpdate: false,
  }),
});

const knowledgeBasePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  embeddingProfileId: z.string().min(1).optional(),
  rerankProfileId: z.string().min(1).nullable().optional(),
  asrProfileId: z.string().min(1).nullable().optional(),
  settings: knowledgeBaseSettingsSchema.partial().optional(),
});

const folderCreateSchema = z.object({
  parentId: z.string().min(1).nullable().default(null),
  name: z.string().trim().min(1).max(120),
});
const folderPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().min(1).nullable().optional(),
});

const documentQuery = pageQuery.extend({
  folderId: z.string().optional(),
  tag: z.string().optional(),
  status: knowledgeDocumentStatusSchema.optional(),
  q: z.string().max(200).optional(),
});

const documentPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().optional(),
  status: z.enum(['ready', 'disabled']).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).optional(),
});

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().default(null),
  relativePath: z.string().min(1).max(512).optional(),
});

const manualCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z
    .string()
    .max(200_000)
    .refine((value) => value.trim().length > 0, '正文不能为空'),
  folderId: z.string().min(1).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});

const manualDraftSchema = z.object({
  content: z
    .string()
    .max(200_000)
    .refine((value) => value.trim().length > 0, '正文不能为空'),
  expectedVersionId: z.string().min(1),
});

const documentPublishSchema = z.object({
  versionId: z.string().min(1),
  expectedVersionId: z.string().nullable(),
});

const urlSchema = z.object({
  url: httpUrlSchema,
  title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().default(null),
});

const chunkCreateSchema = z.object({
  expectedVersionId: z.string().min(1),
  kind: z.enum(['text', 'table', 'image']).default('text'),
  heading: z.string().max(300).nullable().default(null),
  content: z.string().min(1).max(100_000),
  enabled: z.boolean().default(true),
});
const chunkPatchSchema = z.object({
  expectedVersionId: z.string().min(1),
  content: z.string().min(1).max(100_000).optional(),
  heading: z.string().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});
const chunkDeleteSchema = z.object({ expectedVersionId: z.string().min(1) });

const rebuildSchema = z.object({
  documentIds: z.array(z.string().min(1)).optional(),
  chunksOnly: z.boolean().default(false),
  confirmOverwriteManualChunks: z.boolean().default(false),
});
const reprocessSchema = z.object({ confirmOverwriteManualChunks: z.boolean().default(false) });
const rollbackSchema = z.object({
  versionId: z.string().min(1),
  expectedVersionId: z.string().nullable(),
});

const searchQuerySchema = knowledgeSearchQuerySchema.extend({
  kinds: z.preprocess(
    (value) =>
      value === undefined ? ['document', 'faq', 'wiki'] : Array.isArray(value) ? value : [value],
    z.array(knowledgeTargetKindSchema).min(1),
  ),
  folders: z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(z.string()),
  ),
  tags: z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(z.string()),
  ),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  rerank: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  diagnostics: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  minVectorScore: z.coerce.number().min(-1).max(1).default(0.3),
  onlyRecommended: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  faqPriority: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  faqDirectAnswerThreshold: z.coerce.number().min(-1).max(1).default(0.9),
});

const batchSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['move', 'copy', 'tag', 'delete', 'reprocess']),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  tagMode: z.enum(['add', 'remove', 'replace']).optional(),
  confirmOverwriteManualChunks: z.boolean().default(false),
});

const faqListQuery = pageQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: knowledgeDocumentStatusSchema.optional(),
  folderId: z.string().optional(),
  isRecommended: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const faqCreateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  faq: knowledgeFaqInputSchema,
  folderId: z.string().min(1).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});
const faqUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  faq: knowledgeFaqInputSchema,
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  expectedVersionId: z.string().min(1),
});
const faqPublishSchema = z.object({
  versionId: z.string().min(1),
  expectedVersionId: z.string().min(1).nullable(),
});
const faqStatusSchema = z.object({ enabled: z.boolean() });
const faqBatchSchema = z.object({
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
const faqTestSchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  minVectorScore: z.number().min(-1).max(1).default(0.3),
  onlyRecommended: z.boolean().default(false),
  faqPriority: z.boolean().default(false),
  faqDirectAnswerThreshold: z.number().min(-1).max(1).default(0.9),
});

const profileKindSchema = z.enum(['embedding', 'rerank', 'asr']);
const profileCreateSchema = z
  .object({
    kind: profileKindSchema,
    name: z.string().trim().min(1).max(120),
    endpointUrl: httpUrlSchema,
    model: z.string().trim().min(1).max(200),
    embeddingProtocol: z.enum(['openai', 'cohere_v2']).default('openai'),
    imageInputEnabled: z.boolean().default(false),
    apiKey: z.string().min(1).max(500).optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'asr') return;
    if (value.embeddingProtocol !== 'openai') {
      ctx.addIssue({
        code: 'custom',
        path: ['embeddingProtocol'],
        message: 'ASR profile 固定使用 openai 转录协议',
      });
    }
    if (value.imageInputEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['imageInputEnabled'],
        message: 'ASR profile 不支持图片输入',
      });
    }
  });
const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  endpointUrl: httpUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  embeddingProtocol: z.enum(['openai', 'cohere_v2']).optional(),
  imageInputEnabled: z.boolean().optional(),
  apiKey: z.string().min(1).max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});
const profileListQuery = z.object({ view: z.literal('selection').optional() });

const sourcePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  syncCron: cronSchema.nullable().optional(),
  ranges: z.array(knowledgeSourceRangeInputSchema).min(1).optional(),
});

const sourceDeleteQuery = z.object({ documents: z.enum(['keep', 'delete']).default('keep') });

const syncItemsQuery = pageQuery.extend({ status: z.enum(['failed', 'skipped']).optional() });

const wikiPageCreateSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(300),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
});
const wikiPagePatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  markdown: z.string().min(1).optional(),
  parentId: z.string().min(1).nullable().optional(),
  position: z.number().int().min(0).optional(),
  expectedVersion: z.string().min(1).nullable().optional(),
});
const wikiGenerateSchema = z.object({
  instruction: z.string().max(2_000).optional(),
  sourceDocumentIds: z.array(z.string().min(1)).max(50).optional(),
});
const wikiVersionBodySchema = z.object({ versionId: z.string().min(1) });
const wikiDiffQuery = z.object({
  fromVersionId: z.string().min(1),
  toVersionId: z.string().min(1),
});

const evaluationCaseSchema = z.object({
  q: z.string().trim().min(1).max(500),
  expectedTargets: z
    .array(z.object({ kind: knowledgeTargetKindSchema, id: z.string() }))
    .min(1)
    .max(50),
  expectedChunkIds: z.array(z.string().min(1)).max(100).optional(),
});
const evaluationBodySchema = z.object({
  cases: z.array(evaluationCaseSchema).min(1).max(100),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  minVectorScore: z.number().min(-1).max(1).default(0.3),
});

const jobQuery = pageQuery.extend({
  baseId: z.string().optional(),
  documentId: z.string().optional(),
  status: knowledgeJobStatusSchema.optional(),
});

const batchResultSchema = z.array(
  z.object({
    documentId: z.string(),
    status: z.enum(['succeeded', 'failed']),
    newDocumentId: z.string().optional(),
    jobId: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
);

const faqBatchResultSchema = z.array(
  z.object({
    documentId: z.string(),
    status: z.enum(['succeeded', 'failed']),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
);

export const knowledgeFaqBatchProblemSchema = problemSchema.extend({
  results: z.array(knowledgeFaqImportResultSchema).optional(),
});

const faqBatchErrors = Object.fromEntries(
  Object.entries(contractErrors).map(([code, error]) => [
    code,
    { ...error, data: knowledgeFaqBatchProblemSchema },
  ]),
) as {
  [Code in keyof typeof contractErrors]: Omit<(typeof contractErrors)[Code], 'data'> & {
    data: typeof knowledgeFaqBatchProblemSchema;
  };
};

const jobAcceptedSchema = z.object({ jobId: z.string() });
const documentJobAcceptedSchema = z.object({ documentId: z.string(), jobId: z.string() });
const faqJobAcceptedSchema = z.object({
  documentId: z.string(),
  jobId: z.string(),
  issues: z.array(knowledgeFaqImportIssueSchema).optional(),
});

const chunkMutationResultSchema = z.object({
  document: knowledgeDocumentSchema,
  chunk: knowledgeChunkSchema.nullable(),
  jobId: z.string().nullable(),
});

const basesContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ query: pageQuery }))
    .output(pageOf(knowledgeBaseSchema)),
  create: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.create' } })
    .input(z.object({ body: knowledgeBaseCreateSchema }))
    .output(knowledgeBaseSchema),
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams }))
    .output(knowledgeBaseSchema),
  summary: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/summary' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams }))
    .output(knowledgeBaseSummarySchema),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/bases/{id}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.update' } })
    .input(z.object({ params: idParams, body: knowledgeBasePatchSchema }))
    .output(knowledgeBaseSchema),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/bases/{id}', successStatus: 204 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.delete' } })
    .input(z.object({ params: idParams }))
    .output(z.void()),
  duplicate: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/duplicate', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.create' } })
    .input(
      z.object({
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          slug: slugSchema.optional(),
          description: z.string().max(500).optional(),
        }),
      }),
    )
    .output(knowledgeBaseSchema),
  folders: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/folders' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams, query: pageQuery }))
    .output(z.array(knowledgeFolderSchema)),
  createFolder: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/folders', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: folderCreateSchema }))
    .output(knowledgeFolderSchema),
  tags: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/tags' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams }))
    .output(z.array(knowledgeTagSchema)),
  createTag: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/tags', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(
      z.object({ params: idParams, body: z.object({ name: z.string().trim().min(1).max(64) }) }),
    )
    .output(knowledgeTagSchema),
  documents: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/documents' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams, query: documentQuery }))
    .output(pageOf(knowledgeDocumentSchema)),
  upload: contractProcedure
    .route({ method: 'PUT', path: '/knowledge/bases/{id}/documents/upload', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: uploadSchema }))
    .output(documentJobAcceptedSchema),
  createManual: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/bases/{id}/documents/manual',
      successStatus: 202,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: manualCreateSchema }))
    .output(documentJobAcceptedSchema),
  createUrl: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/documents/url', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: urlSchema }))
    .output(documentJobAcceptedSchema),
  search: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/search' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: idParams, query: searchQuerySchema }))
    .output(knowledgeSearchResultSchema),
  rebuild: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/rebuild', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: idParams, body: rebuildSchema }))
    .output(jobAcceptedSchema),
  batch: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/documents/batch' })
    .meta({ access: { kind: 'authenticated' } })
    .input(z.object({ params: idParams, body: batchSchema }))
    .output(z.object({ results: batchResultSchema })),
  sources: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/sources' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams, query: pageQuery }))
    .output(pageOf(knowledgeSourceSchema)),
  createSource: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/sources', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } })
    .input(z.object({ params: idParams, body: knowledgeSourceInputSchema }))
    .output(knowledgeSourceSchema),
  wikiPages: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/wiki-pages' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams, query: pageQuery }))
    .output(pageOf(knowledgeWikiPageSchema)),
  createWikiPage: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/wiki-pages', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: wikiPageCreateSchema }))
    .output(knowledgeWikiPageSchema),
  faqs: contractProcedure
    .route({ method: 'GET', path: '/knowledge/bases/{id}/faqs' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: idParams, query: faqListQuery }))
    .output(
      pageOf(
        knowledgeFaqDocumentSchema.extend({
          faq: knowledgeFaqSchema.nullable(),
        }),
      ),
    ),
  createFaq: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/faqs', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: idParams, body: faqCreateSchema }))
    .output(faqJobAcceptedSchema),
  faqBatch: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/bases/{id}/faqs/batch',
      outputStructure: 'detailed',
    })
    .meta({ access: { kind: 'authenticated' } })
    .errors(faqBatchErrors)
    .input(z.object({ params: idParams, body: faqBatchSchema }))
    .output(
      z.object({
        status: z.literal(200),
        body: z.object({ results: faqBatchResultSchema }),
      }),
    ),
  importFaqs: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/bases/{id}/faqs/import',
      outputStructure: 'detailed',
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.import' } })
    .input(z.object({ params: idParams, body: knowledgeFaqImportInputSchema }))
    .output(
      z.union([
        z.object({ status: z.literal(200), body: knowledgeFaqImportResponseSchema }),
        z.object({ status: z.literal(202), body: knowledgeFaqImportResponseSchema }),
      ]),
    ),
  testFaqs: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/faqs/test' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: idParams, body: faqTestSchema }))
    .output(knowledgeSearchResultSchema),
  evaluate: contractProcedure
    .route({ method: 'POST', path: '/knowledge/bases/{id}/retrieval-evaluations' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: idParams, body: evaluationBodySchema }))
    .output(retrievalEvaluationReportSchema),
};

const foldersContract = {
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/folders/{folderId}', successStatus: 204 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: folderParams }))
    .output(z.void()),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/folders/{folderId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: folderParams, body: folderPatchSchema }))
    .output(knowledgeFolderSchema),
};

const tagsContract = {
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/tags/{tagId}', successStatus: 204 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: z.object({ tagId: z.string().min(1) }) }))
    .output(z.void()),
};

const documentsContract = {
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/documents/{documentId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: documentParams }))
    .output(knowledgeDocumentSchema),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/documents/{documentId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams, body: documentPatchSchema }))
    .output(knowledgeDocumentSchema),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/documents/{documentId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams }))
    .output(z.object({ wikiPagesMarkedStale: z.number().int() })),
  reprocess: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/documents/{documentId}/reprocess',
      successStatus: 202,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: documentParams, body: reprocessSchema }))
    .output(jobAcceptedSchema),
  chunks: contractProcedure
    .route({ method: 'GET', path: '/knowledge/documents/{documentId}/chunks' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(
      z.object({
        params: documentParams,
        query: pageQuery.extend({ versionId: z.string().optional() }),
      }),
    )
    .output(pageOf(knowledgeChunkSchema)),
  createChunk: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/documents/{documentId}/chunks',
      successStatus: 201,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams, body: chunkCreateSchema }))
    .output(chunkMutationResultSchema),
  versions: contractProcedure
    .route({ method: 'GET', path: '/knowledge/documents/{documentId}/versions' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: documentParams, query: pageQuery }))
    .output(pageOf(knowledgeDocumentVersionSchema)),
  rollback: contractProcedure
    .route({ method: 'POST', path: '/knowledge/documents/{documentId}/rollback' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: documentParams, body: rollbackSchema }))
    .output(knowledgeDocumentSchema),
  manual: contractProcedure
    .route({ method: 'GET', path: '/knowledge/documents/{documentId}/manual' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: documentParams }))
    .output(
      z.object({
        content: z.string(),
        versionId: z.string(),
        status: z.enum(['draft', 'published']),
      }),
    ),
  saveManual: contractProcedure
    .route({
      method: 'PUT',
      path: '/knowledge/documents/{documentId}/manual',
      successStatus: 202,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams, body: manualDraftSchema }))
    .output(documentJobAcceptedSchema),
  publish: contractProcedure
    .route({ method: 'POST', path: '/knowledge/documents/{documentId}/publish' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: documentParams, body: documentPublishSchema }))
    .output(knowledgeDocumentSchema),
};

const chunksContract = {
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/chunks/{chunkId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: chunkParams, body: chunkPatchSchema }))
    .output(chunkMutationResultSchema),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/chunks/{chunkId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: chunkParams, body: chunkDeleteSchema }))
    .output(chunkMutationResultSchema),
};

const versionsContract = {
  details: contractProcedure
    .route({ method: 'GET', path: '/knowledge/versions/{versionId}/details' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: versionParams }))
    .output(knowledgeVersionDetailsSchema),
};

const sourcesContract = {
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/sources/{sourceId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } })
    .input(z.object({ params: sourceParams, body: sourcePatchSchema }))
    .output(
      knowledgeSourceSchema.extend({
        disabledDocumentIds: z.array(z.string()),
      }),
    ),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/sources/{sourceId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } })
    .input(z.object({ params: sourceParams, query: sourceDeleteQuery }))
    .output(z.object({ documents: z.enum(['keep', 'delete']), affected: z.number().int() })),
  test: contractProcedure
    .route({ method: 'POST', path: '/knowledge/sources/{sourceId}/test', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.sources.manage' } })
    .input(z.object({ params: sourceParams }))
    .output(jobAcceptedSchema),
  sync: contractProcedure
    .route({ method: 'POST', path: '/knowledge/sources/{sourceId}/sync', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: sourceParams }))
    .output(z.object({ jobId: z.string(), syncRunId: z.string() })),
  runs: contractProcedure
    .route({ method: 'GET', path: '/knowledge/sources/{sourceId}/runs' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: sourceParams, query: pageQuery }))
    .output(pageOf(knowledgeSyncRunSchema)),
  runItems: contractProcedure
    .route({ method: 'GET', path: '/knowledge/sources/{sourceId}/runs/{syncRunId}/items' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(
      z.object({
        params: z.object({ sourceId: z.string().min(1), syncRunId: z.string().min(1) }),
        query: syncItemsQuery,
      }),
    )
    .output(pageOf(knowledgeSyncItemSchema)),
};

const wikiContract = {
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/wiki-pages/{pageId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: wikiPageParams, query: pageQuery }))
    .output(
      knowledgeWikiPageSchema.extend({
        versions: z.array(knowledgeWikiVersionSchema),
        nextCursor: z.string().nullable(),
      }),
    ),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/wiki-pages/{pageId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: wikiPageParams, body: wikiPagePatchSchema }))
    .output(knowledgeWikiPageSchema),
  generate: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/wiki-pages/{pageId}/generate',
      successStatus: 202,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: wikiPageParams, body: wikiGenerateSchema }))
    .output(jobAcceptedSchema),
  versions: contractProcedure
    .route({ method: 'GET', path: '/knowledge/wiki-pages/{pageId}/versions' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: wikiPageParams, query: pageQuery }))
    .output(pageOf(knowledgeWikiVersionSchema)),
  links: contractProcedure
    .route({ method: 'GET', path: '/knowledge/wiki-pages/{pageId}/links' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: wikiPageParams }))
    .output(knowledgeWikiLinksResultSchema),
  diff: contractProcedure
    .route({ method: 'GET', path: '/knowledge/wiki-pages/{pageId}/diff' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: wikiPageParams, query: wikiDiffQuery }))
    .output(knowledgeWikiVersionDiffSchema),
  publish: contractProcedure
    .route({ method: 'POST', path: '/knowledge/wiki-pages/{pageId}/publish' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: wikiPageParams, body: wikiVersionBodySchema }))
    .output(knowledgeWikiPageSchema),
  rollback: contractProcedure
    .route({
      method: 'POST',
      path: '/knowledge/wiki-pages/{pageId}/rollback',
      successStatus: 201,
    })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: wikiPageParams, body: wikiVersionBodySchema }))
    .output(knowledgeWikiVersionSchema),
};

const faqsContract = {
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/faqs/{documentId}', successStatus: 204 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams }))
    .output(z.void()),
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/faqs/{documentId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: documentParams }))
    .output(
      z.object({
        document: knowledgeFaqDocumentSchema,
        draftVersion: knowledgeFaqVersionSchema.nullable(),
        publishedVersion: knowledgeFaqVersionSchema.nullable(),
        faq: knowledgeFaqSchema.nullable(),
      }),
    ),
  update: contractProcedure
    .route({ method: 'PUT', path: '/knowledge/faqs/{documentId}', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams, body: faqUpdateSchema }))
    .output(faqJobAcceptedSchema),
  publish: contractProcedure
    .route({ method: 'POST', path: '/knowledge/faqs/{documentId}/publish' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.publish' } })
    .input(z.object({ params: documentParams, body: faqPublishSchema }))
    .output(knowledgeFaqDocumentSchema),
  status: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/faqs/{documentId}/status' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.content.manage' } })
    .input(z.object({ params: documentParams, body: faqStatusSchema }))
    .output(knowledgeFaqDocumentSchema),
};

const jobsContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/knowledge/jobs' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ query: jobQuery }))
    .output(pageOf(knowledgeJobSchema)),
  get: contractProcedure
    .route({ method: 'GET', path: '/knowledge/jobs/{jobId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.read' } })
    .input(z.object({ params: jobParams }))
    .output(knowledgeJobSchema),
  retry: contractProcedure
    .route({ method: 'POST', path: '/knowledge/jobs/{jobId}/retry', successStatus: 202 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: jobParams }))
    .output(jobAcceptedSchema),
  cancel: contractProcedure
    .route({ method: 'POST', path: '/knowledge/jobs/{jobId}/cancel' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.execute' } })
    .input(z.object({ params: jobParams }))
    .output(knowledgeJobSchema),
};

const modelProfilesContract = {
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/knowledge/model-profiles/{profileId}', successStatus: 204 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.models.manage' } })
    .input(z.object({ params: profileParams }))
    .output(z.void()),
  list: contractProcedure
    .route({ method: 'GET', path: '/knowledge/model-profiles' })
    .meta({ access: { kind: 'authenticated' } })
    .input(z.object({ query: profileListQuery }))
    .output(
      z.union([
        z.array(knowledgeModelProfileSchema),
        z.array(knowledgeModelProfileSelectionSchema),
      ]),
    ),
  create: contractProcedure
    .route({ method: 'POST', path: '/knowledge/model-profiles', successStatus: 201 })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.models.manage' } })
    .input(z.object({ body: profileCreateSchema }))
    .output(knowledgeModelProfileSchema),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/knowledge/model-profiles/{profileId}' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.models.manage' } })
    .input(z.object({ params: profileParams, body: profilePatchSchema }))
    .output(knowledgeModelProfileSchema),
  test: contractProcedure
    .route({ method: 'POST', path: '/knowledge/model-profiles/{profileId}/test' })
    .meta({ access: { kind: 'permission', permissionId: 'knowledge.models.manage' } })
    .input(z.object({ params: profileParams }))
    .output(
      z.union([
        z.object({ ok: z.literal(true) }),
        z.object({ ok: z.literal(false), kind: z.string() }),
      ]),
    ),
};

type KnowledgeContractShape = {
  bases: typeof basesContract;
  folders: typeof foldersContract;
  tags: typeof tagsContract;
  documents: typeof documentsContract;
  chunks: typeof chunksContract;
  versions: typeof versionsContract;
  sources: typeof sourcesContract;
  wiki: typeof wikiContract;
  faqs: typeof faqsContract;
  jobs: typeof jobsContract;
  modelProfiles: typeof modelProfilesContract;
};

export const knowledgeContract: KnowledgeContractShape = {
  bases: basesContract,
  folders: foldersContract,
  tags: tagsContract,
  documents: documentsContract,
  chunks: chunksContract,
  versions: versionsContract,
  sources: sourcesContract,
  wiki: wikiContract,
  faqs: faqsContract,
  jobs: jobsContract,
  modelProfiles: modelProfilesContract,
};

export type KnowledgeContract = KnowledgeContractShape;
