import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { embedImages, embedTexts, KnowledgeModelError, segmentForSearch } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import type { KnowledgeImageProcessing } from '@agentport/shared';
import {
  knowledgeBaseSettingsSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeJobPayloadSchema,
} from '@agentport/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { describeKnowledgeImage, type ImageQueryFn } from './image-processing.js';
import { KnowledgeParseError } from './parsing.js';
import { SourceAuthError } from './sources.js';

// 契约 §6.3：解析/分块与来源适配由 sources.ts / parsing.ts 实现，本模块只依赖这些形状。
type KnowledgeDocumentRow = typeof schema.knowledgeDocuments.$inferSelect;
type KnowledgeJobRow = typeof schema.knowledgeJobs.$inferSelect;
type KnowledgeSourceRow = typeof schema.knowledgeSources.$inferSelect;
type KnowledgeBaseRow = typeof schema.knowledgeBases.$inferSelect;

/** 自动建的唯一索引页；后续文档复用同一页，不按文档各建一页。 */
const OVERVIEW_SLUG = 'overview';
const OVERVIEW_TITLE = '知识库概览';
const OVERVIEW_INSTRUCTION =
  '这是知识库的索引页：概括知识库主题与主要文档，给出推荐阅读顺序；只为实际检索到的当前内容建立引用。';

export interface WikiUpdateInput {
  baseId: string;
  /** 已落库、待投递到独立 knowledge 队列的 wiki_generate 任务。 */
  jobIds: string[];
}

export interface ParsedImage {
  name: string;
  data: Uint8Array;
  mimeType: string;
  page: number;
}

export interface ParsedDocument {
  markdown: string;
  images: ParsedImage[];
  pageMap: Array<{ page: number; startOffset: number; endOffset: number }>;
}

export interface ChunkDraft {
  kind: 'text' | 'table' | 'image';
  heading: string | null;
  content: string;
  pageFrom: number | null;
  pageTo: number | null;
  /** 图片子块（ocr/caption/vector）的定位；普通块为空。 */
  metadata?: Record<string, unknown>;
  /** 仅 imageRole=vector：该 chunk 只做图片向量检索，不进关键词索引。 */
  searchText?: string;
  /** 图片向量已在生成阶段算好；其余 draft 由文字 embedding 统一填充。null = 留待 chunksOnly 补。 */
  embedding?: number[] | null;
}

export interface SourceItem {
  sourceId: string;
  sourceUrl: string | null;
  sourcePath: string | null;
  title: string;
  mimeType: string;
  revision: string;
  content: Buffer | { markdown: string };
  /** Remote item is gone; only trusted from a connector whose listing was complete. */
  deleted?: boolean;
}

/**
 * 一次检查点：其中 `complete` 表示到此刻为止的枚举已证明「没返回的都删除了」。
 * RSS 这类滚动窗口的读取永不 complete。
 */
export interface SourceCheckpoint {
  complete: boolean;
}

/** 连接器的出站网络策略；只能由部署配置提供，来源 config 无法设置。 */
export interface ConnectorNetwork {
  /** KNOWLEDGE_PRIVATE_HOST_ALLOWLIST 解析后的精确 `host`/`host:port`。 */
  trustedHosts?: readonly string[];
  /** 本地 fixture 仅用；sources 在 production 下仍拒绝 loopback。 */
  allowLoopback?: boolean;
}

export interface KnowledgeConnector {
  sync(input: {
    /** 来源连接 ID：外部条目 ID 必须 scope 到它，两个连接读到同一外部 ID 才不会互撞。 */
    connectionId: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    ranges: Array<{ kind: string; externalId: string; ref: string | null; paths: string[] }>;
    cursor: Record<string, unknown>;
    signal: AbortSignal;
    network?: ConnectorNetwork;
    onCheckpoint(cursor: Record<string, unknown>, checkpoint: SourceCheckpoint): Promise<void>;
  }): AsyncIterable<SourceItem>;
}

export interface KnowledgeDeps {
  db: Database;
  logger: Logger;
  knowledgeDir: string;
  parse: (input: {
    filename: string;
    mimeType: string;
    data: Buffer;
    signal?: AbortSignal;
  }) => Promise<ParsedDocument>;
  chunkMarkdown: (
    markdown: string,
    pageMap: ParsedDocument['pageMap'],
    options: { chunkTokens: number; overlap: number },
  ) => ChunkDraft[];
  connectors: Partial<Record<KnowledgeSourceRow['type'], KnowledgeConnector>>;
  /** 解密来源/模型凭证；与 API 共用 APP_SECRET_KEY。 */
  decrypt: (payload: string) => Record<string, string>;
  /**
   * wikiAutoUpdate 开启时，版本切换成功后为关联页面投递 wiki_generate 草稿任务。
   * 由主会话队列注入（保持单例 Redis）；不注入时只标 stale，绝不假装自动更新成功。
   */
  onWikiUpdate?: (input: WikiUpdateInput) => Promise<void>;
  /** KNOWLEDGE_PRIVATE_HOST_ALLOWLIST 解析后的精确 `host`/`host:port`；由部署配置注入。 */
  trustedHosts?: readonly string[];
  /** 本地 fixture 仅用；sources 在 production 下仍拒绝 loopback。 */
  allowLoopback?: boolean;
  /** 图片 OCR/描述走官方 query；worker 真实运行默认 query，测试注入替身。 */
  imageQueryFn?: ImageQueryFn;
}

const EMBED_BATCH = 32;
const SYNC_CHECKPOINT_ITEMS = 50;
const SYNC_CHECKPOINT_MS = 30_000;
const BLOB_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 仓库列表单页上限就是 200；分页循环按此翻到末尾，不能只取首页。 */
const LIST_PAGE_SIZE = 200;

/** timeout/rate_limit/unavailable 值得重试；auth 与 bad_response 重试也不会变好。 */
const RETRYABLE = new Set(['timeout', 'rate_limit', 'unavailable']);

/** 解析服务的临时故障可重试；格式不支持、输入非法与部分成功不重试。 */
const RETRYABLE_PARSE = new Set([
  'parser_unavailable',
  'upstream_http',
  'upstream_failure',
  'aborted',
]);

export function isRetryableKnowledgeError(err: unknown): boolean {
  if (err instanceof KnowledgeModelError) return RETRYABLE.has(err.kind);
  if (err instanceof KnowledgeParseError) return RETRYABLE_PARSE.has(err.code);
  return false;
}

export function describeKnowledgeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const kind =
    err instanceof KnowledgeModelError
      ? `${err.kind}: `
      : err instanceof KnowledgeParseError
        ? `parse_${err.code}: `
        : '';
  return `${kind}${message}`.slice(0, 500);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class KnowledgeCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** 版本与库 profile 不同一：补缺失向量会把新模型向量混进旧版本，只能完整重建。 */
class KnowledgeProfileMismatch extends Error {}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new KnowledgeCancelled();
}

// ---------------------------------------------------------------------------
// 存储布局（契约 §3）

function blobPath(knowledgeDir: string, sha: string): string {
  return join(knowledgeDir, 'blobs', sha.slice(0, 2), sha);
}

function versionDir(knowledgeDir: string, documentId: string, versionId: string): string {
  return join(knowledgeDir, 'docs', documentId, versionId);
}

/** 先写临时文件再原子 rename；同内容复用同一 blob。 */
async function storeBlob(knowledgeDir: string, data: Buffer): Promise<string> {
  const sha = sha256(data);
  const target = blobPath(knowledgeDir, sha);
  const existing = await stat(target).catch(() => null);
  if (existing) return sha;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${newId('knowledgeJob')}`;
  await writeFile(temp, data);
  await rename(temp, target);
  return sha;
}

async function writeParsed(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
  parsed: ParsedDocument,
): Promise<void> {
  const dir = versionDir(knowledgeDir, documentId, versionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'markdown.md'), parsed.markdown, 'utf8');
  if (parsed.images.length === 0) return;
  const imageDir = join(dir, 'images');
  await mkdir(imageDir, { recursive: true });
  for (const image of parsed.images) await writeFile(join(imageDir, image.name), image.data);
}

// ---------------------------------------------------------------------------
// embedding

interface EmbeddingClient {
  profileId: string;
  /** 同空间图片向量能力：cohere_v2 + embed-v4.0 + profile 显式开启。 */
  imageVectors: boolean;
  embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
  embedImage: (
    image: { mimeType: string; dataBase64: string },
    signal?: AbortSignal,
  ) => Promise<number[]>;
}

async function embeddingClient(deps: KnowledgeDeps, profileId: string): Promise<EmbeddingClient> {
  const profile = await repo.knowledge.getModelProfileWithSecret(deps.db, profileId);
  if (profile?.kind !== 'embedding' || !profile.enabled) {
    throw new Error('embedding profile 不可用');
  }
  const apiKey = profile.secretsEncrypted
    ? deps.decrypt(profile.secretsEncrypted).apiKey
    : undefined;
  const settings = {
    endpointUrl: profile.endpointUrl,
    model: profile.model,
    dimensions: 1024 as const,
    ...(apiKey ? { apiKey } : {}),
    embeddingProtocol: profile.embeddingProtocol,
    imageInputEnabled: profile.imageInputEnabled,
  };
  return {
    profileId: profile.id,
    imageVectors:
      profile.embeddingProtocol === 'cohere_v2' &&
      profile.model === 'embed-v4.0' &&
      profile.imageInputEnabled,
    embed: (texts, signal) => embedTexts(settings, texts, signal),
    embedImage: async (image, signal) => {
      const [vector] = await embedImages(settings, [image], signal);
      if (!vector) throw new Error('图片向量返回为空');
      return vector;
    },
  };
}

async function embedAll(
  client: EmbeddingClient,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    checkAborted(signal);
    vectors.push(...(await client.embed(texts.slice(start, start + EMBED_BATCH), signal)));
  }
  return vectors;
}

async function setStep(
  deps: KnowledgeDeps,
  jobId: string,
  step: string,
  progress: number,
): Promise<void> {
  await deps.db
    .update(schema.knowledgeJobs)
    .set({ step, progress })
    .where(and(eq(schema.knowledgeJobs.id, jobId), eq(schema.knowledgeJobs.status, 'running')));
}

// ---------------------------------------------------------------------------
// 单文档摄取：解析 → 分块 → embedding → 落版本与 chunk → 原子切版本

/**
 * 版本切换成功后联动 Wiki：关联页先标 stale（已发布内容与 currentVersionId 不动），
 * 仅当 wikiAutoUpdate 开启且注入了队列回调时才投递 wiki_generate 草稿任务；
 * 没有回调就只标 stale 并记 warn，不假装自动更新已触发。
 * 首个文档且库里还没有任何 Wiki 页时才建唯一索引页，之后复用，不按文档各建一页。
 */
async function linkWikiAfterIngest(
  deps: KnowledgeDeps,
  base: KnowledgeBaseRow,
  document: KnowledgeDocumentRow,
): Promise<void> {
  const linked = await deps.db
    .select({ pageId: schema.knowledgeWikiSources.pageId })
    .from(schema.knowledgeWikiSources)
    .where(eq(schema.knowledgeWikiSources.documentId, document.id));
  if (linked.length > 0) await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
  if (!base.settings.wikiAutoUpdate) return;
  if (!deps.onWikiUpdate) {
    deps.logger.warn(
      { baseId: base.id, documentId: document.id },
      'wikiAutoUpdate 已开启但 worker 未注入 onWikiUpdate，仅标记 stale',
    );
    return;
  }

  const related = new Set(linked.map((row) => row.pageId));
  const findOverview = async () =>
    (
      await deps.db
        .select()
        .from(schema.knowledgeWikiPages)
        .where(
          and(
            eq(schema.knowledgeWikiPages.baseId, base.id),
            eq(schema.knowledgeWikiPages.slug, OVERVIEW_SLUG),
          ),
        )
        .limit(1)
    )[0] ?? null;
  let overview = await findOverview();
  if (!overview) {
    const anyPage = await repo.knowledge.listWikiPages(deps.db, base.id, { limit: 1 });
    // 首文档才自动建索引页；并发摄取撞唯一索引时读回既有的那一页。
    if (anyPage.items.length === 0) {
      overview = await repo.knowledge
        .createWikiPage(deps.db, { baseId: base.id, slug: OVERVIEW_SLUG, title: OVERVIEW_TITLE })
        .catch(findOverview);
    }
  }
  if (overview) {
    related.add(overview.id);
    if (overview.status !== 'draft') {
      await deps.db
        .update(schema.knowledgeWikiPages)
        .set({ status: 'stale', updatedAt: new Date() })
        .where(eq(schema.knowledgeWikiPages.id, overview.id));
    }
  }
  if (related.size === 0) return;

  const pending = await deps.db
    .select({ payload: schema.knowledgeJobs.payload })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.baseId, base.id),
        eq(schema.knowledgeJobs.type, 'wiki_generate'),
        inArray(schema.knowledgeJobs.status, ['queued', 'running']),
      ),
    );
  const busy = new Set<string>();
  for (const row of pending) {
    const parsed = knowledgeJobPayloadSchema.safeParse(row.payload);
    if (parsed.success && parsed.data.type === 'wiki_generate' && parsed.data.pageId) {
      busy.add(parsed.data.pageId);
    }
  }

  const jobIds: string[] = [];
  for (const pageId of related) {
    if (busy.has(pageId)) continue;
    const job = await repo.knowledge.createJob(deps.db, {
      type: 'wiki_generate',
      baseId: base.id,
      documentId: null,
      sourceId: null,
      payload: {
        type: 'wiki_generate',
        baseId: base.id,
        pageId,
        ...(pageId === overview?.id ? { instruction: OVERVIEW_INSTRUCTION } : {}),
      },
    });
    jobIds.push(job.id);
  }
  if (jobIds.length === 0) return;
  try {
    await deps.onWikiUpdate({ baseId: base.id, jobIds });
  } catch (err) {
    // 行已落库为 queued；对账会把它重新投递，不因此让已成功的摄取整体失败或重建版本。
    deps.logger.warn({ err, baseId: base.id, jobIds }, 'wiki 任务入队失败，等待对账补投');
  }
}

function imageRefOf(image: ParsedImage) {
  return { name: image.name, mimeType: image.mimeType, page: image.page };
}

/**
 * 图片后处理：每张图按启用的动作各自 query，OCR/caption 分别成为可检索的 kind:image chunk，
 * 同一个可读描述再参与文字向量；全部通过后才追加 opt-in 的图片向量 chunk。
 * 双动作都无产出时抛错让整版不发布；单动作失败/向量失败只记 warning。
 */
async function imageDrafts(
  deps: KnowledgeDeps,
  client: EmbeddingClient,
  parsed: ParsedDocument,
  settings: KnowledgeImageProcessing,
  signal: AbortSignal,
): Promise<{ drafts: ChunkDraft[]; warnings: Map<string, string[]> }> {
  const drafts: ChunkDraft[] = [];
  const warnings = new Map<string, string[]>();
  const vectorEnabled = settings.imageVectorEnabled && client.imageVectors;
  const vectorWarning =
    settings.imageVectorEnabled && !client.imageVectors
      ? '图片向量已跳过：当前 embedding profile 不是 cohere_v2/embed-v4.0 或未开启图片输入'
      : null;

  for (const image of parsed.images) {
    checkAborted(signal);
    const described = await describeKnowledgeImage(
      {
        image: { mimeType: image.mimeType, data: image.data },
        settings,
        signal,
      },
      deps.imageQueryFn ? { queryFn: deps.imageQueryFn } : {},
    );
    checkAborted(signal);
    const own = [...described.warnings];
    if (vectorWarning) own.push(vectorWarning);
    if (described.ocr === null && described.caption === null) {
      // 失败占位不能当正文索引：整版不发布，旧版本继续可查。
      throw new Error(`图片 ${image.name} 没有可用的 OCR 或描述：${own.join('; ')}`);
    }
    const metadata = (role: 'ocr' | 'caption' | 'vector') =>
      knowledgeImageChunkMetadataSchema.parse({ image: imageRefOf(image), imageRole: role });
    if (described.ocr !== null) {
      drafts.push({
        kind: 'image',
        heading: null,
        content: described.ocr,
        pageFrom: image.page,
        pageTo: image.page,
        metadata: metadata('ocr'),
      });
    }
    if (described.caption !== null) {
      drafts.push({
        kind: 'image',
        heading: null,
        content: described.caption,
        pageFrom: image.page,
        pageTo: image.page,
        metadata: metadata('caption'),
      });
    }
    const description = described.caption ?? described.ocr ?? '';
    if (vectorEnabled) {
      try {
        const embedding = await client.embedImage(
          { mimeType: image.mimeType, dataBase64: Buffer.from(image.data).toString('base64') },
          signal,
        );
        drafts.push({
          kind: 'image',
          heading: null,
          content: description,
          pageFrom: image.page,
          pageTo: image.page,
          metadata: metadata('vector'),
          // 图片向量是几何距离，不进关键词索引，避免把描述当文字排名。
          searchText: '',
          embedding,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        // 保留 vector 草稿身份（描述、metadata、searchText 为空、embedding:null），
        // 让 chunksOnly 能按原图补向量；它不进文字 embedding，也不参与关键词索引。
        drafts.push({
          kind: 'image',
          heading: null,
          content: description,
          pageFrom: image.page,
          pageTo: image.page,
          metadata: metadata('vector'),
          searchText: '',
          embedding: null,
        });
        own.push(`图片向量失败，已降级为描述检索：${describeKnowledgeError(err)}`);
      }
    }
    if (own.length > 0) warnings.set(image.name, own);
  }
  return { drafts, warnings };
}

async function ingestContent(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  input: {
    filename: string;
    mimeType: string;
    data: Buffer;
    markdown?: string | undefined;
    sourceRevision: string | null;
    signal: AbortSignal;
    jobId: string;
  },
): Promise<string> {
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) throw new Error('知识库不存在，文档可能已删除');
  const client = await embeddingClient(deps, base.embeddingProfileId);
  const settings = knowledgeBaseSettingsSchema.parse(base.settings);

  const blobSha = await storeBlob(deps.knowledgeDir, input.data);
  await setStep(deps, input.jobId, 'parsing', 10);
  // 解析器被 abort 时抛的是上游错误；这里统一归成取消，避免被当成可重试的解析失败。
  const parsed: ParsedDocument =
    input.markdown === undefined
      ? await deps
          .parse({
            filename: input.filename,
            mimeType: input.mimeType,
            data: input.data,
            signal: input.signal,
          })
          .catch((err: unknown) => {
            if (input.signal.aborted) throw new KnowledgeCancelled();
            throw err;
          })
      : { markdown: input.markdown, images: [], pageMap: [] };
  checkAborted(input.signal);
  if (parsed.markdown.trim() === '') throw new Error('解析结果为空');

  const drafts = deps.chunkMarkdown(parsed.markdown, parsed.pageMap, {
    chunkTokens: base.settings.chunkTokens,
    overlap: base.settings.chunkOverlap,
  });
  if (drafts.length === 0) throw new Error('分块结果为空');

  let imageWarnings = new Map<string, string[]>();
  const imageDraftList: ChunkDraft[] = [];
  if (parsed.images.length > 0) {
    if (!settings.imageProcessing.enabled) {
      // 关闭图片处理时普通文档照旧解析/索引/供图；只有独立图片必须显式开启。
      if (document.mimeType.startsWith('image/')) {
        throw new Error('图片处理未启用：请先在知识库设置中开启图片处理并选择视觉模型');
      }
    } else {
      await setStep(deps, input.jobId, 'image_processing', 20);
      const processed = await imageDrafts(
        deps,
        client,
        parsed,
        settings.imageProcessing,
        input.signal,
      );
      imageDraftList.push(...processed.drafts);
      imageWarnings = processed.warnings;
    }
  }
  const allDrafts = [...drafts, ...imageDraftList];
  await setStep(deps, input.jobId, 'embedding', 30);
  // 图片 vector 的向量已单独生成；文字 embedding 只覆盖其余 draft，不把图向量当文本。
  // 降级的 vector 草稿（embedding:null）同样排除，留待 chunksOnly 按原图补。
  const textual = allDrafts
    .map((draft, index) => ({ draft, index }))
    .filter(
      (entry) =>
        !(
          entry.draft.metadata &&
          knowledgeImageChunkMetadataSchema.safeParse(entry.draft.metadata).data?.imageRole ===
            'vector'
        ),
    );
  const vectors = await embedAll(
    client,
    textual.map((entry) => entry.draft.content),
    input.signal,
  );
  const embeddings = allDrafts.map((draft) => draft.embedding ?? null);
  for (const [position, entry] of textual.entries()) {
    embeddings[entry.index] = vectors[position] ?? null;
  }
  checkAborted(input.signal);
  // 发布前重核：库停用或图片处理配置变化时不用旧配置覆盖新决定，明确要求重试。
  const latest = await repo.knowledge.getBase(deps.db, document.baseId);
  if (latest?.status !== 'active') throw new Error('知识库已停用，未发布本次结果');
  if (
    latest.embeddingProfileId !== client.profileId ||
    JSON.stringify(knowledgeBaseSettingsSchema.parse(latest.settings).imageProcessing) !==
      JSON.stringify(settings.imageProcessing)
  ) {
    throw new Error('知识库配置已变化，请重试本次摄取');
  }

  const version = await repo.knowledge.createVersion(deps.db, {
    documentId: document.id,
    blobSha256: blobSha,
    markdownSha256: sha256(parsed.markdown),
    originalFilename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    sourceRevision: input.sourceRevision,
    parseStatus: 'parsed',
    pageMap: parsed.pageMap,
    images: parsed.images.map((image) => ({
      name: image.name,
      sha256: sha256(Buffer.from(image.data)),
      mimeType: image.mimeType,
      page: image.page,
      warnings: imageWarnings.get(image.name) ?? [],
    })),
    embeddingProfileId: client.profileId,
  });
  await writeParsed(deps.knowledgeDir, document.id, version.id, parsed);
  await setStep(deps, input.jobId, 'indexing', 80);
  checkAborted(input.signal);
  await repo.knowledge.insertChunks(deps.db, {
    baseId: document.baseId,
    documentId: document.id,
    versionId: version.id,
    folderId: document.folderId,
    chunks: allDrafts.map((draft, index) => ({
      ordinal: index,
      kind: draft.kind,
      heading: draft.heading,
      content: draft.content,
      searchText: draft.searchText ?? segmentForSearch(draft.content),
      embedding: embeddings[index] ?? null,
      pageFrom: draft.pageFrom,
      pageTo: draft.pageTo,
      tokenCount: Math.ceil(draft.content.length / 2),
      ...(draft.metadata ? { metadata: draft.metadata } : {}),
    })),
  });
  // 运行中取消只走 Redis abort（job 行仍是 running），所以切版前必须先看 signal；
  // 事务内的 guard 再核对任务未被收尾、库仍 active、profile 与配置未变。
  checkAborted(input.signal);
  const published = await repo.knowledge.setCurrentVersion(deps.db, document.id, version.id, {
    jobId: input.jobId,
    baseId: document.baseId,
    embeddingProfileId: client.profileId,
    imageProcessingJson: JSON.stringify(settings.imageProcessing),
    isAborted: () => input.signal.aborted,
  });
  if (!published) throw new Error('知识库配置已变化或已停用，未发布本次结果');
  await repo.knowledge.updateDocument(deps.db, document.id, {
    contentHash: sha256(input.data),
    lastSyncedAt: new Date(),
  });
  // 只有成功切版本才推进 Wiki；失败/取消在上面的异常路径返回，不会走到这里。
  await linkWikiAfterIngest(deps, base, document);
  return version.id;
}

function requirePayload(job: KnowledgeJobRow) {
  const parsed = knowledgeJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`job payload 不合法: ${parsed.error.message}`);
  return parsed.data;
}

function filenameOf(document: KnowledgeDocumentRow): string {
  const stored = document.metadata.originalFilename;
  return typeof stored === 'string' ? stored : document.title;
}

// ---------------------------------------------------------------------------
// runIngest：原件由 API 写入 blob 并记录 contentHash。

export async function runIngest(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  const payload = requirePayload(job);
  if (payload.type !== 'ingest') throw new Error('job 类型不是 ingest');
  const document = await repo.knowledge.getDocument(deps.db, payload.documentId);
  if (!document) throw new Error('文档不存在，可能已被删除');
  if (!document.contentHash) throw new Error('文档没有已上传的原件');
  // 已有当前版本的文档在摄取期间保持原状态：失败时旧版本必须继续可查。
  if (!document.currentVersionId) {
    await repo.knowledge.updateDocument(deps.db, document.id, { status: 'processing' });
  }
  try {
    const data = await readFile(blobPath(deps.knowledgeDir, document.contentHash));
    await ingestContent(deps, document, {
      filename: filenameOf(document),
      mimeType: document.mimeType,
      data,
      sourceRevision: null,
      signal,
      jobId: job.id,
    });
  } catch (err) {
    if (err instanceof KnowledgeCancelled) throw err;
    await repo.knowledge.updateDocument(deps.db, document.id, {
      status: document.currentVersionId ? 'ready' : 'failed',
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runReindex：chunksOnly 只补缺失向量；否则每个文档新建版本，失败保留旧版本。

/** 列表接口单页最多 200 条；按 nextCursor 翻到末尾，漏页会让重建/删除传播静默不完整。 */
async function listAllPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

async function reembedMissing(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  signal: AbortSignal,
): Promise<void> {
  const versionId = document.currentVersionId;
  if (!versionId) throw new Error('文档没有当前版本');
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) throw new Error('知识库不存在');
  // 版本 profile 必须与库当前 profile 一致：同维度不等于同空间，混写会污染整版。
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) throw new Error('文档当前版本不存在');
  if (version.embeddingProfileId !== base.embeddingProfileId) {
    throw new KnowledgeProfileMismatch(
      '当前版本使用的 embedding profile 与知识库不一致，请完整重建该文档',
    );
  }
  const client = await embeddingClient(deps, base.embeddingProfileId);
  const chunks = await listAllPages((cursor) =>
    repo.knowledge.listChunks(deps.db, versionId, { limit: LIST_PAGE_SIZE, cursor }),
  );
  const imageProcessing = knowledgeBaseSettingsSchema.parse(base.settings).imageProcessing;
  const roleOf = (chunk: (typeof chunks)[number]) => {
    const image = knowledgeImageChunkMetadataSchema.safeParse(chunk.metadata);
    return image.success ? image.data : null;
  };
  // 图片处理已停用时图片语义 chunk 本来就不参与检索，不补其向量。
  const candidates = chunks.filter(
    (chunk) => chunk.embedding === null && (imageProcessing.enabled || !roleOf(chunk)),
  );
  const textLike = candidates.filter((chunk) => roleOf(chunk)?.imageRole !== 'vector');
  const vectors = await embedAll(
    client,
    textLike.map((chunk) => chunk.content),
    signal,
  );
  for (const [index, chunk] of textLike.entries()) {
    checkAborted(signal);
    await repo.knowledge.patchChunk(deps.db, chunk.id, { embedding: vectors[index] ?? null });
  }

  const vectorChunks = candidates.flatMap((chunk) => {
    const image = roleOf(chunk);
    return image?.imageRole === 'vector' ? [{ chunk, image: image.image }] : [];
  });
  if (vectorChunks.length === 0) return;
  if (!client.imageVectors) {
    throw new Error('当前 embedding profile 不支持图片向量，无法补齐 vector 分块');
  }
  // 只读版本清单里的原图：name 必须精确匹配，绝不按 chunk 内容拼路径。
  const whitelist = new Map((version.images ?? []).map((image) => [image.name, image.mimeType]));
  for (const { chunk, image } of vectorChunks) {
    checkAborted(signal);
    const mimeType = whitelist.get(image.name);
    if (!mimeType) throw new Error(`图片 ${image.name} 不在版本清单中`);
    const data = await readFile(
      join(deps.knowledgeDir, 'docs', document.id, versionId, 'images', image.name),
    ).catch(() => null);
    if (!data) throw new Error(`图片 ${image.name} 的文件缺失`);
    const embedding = await client.embedImage(
      { mimeType, dataBase64: data.toString('base64') },
      signal,
    );
    await repo.knowledge.patchChunk(deps.db, chunk.id, { embedding });
  }
}

export async function runReindex(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  const payload = requirePayload(job);
  if (payload.type !== 'reindex') throw new Error('job 类型不是 reindex');
  const documents = payload.documentIds?.length
    ? (
        await Promise.all(payload.documentIds.map((id) => repo.knowledge.getDocument(deps.db, id)))
      ).filter((row): row is KnowledgeDocumentRow => row !== null)
    : await listAllPages((cursor) =>
        repo.knowledge.listDocuments(deps.db, {
          baseId: payload.baseId,
          limit: LIST_PAGE_SIZE,
          cursor,
        }),
      );

  let failed = 0;
  for (const [index, document] of documents.entries()) {
    checkAborted(signal);
    try {
      if (payload.chunksOnly) {
        await reembedMissing(deps, document, signal);
        continue;
      }
      if (!document.contentHash) throw new Error('文档没有已上传的原件');
      // 已有当前版本时状态不动：检索条件要求 ready，重建失败不能让旧版本掉出召回。
      if (!document.currentVersionId) {
        await repo.knowledge.updateDocument(deps.db, document.id, { status: 'processing' });
      }
      const data = await readFile(blobPath(deps.knowledgeDir, document.contentHash));
      await setStep(
        deps,
        job.id,
        `reindex:${index + 1}/${documents.length}`,
        Math.round((index / documents.length) * 100),
      );
      await ingestContent(deps, document, {
        filename: filenameOf(document),
        mimeType: document.mimeType,
        data,
        sourceRevision: null,
        signal,
        jobId: job.id,
      });
    } catch (err) {
      if (err instanceof KnowledgeCancelled) throw err;
      // profile 不匹配是整库配置问题，逐个吞掉只会让每个文档都静默失败。
      if (err instanceof KnowledgeProfileMismatch) throw err;
      failed += 1;
      deps.logger.warn({ err, documentId: document.id }, 'reindex document failed');
    }
  }
  if (failed > 0) throw new Error(`${failed} 个文档重建失败，旧版本保留`);
}

// ---------------------------------------------------------------------------
// runSync：检查点只写 sync run；来源游标只在成功后推进。列举失败绝不批量 disable。

async function upsertSourceItem(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  jobId: string,
  item: SourceItem,
  signal: AbortSignal,
): Promise<boolean> {
  const data = Buffer.isBuffer(item.content)
    ? item.content
    : Buffer.from(item.content.markdown, 'utf8');
  const contentHash = sha256(data);
  const existing =
    (
      await deps.db
        .select()
        .from(schema.knowledgeDocuments)
        .where(
          and(
            eq(schema.knowledgeDocuments.baseId, source.baseId),
            eq(schema.knowledgeDocuments.sourceType, source.type),
            eq(schema.knowledgeDocuments.sourceId, item.sourceId),
          ),
        )
        .limit(1)
    )[0] ?? null;
  // 文档表没有指向 knowledge_sources 的外键，删除/失权归属记在 metadata。
  const metadata = {
    ...(existing?.metadata ?? {}),
    knowledgeSourceId: source.id,
    originalFilename: item.title,
  };
  if (existing?.contentHash === contentHash) {
    // 内容没变也要落标题/路径/链接/归属，否则 rename 与目录调整永远不同步。
    await repo.knowledge.updateDocument(deps.db, existing.id, {
      title: item.title,
      metadata,
      lastSyncedAt: new Date(),
      ...(existing.status === 'disabled' ? { status: 'ready' } : {}),
    });
    await syncSourceColumns(deps, existing.id, item);
    return false;
  }
  const document =
    existing ??
    (await repo.knowledge.createDocument(deps.db, {
      baseId: source.baseId,
      folderId: null,
      title: item.title,
      sourceType: source.type,
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl,
      sourcePath: item.sourcePath,
      mimeType: item.mimeType,
      sizeBytes: data.length,
      metadata,
    }));
  await repo.knowledge.updateDocument(deps.db, document.id, {
    title: item.title,
    metadata,
    ...(document.currentVersionId ? {} : { status: 'processing' }),
  });
  await syncSourceColumns(deps, document.id, item);
  await ingestContent(deps, document, {
    filename: item.title,
    mimeType: item.mimeType,
    data,
    markdown: Buffer.isBuffer(item.content) ? undefined : item.content.markdown,
    sourceRevision: item.revision,
    signal,
    jobId,
  });
  return existing === null || existing.status === 'disabled';
}

/** source_url / source_path / mime_type 只在来源条目自述时更新，避免清空已有值。 */
async function syncSourceColumns(
  deps: KnowledgeDeps,
  documentId: string,
  item: SourceItem,
): Promise<void> {
  if (!item.sourceUrl && !item.sourcePath) return;
  await deps.db
    .update(schema.knowledgeDocuments)
    .set({
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      mimeType: item.mimeType,
    })
    .where(eq(schema.knowledgeDocuments.id, documentId));
}

/**
 * 删除只来自两处：来源显式报 deleted，或「完整枚举后没再看到该 ID」的推导。
 * 范围严格限定在本 source 名下的文档，且仅 disable，不物理删除。
 */
async function disableStaleDocuments(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  seen: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<number> {
  const documents = await listAllPages((cursor) =>
    repo.knowledge.listDocuments(deps.db, {
      baseId: source.baseId,
      status: 'ready',
      limit: LIST_PAGE_SIZE,
      cursor,
    }),
  );
  let disabled = 0;
  for (const document of documents) {
    checkAborted(signal);
    if (document.metadata.knowledgeSourceId !== source.id) continue;
    if (document.sourceId !== null && seen.has(document.sourceId)) continue;
    await repo.knowledge.updateDocument(deps.db, document.id, { status: 'disabled' });
    await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
    disabled += 1;
  }
  return disabled;
}

/** 非 active 来源（paused/disabled/auth_error）不同步：只把 run 记成 cancelled，不动游标与文档。 */
const SYNCABLE = new Set(['active']);

export async function runSync(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  const payload = requirePayload(job);
  if (payload.type !== 'sync') throw new Error('job 类型不是 sync');
  const source = await repo.knowledge.getSource(deps.db, payload.sourceId);
  if (!source) throw new Error('来源不存在，可能已被删除');
  if (!SYNCABLE.has(source.status)) {
    // job 与 sync run 用同一个 cancelled 结果，避免暂停/失权来源看起来"同步成功"。
    await repo.knowledge.finishSyncRun(deps.db, payload.syncRunId, {
      status: 'cancelled',
      cursorAfter: null,
      error: `来源状态为 ${source.status}，已跳过同步`,
    });
    throw new KnowledgeCancelled();
  }
  const connector = deps.connectors[source.type];
  if (!connector) throw new Error(`不支持的来源类型 ${source.type}`);
  const ranges = (await repo.knowledge.listRanges(deps.db, source.id)).filter(
    (range) => range.enabled,
  );
  if (ranges.length === 0) throw new Error('来源没有启用的范围');

  const secrets = source.secretsEncrypted ? deps.decrypt(source.secretsEncrypted) : {};
  const network: ConnectorNetwork | undefined =
    deps.trustedHosts?.length || deps.allowLoopback === true
      ? {
          ...(deps.trustedHosts?.length ? { trustedHosts: deps.trustedHosts } : {}),
          ...(deps.allowLoopback === true ? { allowLoopback: true } : {}),
        }
      : undefined;
  const stats = { listed: 0, created: 0, updated: 0, disabled: 0, failed: 0 };
  const seen = new Set<string>();
  // 默认不完整：连接器必须显式给一个 complete 检查点，删除推导才允许发生。
  let complete = false;
  let cursorAfter: Record<string, unknown> = source.cursor;
  let lastCheckpoint = Date.now();
  const checkpoint = async (
    cursor: Record<string, unknown>,
    status: SourceCheckpoint,
  ): Promise<void> => {
    cursorAfter = cursor;
    complete = status.complete && stats.failed === 0;
    await deps.db
      .update(schema.knowledgeSyncRuns)
      .set({ cursorAfter: cursor })
      .where(eq(schema.knowledgeSyncRuns.id, payload.syncRunId));
    lastCheckpoint = Date.now();
  };

  try {
    for await (const item of connector.sync({
      connectionId: source.id,
      config: source.config,
      secrets,
      ranges: ranges.map((range) => ({
        kind: range.kind,
        externalId: range.externalId,
        ref: range.ref,
        paths: range.paths,
      })),
      cursor: source.cursor,
      signal,
      ...(network ? { network } : {}),
      onCheckpoint: checkpoint,
    })) {
      checkAborted(signal);
      stats.listed += 1;
      try {
        if (item.deleted === true) {
          // 显式删除是来源主动陈述，不看 complete；滚动窗口的"缺失"才需要完整枚举。
          const existing =
            (
              await deps.db
                .select()
                .from(schema.knowledgeDocuments)
                .where(
                  and(
                    eq(schema.knowledgeDocuments.baseId, source.baseId),
                    eq(schema.knowledgeDocuments.sourceType, source.type),
                    eq(schema.knowledgeDocuments.sourceId, item.sourceId),
                  ),
                )
                .limit(1)
            )[0] ?? null;
          if (existing && existing.status !== 'disabled') {
            await repo.knowledge.updateDocument(deps.db, existing.id, { status: 'disabled' });
            await repo.knowledge.markWikiStaleByDocument(deps.db, existing.id);
            stats.disabled += 1;
          }
          continue;
        }
        seen.add(item.sourceId);
        const created = await upsertSourceItem(deps, source, job.id, item, signal);
        if (created) stats.created += 1;
        else stats.updated += 1;
      } catch (err) {
        // 凭证已失权：单条失败不能让本轮继续，否则来源会一直 active 反复失败。
        if (err instanceof KnowledgeCancelled || err instanceof SourceAuthError) throw err;
        stats.failed += 1;
        deps.logger.warn({ err, sourceId: source.id, itemId: item.sourceId }, 'sync item failed');
      }
      if (
        stats.listed % SYNC_CHECKPOINT_ITEMS === 0 ||
        Date.now() - lastCheckpoint > SYNC_CHECKPOINT_MS
      ) {
        await checkpoint(cursorAfter, { complete: false });
      }
    }
  } catch (err) {
    if (err instanceof KnowledgeCancelled) {
      // 取消：本范围游标不推进，run 状态与 job 的 cancelled 保持一致。
      await repo.knowledge.finishSyncRun(deps.db, payload.syncRunId, {
        status: 'cancelled',
        cursorAfter: null,
        stats,
        error: 'cancelled',
      });
      throw err;
    }
    // 明确失权（401/403/已知飞书鉴权码）才撤权：停源 + 旧文档退出检索与 read + Wiki 显式 stale。
    // 网络、限流、超时等临时故障保持 active，可继续重试。
    const authError = err instanceof SourceAuthError;
    if (authError) {
      const disabled = await repo.knowledge.disableDocumentsBySource(deps.db, source.id);
      for (const document of disabled) {
        await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
      }
      stats.disabled += disabled.length;
    }
    // 列举失败：游标不推进、不 disable 任何文档。
    await repo.knowledge.finishSyncRun(deps.db, payload.syncRunId, {
      status: 'failed',
      cursorAfter: source.cursor,
      stats,
      error: describeKnowledgeError(err),
    });
    await repo.knowledge.updateSource(deps.db, source.id, {
      lastSyncAt: new Date(),
      lastSyncStatus: 'failed',
      lastError: describeKnowledgeError(err),
      // 凭证失效时暂停来源，避免每次 cron 重复失败；其他错误保持原状态可重试。
      ...(authError || (err instanceof KnowledgeModelError && err.kind === 'auth')
        ? { status: 'auth_error' }
        : {}),
    });
    throw err;
  }

  // 单文档失败：本轮不算成功，游标停在上一次成功的位置；下轮会重新读到它。
  if (stats.failed > 0) {
    const message = `${stats.failed} 个条目同步失败，游标未推进`;
    await repo.knowledge.finishSyncRun(deps.db, payload.syncRunId, {
      status: 'failed',
      cursorAfter: source.cursor,
      stats,
      error: message,
    });
    await repo.knowledge.updateSource(deps.db, source.id, {
      lastSyncAt: new Date(),
      lastSyncStatus: 'failed',
      lastError: message,
    });
    throw new Error(message);
  }

  // 只有完整枚举（含所有 range、无单文档失败）才能推导「缺失即删除」。
  // 显式 deleted 已在循环内处理；这里只处理未出现在本次枚举里的旧文档。
  if (source.config.syncDeletions === true && complete) {
    stats.disabled += await disableStaleDocuments(deps, source, seen, signal);
  }

  await repo.knowledge.finishSyncRun(deps.db, payload.syncRunId, {
    status: 'succeeded',
    cursorAfter,
    stats,
  });
  await repo.knowledge.updateSource(deps.db, source.id, {
    cursor: cursorAfter,
    lastSyncAt: new Date(),
    lastSyncStatus: 'succeeded',
    lastError: null,
  });
}

// ---------------------------------------------------------------------------
// runCleanup：只删无版本引用且超过 24h 的 blob 与解析目录。

export async function runCleanup(
  deps: KnowledgeDeps,
  _job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  const versions = await deps.db
    .select({
      id: schema.knowledgeDocumentVersions.id,
      blob: schema.knowledgeDocumentVersions.blobSha256,
    })
    .from(schema.knowledgeDocumentVersions);
  const referencedBlobs = new Set(versions.map((row) => row.blob));
  const liveVersionIds = new Set(versions.map((row) => row.id));
  const cutoff = Date.now() - BLOB_RETENTION_MS;

  const blobsRoot = join(deps.knowledgeDir, 'blobs');
  for (const shard of await readdir(blobsRoot).catch(() => [])) {
    checkAborted(signal);
    for (const name of await readdir(join(blobsRoot, shard)).catch(() => [])) {
      if (referencedBlobs.has(name)) continue;
      const file = join(blobsRoot, shard, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(file, { force: true });
    }
  }

  const docsRoot = join(deps.knowledgeDir, 'docs');
  for (const documentId of await readdir(docsRoot).catch(() => [])) {
    checkAborted(signal);
    for (const versionId of await readdir(join(docsRoot, documentId)).catch(() => [])) {
      if (liveVersionIds.has(versionId)) continue;
      const dir = join(docsRoot, documentId, versionId);
      const info = await stat(dir).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 已认领 job 的分发

export async function runKnowledgeJob(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  switch (job.type) {
    case 'ingest':
      return runIngest(deps, job, signal);
    case 'reindex':
      return runReindex(deps, job, signal);
    case 'sync':
      return runSync(deps, job, signal);
    case 'cleanup':
      return runCleanup(deps, job, signal);
    case 'wiki_generate':
      throw new Error('wiki_generate 由 P5 的 wiki worker 处理');
  }
}
