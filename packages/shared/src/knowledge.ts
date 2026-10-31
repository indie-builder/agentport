import { z } from 'zod';
import { cronSchema } from './ops.js';
import { slugSchema } from './params.js';

/** 知识库任务队列；jobId 即 knowledge_jobs.id，重复投递由 BullMQ 去重。 */
export const KNOWLEDGE_JOBS_QUEUE = 'knowledge-jobs';

/** 运行中取消：API 写键，worker 每秒轮询到非空后 abort；值本身不承载信息。 */
export const KNOWLEDGE_CANCEL_PAYLOAD = '1';

export function knowledgeCancelKey(jobId: string): string {
  return `knowledge:${jobId}:cancel`;
}

export function knowledgeEnqueueOptions(jobId: string) {
  return {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  };
}

/** 官方视觉输入单图上限 5MB；按二进制字节计，base64 膨胀不算在内。 */
export const KNOWLEDGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 图片名必须是版本清单里的单段文件名；任何路径分隔符或 `..` 都不接受。 */
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
    /** 现有 Anthropic 网关接受的视觉模型 ID；关闭时为 null。 */
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

export const knowledgeBaseSettingsSchema = z.object({
  chunkTokens: z.number().int().min(200).max(4000),
  chunkOverlap: z.number().int().min(0).max(1000),
  wikiAutoUpdate: z.boolean(),
  imageProcessing: knowledgeImageProcessingSchema.default(imageProcessingDefaults),
});

export const knowledgeBaseInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
});

export const knowledgeBaseSchema = knowledgeBaseInputSchema.extend({
  id: z.string(),
  serverId: z.string(),
  status: z.enum(['active', 'disabled']),
  embeddingProfileId: z.string(),
  rerankProfileId: z.string().nullable(),
  /** 音频转录模型；null 表示未启用 ASR。 */
  asrProfileId: z.string().nullable(),
  settings: knowledgeBaseSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;
export type KnowledgeBaseSettings = z.infer<typeof knowledgeBaseSettingsSchema>;

/** 无管理权限的创建/设置页只需选择项：不含端点、模型与任何密钥线索。 */
export const knowledgeModelProfileSelectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['embedding', 'rerank', 'asr']),
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

/**
 * 新增来源的 range externalId 入口上限。worker 把文档写成
 * `<connectionId>:<leaf externalId>`，连接 ID 固定 31 字符，ZIP 清单上限 500；
 * 这里按 provider 实际 ID 空间收紧，给连接与叶前缀留出余量，超长直接拒绝而非截断。
 */
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

/** 语料角色：普通文档、FAQ 与 Wiki 索引文档共用同一套版本与分块。 */
export const knowledgeContentKindSchema = z.enum(['document', 'faq', 'wiki']);

export const knowledgeDisabledReasonSchema = z.enum(['manual', 'source', 'range', 'remote']);

/** 解析器给出的定位；不支持的维度缺省，不编造坐标。 */
export const knowledgeLocatorSchema = z
  .object({
    /** 页码从 1 起。 */
    pageFrom: z.number().int().positive().optional(),
    pageTo: z.number().int().positive().optional(),
    /** UTF-16 下标，与现有正文偏移一致。 */
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().nonnegative().optional(),
    /** 行号从 1 起。 */
    lineFrom: z.number().int().positive().optional(),
    lineTo: z.number().int().positive().optional(),
    headingPath: z.array(z.string()).optional(),
    sheet: z.string().optional(),
    cellRange: z.string().optional(),
    /**
     * 相对原始音频起点的毫秒；范围是来源段，不声称逐字精度。
     * 两个字段同时存在或同时缺省；0 是合法时码。
     */
    timeFromMs: z.number().int().nonnegative().safe().optional(),
    timeToMs: z.number().int().nonnegative().safe().optional(),
    /** 解析器原坐标，不声称通用像素。 */
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

/** 版本 metadata.audio 的段级映射；偏移是最终转录 markdown 的 UTF-16 半开区间。 */
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
  /** 执行时快照，不是外键，不含 endpoint/key。 */
  profileName: z.string().min(1),
  model: z.string().min(1),
  /** 仅上游真实 duration；绝不用于制造定位。 */
  durationMs: z.number().int().nonnegative().safe().nullable(),
  /** 无时码时为 []；正文从 markdown 按区间取。 */
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
      message: '至少需要一条非空答案',
    }),
  /** 命中时返回全部答案或随机选一条；默认全部。 */
  answerStrategy: knowledgeFaqAnswerStrategySchema.default('all'),
  isRecommended: z.boolean().default(true),
});

export type KnowledgeFaq = z.infer<typeof knowledgeFaqSchema>;

/** 导入/导出条目：FAQ 内容 + 启用标记；运营标记不参与内容哈希。 */
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
  /** xlsx 为 base64，其余为原始文本；字节上限由入口校验。 */
  content: z.string().min(1),
  mode: knowledgeFaqImportModeSchema.default('append'),
  dryRun: z.boolean().default(false),
});

export type KnowledgeFaqImportInput = z.infer<typeof knowledgeFaqImportInputSchema>;

/** 规划时读取的文档两版指针快照；导入事务与批发布都用它检测期间变化。 */
export const knowledgeFaqImportStateSchema = z.object({
  documentId: z.string(),
  currentVersionId: z.string().nullable(),
  latestDraftVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

export type KnowledgeFaqImportState = z.infer<typeof knowledgeFaqImportStateSchema>;

/** 版本 metadata.faqImport；replaceTargets 是待替换旧 FAQ 的同形快照。 */
export const knowledgeFaqImportMetadataSchema = z.object({
  batchId: z.string(),
  mode: knowledgeFaqImportModeSchema,
  enabled: z.boolean(),
  /** 保存草稿时锁定的线上版本；发布必须同时匹配它与当前指针。 */
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
  /** 来源失权/范围失效/远程认证失败/人工停用；null 表示可读。 */
  disabledReason: knowledgeDisabledReasonSchema.nullable().default(null),
  /** 外部来源连接；保留已删除的来源 ID，因此不设外键。 */
  sourceConnectionId: z.string().nullable().default(null),
  currentVersionId: z.string().nullable(),
  tags: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeVersionOriginSchema = z.enum(['source', 'manual', 'faq', 'wiki']);

/** 版本列表 wire：不返回 hash 路径与存储细节。 */
export const knowledgeDocumentVersionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int(),
  origin: knowledgeVersionOriginSchema,
  parentVersionId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  faq: knowledgeFaqSchema.nullable().default(null),
  sourceRevision: z.string().nullable(),
  parseStatus: z.enum(['parsed', 'parse_failed']),
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
  /** 同版本父块序号；父块只作上下文，不参加排名。 */
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
  /** 图片 chunk 的定位信息；普通 chunk 为空对象。 */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const knowledgeTargetKindSchema = z.enum(['document', 'faq', 'wiki']);

export const knowledgeTargetSchema = z.object({
  kind: knowledgeTargetKindSchema,
  id: z.string(),
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
  q: z.string().trim().min(1).max(500),
  kinds: z.array(knowledgeTargetKindSchema).min(1).default(['document', 'faq', 'wiki']),
  folders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  /** 文本向量相似度门槛；0.3 是可配置初值，不是已校准的质量保证。 */
  minVectorScore: z.number().min(-1).max(1).default(0.3),
  diagnostics: z.boolean().default(false),
  /** 只筛选 FAQ，不排除可推荐条目；文档/Wiki 不受影响。 */
  onlyRecommended: z.boolean().default(false),
  /** FAQ 组排到普通结果前；默认不改变既有混合排序。 */
  faqPriority: z.boolean().default(false),
  /** directAnswer 的原始问题 cosine 门槛；0.9 是待数据校准的初值。 */
  faqDirectAnswerThreshold: z.number().min(-1).max(1).default(0.9),
});

export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

/** FAQ 命中的策略与命中问题；其他 kind 的 hit.faq 为 null。 */
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
  /** Wiki 命中时指内部索引文档/版本；对外的源对象看 target/targetVersionId。 */
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
  /** 子块命中时同一父块的上下文正文。 */
  parentContent: z.string().nullable().default(null),
  sourceUrl: z.string().nullable(),
  score: z.number(),
  /** 明示 score 的单位，两张量纲不能直接比较。 */
  scoreKind: z.enum(['rrf', 'rerank']).default('rrf'),
  scores: knowledgeSearchScoresSchema,
  /** 普通命中为 null；旧 wire / 历史 trace 没有该字段时按 null 读取。 */
  image: knowledgeImageRefSchema.nullable().default(null),
  /** FAQ 命中带答案策略与命中问题；其他 kind 为 null。 */
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
  'cleanup',
]);

export const knowledgeJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

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
  /** source_probe 等任务的可见结果；普通任务为 null。 */
  result: knowledgeSourceProbeResultSchema.nullable().default(null),
  /** 归属对象；列表左连名字，单任务读取不带名字时为 null。 */
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

/** 逐项同步失败/跳过记录；只存状态与错误，不存凭证或正文。 */
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

export const knowledgeSourceRangeInputSchema = z.object({
  kind: z.enum([
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
  ]),
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

/** 各来源共用的同步策略；不显式声明会被 zod strip 掉，worker 就读不到。 */
const sourceSyncOptions = {
  syncDeletions: z.boolean().default(false),
};

const feishuConfig = z.object({
  appId: z.string().min(1),
  baseUrl: z.string().url().optional(),
  ...sourceSyncOptions,
});

/** Lark 应用与飞书独立，API origin 固定，不接受自定义 baseUrl。 */
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
      // 缺省是 https://api.github.com；GitHub Enterprise 填 API 根（如 https://ghe.example.com/api/v3）。
      baseUrl: z.string().url().optional(),
      projectId: z.string().trim().min(1),
      // 可空：worker 回落到仓库 default_branch。
      ref: z.string().min(1).optional(),
      ...sourceSyncOptions,
    }),
    secrets: z.object({ token: z.string().min(1) }),
  }),
  z.object({
    ...sourceBase,
    type: z.literal('feed'),
    // url 可选：订阅地址也可由 range 的 externalId 指定（每个订阅源一条范围）。
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
    // Cloud 用 apiToken，DC 用 pat；具体与 authMode 的对应由入口统一校验。
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

export const knowledgeWikiPageSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  slug: z.string(),
  title: z.string(),
  parentId: z.string().nullable().default(null),
  position: z.number().int().default(0),
  status: knowledgeWikiPageStatusSchema,
  currentVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

export const knowledgeWikiLinkSchema = z.object({
  /** null 表示目标页不存在：管理端据此标记坏链接，不伪造页面 ID。 */
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

export const knowledgeWikiVersionDiffSchema = z.object({
  fromVersionId: z.string(),
  toVersionId: z.string(),
  addedLines: z.array(z.string()),
  removedLines: z.array(z.string()),
  addedSourceChunkIds: z.array(z.string()),
  removedSourceChunkIds: z.array(z.string()),
});

export type KnowledgeWikiVersionDiff = z.infer<typeof knowledgeWikiVersionDiffSchema>;

/** 手动/上传摄取的不可变输入快照；任务重试只能复用该快照，不重新读取线上状态。 */
export const knowledgeIngestInputSnapshotSchema = z.object({
  blobSha256: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  expectedCurrentVersionId: z.string().nullable(),
});

export type KnowledgeIngestInputSnapshot = z.infer<typeof knowledgeIngestInputSnapshotSchema>;

export const knowledgeJobPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ingest'),
    documentId: z.string(),
    /** 手写/FAQ/Wiki 草稿先存草稿；默认沿用自动原子发布。 */
    publish: z.enum(['draft', 'automatic']).default('automatic'),
    /** 预分配草稿版本；FAQ 等调用方要求任务必须索引指定版本，不能回落到“最新”。 */
    versionId: z.string().min(1).optional(),
    /** 建版本时合入的不可变 metadata（如 publication/faqImport/wiki 引用）。 */
    versionMetadata: z.record(z.string(), z.unknown()).optional(),
    /** 摄取输入快照：重试与并发切换都按它核对，不再读取运行时最新状态。 */
    input: knowledgeIngestInputSnapshotSchema.optional(),
  }),
  z.object({
    type: z.literal('reindex'),
    baseId: z.string(),
    documentIds: z.array(z.string()).optional(),
    chunksOnly: z.boolean().default(false),
    /** 覆盖解析文本前必须显式确认人工分块；重试时随 payload 保留。 */
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
  z.object({ type: z.literal('cleanup'), baseId: z.string().optional() }),
]);

export type KnowledgeJobPayload = z.infer<typeof knowledgeJobPayloadSchema>;

export const knowledgeReadImageInputSchema = z.object({
  chunkId: z.string().min(1),
  format: z.enum(['description', 'image']).default('description'),
});

export const knowledgeReadImageResultSchema = z.object({
  hit: knowledgeSearchHitSchema,
  description: z.string(),
});

export type KnowledgeReadImageInput = z.infer<typeof knowledgeReadImageInputSchema>;
export type KnowledgeReadImageResult = z.infer<typeof knowledgeReadImageResultSchema>;

/** faqPriority 命中且原始 cosine 达阈值时的直接答案；只取 cosine 最高者。 */
export const knowledgeSearchDirectAnswerSchema = z.object({
  target: knowledgeTargetSchema,
  versionId: z.string(),
  answers: z.array(z.string()).min(1),
  vectorScore: z.number(),
});

export type KnowledgeSearchDirectAnswer = z.infer<typeof knowledgeSearchDirectAnswerSchema>;

/** MCP 工具结果的 wire 形状：服务端生成、前端解析共用。 */
export const knowledgeSearchResultSchema = z.object({
  hits: z.array(knowledgeSearchHitSchema),
  degraded: z.boolean().default(false),
  warnings: z.array(knowledgeSearchWarningSchema).default([]),
  /** 仅管理端 REST 请求可开启；MCP 不返回候选正文与内部配置。 */
  diagnostics: knowledgeSearchDiagnosticsSchema.optional(),
  /** 只有 faqPriority 且 FAQ 原始 cosine 达阈值时非空。 */
  directAnswer: knowledgeSearchDirectAnswerSchema.nullable().default(null),
});

export const knowledgeReadInputSchema = z.object({
  target: knowledgeTargetSchema,
  versionId: z.string().optional(),
  /** Unicode code point 下标。 */
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20_000).default(10_000),
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
  kinds: z.array(knowledgeTargetKindSchema).default(['document', 'faq', 'wiki']),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const knowledgeListResultSchema = z.object({
  items: z.array(
    z.object({
      target: knowledgeTargetSchema,
      versionId: z.string(),
      title: z.string(),
      folderId: z.string().nullable(),
      tags: z.array(z.string()),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const knowledgeMcpResultSchema = z.union([
  knowledgeSearchResultSchema,
  knowledgeReadResultSchema,
  knowledgeListResultSchema,
]);

export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;
export type KnowledgeReadInput = z.infer<typeof knowledgeReadInputSchema>;
export type KnowledgeReadResult = z.infer<typeof knowledgeReadResultSchema>;
export type KnowledgeListInput = z.infer<typeof knowledgeListInputSchema>;
export type KnowledgeListResult = z.infer<typeof knowledgeListResultSchema>;
