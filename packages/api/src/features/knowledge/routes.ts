import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  decryptSecrets,
  embedImages,
  embedTexts,
  encryptSecrets,
  inspectKnowledgeAudio,
  KnowledgeModelError,
  rerankDocuments,
  segmentForSearch,
} from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import type { KnowledgeBaseSettings, KnowledgeJobPayload } from '@agentport/shared';
import {
  httpUrlSchema,
  knowledgeBaseInputSchema,
  knowledgeBaseSettingsSchema,
  knowledgeChunkKindSchema,
  knowledgeDocumentVersionSchema,
  knowledgeFaqImportMetadataSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeJobPayloadSchema,
  knowledgeTargetKindSchema,
} from '@agentport/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { AppError, isAppError, isPgCode, reject } from '../../plugins/errors.js';
import { publishKnowledgeCancel } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { assertSafeUrl } from '../servers/ssrf.js';
import { searchKnowledge } from './retrieval.js';
import { createJob, documentWire, enqueueKnowledgeJob, ensureKnowledgeServer } from './service.js';

/** 1x1 PNG：图片能力探针用真实字节，不靠模型名推断。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** base64 膨胀 4/3 + JSON 包装；契约固定 48MiB。 */
const UPLOAD_BODY_LIMIT = 48 * 1024 * 1024;

const baseParams = z.object({ id: z.string().min(1) });
const folderParams = z.object({ folderId: z.string().min(1) });
const tagParams = z.object({ tagId: z.string().min(1) });
const documentParams = z.object({ documentId: z.string().min(1) });
const chunkParams = z.object({ chunkId: z.string().min(1) });
const versionParams = z.object({ versionId: z.string().min(1) });
const jobParams = z.object({ jobId: z.string().min(1) });
const profileParams = z.object({ profileId: z.string().min(1) });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 创建时缺省整块补齐；更新时只合并传入字段，不能把没传的 imageProcessing 重置成默认值。 */
const baseCreateSchema = knowledgeBaseInputSchema.extend({
  embeddingProfileId: z.string().min(1),
  rerankProfileId: z.string().min(1).nullable().default(null),
  /** null 表示不启用音频转录；绑定非空 ID 时由入口校验 kind 与 enabled。 */
  asrProfileId: z.string().min(1).nullable().default(null),
  settings: knowledgeBaseSettingsSchema.prefault({
    chunkTokens: 800,
    chunkOverlap: 120,
    wikiAutoUpdate: false,
  }),
});

const basePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  embeddingProfileId: z.string().min(1).optional(),
  rerankProfileId: z.string().min(1).nullable().optional(),
  /** undefined 保持，null 关闭。 */
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

const uploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().default(null),
  /** 浏览器目录上传时的相对路径；只用于建真实目录，不接受绝对路径或 ..。 */
  relativePath: z.string().min(1).max(512).optional(),
});

const documentQuery = pageQuery.extend({
  /** 'null' 表示只看根目录；缺省不过滤。 */
  folderId: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed', 'disabled']).optional(),
  q: z.string().max(200).optional(),
});

const documentPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  folderId: z.string().min(1).nullable().optional(),
  status: z.enum(['ready', 'disabled']).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).optional(),
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

const batchSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['move', 'copy', 'tag', 'delete', 'reprocess']),
  folderId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  tagMode: z.enum(['add', 'remove', 'replace']).optional(),
  confirmOverwriteManualChunks: z.boolean().default(false),
});

/** 浏览器可构造的重复 query 参数：单值也按一元数组读取。 */
const repeated = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]),
    z.array(schema),
  );

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  // 缺省三类；重复 query 参数按数组读取，单值视为一元数组。
  kinds: z.preprocess(
    (value) =>
      value === undefined ? ['document', 'faq', 'wiki'] : Array.isArray(value) ? value : [value],
    z.array(knowledgeTargetKindSchema).min(1),
  ),
  folders: repeated(z.string()),
  tags: repeated(z.string()),
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

const profileKindSchema = z.enum(['embedding', 'rerank', 'asr']);

/** ASR 固定 openai 转录协议、无维度、无图片能力；其余字段沿用同一张表。 */
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
  /** undefined 保持原密钥；null 显式清除。 */
  apiKey: z.string().min(1).max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});

const jobQuery = pageQuery.extend({
  baseId: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
});

const chunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionId: z.string(),
  ordinal: z.number().int(),
  parentOrdinal: z.number().int().nullable(),
  indexRole: z.enum(['leaf', 'parent']),
  kind: knowledgeChunkKindSchema,
  heading: z.string().nullable(),
  content: z.string(),
  enabled: z.boolean(),
  editedByUser: z.boolean(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  locator: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const folderSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
});

const tagSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

const profileSchema = z.object({
  id: z.string(),
  kind: profileKindSchema,
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

type DocumentRow = NonNullable<Awaited<ReturnType<typeof repo.knowledge.getDocument>>>;
type ChunkRow = Awaited<ReturnType<typeof repo.knowledge.listChunkSummaries>>['items'][number];
type JobRow = Awaited<ReturnType<typeof repo.knowledge.listJobs>>['items'][number];
type FolderRow = Awaited<ReturnType<typeof repo.knowledge.listFolders>>['items'][number];
type TagRow = Awaited<ReturnType<typeof repo.knowledge.listTags>>[number];
type ProfileRow = Awaited<ReturnType<typeof repo.knowledge.listModelProfiles>>[number];

function toBase(row: Awaited<ReturnType<typeof repo.knowledge.createBase>>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    serverId: row.serverId,
    status: row.status,
    embeddingProfileId: row.embeddingProfileId,
    rerankProfileId: row.rerankProfileId,
    asrProfileId: row.asrProfileId,
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocument(row: DocumentRow, tags: string[]) {
  return documentWire(row, tags);
}

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

function toJob(row: JobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    step: row.step,
    progress: row.progress,
    attempts: row.attempts,
    error: row.error,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;

/** 版本 wire 不返回 hash 与磁盘路径，只给管理端需要的可读字段。 */
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

function toFolder(row: FolderRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    parentId: row.parentId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTag(row: TagRow) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** wire 只回显式字段：列表行与带密文的创建/更新行都不能把 secretsEncrypted 带出去。 */
function toProfile(row: {
  id: string;
  kind: ProfileRow['kind'];
  name: string;
  endpointUrl: string;
  model: string;
  dimensions: number | null;
  embeddingProtocol: ProfileRow['embeddingProtocol'];
  imageInputEnabled: boolean;
  enabled: boolean;
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    endpointUrl: row.endpointUrl,
    model: row.model,
    dimensions: row.dimensions,
    embeddingProtocol: row.embeddingProtocol,
    imageInputEnabled: row.imageInputEnabled,
    enabled: row.enabled,
    hasSecret: row.hasSecret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(reply: FastifyReply, what: string) {
  return reject(reply, 'NOT_FOUND', `${what}不存在，可能已被删除；请刷新后重试`);
}

/** zod 的查询参数是显式 `| undefined`；仓库用 exactOptionalPropertyTypes，需要剔除未传的键。 */
function pageOptions(query: { cursor?: string | undefined; limit?: number | undefined }): {
  cursor?: string;
  limit?: number;
} {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 与 worker 同一布局：`blobs/<sha 前2位>/<sha>`，先写临时文件再原子 rename。 */
async function storeBlob(knowledgeDir: string, data: Buffer): Promise<string> {
  const sha = sha256(data);
  const target = join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data);
  await rename(temp, target);
  return sha;
}

/** Node 的 base64 解码会静默跳过非法字符；重编码比对把损坏输入挡在写盘前。 */
function decodeBase64(value: string): Buffer | null {
  const data = Buffer.from(value, 'base64');
  if (data.length === 0) return null;
  return data.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? data : null;
}

function fileTitle(filename: string): string {
  const withoutExtension = basename(filename).replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
}

/**
 * 模型端点是出站信任边界：私网/环回地址只有在 KNOWLEDGE_PRIVATE_HOST_ALLOWLIST
 * 里显式列出（`host`、`host:port` 或完整 origin）才放行；其余交给服务器统一的 SSRF 检查。
 * 开发环境沿用 assertSafeUrl 对 localhost 的放行。
 */
async function assertKnowledgeEndpoint(
  raw: string,
  config: { KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: string; NODE_ENV: string | undefined },
): Promise<void> {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const key = url.port ? `${host}:${url.port}` : host;
  const allowed = config.KNOWLEDGE_PRIVATE_HOST_ALLOWLIST.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.includes(key) || allowed.includes(host) || allowed.includes(url.origin)) return;
  await assertSafeUrl(raw, config.NODE_ENV);
}

/** 同空间图片向量只认 cohere_v2 + embed-v4.0；同维度不等于同空间。 */
function supportsImageVectors(profile: {
  embeddingProtocol: string;
  model: string;
  imageInputEnabled: boolean;
  enabled: boolean;
}): boolean {
  return (
    profile.enabled &&
    profile.embeddingProtocol === 'cohere_v2' &&
    profile.model === 'embed-v4.0' &&
    profile.imageInputEnabled
  );
}

/** 图片能力只能长在 embedding profile 上，且协议/模型必须匹配；否则探针结果不可信。 */
function imageCapabilityProblem(input: {
  kind: z.infer<typeof profileKindSchema>;
  model: string;
  embeddingProtocol: 'openai' | 'cohere_v2';
  imageInputEnabled: boolean;
}): string | null {
  if (!input.imageInputEnabled) return null;
  if (input.kind === 'asr') return 'ASR profile 不支持图片输入';
  if (input.kind !== 'embedding') return '只有 embedding profile 可以开启图片输入';
  if (input.embeddingProtocol !== 'cohere_v2' || input.model !== 'embed-v4.0') {
    return '图片输入需要 embeddingProtocol=cohere_v2 且 model=embed-v4.0';
  }
  return null;
}

/** 图片向量是 opt-in 同空间查询：库设置必须同时满足 profile 能力与开关。 */
async function imageSettingsProblem(
  settings: KnowledgeBaseSettings,
  embedding: {
    embeddingProtocol: string;
    model: string;
    imageInputEnabled: boolean;
    enabled: boolean;
  } | null,
): Promise<string | null> {
  if (!embedding) return 'embedding profile 不存在，可能已被删除';
  if (!settings.imageProcessing.enabled) return null;
  if (!settings.imageProcessing.imageVectorEnabled || supportsImageVectors(embedding)) return null;
  return (
    '图片向量需要当前 embedding profile 为 cohere_v2 + embed-v4.0 且开启图片输入；' +
    '请先创建并切换到满足条件的 profile'
  );
}

export function registerKnowledgeRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };
  const secretKey = (): string => app.config.APP_SECRET_KEY;

  const enqueue = async (
    payload: Parameters<typeof createJob>[1]['payload'],
    refs: { baseId: string | null; documentId: string | null; sourceId?: string | null },
  ) => {
    const job = await createJob(app.db, { ...refs, payload });
    await enqueueKnowledgeJob(job);
    return job;
  };

  const documentWithTags = async (row: DocumentRow) => {
    const tags = await repo.knowledge.getDocumentTagNames(app.db, [row.id]);
    return toDocument(row, tags.get(row.id) ?? []);
  };

  type FullChunkRow = typeof schema.knowledgeChunks.$inferSelect;

  const collectChunks = async (versionId: string): Promise<FullChunkRow[]> => {
    const items: FullChunkRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await repo.knowledge.listChunks(app.db, versionId, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      if (page.nextCursor === null || page.nextCursor === cursor) return items;
      cursor = page.nextCursor;
    }
  };

  const cloneChunk = (chunk: FullChunkRow): repo.knowledge.NewChunk => ({
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
  });

  /**
   * 人工编辑分块 = 新文档版本：正文由新块按序号拼出，原件仍指向同一 blob；
   * 旧版本与其文件保持只读，任何人不能再原地改写历史。
   * 版本 id 先在 API 预分配并把完整文件写好后，事务才 INSERT/COW/切指针。
   */
  const preparedVersionInput = (
    current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
    versionId: string,
    markdown: string,
  ): repo.knowledge.EditDocumentChunksInput['preparedVersion'] => ({
    id: versionId,
    blobSha256: current.blobSha256,
    markdownSha256: sha256(Buffer.from(markdown, 'utf8')),
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
  });

  /** 清单声明了什么就逐张复制什么；缺文件立即抛错，不能留下指向坏清单的版本目录。 */
  const copyVersionImages = async (
    sourceDir: string,
    targetDir: string,
    images: Array<{ name: string }>,
  ): Promise<void> => {
    if (images.length === 0) return;
    await mkdir(targetDir, { recursive: true });
    for (const image of images) {
      try {
        await copyFile(join(sourceDir, image.name), join(targetDir, image.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AppError('CONFLICT', `版本图片文件缺失：${image.name}`);
        }
        throw err;
      }
    }
  };

  /** 文件准备失败必须在事务前抛出；调用方随后清理残留目录，绝不切换指针。 */
  const prepareVersionFiles = async (
    documentId: string,
    current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
    versionId: string,
    markdown: string,
  ): Promise<string> => {
    const dir = join(app.config.KNOWLEDGE_DIR, 'docs', documentId, versionId);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'markdown.md'), markdown, 'utf8');
      await copyVersionImages(
        join(app.config.KNOWLEDGE_DIR, 'docs', documentId, current.id, 'images'),
        join(dir, 'images'),
        current.images,
      );
      return dir;
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  };

  /**
   * 只有事务确实没提交（版本行不存在）时才删预写目录；
   * editDocumentChunks 可能提交事务后才在收尾步骤抛错，此时文件已属于线上版本。
   */
  const discardUncommittedVersion = async (dir: string, versionId: string): Promise<void> => {
    try {
      if (await repo.knowledge.getVersion(app.db, versionId)) return;
    } catch {
      return;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  /** 索引补齐失败不回滚已提交的人工版本，但要让调用方看到 jobId=null。 */
  const enqueueChunkReindex = async (
    baseId: string,
    documentId: string,
  ): Promise<string | null> => {
    const job = await createJob(app.db, {
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
    try {
      await enqueueKnowledgeJob(job);
      return job.id;
    } catch (err) {
      await app.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
      app.log.warn({ err, documentId }, 'knowledge chunk reindex enqueue failed');
      return null;
    }
  };

  /** 显式启用前只核来源/范围授权，复用 repo 的唯一可读 SQL，不另写一套条件。 */
  const sourceScopeAllowsEnable = async (documentId: string): Promise<boolean> => {
    const result = await app.db.execute<{ ok: boolean }>(sql`
      select ${repo.knowledge.readableDocumentSql('probe')} as ok
      from (
        select d.id, 'ready'::text as status, d.current_version_id, null::text as disabled_reason,
               d.source_connection_id, d.base_id, d.source_path
        from knowledge_documents d
        where d.id = ${documentId}
      ) probe
    `);
    return result.rows[0]?.ok === true;
  };

  /** 目录上传的相对路径只用于建库内真实目录，不信任任何路径分隔符组合。 */
  const relativePathParts = (raw: string): string[] | null => {
    if (raw.includes('\\')) return null;
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
    if ([...raw].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return null;
    const parts = raw.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
    return parts;
  };

  const folderForPath = async (
    baseId: string,
    rootFolderId: string | null,
    parts: string[],
  ): Promise<string | null> => {
    let parentId = rootFolderId;
    let parentPath = '';
    if (rootFolderId !== null) {
      const root = await repo.knowledge.getFolder(app.db, rootFolderId);
      if (!root || root.baseId !== baseId) throw new Error('root folder missing');
      parentPath = root.path;
    }
    for (const name of parts) {
      const path = `${parentPath}/${name}`;
      const existing = await app.db
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
          const created = await repo.knowledge.createFolder(app.db, {
            baseId,
            parentId,
            name,
            path,
          });
          parentId = created.id;
        } catch (err) {
          if (!isPgCode(err, '23505')) throw err;
          // 并发上传同一目录：唯一约束胜出后复用已存在的行。
          const [row] = await app.db
            .select({ id: schema.knowledgeFolders.id })
            .from(schema.knowledgeFolders)
            .where(
              and(
                eq(schema.knowledgeFolders.baseId, baseId),
                eq(schema.knowledgeFolders.path, path),
              ),
            )
            .limit(1);
          if (!row) throw err;
          parentId = row.id;
        }
      }
      parentPath = path;
    }
    return parentId;
  };

  // ---- 知识库 -------------------------------------------------------------

  app.get(
    '/api/knowledge/bases',
    { ...auth, schema: { querystring: pageQuery } },
    async (request) => {
      const page = await repo.knowledge.listBases(app.db, pageOptions(request.query));
      return { items: page.items.map(toBase), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/api/knowledge/bases',
    { ...auth, schema: { body: baseCreateSchema } },
    async (request, reply) => {
      const input = request.body;
      const [embedding, rerank, asr] = await Promise.all([
        repo.knowledge.getModelProfileWithSecret(app.db, input.embeddingProfileId),
        input.rerankProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, input.rerankProfileId)
          : null,
        input.asrProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, input.asrProfileId)
          : null,
      ]);
      if (!embedding || embedding.kind !== 'embedding' || !embedding.enabled) {
        return reject(reply, 'INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
      }
      if (input.rerankProfileId && (!rerank || rerank.kind !== 'rerank' || !rerank.enabled)) {
        return reject(reply, 'INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
      }
      if (input.asrProfileId && (!asr || asr.kind !== 'asr' || !asr.enabled)) {
        return reject(reply, 'INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
      }
      const settingsProblem = await imageSettingsProblem(input.settings, embedding);
      if (settingsProblem !== null) return reject(reply, 'CONFLICT', settingsProblem);
      try {
        // base.server_id 非空：先建内置 server 占位，建完 base 再把 knowledgeBaseId 写进 config。
        const server = await ensureKnowledgeServer(app.db, { slug: input.slug });
        const row = await repo.knowledge.createBase(app.db, {
          slug: input.slug,
          name: input.name,
          description: input.description,
          serverId: server.id,
          embeddingProfileId: input.embeddingProfileId,
          rerankProfileId: input.rerankProfileId,
          asrProfileId: input.asrProfileId,
          settings: input.settings,
        });
        await ensureKnowledgeServer(app.db, { slug: row.slug, id: row.id, serverId: server.id });
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'knowledge.base.created',
          target: row.id,
          input: { slug: row.slug },
          status: 'ok',
          requestId: request.id,
        });
        return reply.status(201).send(toBase(row));
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '该 slug 已被占用，请换一个');
        throw err;
      }
    },
  );

  app.get(
    '/api/knowledge/bases/:id',
    { ...auth, schema: { params: baseParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getBase(app.db, request.params.id);
      return row ? toBase(row) : notFound(reply, '知识库');
    },
  );

  app.patch(
    '/api/knowledge/bases/:id',
    { ...auth, schema: { params: baseParams, body: basePatchSchema } },
    async (request, reply) => {
      const current = await repo.knowledge.getBase(app.db, request.params.id);
      if (!current) return notFound(reply, '知识库');
      const settingsPatch = request.body.settings;
      const merged = knowledgeBaseSettingsSchema.safeParse({
        chunkTokens: settingsPatch?.chunkTokens ?? current.settings.chunkTokens,
        chunkOverlap: settingsPatch?.chunkOverlap ?? current.settings.chunkOverlap,
        wikiAutoUpdate: settingsPatch?.wikiAutoUpdate ?? current.settings.wikiAutoUpdate,
        imageProcessing: {
          ...current.settings.imageProcessing,
          ...settingsPatch?.imageProcessing,
        },
      });
      // 合并后的整块设置仍要满足跨字段约束（开启需模型、向量需图片处理）。
      if (!merged.success) {
        return reject(
          reply,
          'INVALID_INPUT',
          merged.error.issues[0]?.message ?? '知识库设置不合法',
        );
      }
      const settings: KnowledgeBaseSettings = merged.data;
      const nextEmbeddingProfileId = request.body.embeddingProfileId ?? current.embeddingProfileId;
      const nextRerankProfileId =
        request.body.rerankProfileId === undefined
          ? current.rerankProfileId
          : request.body.rerankProfileId;
      const nextAsrProfileId =
        request.body.asrProfileId === undefined ? current.asrProfileId : request.body.asrProfileId;
      const [embedding, rerank, asr] = await Promise.all([
        repo.knowledge.getModelProfileWithSecret(app.db, nextEmbeddingProfileId),
        nextRerankProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, nextRerankProfileId)
          : null,
        nextAsrProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, nextAsrProfileId)
          : null,
      ]);
      // 与创建入口同一条规则：换绑不能指向错类型或已停用的模型。
      // 未换绑时只要求 profile 仍在，否则已绑停用 profile 的库连改名/停用都做不了。
      if (nextEmbeddingProfileId !== current.embeddingProfileId) {
        if (!embedding || embedding.kind !== 'embedding' || !embedding.enabled) {
          return reject(reply, 'INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
        }
      } else if (!embedding) {
        return reject(reply, 'INVALID_INPUT', 'embedding profile 不存在，可能已被删除');
      }
      if (nextRerankProfileId !== current.rerankProfileId) {
        if (nextRerankProfileId && (!rerank || rerank.kind !== 'rerank' || !rerank.enabled)) {
          return reject(reply, 'INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
        }
      }
      if (nextAsrProfileId !== current.asrProfileId) {
        if (nextAsrProfileId && (!asr || asr.kind !== 'asr' || !asr.enabled)) {
          return reject(reply, 'INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
        }
      } else if (nextAsrProfileId && !asr) {
        return reject(reply, 'INVALID_INPUT', 'ASR profile 不存在，可能已被删除');
      }
      const settingsProblem = await imageSettingsProblem(settings, embedding);
      if (settingsProblem !== null) return reject(reply, 'CONFLICT', settingsProblem);
      const { settings: _settings, ...rest } = request.body;
      const row = await repo.knowledge.updateBase(app.db, current.id, {
        ...rest,
        ...(settingsPatch === undefined ? {} : { settings }),
      });
      return row ? toBase(row) : notFound(reply, '知识库');
    },
  );

  // 删内置 server 即级联删库与 agent_servers 绑定；blob 由 cleanup job 按引用回收。
  app.delete(
    '/api/knowledge/bases/:id',
    { ...auth, schema: { params: baseParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getBase(app.db, request.params.id);
      if (!row) return notFound(reply, '知识库');
      const unbound = await app.pool.query<{ agent_id: string }>(
        'select agent_id from agent_servers where server_id = $1',
        [row.serverId],
      );
      await repo.servers.deleteServer(app.db, row.serverId);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'knowledge.base.deleted',
        target: row.id,
        input: { unboundAgents: unbound.rows.map((r) => r.agent_id) },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  // ---- 文件夹 / 标签 ------------------------------------------------------

  app.get(
    '/api/knowledge/bases/:id/folders',
    {
      ...auth,
      schema: {
        params: baseParams,
        querystring: pageQuery,
        response: { 200: z.array(folderSchema) },
      },
    },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id)))
        return notFound(reply, '知识库');
      const page = await repo.knowledge.listFolders(
        app.db,
        request.params.id,
        pageOptions(request.query),
      );
      return page.items.map(toFolder);
    },
  );

  app.post(
    '/api/knowledge/bases/:id/folders',
    { ...auth, schema: { params: baseParams, body: folderCreateSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      const parent = request.body.parentId
        ? await repo.knowledge.getFolder(app.db, request.body.parentId)
        : null;
      if (request.body.parentId && (!parent || parent.baseId !== base.id)) {
        return reject(reply, 'INVALID_INPUT', '父文件夹不存在或属于其他知识库');
      }
      try {
        const row = await repo.knowledge.createFolder(app.db, {
          baseId: base.id,
          parentId: parent?.id ?? null,
          name: request.body.name,
          path: parent ? `${parent.path}/${request.body.name}` : `/${request.body.name}`,
        });
        return reply.status(201).send(toFolder(row));
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '同级下已有同名文件夹');
        throw err;
      }
    },
  );

  app.patch(
    '/api/knowledge/folders/:folderId',
    { ...auth, schema: { params: folderParams, body: folderPatchSchema } },
    async (request, reply) => {
      const current = await repo.knowledge.getFolder(app.db, request.params.folderId);
      if (!current) return notFound(reply, '文件夹');
      try {
        const row =
          (await repo.knowledge.updateFolder(app.db, current.id, request.body)) ?? current;
        return toFolder(row);
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '同级下已有同名文件夹');
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.delete(
    '/api/knowledge/folders/:folderId',
    { ...auth, schema: { params: folderParams } },
    async (request, reply) => {
      if (!(await repo.knowledge.deleteFolder(app.db, request.params.folderId))) {
        return notFound(reply, '文件夹');
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/knowledge/bases/:id/tags',
    { ...auth, schema: { params: baseParams, response: { 200: z.array(tagSchema) } } },
    async (request) => {
      const rows = await repo.knowledge.listTags(app.db, request.params.id);
      return rows.map(toTag);
    },
  );

  app.post(
    '/api/knowledge/bases/:id/tags',
    {
      ...auth,
      schema: { params: baseParams, body: z.object({ name: z.string().trim().min(1).max(64) }) },
    },
    async (request, reply) => {
      if (!(await repo.knowledge.getBase(app.db, request.params.id)))
        return notFound(reply, '知识库');
      const row = await repo.knowledge.upsertTag(app.db, request.params.id, request.body.name);
      return reply.status(201).send(toTag(row));
    },
  );

  app.delete(
    '/api/knowledge/tags/:tagId',
    { ...auth, schema: { params: tagParams } },
    async (request, reply) => {
      if (!(await repo.knowledge.deleteTag(app.db, request.params.tagId)))
        return notFound(reply, '标签');
      return reply.status(204).send();
    },
  );

  // ---- 文档 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/bases/:id/documents',
    { ...auth, schema: { params: baseParams, querystring: documentQuery } },
    async (request) => {
      const { folderId, tag, status, q, ...rest } = request.query;
      const page = await repo.knowledge.listDocuments(app.db, {
        ...pageOptions(rest),
        baseId: request.params.id,
        // 普通列表只放真正文档：FAQ 由 FAQ 面板、Wiki 内部索引由 Wiki 页面负责。
        contentKind: 'document',
        ...(folderId === undefined ? {} : { folderId: folderId === 'null' ? null : folderId }),
        ...(tag === undefined ? {} : { tag }),
        ...(status === undefined ? {} : { status }),
        ...(q === undefined ? {} : { q }),
      });
      const tags = await repo.knowledge.getDocumentTagNames(
        app.db,
        page.items.map((row) => row.id),
      );
      return {
        items: page.items.map((row) => toDocument(row, tags.get(row.id) ?? [])),
        nextCursor: page.nextCursor,
      };
    },
  );

  // 上传走 base64 JSON（避免 multipart 依赖）：先落 blob，再建行，最后入队 ingest。
  app.put(
    '/api/knowledge/bases/:id/documents/upload',
    { ...auth, bodyLimit: UPLOAD_BODY_LIMIT, schema: { params: baseParams, body: uploadSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      const data = decodeBase64(request.body.dataBase64);
      if (!data) return reject(reply, 'INVALID_INPUT', 'dataBase64 不是合法的 base64');
      if (data.length > MAX_UPLOAD_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '文件解码后超过 32MiB 上限');
      }
      // 音频在校验阶段就确定格式与 canonical MIME；任何失败都发生在建目录/blob/行/任务之前。
      let audio: Awaited<ReturnType<typeof inspectKnowledgeAudio>>;
      try {
        audio = await inspectKnowledgeAudio({
          data,
          filename: request.body.filename,
          mimeType: request.body.mimeType,
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      if (audio) {
        if (base.status !== 'active') {
          return reject(reply, 'CONFLICT', '知识库未启用，不能上传音频');
        }
        if (!base.asrProfileId) {
          return reject(reply, 'CONFLICT', '知识库未绑定音频转录模型，不能上传音频');
        }
        const asrProfile = await repo.knowledge.getModelProfileWithSecret(
          app.db,
          base.asrProfileId,
        );
        if (!asrProfile || asrProfile.kind !== 'asr' || !asrProfile.enabled) {
          return reject(reply, 'CONFLICT', '知识库绑定的音频转录模型不存在或已禁用');
        }
      }
      const mimeType = audio?.mimeType ?? request.body.mimeType;
      if (request.body.folderId) {
        const folder = await repo.knowledge.getFolder(app.db, request.body.folderId);
        if (!folder || folder.baseId !== base.id) {
          return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
        }
      }
      let folderId = request.body.folderId;
      let title = request.body.title ?? fileTitle(request.body.filename);
      if (request.body.relativePath !== undefined) {
        const parts = relativePathParts(request.body.relativePath);
        if (!parts) {
          return reject(
            reply,
            'INVALID_INPUT',
            'relativePath 必须是安全的相对路径（不能是绝对路径、.. 或空段）',
          );
        }
        folderId =
          parts.length > 1
            ? await folderForPath(base.id, request.body.folderId, parts.slice(0, -1))
            : request.body.folderId;
        title = request.body.title ?? fileTitle(parts.at(-1)!);
      }
      const sha = await storeBlob(app.config.KNOWLEDGE_DIR, data);
      const document = await repo.knowledge.createDocument(app.db, {
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
          originalFilename: request.body.filename,
          ...(request.body.relativePath === undefined
            ? {}
            : { relativePath: request.body.relativePath }),
        },
      });
      await repo.knowledge.updateDocument(app.db, document.id, { contentHash: sha });
      const job = await enqueue(
        { type: 'ingest', documentId: document.id, publish: 'automatic' },
        { baseId: base.id, documentId: document.id },
      );
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'knowledge.document.uploaded',
        target: document.id,
        input: { filename: request.body.filename, sizeBytes: data.length },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(202).send({ documentId: document.id, jobId: job.id });
    },
  );

  app.get(
    '/api/knowledge/documents/:documentId',
    { ...auth, schema: { params: documentParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      return row ? documentWithTags(row) : notFound(reply, '文档');
    },
  );

  app.patch(
    '/api/knowledge/documents/:documentId',
    { ...auth, schema: { params: documentParams, body: documentPatchSchema } },
    async (request, reply) => {
      const current = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!current) return notFound(reply, '文档');
      const { tags, ...patch } = request.body;
      // 显式启用必须先证明来源授权仍有效；撤权/范围失效的文档只能靠成功同步恢复。
      if (current.status === 'disabled' && patch.status === 'ready' && current.sourceConnectionId) {
        if (!(await sourceScopeAllowsEnable(current.id))) {
          return reject(reply, 'CONFLICT', '来源授权已失效，需成功同步重新确认范围后才能启用');
        }
      }
      if (patch.folderId) {
        const folder = await repo.knowledge.getFolder(app.db, patch.folderId);
        if (!folder || folder.baseId !== current.baseId) {
          return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
        }
      }
      // 重新启用必须仍有当前版本的 chunk，否则检索会指向空文档。
      if (current.status === 'disabled' && patch.status === 'ready') {
        const chunks = current.currentVersionId
          ? await repo.knowledge.listChunkSummaries(app.db, current.currentVersionId, { limit: 1 })
          : null;
        if (!chunks || chunks.items.length === 0) {
          return reject(reply, 'CONFLICT', '当前版本没有可用分块，请先重新摄取');
        }
      }
      const row = await repo.knowledge.updateDocument(app.db, current.id, {
        ...patch,
        // 人工停用写 manual；显式启用在授权已确认后清除停用原因。
        ...(patch.status === 'disabled' ? { disabledReason: 'manual' } : {}),
        ...(patch.status === 'ready' ? { disabledReason: null } : {}),
      });
      if (!row) return notFound(reply, '文档');
      // 文档停用（不再可检索）时，引用它的 Wiki 页必须显式 stale，不能继续装作有效。
      if (patch.status === 'disabled' && current.status !== 'disabled') {
        await repo.knowledge.markWikiStaleByDocument(app.db, row.id);
      }
      if (tags !== undefined) {
        const rows = await repo.knowledge.upsertTags(app.db, current.baseId, tags);
        const idByName = new Map(rows.map((tag) => [tag.name, tag.id]));
        // 重复名原样保留到关联插入，由关联表唯一约束拒绝，不能在此去重换取成功。
        await repo.knowledge.setDocumentTags(
          app.db,
          row.id,
          tags.map((name) => idByName.get(name)!),
        );
      }
      return documentWithTags(row);
    },
  );

  app.delete(
    '/api/knowledge/documents/:documentId',
    { ...auth, schema: { params: documentParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      // 先标 Wiki 引用 stale，再删行（cascade 带走版本/chunk/标签关系）；blob 留给 cleanup。
      const wikiPagesMarkedStale = await repo.knowledge.markWikiStaleByDocument(app.db, row.id);
      await repo.knowledge.deleteDocument(app.db, row.id);
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'knowledge.document.deleted',
        target: row.id,
        input: { wikiPagesMarkedStale },
        status: 'ok',
        requestId: request.id,
      });
      return { wikiPagesMarkedStale };
    },
  );

  app.post(
    '/api/knowledge/documents/:documentId/reprocess',
    { ...auth, schema: { params: documentParams, body: reprocessSchema } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      if (row.status === 'disabled' || row.disabledReason !== null) {
        return reject(
          reply,
          'CONFLICT',
          '文档已停用，不能通过重解析恢复；请先完成来源同步或显式启用',
        );
      }
      if (!row.currentVersionId) return reject(reply, 'CONFLICT', '文档还没有成功解析的版本');
      const manualChunkCount = await repo.knowledge.countEditedChunks(app.db, row.currentVersionId);
      // 重解析新建版本、不继承人工 chunk；未确认时明确拒绝，避免静默丢弃编辑。
      if (manualChunkCount > 0 && !request.body.confirmOverwriteManualChunks) {
        return reject(
          reply,
          'CONFLICT',
          `存在 ${manualChunkCount} 个人工编辑的分块，重解析会丢弃这些修改；请确认后重试`,
        );
      }
      // 人工覆盖确认必须随 job 快照进 worker；只校验不传递会被 worker 当成未确认而跳过。
      const job = await enqueue(
        {
          type: 'reindex',
          baseId: row.baseId,
          documentIds: [row.id],
          chunksOnly: false,
          confirmOverwriteManualChunks: request.body.confirmOverwriteManualChunks,
        },
        { baseId: row.baseId, documentId: row.id },
      );
      return reply.status(202).send({ jobId: job.id });
    },
  );

  // ---- 分块 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/documents/:documentId/chunks',
    {
      ...auth,
      schema: {
        params: documentParams,
        querystring: pageQuery.extend({ versionId: z.string().optional() }),
        response: {
          200: z.object({ items: z.array(chunkSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      const versionId = request.query.versionId ?? row.currentVersionId;
      if (!versionId) return { items: [], nextCursor: null };
      if (versionId !== row.currentVersionId) {
        // 只允许读该文档自己的历史版本；否则能借 documentId 读到别的文档分块。
        const version = await repo.knowledge.getVersion(app.db, versionId);
        if (!version || version.documentId !== row.id) {
          return reject(reply, 'INVALID_INPUT', '版本不存在或不属于该文档');
        }
      }
      const page = await repo.knowledge.listChunkSummaries(
        app.db,
        versionId,
        pageOptions(request.query),
      );
      return { items: page.items.map(toChunk), nextCursor: page.nextCursor };
    },
  );

  /** FAQ/Wiki 的 chunk 是各自语义的投影，直接改会拆掉问答结构与索引版本。 */
  const editableChunkDocument = (document: DocumentRow, reply: FastifyReply): boolean => {
    if (document.contentKind === 'document') return true;
    reject(reply, 'CONFLICT', 'FAQ/Wiki 内部索引不能直接编辑分块，请使用各自入口');
    return false;
  };

  app.post(
    '/api/knowledge/documents/:documentId/chunks',
    { ...auth, schema: { params: documentParams, body: chunkCreateSchema } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      if (!editableChunkDocument(row, reply)) return;
      if (!row.currentVersionId) return reject(reply, 'CONFLICT', '文档还没有可用版本');
      if (request.body.expectedVersionId !== row.currentVersionId) {
        return reject(reply, 'CONFLICT_STALE', '文档版本已变化，请刷新后重试');
      }
      const current = await repo.knowledge.getVersion(app.db, row.currentVersionId);
      if (!current) return reject(reply, 'CONFLICT', '文档当前版本已失效');
      const currentChunks = await collectChunks(current.id);
      const added = {
        kind: request.body.kind,
        heading: request.body.heading,
        content: request.body.content,
        searchText: segmentForSearch(request.body.content),
        embedding: null,
        tokenCount: 0,
        metadata: {},
        enabled: request.body.enabled,
      };
      const markdown = [...currentChunks.map((chunk) => chunk.content), added.content].join('\n\n');
      const versionId = newId('knowledgeVersion');
      const dir = await prepareVersionFiles(row.id, current, versionId, markdown);
      let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
      try {
        result = await repo.knowledge.editDocumentChunks(app.db, {
          documentId: row.id,
          expectedVersionId: request.body.expectedVersionId,
          mutation: { type: 'add', chunk: added },
          preparedVersion: preparedVersionInput(current, versionId, markdown),
        });
      } catch (err) {
        await discardUncommittedVersion(dir, versionId);
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      const jobId = await enqueueChunkReindex(row.baseId, row.id);
      return reply.status(201).send({
        document: await documentWithTags(result.document),
        chunk: result.chunk ? toChunk(result.chunk) : null,
        jobId,
      });
    },
  );

  const currentVersionForChunk = async (
    chunk: Awaited<ReturnType<typeof repo.knowledge.getChunk>> & {},
    expectedVersionId: string,
    reply: FastifyReply,
  ) => {
    const document = await repo.knowledge.getDocument(app.db, chunk.documentId);
    if (!document) {
      notFound(reply, '文档');
      return null;
    }
    if (!editableChunkDocument(document, reply)) return null;
    if (
      !document.currentVersionId ||
      chunk.versionId !== document.currentVersionId ||
      expectedVersionId !== document.currentVersionId
    ) {
      reject(reply, 'CONFLICT_STALE', '只能修改当前版本的分块，请刷新后重试');
      return null;
    }
    const version = await repo.knowledge.getVersion(app.db, document.currentVersionId);
    if (!version) {
      reject(reply, 'CONFLICT', '文档当前版本已失效');
      return null;
    }
    return { document, version };
  };

  app.patch(
    '/api/knowledge/chunks/:chunkId',
    { ...auth, schema: { params: chunkParams, body: chunkPatchSchema } },
    async (request, reply) => {
      const current = await repo.knowledge.getChunk(app.db, request.params.chunkId);
      if (!current) return notFound(reply, '分块');
      const imageMetadata = knowledgeImageChunkMetadataSchema.safeParse(current.metadata);
      if (
        imageMetadata.success &&
        imageMetadata.data.imageRole === 'vector' &&
        (request.body.content !== undefined || request.body.heading !== undefined)
      ) {
        return reject(reply, 'CONFLICT', '图片向量分块只能启停，正文来自原图描述，不能手改');
      }
      const target = await currentVersionForChunk(current, request.body.expectedVersionId, reply);
      if (!target) return;
      const chunks = await collectChunks(target.version.id);
      const index = chunks.findIndex((chunk) => chunk.id === current.id);
      if (index < 0) return notFound(reply, '分块');
      const contentChanged =
        request.body.content !== undefined && request.body.content !== current.content;
      const headingChanged =
        request.body.heading !== undefined && request.body.heading !== current.heading;
      const patch = {
        ...(contentChanged
          ? {
              content: request.body.content!,
              searchText: segmentForSearch(request.body.content!),
              embedding: null,
            }
          : {}),
        ...(headingChanged ? { heading: request.body.heading ?? null } : {}),
        ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
      };
      const nextChunks = chunks.map((chunk) =>
        chunk.id === current.id
          ? {
              content: request.body.content ?? chunk.content,
              heading: headingChanged ? (request.body.heading ?? null) : chunk.heading,
            }
          : chunk,
      );
      const markdown = nextChunks.map((chunk) => chunk.content).join('\n\n');
      const versionId = newId('knowledgeVersion');
      const dir = await prepareVersionFiles(
        target.document.id,
        target.version,
        versionId,
        markdown,
      );
      let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
      try {
        result = await repo.knowledge.editDocumentChunks(app.db, {
          documentId: target.document.id,
          expectedVersionId: request.body.expectedVersionId,
          mutation: { type: 'update', chunkId: current.id, patch },
          preparedVersion: preparedVersionInput(target.version, versionId, markdown),
        });
      } catch (err) {
        await discardUncommittedVersion(dir, versionId);
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      const jobId = contentChanged
        ? await enqueueChunkReindex(target.document.baseId, target.document.id)
        : null;
      return {
        document: await documentWithTags(result.document),
        chunk: result.chunk ? toChunk(result.chunk) : null,
        jobId,
      };
    },
  );

  app.delete(
    '/api/knowledge/chunks/:chunkId',
    { ...auth, schema: { params: chunkParams, body: chunkDeleteSchema } },
    async (request, reply) => {
      const chunk = await repo.knowledge.getChunk(app.db, request.params.chunkId);
      if (!chunk) return notFound(reply, '分块');
      const target = await currentVersionForChunk(chunk, request.body.expectedVersionId, reply);
      if (!target) return;
      const chunks = (await collectChunks(target.version.id)).filter((row) => row.id !== chunk.id);
      const markdown = chunks.map((row) => row.content).join('\n\n');
      const versionId = newId('knowledgeVersion');
      const dir = await prepareVersionFiles(
        target.document.id,
        target.version,
        versionId,
        markdown,
      );
      let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
      try {
        result = await repo.knowledge.editDocumentChunks(app.db, {
          documentId: target.document.id,
          expectedVersionId: request.body.expectedVersionId,
          mutation: { type: 'delete', chunkId: chunk.id },
          preparedVersion: preparedVersionInput(target.version, versionId, markdown),
        });
      } catch (err) {
        await discardUncommittedVersion(dir, versionId);
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      return {
        document: await documentWithTags(result.document),
        chunk: null,
        jobId: null,
      };
    },
  );

  // ---- 版本列表 / 回退 -----------------------------------------------------

  app.get(
    '/api/knowledge/documents/:documentId/versions',
    {
      ...auth,
      schema: {
        params: documentParams,
        querystring: pageQuery,
        response: {
          200: z.object({
            items: z.array(knowledgeDocumentVersionSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const document = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!document) return notFound(reply, '文档');
      const page = await repo.knowledge.listDocumentVersions(
        app.db,
        document.id,
        pageOptions(request.query),
      );
      return {
        items: page.items.map((row) => toDocumentVersion(row, document.currentVersionId)),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    '/api/knowledge/documents/:documentId/rollback',
    { ...auth, schema: { params: documentParams, body: rollbackSchema } },
    async (request, reply) => {
      const document = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!document) return notFound(reply, '文档');
      const version = await repo.knowledge.getVersion(app.db, request.body.versionId);
      // 跨文档版本必须 404，不能让一个 documentId 借到别的文档历史。
      if (!version || version.documentId !== document.id) {
        return reject(reply, 'NOT_FOUND', '版本不存在或不属于该文档');
      }
      const base = await repo.knowledge.getBase(app.db, document.baseId);
      if (!base) return notFound(reply, '知识库');
      if (version.embeddingProfileId !== base.embeddingProfileId) {
        return reject(reply, 'CONFLICT', '该版本来自不同 embedding 空间，需重建后才能切换');
      }
      try {
        const row = await repo.knowledge.activateDocumentVersion(app.db, {
          documentId: document.id,
          versionId: version.id,
          expectedVersionId: request.body.expectedVersionId,
        });
        // 回退到的版本同样是线上发布版：仓储已在切指针同事务写发布标记。
        return documentWithTags(row);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  // ---- 版本内容 -----------------------------------------------------------

  app.get(
    '/api/knowledge/versions/:versionId/content',
    { ...auth, schema: { params: versionParams } },
    async (request, reply) => {
      const version = await repo.knowledge.getVersion(app.db, request.params.versionId);
      if (!version) return notFound(reply, '版本');
      const data = await readFile(
        join(app.config.KNOWLEDGE_DIR, 'blobs', version.blobSha256.slice(0, 2), version.blobSha256),
      ).catch(() => null);
      if (!data) return notFound(reply, '原件');
      return reply
        .header('Content-Type', version.mimeType)
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(version.originalFilename)}`,
        )
        .header('X-Content-Type-Options', 'nosniff')
        .send(data);
    },
  );

  app.get(
    '/api/knowledge/versions/:versionId/markdown',
    { ...auth, schema: { params: versionParams } },
    async (request, reply) => {
      const version = await repo.knowledge.getVersion(app.db, request.params.versionId);
      if (!version) return notFound(reply, '版本');
      const [document, markdown] = await Promise.all([
        repo.knowledge.getDocument(app.db, version.documentId),
        readFile(
          join(app.config.KNOWLEDGE_DIR, 'docs', version.documentId, version.id, 'markdown.md'),
          'utf8',
        ).catch(() => null),
      ]);
      if (markdown === null) return notFound(reply, '解析正文');
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('X-Knowledge-Document-Status', document?.status ?? 'unknown')
        .send(markdown);
    },
  );

  // ---- 检索 / 重建 --------------------------------------------------------

  app.get(
    '/api/knowledge/bases/:id/search',
    { ...auth, schema: { params: baseParams, querystring: searchQuery } },
    async (request, reply) => {
      try {
        return await searchKnowledge(app.db, request.params.id, request.query, {
          secretKey: secretKey(),
        });
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/api/knowledge/bases/:id/rebuild',
    { ...auth, schema: { params: baseParams, body: rebuildSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      const ids = request.body.documentIds ? [...new Set(request.body.documentIds)] : null;
      // reindex 的 documentIds 必须属于该库；否则跨库文档会被按错误 base 重建。
      if (ids && ids.length > 0) {
        const rows = await app.db
          .select({ id: schema.knowledgeDocuments.id })
          .from(schema.knowledgeDocuments)
          .where(
            and(
              eq(schema.knowledgeDocuments.baseId, base.id),
              inArray(schema.knowledgeDocuments.id, ids),
            ),
          );
        if (rows.length !== ids.length) {
          return reject(reply, 'INVALID_INPUT', '存在不属于该知识库的文档');
        }
      }
      // 完整重建会覆盖正文；chunksOnly 只补向量并保留人工修改，不需要确认。
      if (!request.body.chunksOnly && !request.body.confirmOverwriteManualChunks) {
        const [edited] = await app.db
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
          return reject(
            reply,
            'CONFLICT',
            `存在 ${editedCount} 个人工编辑的分块，完整重建会丢弃这些修改；请确认后重试`,
          );
        }
      }
      const job = await enqueue(
        {
          type: 'reindex',
          baseId: base.id,
          ...(request.body.documentIds ? { documentIds: request.body.documentIds } : {}),
          chunksOnly: request.body.chunksOnly,
          confirmOverwriteManualChunks: request.body.confirmOverwriteManualChunks,
        },
        { baseId: base.id, documentId: null },
      );
      return reply.status(202).send({ jobId: job.id });
    },
  );

  // ---- 批量操作 -----------------------------------------------------------

  type BatchResult = {
    documentId: string;
    status: 'succeeded' | 'failed';
    newDocumentId?: string;
    jobId?: string;
    code?: string;
    message?: string;
  };

  const copyDocument = async (document: DocumentRow): Promise<string> => {
    if (document.contentKind === 'wiki') {
      throw new AppError('CONFLICT', 'Wiki 索引文档不能复制为普通文档');
    }
    const version = document.currentVersionId
      ? await repo.knowledge.getVersion(app.db, document.currentVersionId)
      : null;
    if (!version) throw new AppError('CONFLICT', '文档还没有成功解析的版本，无法复制');
    const chunks = await collectChunks(version.id);
    const newDocumentId = newId('knowledgeDocument');
    const newVersionId = newId('knowledgeVersion');
    const sourceDir = join(app.config.KNOWLEDGE_DIR, 'docs', document.id, version.id);
    const targetDir = join(app.config.KNOWLEDGE_DIR, 'docs', newDocumentId, newVersionId);
    await mkdir(targetDir, { recursive: true });
    try {
      const markdown =
        (await readFile(join(sourceDir, 'markdown.md'), 'utf8').catch(() => null)) ??
        chunks.map((chunk) => chunk.content).join('\n\n');
      await writeFile(join(targetDir, 'markdown.md'), markdown, 'utf8');
      // 清单声明了图片就必须真的复制；任一文件缺失时整项失败，不能留下指向坏清单的假成功副本。
      await copyVersionImages(
        join(sourceDir, 'images'),
        join(targetDir, 'images'),
        version.images ?? [],
      );
      const tagNames =
        (await repo.knowledge.getDocumentTagNames(app.db, [document.id])).get(document.id) ?? [];
      await app.db.transaction(async (tx) => {
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
          // 复制是独立人工文档：保留原启停，不继承来源连接与授权。
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
          markdownSha256: sha256(Buffer.from(markdown, 'utf8')),
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
          // 精确版本复制：音频元数据（含段级时码）必须随版本保留，不能重新转录。
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
        if (tagNames.length > 0) {
          const tags = await repo.knowledge.upsertTags(tx, document.baseId, tagNames);
          await tx
            .insert(schema.knowledgeDocumentTags)
            .values(tags.map((tag) => ({ documentId: newDocumentId, tagId: tag.id })));
        }
      });
      return newDocumentId;
    } catch (err) {
      // 失败时连预分配文档目录一起回收，不能留下空文档目录冒充副本。
      await rm(join(app.config.KNOWLEDGE_DIR, 'docs', newDocumentId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      throw err;
    }
  };

  app.post(
    '/api/knowledge/bases/:id/documents/batch',
    { ...auth, schema: { params: baseParams, body: batchSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      const input = request.body;
      if (input.action === 'move') {
        if (input.folderId === undefined) {
          return reject(reply, 'INVALID_INPUT', '移动文档需要 folderId（根目录传 null）');
        }
        if (input.folderId !== null) {
          const folder = await repo.knowledge.getFolder(app.db, input.folderId);
          if (!folder || folder.baseId !== base.id) {
            return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
          }
        }
      }
      if (input.action === 'tag' && (!input.tags || !input.tagMode)) {
        return reject(reply, 'INVALID_INPUT', '批量标签需要 tags 与 tagMode');
      }

      const results: BatchResult[] = [];
      for (const documentId of input.documentIds) {
        const document = await repo.knowledge.getDocument(app.db, documentId);
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
            await repo.knowledge.updateDocument(app.db, document.id, {
              folderId: input.folderId ?? null,
            });
            results.push({ documentId, status: 'succeeded' });
          } else if (input.action === 'copy') {
            results.push({
              documentId,
              status: 'succeeded',
              newDocumentId: await copyDocument(document),
            });
          } else if (input.action === 'tag') {
            const currentNames =
              (await repo.knowledge.getDocumentTagNames(app.db, [document.id])).get(document.id) ??
              [];
            const tags = input.tags ?? [];
            const names =
              input.tagMode === 'replace'
                ? tags
                : input.tagMode === 'remove'
                  ? currentNames.filter((name) => !tags.includes(name))
                  : [...new Set([...currentNames, ...tags])];
            const rows = await repo.knowledge.upsertTags(app.db, base.id, names);
            await repo.knowledge.setDocumentTags(
              app.db,
              document.id,
              rows.map((tag) => tag.id),
            );
            results.push({ documentId, status: 'succeeded' });
          } else if (input.action === 'delete') {
            await repo.knowledge.markWikiStaleByDocument(app.db, document.id);
            await repo.knowledge.deleteDocument(app.db, document.id);
            results.push({ documentId, status: 'succeeded' });
          } else {
            if (document.status === 'disabled' || document.disabledReason !== null) {
              throw new AppError('CONFLICT', '文档已停用，不能通过重解析恢复');
            }
            if (!document.currentVersionId) {
              throw new AppError('CONFLICT', '文档还没有成功解析的版本');
            }
            if (!input.confirmOverwriteManualChunks) {
              const edited = await repo.knowledge.countEditedChunks(
                app.db,
                document.currentVersionId,
              );
              if (edited > 0) {
                throw new AppError(
                  'CONFLICT',
                  `存在 ${edited} 个人工编辑的分块，重解析会丢弃这些修改`,
                );
              }
            }
            const job = await enqueue(
              {
                type: 'reindex',
                baseId: base.id,
                documentIds: [document.id],
                chunksOnly: false,
                confirmOverwriteManualChunks: input.confirmOverwriteManualChunks,
              },
              { baseId: base.id, documentId: document.id },
            );
            results.push({ documentId, status: 'succeeded', jobId: job.id });
          }
        } catch (err) {
          results.push({
            documentId,
            status: 'failed',
            code: isAppError(err) ? err.code : 'INTERNAL_ERROR',
            message: isAppError(err) ? err.message : '操作失败',
          });
          if (!isAppError(err)) app.log.error({ err, documentId }, 'knowledge batch item failed');
        }
      }
      return { results };
    },
  );

  // ---- 任务 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/jobs',
    { ...auth, schema: { querystring: jobQuery } },
    async (request) => {
      const { baseId, status, ...rest } = request.query;
      const page = await repo.knowledge.listJobs(app.db, {
        ...pageOptions(rest),
        ...(baseId === undefined ? {} : { baseId }),
        ...(status === undefined ? {} : { status }),
      });
      return { items: page.items.map(toJob), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/api/knowledge/jobs/:jobId',
    { ...auth, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      return row ? toJob(row) : notFound(reply, '任务');
    },
  );

  // 重试不复用原行：终态只写一次，新行才能真正重新执行。
  app.post(
    '/api/knowledge/jobs/:jobId/retry',
    { ...auth, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      if (!row) return notFound(reply, '任务');
      if (row.status !== 'failed' && row.status !== 'cancelled') {
        return reject(reply, 'CONFLICT', '只有失败或已取消的任务可以重试');
      }
      // schema 已包含输入快照/覆盖确认等字段，重试因此复用原任务语义。
      let retryPayload: KnowledgeJobPayload = knowledgeJobPayloadSchema.parse(row.payload);
      if (retryPayload.type === 'sync') {
        const source = await repo.knowledge.getSource(app.db, retryPayload.sourceId);
        if (!source) return notFound(reply, '来源');
        const [run] = await app.db
          .insert(schema.knowledgeSyncRuns)
          .values({
            id: newId('knowledgeSyncRun'),
            sourceId: source.id,
            status: 'queued',
            cursorBefore: source.cursor,
          })
          .returning();
        if (!run) throw new Error('knowledge sync run insert returned no row');
        retryPayload = { ...retryPayload, syncRunId: run.id };
      }
      // 普通 FAQ 草稿版本由 API 预落库，worker 只补分块、不写 metadata；
      // 重试必须把草稿改绑到新任务：普通草稿写 indexingJobId，批次导入草稿写
      // faqImportJobId，发布守卫（逐条/整批）才能核到这次重试。
      let faqDraftBinding: {
        versionId: string;
        jobKey: 'indexingJobId' | 'faqImportJobId';
      } | null = null;
      if (
        retryPayload.type === 'ingest' &&
        retryPayload.publish === 'draft' &&
        retryPayload.versionId !== undefined
      ) {
        const document = await repo.knowledge.getDocument(app.db, retryPayload.documentId);
        const version = document
          ? await repo.knowledge.getVersion(app.db, retryPayload.versionId)
          : null;
        if (
          document?.contentKind === 'faq' &&
          document.id === row.documentId &&
          document.baseId === row.baseId &&
          version?.documentId === document.id &&
          version.metadata.publication === 'draft'
        ) {
          if (version.metadata.faqImport === undefined) {
            faqDraftBinding = { versionId: version.id, jobKey: 'indexingJobId' };
          } else if (
            knowledgeFaqImportMetadataSchema.safeParse(version.metadata.faqImport).success
          ) {
            faqDraftBinding = { versionId: version.id, jobKey: 'faqImportJobId' };
          }
        }
      }
      if (faqDraftBinding) {
        const { versionId, jobKey } = faqDraftBinding;
        const job = await app.db.transaction(async (tx) => {
          const created = await createJob(tx, {
            baseId: row.baseId,
            documentId: row.documentId,
            sourceId: row.sourceId,
            payload: retryPayload,
          });
          // 只补一个键：faqImport 快照、replaceTargets 等其它 metadata 原样保留。
          const rebind =
            jobKey === 'indexingJobId'
              ? sql`jsonb_build_object('indexingJobId', ${created.id}::text)`
              : sql`jsonb_build_object('faqImportJobId', ${created.id}::text)`;
          const [bound] = await tx
            .update(schema.knowledgeDocumentVersions)
            .set({
              metadata: sql`${schema.knowledgeDocumentVersions.metadata} || ${rebind}`,
            })
            .where(
              and(
                eq(schema.knowledgeDocumentVersions.id, versionId),
                sql`${schema.knowledgeDocumentVersions.metadata} ->> 'publication' = 'draft'`,
                jobKey === 'indexingJobId'
                  ? sql`${schema.knowledgeDocumentVersions.metadata} -> 'faqImport' is null`
                  : sql`${schema.knowledgeDocumentVersions.metadata} -> 'faqImport' is not null`,
              ),
            )
            .returning({ id: schema.knowledgeDocumentVersions.id });
          if (!bound) throw new AppError('CONFLICT', '目标 FAQ 草稿已变化，请刷新后重试');
          return created;
        });
        await enqueueKnowledgeJob(job);
        return reply.status(202).send({ jobId: job.id });
      }
      const job = await enqueue(retryPayload, {
        baseId: row.baseId,
        documentId: row.documentId,
        sourceId: row.sourceId,
      });
      return reply.status(202).send({ jobId: job.id });
    },
  );

  /**
   * 排队中直接写终态；运行中只发 cancel key，等 worker abort 后自己写 cancelled，
   * 不用「先改 DB 再发信号」制造看起来取消成功的假终态。
   */
  app.post(
    '/api/knowledge/jobs/:jobId/cancel',
    { ...auth, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      if (!row) return notFound(reply, '任务');
      if (row.status === 'queued') {
        const cancelled = await repo.knowledge.requestCancel(app.db, row.id);
        if (cancelled) {
          // 排队中取消不会再经过 worker，sync run 必须同一次收尾，否则永久显示进行中。
          const payload = knowledgeJobPayloadSchema.safeParse(cancelled.payload);
          if (payload.success && payload.data.type === 'sync') {
            await repo.knowledge.finishSyncRun(app.db, payload.data.syncRunId, {
              status: 'cancelled',
              error: 'cancelled',
            });
            await repo.knowledge.updateSource(app.db, payload.data.sourceId, {
              lastSyncAt: new Date(),
              lastSyncStatus: 'cancelled',
              lastError: 'cancelled',
            });
          }
          return toJob(cancelled);
        }
        // worker 抢在取消前认领：按运行中处理，别把这次取消当成失败。
        const claimed = await repo.knowledge.getJob(app.db, row.id);
        if (!claimed || claimed.status !== 'running') {
          return reject(reply, 'CONFLICT', '任务已结束，无法取消');
        }
        await publishKnowledgeCancel(claimed.id);
        return toJob(claimed);
      }
      if (row.status !== 'running') return reject(reply, 'CONFLICT', '任务已结束，无法取消');
      await publishKnowledgeCancel(row.id);
      return toJob(row);
    },
  );

  // ---- 模型 profile -------------------------------------------------------

  app.get(
    '/api/knowledge/model-profiles',
    { ...auth, schema: { response: { 200: z.array(profileSchema) } } },
    async () => {
      const rows = await repo.knowledge.listModelProfiles(app.db);
      return rows.map(toProfile);
    },
  );

  app.post(
    '/api/knowledge/model-profiles',
    { ...auth, schema: { body: profileCreateSchema } },
    async (request, reply) => {
      const input = request.body;
      const capabilityProblem = imageCapabilityProblem(input);
      if (capabilityProblem !== null) return reject(reply, 'INVALID_INPUT', capabilityProblem);
      try {
        await assertKnowledgeEndpoint(input.endpointUrl, app.config);
        const row = await repo.knowledge.createModelProfile(app.db, {
          kind: input.kind,
          name: input.name,
          endpointUrl: input.endpointUrl,
          model: input.model,
          embeddingProtocol: input.embeddingProtocol,
          imageInputEnabled: input.imageInputEnabled,
          // 契约固定 1024 维；rerank 没有维度概念。
          dimensions: input.kind === 'embedding' ? 1024 : null,
          secretsEncrypted: input.apiKey
            ? encryptSecrets({ apiKey: input.apiKey }, secretKey())
            : null,
          enabled: input.enabled,
        });
        return reply
          .status(201)
          .send(toProfile({ ...row, hasSecret: row.secretsEncrypted !== null }));
      } catch (err) {
        if (isPgCode(err, '23505')) return reject(reply, 'CONFLICT', '同类型下已有同名 profile');
        throw err;
      }
    },
  );

  app.patch(
    '/api/knowledge/model-profiles/:profileId',
    { ...auth, schema: { params: profileParams, body: profilePatchSchema } },
    async (request, reply) => {
      const { apiKey, ...rest } = request.body;
      if (rest.endpointUrl !== undefined)
        await assertKnowledgeEndpoint(rest.endpointUrl, app.config);
      const current = await repo.knowledge.getModelProfileWithSecret(
        app.db,
        request.params.profileId,
      );
      if (!current) return notFound(reply, '模型 profile');
      if (
        current.kind === 'asr' &&
        rest.embeddingProtocol !== undefined &&
        rest.embeddingProtocol !== 'openai'
      ) {
        return reject(reply, 'INVALID_INPUT', 'ASR profile 固定使用 openai 转录协议');
      }
      const next = {
        kind: current.kind,
        model: rest.model ?? current.model,
        embeddingProtocol: rest.embeddingProtocol ?? current.embeddingProtocol,
        imageInputEnabled: rest.imageInputEnabled ?? current.imageInputEnabled,
      };
      const capabilityProblem = imageCapabilityProblem(next);
      if (capabilityProblem !== null) return reject(reply, 'INVALID_INPUT', capabilityProblem);
      // 被引用后模型/协议/图片能力不可原地更换：同维度也不等于同空间，必须新建 profile 并重建。
      if (
        (rest.model !== undefined && rest.model !== current.model) ||
        (rest.embeddingProtocol !== undefined &&
          rest.embeddingProtocol !== current.embeddingProtocol) ||
        (rest.imageInputEnabled !== undefined &&
          rest.imageInputEnabled !== current.imageInputEnabled)
      ) {
        const referenced = await app.pool.query<{ referenced: boolean }>(
          `select exists(
             select 1 from knowledge_bases where embedding_profile_id = $1
             union all
             select 1 from knowledge_bases where asr_profile_id = $1
             union all
             select 1 from knowledge_document_versions where embedding_profile_id = $1
           ) as referenced`,
          [current.id],
        );
        if (referenced.rows[0]?.referenced) {
          return reject(
            reply,
            'CONFLICT',
            '该 profile 已被知识库引用，不能原地更换模型、协议或图片能力；请新建 profile 后切换并重建',
          );
        }
      }
      const row = await repo.knowledge.updateModelProfile(app.db, request.params.profileId, {
        ...rest,
        ...(apiKey === undefined
          ? {}
          : { secretsEncrypted: apiKey === null ? null : encryptSecrets({ apiKey }, secretKey()) }),
      });
      if (!row) return notFound(reply, '模型 profile');
      return toProfile({ ...row, hasSecret: row.secretsEncrypted !== null });
    },
  );

  app.delete(
    '/api/knowledge/model-profiles/:profileId',
    { ...auth, schema: { params: profileParams } },
    async (request, reply) => {
      try {
        const result = await app.pool.query('delete from knowledge_model_profiles where id = $1', [
          request.params.profileId,
        ]);
        if (result.rowCount === 0) return notFound(reply, '模型 profile');
        return reply.status(204).send();
      } catch (err) {
        // 仍被引用时外键走 RESTRICT：23001=restrict_violation，23503=foreign_key_violation。
        if (isPgCode(err, '23001') || isPgCode(err, '23503')) {
          return reject(reply, 'CONFLICT', '该 profile 仍被知识库使用，请先切换或删除知识库');
        }
        throw err;
      }
    },
  );

  // 只发一次最小请求验证凭证/维度；不落 job，也不改 profile。
  app.post(
    '/api/knowledge/model-profiles/:profileId/test',
    { ...auth, schema: { params: profileParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getModelProfileWithSecret(app.db, request.params.profileId);
      if (!row) return notFound(reply, '模型 profile');
      // ASR 没有免费探针：不静音上传、不联网、不计费，验证走显式音频上传。
      if (row.kind === 'asr') {
        return reject(reply, 'CONFLICT', 'ASR 请通过显式音频上传验证');
      }
      // 存量数据也要过同一道边界，测试端点不能成为访问内网的跳板。
      try {
        await assertKnowledgeEndpoint(row.endpointUrl, app.config);
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
      const apiKey = row.secretsEncrypted
        ? decryptSecrets(row.secretsEncrypted, secretKey()).apiKey
        : undefined;
      try {
        if (row.kind === 'embedding') {
          const embeddingProfile = {
            endpointUrl: row.endpointUrl,
            model: row.model,
            dimensions: 1024 as const,
            embeddingProtocol: row.embeddingProtocol,
            imageInputEnabled: row.imageInputEnabled,
            ...(apiKey ? { apiKey } : {}),
          };
          await embedTexts(embeddingProfile, ['ping'], undefined, 'search_query');
          // 声明图片能力的 profile 必须真的接受图片；只测文本不算证明。
          if (row.imageInputEnabled) {
            await embedImages(embeddingProfile, [
              { mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 },
            ]);
          }
        } else {
          await rerankDocuments(
            { endpointUrl: row.endpointUrl, model: row.model, ...(apiKey ? { apiKey } : {}) },
            'ping',
            ['pong'],
          );
        }
        return { ok: true };
      } catch (err) {
        if (err instanceof KnowledgeModelError) return { ok: false, kind: err.kind };
        throw err;
      }
    },
  );
}
