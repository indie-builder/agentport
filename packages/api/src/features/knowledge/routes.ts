import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  decryptSecrets,
  embedImages,
  embedTexts,
  encryptSecrets,
  KnowledgeModelError,
  rerankDocuments,
  segmentForSearch,
} from '@agentport/core';
import { repo, schema } from '@agentport/db';
import type { KnowledgeBaseSettings } from '@agentport/shared';
import {
  httpUrlSchema,
  knowledgeBaseInputSchema,
  knowledgeBaseSettingsSchema,
  knowledgeChunkKindSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeJobPayloadSchema,
  knowledgeModelProfileSelectionSchema,
} from '@agentport/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isAppError, isPgCode, reject } from '../../plugins/errors.js';
import { publishKnowledgeCancel } from '../../queue/producer.js';
import { typed } from '../../types.js';
import { actorOf } from '../access.js';
import { assertSafeUrl } from '../servers/ssrf.js';
import { searchKnowledge } from './retrieval.js';
import { createJob, enqueueKnowledgeJob, ensureKnowledgeServer } from './service.js';

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
const profileListQuery = z.object({ view: z.literal('selection').optional() });

const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** 创建时缺省整块补齐；更新时只合并传入字段，不能把没传的 imageProcessing 重置成默认值。 */
const baseCreateSchema = knowledgeBaseInputSchema.extend({
  embeddingProfileId: z.string().min(1),
  rerankProfileId: z.string().min(1).nullable().default(null),
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
  versionId: z.string().min(1).optional(),
  kind: z.enum(['text', 'table', 'image']).default('text'),
  heading: z.string().max(300).nullable().default(null),
  content: z.string().min(1).max(100_000),
  enabled: z.boolean().default(true),
  pageFrom: z.number().int().nullable().default(null),
  pageTo: z.number().int().nullable().default(null),
});
const chunkPatchSchema = z.object({
  content: z.string().min(1).max(100_000).optional(),
  heading: z.string().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});

const rebuildSchema = z.object({
  documentIds: z.array(z.string().min(1)).optional(),
  chunksOnly: z.boolean().default(false),
});
const reprocessSchema = z.object({ confirmOverwriteManualChunks: z.boolean().default(false) });

/** querystring 一律字符串：folders/tags 用逗号分隔，与浏览器可构造的 URL 形状一致。 */
const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  folders: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : [])),
  tags: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : [])),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  rerank: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

const profileCreateSchema = z.object({
  kind: z.enum(['embedding', 'rerank']),
  name: z.string().trim().min(1).max(120),
  endpointUrl: httpUrlSchema,
  model: z.string().trim().min(1).max(200),
  embeddingProtocol: z.enum(['openai', 'cohere_v2']).default('openai'),
  imageInputEnabled: z.boolean().default(false),
  apiKey: z.string().min(1).max(500).optional(),
  enabled: z.boolean().default(true),
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
  documentId: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
});

const chunkSchema = z.object({
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
  kind: z.enum(['embedding', 'rerank']),
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
type RawJobRow = NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>;
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
    settings: row.settings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocument(row: DocumentRow, tags: string[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    folderId: row.folderId,
    title: row.title,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    sourcePath: row.sourcePath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    currentVersionId: row.currentVersionId,
    tags,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toChunk(row: ChunkRow) {
  return {
    id: row.id,
    documentId: row.documentId,
    versionId: row.versionId,
    ordinal: row.ordinal,
    kind: row.kind,
    heading: row.heading,
    content: row.content,
    enabled: row.enabled,
    editedByUser: row.editedByUser,
    pageFrom: row.pageFrom,
    pageTo: row.pageTo,
    metadata: row.metadata,
  };
}

/** 列表带关联名字；单任务读取不额外查名字，保持 null。 */
function toJob(row: JobRow | RawJobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    step: row.step,
    progress: row.progress,
    attempts: row.attempts,
    error: row.error,
    documentId: row.documentId,
    sourceId: row.sourceId,
    documentTitle: 'documentTitle' in row ? row.documentTitle : null,
    sourceName: 'sourceName' in row ? row.sourceName : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
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

function toProfile(row: ProfileRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
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
  kind: 'embedding' | 'rerank';
  model: string;
  embeddingProtocol: 'openai' | 'cohere_v2';
  imageInputEnabled: boolean;
}): string | null {
  if (!input.imageInputEnabled) return null;
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

  // ---- 知识库 -------------------------------------------------------------

  app.get(
    '/api/knowledge/bases',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { querystring: pageQuery } },
    async (request) => {
      const page = await repo.knowledge.listBases(app.db, pageOptions(request.query));
      return { items: page.items.map(toBase), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/api/knowledge/bases',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.create' } }, schema: { body: baseCreateSchema } },
    async (request, reply) => {
      const input = request.body;
      const [embedding, rerank] = await Promise.all([
        repo.knowledge.getModelProfileWithSecret(app.db, input.embeddingProfileId),
        input.rerankProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, input.rerankProfileId)
          : null,
      ]);
      if (!embedding || embedding.kind !== 'embedding' || !embedding.enabled) {
        return reject(reply, 'INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
      }
      if (input.rerankProfileId && (!rerank || rerank.kind !== 'rerank' || !rerank.enabled)) {
        return reject(reply, 'INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
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
          settings: input.settings,
        });
        await ensureKnowledgeServer(app.db, { slug: row.slug, id: row.id, serverId: server.id });
        await writeAudit(app.db, request.log, {
          actor: actorOf(request),
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: baseParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getBase(app.db, request.params.id);
      return row ? toBase(row) : notFound(reply, '知识库');
    },
  );

  app.patch(
    '/api/knowledge/bases/:id',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.update' } }, schema: { params: baseParams, body: basePatchSchema } },
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
      const [embedding, rerank] = await Promise.all([
        repo.knowledge.getModelProfileWithSecret(app.db, nextEmbeddingProfileId),
        nextRerankProfileId
          ? repo.knowledge.getModelProfileWithSecret(app.db, nextRerankProfileId)
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.delete' } }, schema: { params: baseParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getBase(app.db, request.params.id);
      if (!row) return notFound(reply, '知识库');
      const unbound = await app.pool.query<{ agent_id: string }>(
        'select agent_id from agent_servers where server_id = $1',
        [row.serverId],
      );
      await repo.servers.deleteServer(app.db, row.serverId);
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: baseParams, body: folderCreateSchema } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: folderParams, body: folderPatchSchema } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: folderParams } },
    async (request, reply) => {
      if (!(await repo.knowledge.deleteFolder(app.db, request.params.folderId))) {
        return notFound(reply, '文件夹');
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/knowledge/bases/:id/tags',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: baseParams, response: { 200: z.array(tagSchema) } } },
    async (request) => {
      const rows = await repo.knowledge.listTags(app.db, request.params.id);
      return rows.map(toTag);
    },
  );

  app.post(
    '/api/knowledge/bases/:id/tags',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: tagParams } },
    async (request, reply) => {
      if (!(await repo.knowledge.deleteTag(app.db, request.params.tagId)))
        return notFound(reply, '标签');
      return reply.status(204).send();
    },
  );

  // ---- 文档 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/bases/:id/documents',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: baseParams, querystring: documentQuery } },
    async (request) => {
      const { folderId, tag, status, q, ...rest } = request.query;
      const page = await repo.knowledge.listDocuments(app.db, {
        ...pageOptions(rest),
        baseId: request.params.id,
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, bodyLimit: UPLOAD_BODY_LIMIT, schema: { params: baseParams, body: uploadSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      if (request.body.folderId) {
        const folder = await repo.knowledge.getFolder(app.db, request.body.folderId);
        if (!folder || folder.baseId !== base.id) {
          return reject(reply, 'INVALID_INPUT', '文件夹不存在或属于其他知识库');
        }
      }
      const data = decodeBase64(request.body.dataBase64);
      if (!data) return reject(reply, 'INVALID_INPUT', 'dataBase64 不是合法的 base64');
      if (data.length > MAX_UPLOAD_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '文件解码后超过 32MiB 上限');
      }
      const sha = await storeBlob(app.config.KNOWLEDGE_DIR, data);
      const document = await repo.knowledge.createDocument(app.db, {
        baseId: base.id,
        folderId: request.body.folderId,
        title: request.body.title ?? fileTitle(request.body.filename),
        sourceType: 'upload',
        sourceId: null,
        sourceUrl: null,
        sourcePath: null,
        mimeType: request.body.mimeType,
        sizeBytes: data.length,
        metadata: { originalFilename: request.body.filename },
      });
      await repo.knowledge.updateDocument(app.db, document.id, { contentHash: sha });
      const job = await enqueue(
        { type: 'ingest', documentId: document.id },
        { baseId: base.id, documentId: document.id },
      );
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: documentParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      return row ? documentWithTags(row) : notFound(reply, '文档');
    },
  );

  app.patch(
    '/api/knowledge/documents/:documentId',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: documentParams, body: documentPatchSchema } },
    async (request, reply) => {
      const current = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!current) return notFound(reply, '文档');
      const { tags, ...patch } = request.body;
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
      const row = await repo.knowledge.updateDocument(app.db, current.id, patch);
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: documentParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      // 先标 Wiki 引用 stale，再删行（cascade 带走版本/chunk/标签关系）；blob 留给 cleanup。
      const wikiPagesMarkedStale = await repo.knowledge.markWikiStaleByDocument(app.db, row.id);
      await repo.knowledge.deleteDocument(app.db, row.id);
      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } }, schema: { params: documentParams, body: reprocessSchema } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
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
      const job = await enqueue(
        { type: 'reindex', baseId: row.baseId, documentIds: [row.id], chunksOnly: false },
        { baseId: row.baseId, documentId: row.id },
      );
      return reply.status(202).send({ jobId: job.id });
    },
  );

  // ---- 分块 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/documents/:documentId/chunks',
    {
      config: { access: { kind: 'permission', permissionId: 'knowledge.read' } },
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

  app.post(
    '/api/knowledge/documents/:documentId/chunks',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: documentParams, body: chunkCreateSchema } },
    async (request, reply) => {
      const row = await repo.knowledge.getDocument(app.db, request.params.documentId);
      if (!row) return notFound(reply, '文档');
      const versionId = request.body.versionId ?? row.currentVersionId;
      if (!versionId) return reject(reply, 'CONFLICT', '文档还没有可用版本');
      // 版本必须属于该文档，否则能往别的文档版本里塞 chunk。
      const version = await repo.knowledge.getVersion(app.db, versionId);
      if (!version || version.documentId !== row.id) {
        return reject(reply, 'INVALID_INPUT', '版本不存在或不属于该文档');
      }
      const ordinal = await repo.knowledge.nextChunkOrdinal(app.db, versionId);
      const [chunk] = await repo.knowledge.insertChunks(app.db, {
        baseId: row.baseId,
        documentId: row.id,
        versionId,
        folderId: row.folderId,
        chunks: [
          {
            ordinal,
            kind: request.body.kind,
            heading: request.body.heading,
            content: request.body.content,
            searchText: segmentForSearch(request.body.content),
            embedding: null,
            pageFrom: request.body.pageFrom,
            pageTo: request.body.pageTo,
            tokenCount: 0,
          },
        ],
      });
      if (!chunk) return reject(reply, 'INTERNAL_ERROR', '分块写入失败');
      // 人工新增的分块没有向量；补向量与修改正文共用 chunksOnly 通道。
      const job = await enqueue(
        { type: 'reindex', baseId: row.baseId, documentIds: [row.id], chunksOnly: true },
        { baseId: row.baseId, documentId: row.id },
      );
      return reply.status(201).send({ ...toChunk(chunk), jobId: job.id });
    },
  );

  app.patch(
    '/api/knowledge/chunks/:chunkId',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: chunkParams, body: chunkPatchSchema } },
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
      const patch: Partial<repo.knowledge.ChunkPatch> = {};
      if (request.body.heading !== undefined) patch.heading = request.body.heading;
      if (request.body.enabled !== undefined) patch.enabled = request.body.enabled;
      if (request.body.content !== undefined) {
        patch.content = request.body.content;
        // search_text 与向量都依赖正文：改了正文就重算分词、清空向量并等补向量。
        patch.searchText = segmentForSearch(request.body.content);
        patch.embedding = null;
        patch.editedByUser = true;
      }
      const row = await repo.knowledge.patchChunk(app.db, request.params.chunkId, patch);
      if (!row) return notFound(reply, '分块');
      // 来源分块被禁用后，引用它的 Wiki 页同样要显式 stale。
      if (patch.enabled === false) {
        await repo.knowledge.markWikiStaleByDocument(app.db, row.documentId);
      }
      if (request.body.content !== undefined) {
        await enqueue(
          { type: 'reindex', baseId: row.baseId, documentIds: [row.documentId], chunksOnly: true },
          { baseId: row.baseId, documentId: row.documentId },
        );
      }
      return toChunk(row);
    },
  );

  app.delete(
    '/api/knowledge/chunks/:chunkId',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.content.manage' } }, schema: { params: chunkParams } },
    async (request, reply) => {
      const chunk = await repo.knowledge.getChunk(app.db, request.params.chunkId);
      if (!chunk) return notFound(reply, '分块');
      await repo.knowledge.deleteChunk(app.db, chunk.id);
      // 删除来源分块同样撤销了引用它的 Wiki 页的有效性。
      await repo.knowledge.markWikiStaleByDocument(app.db, chunk.documentId);
      return reply.status(204).send();
    },
  );

  // ---- 版本内容 -----------------------------------------------------------

  app.get(
    '/api/knowledge/versions/:versionId/content',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: versionParams } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: versionParams } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } }, schema: { params: baseParams, querystring: searchQuery } },
    async (request, reply) => {
      try {
        const result = await searchKnowledge(app.db, request.params.id, request.query, {
          secretKey: secretKey(),
        });
        return { hits: result.hits, degraded: result.degraded };
      } catch (err) {
        if (isAppError(err)) return reject(reply, err.code, err.message);
        throw err;
      }
    },
  );

  app.post(
    '/api/knowledge/bases/:id/rebuild',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } }, schema: { params: baseParams, body: rebuildSchema } },
    async (request, reply) => {
      const base = await repo.knowledge.getBase(app.db, request.params.id);
      if (!base) return notFound(reply, '知识库');
      // reindex 的 documentIds 必须属于该库；否则跨库文档会被按错误 base 重建。
      if (request.body.documentIds && request.body.documentIds.length > 0) {
        const ids = [...new Set(request.body.documentIds)];
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
      const job = await enqueue(
        {
          type: 'reindex',
          baseId: base.id,
          ...(request.body.documentIds ? { documentIds: request.body.documentIds } : {}),
          chunksOnly: request.body.chunksOnly,
        },
        { baseId: base.id, documentId: null },
      );
      return reply.status(202).send({ jobId: job.id });
    },
  );

  // ---- 任务 ---------------------------------------------------------------

  app.get(
    '/api/knowledge/jobs',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { querystring: jobQuery } },
    async (request) => {
      const { baseId, documentId, status, ...rest } = request.query;
      const page = await repo.knowledge.listJobs(app.db, {
        ...pageOptions(rest),
        ...(baseId === undefined ? {} : { baseId }),
        ...(documentId === undefined ? {} : { documentId }),
        ...(status === undefined ? {} : { status }),
      });
      return { items: page.items.map(toJob), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/api/knowledge/jobs/:jobId',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.read' } }, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      return row ? toJob(row) : notFound(reply, '任务');
    },
  );

  // 重试不复用原行：终态只写一次，新行才能真正重新执行。
  app.post(
    '/api/knowledge/jobs/:jobId/retry',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } }, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      if (!row) return notFound(reply, '任务');
      if (row.status !== 'failed' && row.status !== 'cancelled') {
        return reject(reply, 'CONFLICT', '只有失败或已取消的任务可以重试');
      }
      const payload = knowledgeJobPayloadSchema.parse(row.payload);
      // 同步重试是一次新同步：新建 run 才能保留旧 run 的历史，不能覆写。
      if (payload.type === 'sync') {
        const created = await repo.knowledge.createSyncJob(app.db, payload.sourceId);
        if (created.status === 'not_found') return notFound(reply, '来源');
        if (created.status === 'not_active') {
          return reject(reply, 'CONFLICT', '来源未启用，无法同步');
        }
        if (created.status === 'in_progress') {
          return reject(reply, 'CONFLICT', '该来源已有同步任务在进行中');
        }
        await enqueueKnowledgeJob(created.job);
        return reply.status(202).send({ jobId: created.job.id });
      }
      const job = await enqueue(payload, {
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.execute' } }, schema: { params: jobParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getJob(app.db, request.params.jobId);
      if (!row) return notFound(reply, '任务');
      if (row.status === 'queued') {
        // 排队中取消不会再经过 worker：job/run/source 摘要必须一次原子提交。
        const cancelled = await repo.knowledge.finishJob(app.db, row.id, {
          fromStatus: 'queued',
          status: 'cancelled',
          error: 'cancelled',
        });
        if (cancelled) return toJob(cancelled);
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

  /**
   * 同一个 URL 两种形状：管理列表要 manage，选择投影只要 read。
   * 权限在 preHandler 里按已校验的 view 选择，不能给 read 暴露管理端点。
   */
  app.get(
    '/api/knowledge/model-profiles',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        querystring: profileListQuery,
        response: {
          200: z.union([
            z.array(profileSchema),
            z.array(knowledgeModelProfileSelectionSchema),
          ]),
        },
      },
      preHandler: async (request, reply) => {
        const { view } = request.query as { view?: 'selection' | undefined };
        await app
          .requirePermission(view === 'selection' ? 'knowledge.read' : 'knowledge.models.manage')
          .call(app, request, reply, () => undefined);
      },
    },
    async (request) => {
      const rows = await repo.knowledge.listModelProfiles(app.db);
      if (request.query.view !== 'selection') return rows.map(toProfile);
      // 显式挑 5 个字段：端点、模型、协议、密钥与时间戳都不属于选择投影。
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        supportsImageVectors: row.kind === 'embedding' && supportsImageVectors(row),
      }));
    },
  );

  app.post(
    '/api/knowledge/model-profiles',
    { config: { access: { kind: 'permission', permissionId: 'knowledge.models.manage' } }, schema: { body: profileCreateSchema } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.models.manage' } }, schema: { params: profileParams, body: profilePatchSchema } },
    async (request, reply) => {
      const { apiKey, ...rest } = request.body;
      if (rest.endpointUrl !== undefined)
        await assertKnowledgeEndpoint(rest.endpointUrl, app.config);
      const current = await repo.knowledge.getModelProfileWithSecret(
        app.db,
        request.params.profileId,
      );
      if (!current) return notFound(reply, '模型 profile');
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.models.manage' } }, schema: { params: profileParams } },
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
    { config: { access: { kind: 'permission', permissionId: 'knowledge.models.manage' } }, schema: { params: profileParams } },
    async (request, reply) => {
      const row = await repo.knowledge.getModelProfileWithSecret(app.db, request.params.profileId);
      if (!row) return notFound(reply, '模型 profile');
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
