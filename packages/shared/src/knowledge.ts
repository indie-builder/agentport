import { z } from 'zod';
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

export type KnowledgeImageChunkMetadata = z.infer<typeof knowledgeImageChunkMetadataSchema>;

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
  kind: z.enum(['embedding', 'rerank']),
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
]);

export const knowledgeDocumentStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'failed',
  'disabled',
]);

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
  currentVersionId: z.string().nullable(),
  tags: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeChunkKindSchema = z.enum(['text', 'table', 'image']);

export const knowledgeChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  ordinal: z.number().int(),
  kind: knowledgeChunkKindSchema,
  heading: z.string().nullable(),
  content: z.string(),
  enabled: z.boolean(),
  editedByUser: z.boolean(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  /** 图片 chunk 的定位信息；普通 chunk 为空对象。 */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  folders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
});

export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

export const knowledgeSearchHitSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  title: z.string(),
  heading: z.string().nullable(),
  quote: z.string(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  sourceUrl: z.string().nullable(),
  score: z.number(),
  /** 普通命中为 null；旧 wire / 历史 trace 没有该字段时按 null 读取。 */
  image: knowledgeImageRefSchema.nullable().default(null),
});

export type KnowledgeSearchHit = z.infer<typeof knowledgeSearchHitSchema>;

export const knowledgeJobTypeSchema = z.enum([
  'ingest',
  'reindex',
  'sync',
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

export const knowledgeJobSchema = z.object({
  id: z.string(),
  type: knowledgeJobTypeSchema,
  status: knowledgeJobStatusSchema,
  step: z.string().nullable(),
  progress: z.number().int(),
  attempts: z.number().int(),
  error: z.string().nullable(),
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

const cron5Schema = z
  .string()
  .regex(/^\S+ \S+ \S+ \S+ \S+$/, '需为 5 段 cron（分 时 日 月 周），UTC');

export const knowledgeSourceRangeInputSchema = z.object({
  kind: z.enum([
    'wiki_space',
    'wiki_node',
    'drive_folder',
    'gitlab_project',
    'github_repo',
    'feed',
  ]),
  externalId: z.string().min(1),
  ref: z.string().nullable().default(null),
  paths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

const sourceBase = {
  name: z.string().trim().min(1).max(120),
  syncCron: cron5Schema.nullable().default(null),
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
]);

export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceInputSchema>;

export const knowledgeWikiPageStatusSchema = z.enum(['draft', 'published', 'stale', 'failed']);

export const knowledgeWikiPageSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  slug: z.string(),
  title: z.string(),
  status: knowledgeWikiPageStatusSchema,
  currentVersionId: z.string().nullable(),
  updatedAt: z.string(),
});

export type KnowledgeWikiPage = z.infer<typeof knowledgeWikiPageSchema>;

export const knowledgeJobPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ingest'), documentId: z.string() }),
  z.object({
    type: z.literal('reindex'),
    baseId: z.string(),
    documentIds: z.array(z.string()).optional(),
    chunksOnly: z.boolean().default(false),
  }),
  z.object({ type: z.literal('sync'), sourceId: z.string(), syncRunId: z.string() }),
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

/** MCP 工具结果的 wire 形状：服务端生成、前端解析共用。 */
export const knowledgeSearchResultSchema = z.object({ hits: z.array(knowledgeSearchHitSchema) });

export const knowledgeReadResultSchema = z.object({
  documentId: z.string(),
  versionId: z.string(),
  title: z.string(),
  sourceUrl: z.string().nullable(),
  markdown: z.string(),
  truncated: z.boolean(),
});

export const knowledgeListResultSchema = z.object({
  items: z.array(
    z.object({
      documentId: z.string(),
      title: z.string(),
      folderId: z.string().nullable(),
      tags: z.array(z.string()),
      sourceType: knowledgeSourceTypeSchema,
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
export type KnowledgeReadResult = z.infer<typeof knowledgeReadResultSchema>;
export type KnowledgeListResult = z.infer<typeof knowledgeListResultSchema>;
export type KnowledgeMcpResult = z.infer<typeof knowledgeMcpResultSchema>;
