import { z } from 'zod';
import { cronSchema } from './ops.js';
import { cursorPageSchema } from './pagination.js';
import { slugSchema } from './params.js';
import { DEFAULT_JOB_RETENTION } from './run-stream.js';

export const KNOWLEDGE_JOBS_QUEUE = 'knowledge-jobs';

/**
 * 轻触发队列：scheduler 的每次触发只带 sourceId，到点后由 worker 创建
 * knowledge_sync_runs + knowledge_jobs 再投递到知识队列。
 * 不能直接在知识队列上重复使用同一个 DB job id：BullMQ 会把后续触发当成重复 job 丢掉。
 */
export const KNOWLEDGE_SYNC_TRIGGERS_QUEUE = 'knowledge-sync-triggers';

const knowledgeJobQueuePayloadSchema = z.object({ jobId: z.string() });

export type KnowledgeJobQueuePayload = z.infer<typeof knowledgeJobQueuePayloadSchema>;

const knowledgeSyncTriggerPayloadSchema = z.object({ sourceId: z.string() });

export type KnowledgeSyncTriggerPayload = z.infer<typeof knowledgeSyncTriggerPayloadSchema>;

export const KNOWLEDGE_CANCEL_PAYLOAD = '1';

export function knowledgeCancelKey(jobId: string): string {
  return `knowledge:${jobId}:cancel`;
}

export function knowledgeEnqueueOptions(jobId: string) {
  return {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    ...DEFAULT_JOB_RETENTION,
  };
}

export const KNOWLEDGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const KNOWLEDGE_IMAGE_MAX_PIXELS = 25_000_000;

export const KNOWLEDGE_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

export const KNOWLEDGE_DOCUMENT_TITLE_MAX_CHARS = 300;

const knowledgeImageNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'),
    '图片名必须是单段文件名',
  );

export const knowledgeImageRefSchema = z.object({
  name: knowledgeImageNameSchema,
  mimeType: z.string().min(1),
  page: z.number().int().positive().nullable(),
});

export type KnowledgeImageRef = z.infer<typeof knowledgeImageRefSchema>;

export const knowledgeImageChunkMetadataSchema = z.object({
  image: knowledgeImageRefSchema,
  imageRole: z.enum(['ocr', 'caption', 'vector']),
});

const imageProcessingDefaults = {
  enabled: false,
  model: null,
  ocrEnabled: true,
  captionEnabled: true,
  descriptionLanguage: 'zh-CN',
  customInstructions: '',
  imageVectorEnabled: false,
  imageVectorMinScore: 0.3,
};

export const knowledgeImageProcessingSchema = z
  .object({
    enabled: z.boolean().default(imageProcessingDefaults.enabled),
    model: z.string().trim().min(1).max(200).nullable().default(imageProcessingDefaults.model),
    ocrEnabled: z.boolean().default(imageProcessingDefaults.ocrEnabled),
    captionEnabled: z.boolean().default(imageProcessingDefaults.captionEnabled),
    descriptionLanguage: z
      .string()
      .trim()
      .min(1)
      .max(35)
      .default(imageProcessingDefaults.descriptionLanguage),
    customInstructions: z.string().max(2000).default(imageProcessingDefaults.customInstructions),
    imageVectorEnabled: z.boolean().default(imageProcessingDefaults.imageVectorEnabled),
    imageVectorMinScore: z
      .number()
      .min(-1)
      .max(1)
      .default(imageProcessingDefaults.imageVectorMinScore),
  })
  .refine(
    (value) =>
      !value.enabled || (value.model !== null && (value.ocrEnabled || value.captionEnabled)),
    { message: '开启图片处理需要视觉模型，且 OCR 与描述至少开启一个', path: ['enabled'] },
  )
  .refine((value) => !value.imageVectorEnabled || value.enabled, {
    message: '图片向量依赖图片处理开启',
    path: ['imageVectorEnabled'],
  });

export type KnowledgeImageProcessing = z.infer<typeof knowledgeImageProcessingSchema>;

const imageProcessingShape = knowledgeImageProcessingSchema.shape;

export const knowledgeImageProcessingPatchSchema = z.object({
  enabled: imageProcessingShape.enabled.unwrap().optional(),
  model: imageProcessingShape.model.unwrap().optional(),
  ocrEnabled: imageProcessingShape.ocrEnabled.unwrap().optional(),
  captionEnabled: imageProcessingShape.captionEnabled.unwrap().optional(),
  descriptionLanguage: imageProcessingShape.descriptionLanguage.unwrap().optional(),
  customInstructions: imageProcessingShape.customInstructions.unwrap().optional(),
  imageVectorEnabled: imageProcessingShape.imageVectorEnabled.unwrap().optional(),
  imageVectorMinScore: imageProcessingShape.imageVectorMinScore.unwrap().optional(),
});

export type KnowledgeImageProcessingPatch = z.infer<typeof knowledgeImageProcessingPatchSchema>;

export const knowledgeBaseSettingsSchema = z.object({
  chunkTokens: z.number().int().min(200).max(4000),
  chunkOverlap: z.number().int().min(0).max(1000),
  wikiAutoUpdate: z.boolean(),
  autoSummary: z.boolean().optional(),
  autoTag: z.boolean().optional(),
  imageProcessing: knowledgeImageProcessingSchema.default(imageProcessingDefaults),
});

export const knowledgeBaseStatusSchema = z.enum(['active', 'disabled']);
export type KnowledgeBaseStatus = z.infer<typeof knowledgeBaseStatusSchema>;

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024 as const;

export const knowledgeEmbeddingProtocolSchema = z.enum(['openai', 'cohere_v2']);
export type KnowledgeEmbeddingProtocol = z.infer<typeof knowledgeEmbeddingProtocolSchema>;

export function supportsKnowledgeImageVectors(profile: {
  protocol?: string | null | undefined;
  model?: string | null | undefined;
  supportsImageInput?: boolean | null | undefined;
}): boolean {
  return (
    profile.protocol === knowledgeEmbeddingProtocolSchema.enum.cohere_v2 &&
    profile.model === 'embed-v4.0' &&
    profile.supportsImageInput === true
  );
}

export const knowledgeBaseInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
});

export const knowledgeBaseSchema = knowledgeBaseInputSchema.extend({
  id: z.string(),
  serverId: z.string(),
  status: knowledgeBaseStatusSchema,
  embeddingProfileId: z.string(),
  rerankProfileId: z.string().nullable(),
  asrProfileId: z.string().nullable(),
  settings: knowledgeBaseSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;
export type KnowledgeBaseSettings = z.infer<typeof knowledgeBaseSettingsSchema>;

export const knowledgeModelProfileKindSchema = z.enum(['embedding', 'rerank', 'asr']);
export type KnowledgeModelProfileKind = z.infer<typeof knowledgeModelProfileKindSchema>;

export const knowledgeModelProfileSelectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: knowledgeModelProfileKindSchema,
  enabled: z.boolean(),
  supportsImageVectors: z.boolean(),
});

export type KnowledgeModelProfileSelection = z.infer<typeof knowledgeModelProfileSelectionSchema>;

export const knowledgeSourceTypeSchema = z.enum([
  'upload',
  'url',
  'feishu_wiki',
  'feishu_drive',
  'gitlab',
  'github',
  'feed',
  'manual',
  'lark_wiki',
  'lark_drive',
  'notion',
  'confluence',
  'yuque',
  'dingtalk',
  'ima',
  'seafile',
  'nextcloud',
]);

export type KnowledgeSourceType = z.infer<typeof knowledgeSourceTypeSchema>;

export const knowledgeSourceConfigTypeSchema = knowledgeSourceTypeSchema.exclude([
  'upload',
  'url',
  'manual',
]);

export type KnowledgeSourceConfigType = z.infer<typeof knowledgeSourceConfigTypeSchema>;

export const knowledgeSourceStatusSchema = z.enum(['active', 'paused', 'auth_error', 'disabled']);

export type KnowledgeSourceStatus = z.infer<typeof knowledgeSourceStatusSchema>;

export const knowledgeSourceRangeExternalIdMax = {
  lark_wiki: 128,
  lark_drive: 128,
  notion: 36,
  confluence: 32,
  yuque: 16,
  dingtalk: 128,
  ima: 128,
  seafile: 36,
  nextcloud: 255,
} as const satisfies Partial<Record<KnowledgeSourceType, number>>;

export const knowledgeDocumentStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'failed',
  'disabled',
]);
export type KnowledgeDocumentStatus = z.infer<typeof knowledgeDocumentStatusSchema>;

export const knowledgeContentKindSchema = z.enum(['document', 'faq', 'wiki']);

export const knowledgeDisabledReasonSchema = z.enum(['manual', 'source', 'range', 'remote']);

export const SUMMARY_DOCUMENT_DISABLED_MESSAGE = '文档已停用，不能生成摘要';
export const SUMMARY_DOCUMENT_NO_VERSION_MESSAGE = '文档还没有可用版本，不能生成摘要';
export const SUMMARY_CANCELLED_MESSAGE = '摘要生成已取消';
export const TAGGING_DOCUMENT_DISABLED_MESSAGE = '文档已停用，不能生成标签';
export const TAGGING_DOCUMENT_NO_VERSION_MESSAGE = '文档还没有可用版本，不能生成标签';
export const DOCUMENT_UNREADABLE_MESSAGE = '文档当前不可读（来源未授权或不在范围）';
export const DOCUMENT_NO_CONTENT_MESSAGE = '文档当前版本没有可用正文';
export const DOCUMENT_JOB_IN_PROGRESS_MESSAGE = '文档有正在进行的处理任务，请稍后重试';
export const FAQ_ANSWER_REQUIRED_MESSAGE = '至少需要一条非空答案';

export const knowledgeLocatorSchema = z
  .object({
    pageFrom: z.number().int().positive().optional(),
    pageTo: z.number().int().positive().optional(),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().nonnegative().optional(),
    lineFrom: z.number().int().positive().optional(),
    lineTo: z.number().int().positive().optional(),
    headingPath: z.array(z.string()).optional(),
    sheet: z.string().optional(),
    cellRange: z.string().optional(),
    timeFromMs: z.number().int().nonnegative().safe().optional(),
    timeToMs: z.number().int().nonnegative().safe().optional(),
    bbox: z
      .object({
        left: z.number(),
        top: z.number(),
        right: z.number(),
        bottom: z.number(),
      })
      .optional(),
    parserRef: z.string().optional(),
  })
  .refine(
    (value) =>
      (value.timeFromMs === undefined && value.timeToMs === undefined) ||
      (value.timeFromMs !== undefined && value.timeToMs !== undefined),
    { message: '时码必须成对出现', path: ['timeToMs'] },
  )
  .refine(
    (value) =>
      value.timeFromMs === undefined ||
      value.timeToMs === undefined ||
      value.timeToMs >= value.timeFromMs,
    { message: '时码结束不能早于开始', path: ['timeToMs'] },
  );

export type KnowledgeLocator = z.infer<typeof knowledgeLocatorSchema>;

export const knowledgeAudioSegmentSchema = z
  .object({
    startOffset: z.number().int().nonnegative().safe(),
    endOffset: z.number().int().nonnegative().safe(),
    timeFromMs: z.number().int().nonnegative().safe(),
    timeToMs: z.number().int().nonnegative().safe(),
  })
  .refine((segment) => segment.endOffset >= segment.startOffset, {
    message: '偏移结束不能早于开始',
    path: ['endOffset'],
  })
  .refine((segment) => segment.timeToMs >= segment.timeFromMs, {
    message: '时码结束不能早于开始',
    path: ['timeToMs'],
  });

export const knowledgeAudioMetadataSchema = z.object({
  protocol: z.literal('openai_transcriptions'),
  profileName: z.string().min(1),
  model: z.string().min(1),
  durationMs: z.number().int().nonnegative().safe().nullable(),
  segments: z.array(knowledgeAudioSegmentSchema),
});

export type KnowledgeAudioMetadata = z.infer<typeof knowledgeAudioMetadataSchema>;

export const knowledgeFaqAnswerStrategySchema = z.enum(['all', 'random']);

export const knowledgeFaqSchema = z.object({
  question: z.string().trim().min(1).max(500),
  similarQuestions: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  negativeQuestions: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  answers: z
    .array(z.string().max(20_000))
    .min(1)
    .refine((answers) => answers.some((answer) => answer.trim().length > 0), {
      message: FAQ_ANSWER_REQUIRED_MESSAGE,
    }),
  answerStrategy: knowledgeFaqAnswerStrategySchema.default('all'),
  isRecommended: z.boolean().default(true),
});

export type KnowledgeFaq = z.infer<typeof knowledgeFaqSchema>;

export const knowledgeFaqInputSchema = z.object({
  question: z.string(),
  similarQuestions: z.array(z.string()).default([]),
  negativeQuestions: z.array(z.string()).default([]),
  answers: z.array(z.string()),
  answerStrategy: z.string().optional(),
  isRecommended: z.boolean().optional(),
});

export const knowledgeFaqTransferEntrySchema = knowledgeFaqSchema.extend({
  enabled: z.boolean().default(true),
});

export type KnowledgeFaqTransferEntry = z.infer<typeof knowledgeFaqTransferEntrySchema>;

export const knowledgeFaqTransferDocumentSchema = z.object({
  items: z.array(knowledgeFaqTransferEntrySchema),
});

export const knowledgeFaqImportFormatSchema = z.enum(['json', 'csv', 'xlsx']);
export const knowledgeFaqImportModeSchema = z.enum(['append', 'replace']);

export type KnowledgeFaqImportMode = z.infer<typeof knowledgeFaqImportModeSchema>;

export const knowledgeFaqImportInputSchema = z.object({
  format: knowledgeFaqImportFormatSchema,
  content: z.string().min(1),
  mode: knowledgeFaqImportModeSchema.default('append'),
  dryRun: z.boolean().default(false),
});

export type KnowledgeFaqImportInput = z.infer<typeof knowledgeFaqImportInputSchema>;

export const knowledgeFaqImportStateSchema = z.object({
  documentId: z.string(),
  currentVersionId: z.string().nullable(),
  latestDraftVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

export type KnowledgeFaqImportState = z.infer<typeof knowledgeFaqImportStateSchema>;

export const knowledgeFaqImportMetadataSchema = z.object({
  batchId: z.string(),
  mode: knowledgeFaqImportModeSchema,
  enabled: z.boolean(),
  expectedVersionId: z.string().nullable(),
  replaceTargets: z.array(knowledgeFaqImportStateSchema).optional(),
});

export type KnowledgeFaqImportMetadata = z.infer<typeof knowledgeFaqImportMetadataSchema>;

export const knowledgeFaqImportIssueSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export type KnowledgeFaqImportIssue = z.infer<typeof knowledgeFaqImportIssueSchema>;

export const knowledgeFaqImportResultSchema = z.object({
  row: z.number().int().positive(),
  status: z.enum(['success', 'failed', 'partial_failed', 'skipped']),
  operation: z.enum(['add', 'merge', 'skip']).nullable(),
  documentId: z.string().optional(),
  versionId: z.string().optional(),
  expectedVersionId: z.string().nullable().optional(),
  jobId: z.string().optional(),
  issues: z.array(knowledgeFaqImportIssueSchema).default([]),
});

export type KnowledgeFaqImportResult = z.infer<typeof knowledgeFaqImportResultSchema>;

export const knowledgeFaqImportCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  partialFailed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
});

export const knowledgeFaqImportResponseSchema = z.object({
  dryRun: z.boolean(),
  mode: knowledgeFaqImportModeSchema,
  committed: z.boolean(),
  importBatchId: z.string().nullable(),
  counts: knowledgeFaqImportCountsSchema,
  results: z.array(knowledgeFaqImportResultSchema),
});

export type KnowledgeFaqImportResponse = z.infer<typeof knowledgeFaqImportResponseSchema>;

export const knowledgeDocumentSummaryStatusSchema = z.enum([
  'none',
  'pending',
  'generating',
  'ready',
  'failed',
]);

export type KnowledgeDocumentSummaryStatus = z.infer<typeof knowledgeDocumentSummaryStatusSchema>;

export const knowledgeDocumentSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  folderId: z.string().nullable(),
  title: z.string(),
  sourceType: knowledgeSourceTypeSchema,
  sourceUrl: z.string().nullable(),
  sourcePath: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: knowledgeDocumentStatusSchema,
  contentKind: knowledgeContentKindSchema.default('document'),
  disabledReason: knowledgeDisabledReasonSchema.nullable().default(null),
  sourceConnectionId: z.string().nullable().default(null),
  currentVersionId: z.string().nullable(),
  summary: z.string().nullable().default(null),
  summaryStatus: knowledgeDocumentSummaryStatusSchema.default('none'),
  summaryGeneratedAt: z.string().nullable().default(null),
  summaryError: z.string().nullable().default(null),
  tags: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeVersionOriginSchema = z.enum(['source', 'manual', 'faq', 'wiki']);

export const knowledgeParseStatusSchema = z.enum(['parsed', 'parse_failed']);
export type KnowledgeParseStatus = z.infer<typeof knowledgeParseStatusSchema>;

export const knowledgeDocumentVersionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int(),
  origin: knowledgeVersionOriginSchema,
  parentVersionId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  faq: knowledgeFaqSchema.nullable().default(null),
  sourceRevision: z.string().nullable(),
  parseStatus: knowledgeParseStatusSchema,
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  isCurrent: z.boolean(),
  createdAt: z.string(),
});

export type KnowledgeDocumentVersion = z.infer<typeof knowledgeDocumentVersionSchema>;

export const knowledgeChunkKindSchema = z.enum(['text', 'table', 'image']);

export const knowledgeChunkIndexRoleSchema = z.enum(['leaf', 'parent']);

export const knowledgeChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  ordinal: z.number().int(),
  parentOrdinal: z.number().int().nullable().default(null),
  indexRole: knowledgeChunkIndexRoleSchema.default('leaf'),
  kind: knowledgeChunkKindSchema,
  heading: z.string().nullable(),
  content: z.string(),
  enabled: z.boolean(),
  editedByUser: z.boolean(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  locator: knowledgeLocatorSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const knowledgeTargetKindSchema = z.enum(['document', 'faq', 'wiki']);

export const knowledgeTargetSchema = z.object({
  kind: knowledgeTargetKindSchema.describe('Target kind.'),
  id: z.string().describe('Target ID.'),
});

export type KnowledgeTarget = z.infer<typeof knowledgeTargetSchema>;

export const knowledgeSearchScoresSchema = z.object({
  keyword: z.number().nullable(),
  vector: z.number().nullable(),
  rrf: z.number(),
  rerank: z.number().nullable(),
});

export type KnowledgeSearchScores = z.infer<typeof knowledgeSearchScoresSchema>;

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500).describe('Search query text.'),
  kinds: z
    .array(knowledgeTargetKindSchema)
    .min(1)
    .default(['document', 'faq', 'wiki'])
    .describe('Source kinds to search; omit to include document, FAQ and wiki.'),
  folders: z.array(z.string()).default([]).describe('Restrict the search to these folders.'),
  tags: z.array(z.string()).default([]).describe('Return only entries carrying these tags.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of hits (default 10).'),
  rerank: z.boolean().default(true).describe('Reorder hits with the rerank model (default true).'),
  minVectorScore: z
    .number()
    .min(-1)
    .max(1)
    .default(0.3)
    .describe(
      'Minimum similarity for text-vector recall; keyword hits and the image-vector path are unaffected (default 0.3).',
    ),
  diagnostics: z
    .boolean()
    .default(false)
    .describe('Include retrieval diagnostics; management REST only.'),
  onlyRecommended: z
    .boolean()
    .default(false)
    .describe('Keep only recommended FAQ entries; documents and wiki pages are unaffected.'),
  faqPriority: z
    .boolean()
    .default(false)
    .describe(
      'Place FAQ hits before other results and enable directAnswer when retrieval is not degraded (default false).',
    ),
  faqDirectAnswerThreshold: z
    .number()
    .min(-1)
    .max(1)
    .default(0.9)
    .describe(
      'Raw-question cosine threshold for directAnswer; requires faqPriority=true and non-degraded retrieval (default 0.9).',
    ),
});

export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

export const knowledgeFaqHitSchema = z.object({
  answers: z.array(z.string()).min(1),
  answerStrategy: knowledgeFaqAnswerStrategySchema,
  isRecommended: z.boolean(),
  matchedQuestion: z.string(),
  questionKind: z.enum(['standard', 'similar']),
});

export type KnowledgeFaqHit = z.infer<typeof knowledgeFaqHitSchema>;

export const knowledgeSearchHitSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  target: knowledgeTargetSchema,
  targetVersionId: z.string(),
  title: z.string(),
  heading: z.string().nullable(),
  quote: z.string(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  locator: knowledgeLocatorSchema.nullable().default(null),
  parentContent: z.string().nullable().default(null),
  sourceUrl: z.string().nullable(),
  score: z.number(),
  scoreKind: z.enum(['rrf', 'rerank']).default('rrf'),
  scores: knowledgeSearchScoresSchema,
  image: knowledgeImageRefSchema.nullable().default(null),
  faq: knowledgeFaqHitSchema.nullable().default(null),
});

export type KnowledgeSearchHit = z.infer<typeof knowledgeSearchHitSchema>;

export const knowledgeSearchWarningSchema = z.object({
  code: z.enum(['embedding_unavailable', 'rerank_unavailable', 'wiki_index_pending']),
  message: z.string(),
});

export type KnowledgeSearchWarning = z.infer<typeof knowledgeSearchWarningSchema>;

export const knowledgeSearchDiagnosticsSchema = z.object({
  paths: z.object({
    keyword: z.number().int(),
    vector: z.number().int(),
    imageVector: z.number().int(),
  }),
  fused: z.number().int(),
  returned: z.number().int(),
  rerank: z.enum(['off', 'applied', 'unavailable']),
  elapsedMs: z.number(),
  candidates: z.array(z.object({ chunkId: z.string(), scores: knowledgeSearchScoresSchema })),
});

export type KnowledgeSearchDiagnostics = z.infer<typeof knowledgeSearchDiagnosticsSchema>;

export const knowledgeJobTypeSchema = z.enum([
  'ingest',
  'reindex',
  'sync',
  'source_probe',
  'wiki_generate',
  'summary',
  'tag_generate',
  'cleanup',
]);

export type KnowledgeJobType = z.infer<typeof knowledgeJobTypeSchema>;

export const KNOWLEDGE_JOB_TIMEOUT_MS: Record<KnowledgeJobType, number> = {
  ingest: 30 * 60_000,
  sync: 30 * 60_000,
  reindex: 2 * 60 * 60_000,
  source_probe: 5 * 60_000,
  wiki_generate: 15 * 60_000,
  summary: 10 * 60_000,
  tag_generate: 5 * 60_000,
  cleanup: 30 * 60_000,
};

export const knowledgeJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const knowledgeBaseSummarySchema = z.object({
  documents: z.number().int().nonnegative(),
  faqs: z.number().int().nonnegative(),
  wikiPages: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  lastJob: z
    .object({
      id: z.string(),
      type: z.string(),
      status: knowledgeJobStatusSchema,
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
});

export type KnowledgeBaseSummary = z.infer<typeof knowledgeBaseSummarySchema>;

export const knowledgeSourceProbeCheckSchema = z.object({
  rangeId: z.string(),
  ok: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export const knowledgeSourceProbeResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(knowledgeSourceProbeCheckSchema),
});

export type KnowledgeSourceProbeResult = z.infer<typeof knowledgeSourceProbeResultSchema>;

export const knowledgeJobSchema = z.object({
  id: z.string(),
  type: knowledgeJobTypeSchema,
  status: knowledgeJobStatusSchema,
  step: z.string().nullable(),
  progress: z.number().int(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  result: knowledgeSourceProbeResultSchema.nullable().default(null),
  documentId: z.string().nullable(),
  sourceId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  sourceName: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});

export type KnowledgeJob = z.infer<typeof knowledgeJobSchema>;

export const knowledgeSyncItemStatusSchema = z.enum(['failed', 'skipped']);

export const knowledgeSyncItemSchema = z.object({
  id: z.string(),
  syncRunId: z.string(),
  sourceId: z.string(),
  rangeId: z.string().nullable(),
  documentId: z.string().nullable(),
  externalId: z.string(),
  status: knowledgeSyncItemStatusSchema,
  code: z.string(),
  message: z.string().max(500),
  retryable: z.boolean(),
  createdAt: z.string(),
});

export type KnowledgeSyncItem = z.infer<typeof knowledgeSyncItemSchema>;

export const knowledgeSourceRangeKindSchema = z.enum([
  'wiki_space',
  'wiki_node',
  'drive_folder',
  'gitlab_project',
  'github_repo',
  'feed',
  'notion_page',
  'notion_database',
  'notion_data_source',
  'confluence_space',
  'confluence_page',
  'yuque_repo',
  'dingtalk_workspace',
  'dingtalk_node',
  'ima_kb',
  'seafile_repo',
  'nextcloud_path',
]);

export type KnowledgeSourceRangeKind = z.infer<typeof knowledgeSourceRangeKindSchema>;

export const knowledgeSourceRangeInputSchema = z.object({
  kind: knowledgeSourceRangeKindSchema,
  externalId: z.string().min(1),
  ref: z.string().nullable().default(null),
  paths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const sourceBase = {
  name: z.string().trim().min(1).max(120),
  syncCron: cronSchema.nullable().default(null),
  ranges: z.array(knowledgeSourceRangeInputSchema).min(1),
};

const sourceSyncOptions = {
  syncDeletions: z.boolean().default(false),
};

const feishuConfig = z.object({
  appId: z.string().min(1),
  baseUrl: z.string().url().optional(),
  ...sourceSyncOptions,
});

const larkConfig = z.object({
  appId: z.string().min(1),
  ...sourceSyncOptions,
});

const fixedOriginConfig = z.object({ ...sourceSyncOptions });

const confluenceConfig = z.discriminatedUnion('authMode', [
  z.object({
    authMode: z.literal('cloud_basic'),
    baseUrl: z.string().url(),
    email: z.string().email(),
    ...sourceSyncOptions,
  }),
  z.object({
    authMode: z.literal('cloud_scoped'),
    baseUrl: z.string().url(),
    email: z.string().email(),
    cloudId: z.string().min(1),
    ...sourceSyncOptions,
  }),
  z.object({
    authMode: z.literal('dc_pat'),
    baseUrl: z.string().url(),
    ...sourceSyncOptions,
  }),
]);

export const knowledgeSourceInputSchema = z.discriminatedUnion('type', [
  z.object({
    ...sourceBase,
    type: z.literal('feishu_wiki'),
    config: feishuConfig,
    secrets: z.object({ appSecret: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('feishu_drive'),
    config: feishuConfig,
    secrets: z.object({ appSecret: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('gitlab'),
    config: z.object({
      baseUrl: z.string().url(),
      projectId: z.string().min(1),
      ref: z.string().min(1),
      ...sourceSyncOptions,
    }),
    secrets: z.object({ token: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('github'),
    config: z.object({
      baseUrl: z.string().url().optional(),
      projectId: z.string().trim().min(1),
      ref: z.string().min(1).optional(),
      ...sourceSyncOptions,
    }),
    secrets: z.object({ token: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('feed'),
    config: z.object({ url: z.string().url().optional(), ...sourceSyncOptions }),
    secrets: z.object({}),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('lark_wiki'),
    config: larkConfig,
    secrets: z.object({ appSecret: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('lark_drive'),
    config: larkConfig,
    secrets: z.object({ appSecret: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('notion'),
    config: fixedOriginConfig,
    secrets: z.object({ apiKey: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('confluence'),
    config: confluenceConfig,
    secrets: z.union([
      z.object({ apiToken: z.string().min(1) }),
      z.object({ pat: z.string().min(1) }),
    ]),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('yuque'),
    config: fixedOriginConfig,
    secrets: z.object({ apiToken: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('dingtalk'),
    config: z.object({
      clientId: z.string().min(1),
      operatorUnionId: z.string().min(1),
      ...sourceSyncOptions,
    }),
    secrets: z.object({ clientSecret: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('ima'),
    config: z.object({ clientId: z.string().min(1), ...sourceSyncOptions }),
    secrets: z.object({ apiKey: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('seafile'),
    config: z.object({ baseUrl: z.string().url(), ...sourceSyncOptions }),
    secrets: z.object({ apiToken: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('nextcloud'),
    config: z.object({
      baseUrl: z.string().url(),
      username: z.string().min(1),
      ...sourceSyncOptions,
    }),
    secrets: z.object({ appPassword: z.string().min(1) }),
  }),
]);

export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceInputSchema>;

export const knowledgeWikiPageStatusSchema = z.enum(['draft', 'published', 'stale', 'failed']);
export type KnowledgeWikiPageStatus = z.infer<typeof knowledgeWikiPageStatusSchema>;

export const knowledgeWikiGeneratedBySchema = z.enum(['sdk', 'manual']);
export type KnowledgeWikiGeneratedBy = z.infer<typeof knowledgeWikiGeneratedBySchema>;

export const knowledgeWikiLinkSchema = z.object({
  targetPageId: z.string().nullable(),
  anchor: z.string().nullable(),
});

export const knowledgeWikiLinksResultSchema = z.object({
  outgoing: z.array(knowledgeWikiLinkSchema),
  incoming: z.array(
    z.object({
      sourcePageId: z.string(),
      anchor: z.string().nullable(),
    }),
  ),
});

export type KnowledgeWikiLinksResult = z.infer<typeof knowledgeWikiLinksResultSchema>;

export const knowledgeWikiGraphNodeSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
});

export const knowledgeWikiGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const knowledgeWikiGraphSchema = z.object({
  nodes: z.array(knowledgeWikiGraphNodeSchema),
  edges: z.array(knowledgeWikiGraphEdgeSchema),
  truncated: z.boolean(),
});

export type KnowledgeWikiGraph = z.infer<typeof knowledgeWikiGraphSchema>;

export const knowledgeWikiVersionDiffSchema = z.object({
  fromVersionId: z.string(),
  toVersionId: z.string(),
  addedLines: z.array(z.string()),
  removedLines: z.array(z.string()),
  addedSourceChunkIds: z.array(z.string()),
  removedSourceChunkIds: z.array(z.string()),
});

export type KnowledgeWikiVersionDiff = z.infer<typeof knowledgeWikiVersionDiffSchema>;

export const knowledgeIngestInputSnapshotSchema = z.object({
  blobSha256: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  expectedCurrentVersionId: z.string().nullable(),
});

export const knowledgeJobPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ingest'),
    documentId: z.string(),
    publish: z.enum(['draft', 'automatic']).default('automatic'),
    versionId: z.string().min(1).optional(),
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
    input: knowledgeIngestInputSnapshotSchema.optional(),
  }),
  z.object({
    type: z.literal('reindex'),
    baseId: z.string(),
    documentIds: z.array(z.string()).optional(),
    chunksOnly: z.boolean().default(false),
    confirmOverwriteManualChunks: z.boolean().default(false),
  }),
  z.object({ type: z.literal('sync'), sourceId: z.string(), syncRunId: z.string() }),
  z.object({ type: z.literal('source_probe'), sourceId: z.string() }),
  z.object({
    type: z.literal('wiki_generate'),
    baseId: z.string(),
    pageId: z.string().optional(),
    title: z.string().optional(),
    instruction: z.string().optional(),
    sourceDocumentIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('summary'),
    baseId: z.string(),
    documentId: z.string(),
    versionId: z.string(),
  }),
  z.object({
    type: z.literal('tag_generate'),
    baseId: z.string(),
    documentId: z.string(),
    versionId: z.string().optional(),
  }),
  z.object({ type: z.literal('cleanup'), baseId: z.string().optional() }),
]);

export type KnowledgeJobPayload = z.infer<typeof knowledgeJobPayloadSchema>;

export const knowledgeReadImageInputSchema = z.object({
  chunkId: z.string().min(1).describe('Image chunk ID from a prior knowledge_search hit.'),
  format: z
    .enum(['description', 'image'])
    .default('description')
    .describe('description (default) returns text; image returns the original image.'),
});

export const knowledgeReadImageResultSchema = z.object({
  hit: knowledgeSearchHitSchema,
  description: z.string(),
});

export type KnowledgeReadImageInput = z.infer<typeof knowledgeReadImageInputSchema>;
export type KnowledgeReadImageResult = z.infer<typeof knowledgeReadImageResultSchema>;

export const knowledgeSearchDirectAnswerSchema = z.object({
  target: knowledgeTargetSchema,
  versionId: z.string(),
  answers: z.array(z.string()).min(1),
  vectorScore: z.number(),
});

export type KnowledgeSearchDirectAnswer = z.infer<typeof knowledgeSearchDirectAnswerSchema>;

export const knowledgeSearchResultSchema = z.object({
  hits: z.array(knowledgeSearchHitSchema),
  degraded: z.boolean().default(false),
  warnings: z.array(knowledgeSearchWarningSchema).default([]),
  diagnostics: knowledgeSearchDiagnosticsSchema.optional(),
  directAnswer: knowledgeSearchDirectAnswerSchema.nullable().default(null),
});

export const knowledgeReadInputSchema = z.object({
  target: knowledgeTargetSchema.describe(
    'Target to read; kind is document, faq or wiki and id comes from search/list results.',
  ),
  versionId: z
    .string()
    .optional()
    .describe(
      'Must equal the current effective version, otherwise VERSION_NOT_CURRENT is returned; omit to read the current effective version.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Start position (Unicode code-point index).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .default(10_000)
    .describe('Maximum characters to return.'),
});

export const knowledgeReadResultSchema = z.object({
  target: knowledgeTargetSchema,
  versionId: z.string(),
  title: z.string(),
  sourceUrl: z.string().nullable(),
  markdown: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  totalCharacters: z.number().int().nonnegative(),
  citations: z.array(knowledgeSearchHitSchema),
});

export const knowledgeListInputSchema = z.object({
  kinds: z
    .array(knowledgeTargetKindSchema)
    .min(1)
    .default(['document', 'faq', 'wiki'])
    .describe('Source kinds to list; omit to include document, FAQ and wiki.'),
  cursor: z.string().optional().describe('Cursor from the previous page; omit for the first page.'),
  limit: z.number().int().min(1).max(50).default(20).describe('Maximum items per page.'),
});

export const knowledgeListResultSchema = cursorPageSchema(
  z.object({
    target: knowledgeTargetSchema,
    versionId: z.string(),
    title: z.string(),
    folderId: z.string().nullable(),
    tags: z.array(z.string()),
    updatedAt: z.string(),
  }),
);

export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;
export type KnowledgeReadInput = z.infer<typeof knowledgeReadInputSchema>;
export type KnowledgeReadResult = z.infer<typeof knowledgeReadResultSchema>;
export type KnowledgeListInput = z.infer<typeof knowledgeListInputSchema>;
export type KnowledgeListResult = z.infer<typeof knowledgeListResultSchema>;
