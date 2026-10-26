import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail, isAppError, segmentForSearch } from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import {
  knowledgeBaseSettingsSchema,
  knowledgeChunkKindSchema,
  knowledgeDocumentStatusSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeSourceTypeSchema,
  knowledgeWikiPageStatusSchema,
  slugSchema,
} from '@agentport/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { isPgCode } from '../../plugins/errors.js';

/**
 * 知识库数据包（`pace/knowledge@1`）：ZIP 根 manifest.json 记录库元数据、文件夹、标签、
 * 文档版本、人工 chunk、Wiki 版本与引用，以及每个文件的 sha256。不含向量、密钥、
 * 同步游标与任务记录；导入只读文件与 JSON，不执行包内任何内容。
 */

type Db = Database;

export const KNOWLEDGE_PACKAGE_FORMAT = 'pace/knowledge@1';
export const KNOWLEDGE_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VERSION_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_PATH_LENGTH = 512;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const INSERT_BATCH = 500;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const pageMapEntrySchema = z.object({
  page: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
});

const chunkSchema = z.object({
  id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  kind: knowledgeChunkKindSchema,
  heading: z.string().max(300).nullable(),
  content: z.string(),
  enabled: z.boolean(),
  editedByUser: z.boolean(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  tokenCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const versionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  originalPath: z.string(),
  markdownPath: z.string().nullable(),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(MAX_ORIGINAL_BYTES),
  blobSha256: sha256Schema,
  markdownSha256: sha256Schema.nullable(),
  sourceRevision: z.string().nullable(),
  parseStatus: z.enum(['parsed', 'parse_failed']),
  pageMap: z.array(pageMapEntrySchema),
  images: z.array(
    z.object({
      name: z.string().min(1).max(255),
      sha256: sha256Schema,
      mimeType: z.string().min(1).max(255),
      page: z.number().int(),
      /** 单个动作失败/向量降级；旧包没有该字段时按空数组读取。 */
      warnings: z.array(z.string().max(500)).default([]),
      /** 包内路径，必须是同名版本 `documents/<文档>/<版本>/images/<name>`。 */
      path: z.string(),
    }),
  ),
  chunks: z.array(chunkSchema),
});

const documentSchema = z.object({
  id: z.string().min(1),
  folderId: z.string().min(1).nullable(),
  title: z.string().min(1).max(300),
  sourceType: knowledgeSourceTypeSchema,
  sourceId: z.string().max(500).nullable().default(null),
  sourceUrl: z.string().nullable(),
  sourcePath: z.string().nullable(),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  status: knowledgeDocumentStatusSchema,
  currentVersionId: z.string().min(1).nullable(),
  tags: z.array(z.string().min(1).max(64)),
  metadata: z.record(z.string(), z.unknown()).default({}),
  lastSyncedAt: z.string().nullable().default(null),
  versions: z.array(versionSchema).min(1),
});

const wikiPageSchema = z.object({
  id: z.string().min(1),
  slug: slugSchema,
  title: z.string().min(1).max(300),
  status: knowledgeWikiPageStatusSchema,
  currentVersionId: z.string().min(1).nullable(),
  versions: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      markdown: z.string(),
      sourceChunkIds: z.array(z.string().min(1)),
      /** 导出时已不存在的历史引用：包内没有对应 chunk，身份原样保留但明确标记失效。 */
      unresolvedSourceChunkIds: z.array(z.string().min(1)).default([]),
      model: z.string().min(1).max(200),
      generatedBy: z.enum(['sdk', 'manual']),
    }),
  ),
  sources: z.array(
    z.object({
      documentId: z.string().min(1).nullable(),
      versionId: z.string().min(1).nullable(),
      chunkId: z.string().min(1).nullable(),
      stale: z.boolean(),
    }),
  ),
});

const manifestSchema = z.object({
  format: z.literal(KNOWLEDGE_PACKAGE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  base: z.object({
    slug: slugSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500),
    status: z.enum(['active', 'disabled']),
    settings: knowledgeBaseSettingsSchema,
    embeddingProfileName: z.string().min(1).max(120),
    rerankProfileName: z.string().min(1).max(120).nullable(),
    /** 导入端据此判断本机 profile 是否具备导出时的图片能力。 */
    embeddingProfile: z.object({
      model: z.string().min(1).max(200),
      embeddingProtocol: z.enum(['openai', 'cohere_v2']),
      imageInputEnabled: z.boolean(),
    }),
  }),
  folders: z
    .array(
      z.object({
        id: z.string().min(1),
        parentId: z.string().min(1).nullable(),
        name: z.string().min(1).max(120),
        path: z.string(),
      }),
    )
    .max(2_000),
  tags: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(64) })).max(2_000),
  documents: z.array(documentSchema).max(2_000),
  wikiPages: z.array(wikiPageSchema).max(1_000),
  files: z
    .array(
      z.object({ path: z.string(), sha256: sha256Schema, size: z.number().int().nonnegative() }),
    )
    // 只含 Wiki 页、没有文档的库也要能导出/导入。
    .default([]),
});

type Manifest = z.infer<typeof manifestSchema>;
type DocumentPackage = z.infer<typeof documentSchema>;

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function invalid(message: string, path?: string): never {
  fail('INVALID_INPUT', message, path === undefined ? undefined : { path });
}

/** 包内路径只允许规范相对 POSIX 路径；导入端从不按这些名字落盘。 */
function assertEntryPath(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    invalid(`包内路径长度必须在 1-${MAX_PATH_LENGTH} 之间`, path);
  }
  if (path.includes('\\')) invalid('包内路径不能包含反斜杠', path);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) invalid('包内路径必须是相对路径', path);
  if ([...path].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) {
    invalid('包内路径不能包含控制字符', path);
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalid('包内路径不能包含空段、. 或 ..', path);
  }
}

/**
 * 先逐条检查再解压：fflate 的 filter 在解压前拿到声明大小，拒绝的条目不分配内存，
 * 避免用声明体积绕过上限。目录标记条目跳过；同名条目直接拒绝（fflate 会静默覆盖）。
 */
function readZip(data: Buffer): Map<string, Buffer> {
  if (data.length === 0) invalid('知识包是空的');
  if (data.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `知识包超过 ${KNOWLEDGE_PACKAGE_MAX_BYTES} 字节`);
  }
  const seen = new Set<string>();
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(data), {
      filter: (file) => {
        const name = file.name.replace(/\/$/, '');
        assertEntryPath(name);
        if (file.name.endsWith('/')) return false;
        if (seen.has(file.name)) invalid(`ZIP 包内条目「${file.name}」重复`, file.name);
        seen.add(file.name);
        if (seen.size > MAX_ENTRIES) invalid(`知识包内文件数超过 ${MAX_ENTRIES} 个`);
        total += Math.max(file.originalSize, file.size);
        if (total > MAX_EXPANDED_BYTES) {
          invalid(`知识包解压后总大小超过 ${MAX_EXPANDED_BYTES} 字节`);
        }
        if (file.originalSize > MAX_MANIFEST_BYTES) {
          invalid(`知识包条目「${file.name}」超过 ${MAX_MANIFEST_BYTES} 字节`, file.name);
        }
        return true;
      },
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    invalid('ZIP 内容损坏，无法解压');
  }
  return new Map(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)] as const));
}

/** 校验 manifest 的 sha256 清单，返回只有清单登记且哈希一致的条目。 */
function verifiedFiles(files: Map<string, Buffer>, manifest: Manifest): Map<string, Buffer> {
  const listed = new Map<string, { sha256: string; size: number }>();
  for (const file of manifest.files) {
    assertEntryPath(file.path);
    if (file.path === 'manifest.json') invalid('manifest.json 不能登记在 files 中', file.path);
    if (listed.has(file.path)) invalid(`manifest 中文件「${file.path}」重复`, file.path);
    listed.set(file.path, file);
  }
  for (const [path, data] of files) {
    if (path === 'manifest.json') continue;
    const entry = listed.get(path);
    if (!entry) invalid(`知识包包含未登记的条目「${path}」`, path);
    if (entry.size !== data.length) invalid(`「${path}」大小与 manifest 不符`, path);
    if (entry.sha256 !== hash(data)) invalid(`「${path}」内容与 sha256 不符`, path);
  }
  for (const path of listed.keys()) {
    if (!files.has(path)) invalid(`知识包缺少文件「${path}」`, path);
  }
  return new Map([...listed.keys()].map((path) => [path, files.get(path)!] as const));
}

/** 图片名要能直接作为 `images/` 下的单段文件名；导出与导入共用。 */
function imageNameProblem(name: string): string | null {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return '图片名不能包含路径分隔符';
  }
  if ([...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) {
    return '图片名不能包含控制字符';
  }
  return null;
}

/** vector chunk 只做图片向量检索，导入时同样不进关键词索引。 */
function isVectorRole(metadata: Record<string, unknown>): boolean {
  const parsed = knowledgeImageChunkMetadataSchema.safeParse(metadata);
  return parsed.success && parsed.data.imageRole === 'vector';
}

/** 包内图片路径白名单：只允许版本目录下的 `images/<name>`。 */
function imagePathFor(versionDir: string, name: string): string {
  return `${versionDir}/images/${name}`;
}

/** 版本目录由原件路径推出（`<dir>/original`）。 */
function versionDirOf(originalPath: string): string {
  return originalPath.slice(0, originalPath.lastIndexOf('/'));
}

function parseManifest(files: Map<string, Buffer>): Manifest {
  const raw = files.get('manifest.json');
  if (!raw) invalid('知识包缺少 manifest.json', 'manifest.json');
  if (raw.length > MAX_MANIFEST_BYTES) invalid('manifest.json 超过大小上限', 'manifest.json');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    invalid('manifest.json 不是合法 JSON', 'manifest.json');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalid(
      `manifest.json 不合法：${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
      'manifest.json',
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 导出

interface PageLike<T> {
  items: T[];
  nextCursor: string | null;
}

/** 仓库列表单页上限 200；导出必须循环到游标耗尽，否则会静默截断。 */
async function collectPages<T extends { id: string }>(
  fetchPage: (options: { cursor?: string; limit?: number }) => Promise<PageLike<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
}

export interface KnowledgePackageFile {
  filename: string;
  body: Buffer;
}

export async function exportKnowledgePackage(
  db: Db,
  knowledgeDir: string,
  baseId: string,
): Promise<KnowledgePackageFile | null> {
  const base = await repo.knowledge.getBase(db, baseId);
  if (!base) return null;
  const embedding = await repo.knowledge.getModelProfileWithSecret(db, base.embeddingProfileId);
  if (!embedding) fail('CONFLICT', '知识库引用的 embedding profile 不存在，无法导出');
  const rerank = base.rerankProfileId
    ? await repo.knowledge.getModelProfileWithSecret(db, base.rerankProfileId)
    : null;
  if (base.rerankProfileId && !rerank)
    fail('CONFLICT', '知识库引用的 rerank profile 不存在，无法导出');

  const folders = await collectPages((options) => repo.knowledge.listFolders(db, baseId, options));
  const tags = await repo.knowledge.listTags(db, baseId);
  const documents = await collectPages((options) =>
    repo.knowledge.listDocuments(db, { ...options, baseId }),
  );
  const tagNames = await repo.knowledge.getDocumentTagNames(
    db,
    documents.map((row) => row.id),
  );
  const wikiPages = await collectPages((options) =>
    repo.knowledge.listWikiPages(db, baseId, options),
  );
  const wikiSources =
    wikiPages.length === 0
      ? []
      : await db
          .select()
          .from(schema.knowledgeWikiSources)
          .where(
            inArray(
              schema.knowledgeWikiSources.pageId,
              wikiPages.map((row) => row.id),
            ),
          );

  const entries: Record<string, Uint8Array> = {};
  const files: Manifest['files'] = [];
  const addFile = (path: string, data: Buffer) => {
    entries[path] = data;
    files.push({ path, sha256: hash(data), size: data.length });
  };

  const documentPackages: Manifest['documents'] = [];
  const exportedChunkIds = new Set<string>();
  for (const document of documents) {
    const versions = await collectPages((options) =>
      repo.knowledge.listVersions(db, document.id, options),
    );
    if (versions.length === 0) fail('CONFLICT', `文档「${document.title}」没有可导出的版本`);
    const versionPackages: DocumentPackage['versions'] = [];
    for (const version of versions) {
      const original = await readFile(
        join(knowledgeDir, 'blobs', version.blobSha256.slice(0, 2), version.blobSha256),
      ).catch(() => null);
      if (!original) {
        fail(
          'CONFLICT',
          `文档「${document.title}」的原件缺失（版本 ${version.version}），无法导出`,
        );
      }
      if (hash(original) !== version.blobSha256) {
        fail('CONFLICT', `文档「${document.title}」的原件与记录的 sha256 不符，无法导出`);
      }
      const markdown = await readFile(
        join(knowledgeDir, 'docs', document.id, version.id, 'markdown.md'),
        'utf8',
      ).catch(() => null);
      // embedding 不属于包内容；vector chunk 保留身份与描述，靠导入后的 chunksOnly 按原图补向量。
      const chunks = await collectPages((options) =>
        repo.knowledge.listChunks(db, version.id, options),
      );
      for (const chunk of chunks) exportedChunkIds.add(chunk.id);
      const dir = `documents/${document.id}/${version.id}`;
      addFile(`${dir}/original`, original);
      if (markdown !== null) addFile(`${dir}/markdown.md`, Buffer.from(markdown, 'utf8'));
      const images: DocumentPackage['versions'][number]['images'] = [];
      const imageNames = new Set<string>();
      for (const image of version.images) {
        const problem = imageNameProblem(image.name);
        if (problem !== null) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片名「${image.name}」${problem}，无法导出`,
          );
        }
        if (imageNames.has(image.name)) {
          fail('CONFLICT', `文档「${document.title}」的图片「${image.name}」重复，无法导出`);
        }
        imageNames.add(image.name);
        const data = await readFile(
          join(knowledgeDir, 'docs', document.id, version.id, 'images', image.name),
        ).catch(() => null);
        if (!data) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片「${image.name}」缺失（版本 ${version.version}），无法导出`,
          );
        }
        if (hash(data) !== image.sha256) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片「${image.name}」与记录的 sha256 不符，无法导出`,
          );
        }
        const path = imagePathFor(dir, image.name);
        addFile(path, data);
        images.push({ ...image, path });
      }
      versionPackages.push({
        id: version.id,
        version: version.version,
        originalPath: `${dir}/original`,
        markdownPath: markdown === null ? null : `${dir}/markdown.md`,
        originalFilename: version.originalFilename,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        blobSha256: version.blobSha256,
        markdownSha256: markdown === null ? null : hash(Buffer.from(markdown, 'utf8')),
        sourceRevision: version.sourceRevision,
        parseStatus: version.parseStatus,
        pageMap: version.pageMap,
        images,
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          ordinal: chunk.ordinal,
          kind: chunk.kind,
          heading: chunk.heading,
          content: chunk.content,
          enabled: chunk.enabled,
          editedByUser: chunk.editedByUser,
          pageFrom: chunk.pageFrom,
          pageTo: chunk.pageTo,
          tokenCount: chunk.tokenCount,
          metadata: chunk.metadata,
        })),
      });
    }
    // 来源归属（knowledgeSourceId）属于本机同步状态，不随包迁移。
    const { knowledgeSourceId: _source, ...metadata } = document.metadata;
    documentPackages.push({
      id: document.id,
      folderId: document.folderId,
      title: document.title,
      sourceType: document.sourceType,
      sourceId: document.sourceId,
      sourceUrl: document.sourceUrl,
      sourcePath: document.sourcePath,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      status: document.status,
      currentVersionId: document.currentVersionId,
      tags: tagNames.get(document.id) ?? [],
      metadata,
      lastSyncedAt: document.lastSyncedAt?.toISOString() ?? null,
      versions: versionPackages,
    });
  }

  const wikiPagePackages: Manifest['wikiPages'] = [];
  for (const page of wikiPages) {
    const versions = await collectPages((options) =>
      repo.knowledge.listWikiVersions(db, page.id, options),
    );
    wikiPagePackages.push({
      id: page.id,
      slug: page.slug,
      title: page.title,
      status: page.status,
      currentVersionId: page.currentVersionId,
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        markdown: version.markdown,
        sourceChunkIds: version.sourceChunkIds.filter((id) => exportedChunkIds.has(id)),
        // 已删除的 chunk/文档：历史引用不删，但明确标成失效，导入后不会冒充有效引用。
        unresolvedSourceChunkIds: version.sourceChunkIds.filter((id) => !exportedChunkIds.has(id)),
        model: version.model,
        generatedBy: version.generatedBy,
      })),
      sources: wikiSources
        .filter((row) => row.pageId === page.id)
        .map((row) => ({
          documentId: row.documentId,
          versionId: row.versionId,
          chunkId: row.chunkId,
          stale: row.stale,
        })),
    });
  }

  const manifest: Manifest = {
    format: KNOWLEDGE_PACKAGE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    base: {
      slug: base.slug,
      name: base.name,
      description: base.description,
      status: base.status,
      settings: base.settings,
      embeddingProfileName: embedding.name,
      rerankProfileName: rerank?.name ?? null,
      embeddingProfile: {
        model: embedding.model,
        embeddingProtocol: embedding.embeddingProtocol,
        imageInputEnabled: embedding.imageInputEnabled,
      },
    },
    folders: folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      path: folder.path,
    })),
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
    documents: documentPackages,
    wikiPages: wikiPagePackages,
    files,
  };
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const body = Buffer.from(zipSync(entries, { level: 6 }));
  if (body.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    fail(
      'PAYLOAD_TOO_LARGE',
      `知识包压缩后超过 ${KNOWLEDGE_PACKAGE_MAX_BYTES} 字节，请拆分知识库后重试`,
    );
  }
  return { filename: `${base.slug}.knowledge.zip`, body };
}

// ---------------------------------------------------------------------------
// 导入

export interface KnowledgePackageImportResult {
  baseId: string;
  serverId: string;
  counts: {
    folders: number;
    tags: number;
    documents: number;
    versions: number;
    chunks: number;
    wikiPages: number;
  };
}

/**
 * 导入会创建全新的库与内置 server。所有校验、profile 匹配、sha256 与文件写入
 * 都在事务之前完成；元数据在一个事务里落库，失败时删掉本次新建的文件，
 * 不会留下半库，也不会碰任何已有知识库。
 */
export async function importKnowledgePackage(
  db: Db,
  knowledgeDir: string,
  archive: Buffer,
): Promise<KnowledgePackageImportResult> {
  const files = readZip(archive);
  const manifest = parseManifest(files);
  const contents = verifiedFiles(files, manifest);
  validateReferences(manifest, contents);

  const [embedding] = await db
    .select({
      id: schema.knowledgeModelProfiles.id,
      name: schema.knowledgeModelProfiles.name,
      model: schema.knowledgeModelProfiles.model,
      embeddingProtocol: schema.knowledgeModelProfiles.embeddingProtocol,
      imageInputEnabled: schema.knowledgeModelProfiles.imageInputEnabled,
    })
    .from(schema.knowledgeModelProfiles)
    .where(
      and(
        eq(schema.knowledgeModelProfiles.kind, 'embedding'),
        eq(schema.knowledgeModelProfiles.name, manifest.base.embeddingProfileName),
      ),
    )
    .limit(1);
  if (!embedding) {
    fail(
      'CONFLICT',
      `缺少 embedding 模型 profile「${manifest.base.embeddingProfileName}」；请先创建同名 profile 再导入`,
    );
  }
  // 导入方的 profile 才决定图片能力：包里有图片语义或启用了图片向量时不能伪装 ready。
  const hasImageChunks = manifest.documents.some((document) =>
    document.versions.some((version) => version.chunks.some((chunk) => chunk.kind === 'image')),
  );
  const needsImageCapability = manifest.base.settings.imageProcessing.enabled || hasImageChunks;
  if (
    needsImageCapability &&
    (manifest.base.embeddingProfile.model !== embedding.model ||
      manifest.base.embeddingProfile.embeddingProtocol !== embedding.embeddingProtocol)
  ) {
    fail(
      'CONFLICT',
      `本机 profile「${embedding.name}」与包内 embedding 协议/模型不一致；光描述可用但向量空间不同，请先创建匹配的 profile`,
    );
  }
  if (
    manifest.base.settings.imageProcessing.imageVectorEnabled &&
    !(
      embedding.embeddingProtocol === 'cohere_v2' &&
      embedding.model === 'embed-v4.0' &&
      embedding.imageInputEnabled
    )
  ) {
    fail(
      'CONFLICT',
      `包内启用了图片向量，但本机 profile「${embedding.name}」不具备 cohere_v2 + embed-v4.0 图片能力`,
    );
  }
  let rerankId: string | null = null;
  if (manifest.base.rerankProfileName !== null) {
    const [rerank] = await db
      .select({ id: schema.knowledgeModelProfiles.id })
      .from(schema.knowledgeModelProfiles)
      .where(
        and(
          eq(schema.knowledgeModelProfiles.kind, 'rerank'),
          eq(schema.knowledgeModelProfiles.name, manifest.base.rerankProfileName),
        ),
      )
      .limit(1);
    if (!rerank) {
      fail(
        'CONFLICT',
        `缺少 rerank 模型 profile「${manifest.base.rerankProfileName}」；请先创建同名 profile 再导入`,
      );
    }
    rerankId = rerank.id;
  }

  const existing = await repo.knowledge.getBase(db, manifest.base.slug);
  if (existing) {
    fail('CONFLICT', `知识库 slug「${manifest.base.slug}」已被占用；请先删除同名知识库再导入`);
  }

  // 新 ID 分配：文件夹/文档/版本/chunk/Wiki 全部换新，旧 ID 只在包内用于引用。
  const folderId = new Map(manifest.folders.map((folder) => [folder.id, newId('knowledgeFolder')]));
  const tagId = new Map(manifest.tags.map((tag) => [tag.id, newId('knowledgeTag')]));
  const documentId = new Map(
    manifest.documents.map((document) => [document.id, newId('knowledgeDocument')]),
  );
  const versionId = new Map<string, string>();
  const chunkId = new Map<string, string>();
  for (const document of manifest.documents) {
    for (const version of document.versions) {
      versionId.set(version.id, newId('knowledgeVersion'));
      for (const chunk of version.chunks) chunkId.set(chunk.id, newId('knowledgeChunk'));
    }
  }
  const wikiPageId = new Map(
    manifest.wikiPages.map((page) => [page.id, newId('knowledgeWikiPage')]),
  );
  const wikiVersionId = new Map<string, string>();
  for (const page of manifest.wikiPages) {
    for (const version of page.versions) {
      wikiVersionId.set(`${page.id}/${version.id}`, newId('knowledgeWikiVersion'));
    }
  }

  const baseId = newId('knowledgeBase');
  const serverId = newId('server');
  const createdDirs = new Set<string>();
  const createdBlobs: string[] = [];
  try {
    for (const document of manifest.documents) {
      const newDocumentId = documentId.get(document.id)!;
      for (const version of document.versions) {
        const original = contents.get(version.originalPath)!;
        await storeBlob(knowledgeDir, version.blobSha256, original, createdBlobs);
        const dir = join(knowledgeDir, 'docs', newDocumentId, versionId.get(version.id)!);
        if (version.markdownPath !== null) {
          createdDirs.add(dir);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'markdown.md'), contents.get(version.markdownPath)!, 'utf8');
        }
        if (version.images.length > 0) {
          createdDirs.add(dir);
          await mkdir(join(dir, 'images'), { recursive: true });
          for (const image of version.images) {
            await writeFile(join(dir, 'images', image.name), contents.get(image.path)!);
          }
        }
      }
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.servers).values({
        id: serverId,
        name: `kb-${manifest.base.slug}`,
        kind: 'knowledge',
        config: {},
        secretsEncrypted: null,
      });
      await tx.insert(schema.knowledgeBases).values({
        id: baseId,
        slug: manifest.base.slug,
        name: manifest.base.name,
        description: manifest.base.description,
        status: manifest.base.status,
        serverId,
        embeddingProfileId: embedding.id,
        rerankProfileId: rerankId,
        settings: manifest.base.settings,
      });
      await tx
        .update(schema.servers)
        .set({ config: { knowledgeBaseId: baseId } })
        .where(eq(schema.servers.id, serverId));

      for (const folder of [...manifest.folders].sort(
        (a, b) => folderPath(a, manifest).length - folderPath(b, manifest).length,
      )) {
        await tx.insert(schema.knowledgeFolders).values({
          id: folderId.get(folder.id)!,
          baseId,
          parentId: folder.parentId === null ? null : folderId.get(folder.parentId)!,
          name: folder.name,
          path: folderPath(folder, manifest),
        });
      }
      if (manifest.tags.length > 0) {
        await tx.insert(schema.knowledgeTags).values(
          manifest.tags.map((tag) => ({
            id: tagId.get(tag.id)!,
            baseId,
            name: tag.name,
          })),
        );
      }
      const tagByName = new Map(manifest.tags.map((tag) => [tag.name, tagId.get(tag.id)!]));

      for (const document of manifest.documents) {
        const newDocumentId = documentId.get(document.id)!;
        const currentPackage = document.versions.find(
          (version) => version.id === document.currentVersionId,
        );
        const status =
          document.status === 'disabled'
            ? 'disabled'
            : currentPackage && currentPackage.chunks.length > 0
              ? 'ready'
              : 'pending';
        await tx.insert(schema.knowledgeDocuments).values({
          id: newDocumentId,
          baseId,
          folderId: document.folderId === null ? null : folderId.get(document.folderId)!,
          title: document.title,
          sourceType: document.sourceType,
          sourceId: document.sourceId,
          sourceUrl: document.sourceUrl,
          sourcePath: document.sourcePath,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          status,
          currentVersionId: null,
          contentHash: currentPackage?.blobSha256 ?? null,
          metadata: document.metadata,
          lastSyncedAt: document.lastSyncedAt === null ? null : new Date(document.lastSyncedAt),
        });
        for (const version of document.versions) {
          const newVersionId = versionId.get(version.id)!;
          await tx.insert(schema.knowledgeDocumentVersions).values({
            id: newVersionId,
            documentId: newDocumentId,
            version: version.version,
            blobSha256: version.blobSha256,
            // 没有解析正文时写入空文件的哈希，不冒充原件摘要。
            markdownSha256: version.markdownSha256 ?? EMPTY_SHA256,
            originalFilename: version.originalFilename,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            sourceRevision: version.sourceRevision,
            parseStatus: version.parseStatus,
            pageMap: version.pageMap,
            // 包内的 path 只用于随包归档，库里仍存原件目录下的文件名。
            images: version.images.map(({ path: _path, ...image }) => image),
            embeddingProfileId: embedding.id,
          });
          for (let offset = 0; offset < version.chunks.length; offset += INSERT_BATCH) {
            const batch = version.chunks.slice(offset, offset + INSERT_BATCH);
            await tx.insert(schema.knowledgeChunks).values(
              batch.map((chunk) => ({
                id: chunkId.get(chunk.id)!,
                baseId,
                documentId: newDocumentId,
                versionId: newVersionId,
                folderId: document.folderId === null ? null : folderId.get(document.folderId)!,
                ordinal: chunk.ordinal,
                kind: chunk.kind,
                heading: chunk.heading,
                content: chunk.content,
                // vector chunk 与生成时一致：空 searchText，不进关键词索引。
                searchText: isVectorRole(chunk.metadata) ? '' : segmentForSearch(chunk.content),
                // 不导入向量，也不在这里调用付费模型；vector 的 embedding 由 chunksOnly 按原图补。
                embedding: null,
                enabled: chunk.enabled,
                editedByUser: chunk.editedByUser,
                pageFrom: chunk.pageFrom,
                pageTo: chunk.pageTo,
                tokenCount: chunk.tokenCount,
                metadata: chunk.metadata,
              })),
            );
          }
        }
        if (currentPackage) {
          await tx
            .update(schema.knowledgeDocuments)
            .set({ currentVersionId: versionId.get(currentPackage.id) ?? null })
            .where(eq(schema.knowledgeDocuments.id, newDocumentId));
        }
        const tagIds = [
          ...new Set(
            document.tags.map((name) => tagByName.get(name)).filter((id) => id !== undefined),
          ),
        ];
        if (tagIds.length > 0) {
          await tx
            .insert(schema.knowledgeDocumentTags)
            .values(tagIds.map((id) => ({ documentId: newDocumentId, tagId: id })));
        }
      }

      for (const page of manifest.wikiPages) {
        const newPageId = wikiPageId.get(page.id)!;
        await tx.insert(schema.knowledgeWikiPages).values({
          id: newPageId,
          baseId,
          slug: page.slug,
          title: page.title,
          status: page.status,
          currentVersionId: null,
        });
        for (const version of page.versions) {
          await tx.insert(schema.knowledgeWikiVersions).values({
            id: wikiVersionId.get(`${page.id}/${version.id}`)!,
            pageId: newPageId,
            version: version.version,
            markdown: version.markdown,
            // 失效引用原样保留原 ID：它们本就不在包内，不会与任何新 chunk 混淆。
            sourceChunkIds: [
              ...version.sourceChunkIds.map((id) => chunkId.get(id)!),
              ...version.unresolvedSourceChunkIds,
            ],
            model: version.model,
            generatedBy: version.generatedBy,
          });
        }
        if (page.currentVersionId !== null) {
          await tx
            .update(schema.knowledgeWikiPages)
            .set({
              currentVersionId: wikiVersionId.get(`${page.id}/${page.currentVersionId}`) ?? null,
            })
            .where(eq(schema.knowledgeWikiPages.id, newPageId));
        }
        if (page.sources.length > 0) {
          await tx.insert(schema.knowledgeWikiSources).values(
            page.sources.map((source) => ({
              pageId: newPageId,
              documentId: source.documentId === null ? null : documentId.get(source.documentId)!,
              versionId: source.versionId === null ? null : versionId.get(source.versionId)!,
              chunkId: source.chunkId === null ? null : chunkId.get(source.chunkId)!,
              stale: source.stale,
            })),
          );
        }
      }
    });
  } catch (err) {
    await Promise.all([
      ...[...createdDirs].map((dir) => rm(dir, { recursive: true, force: true })),
      ...createdBlobs.map((path) => rm(path, { force: true })),
    ]);
    if (isPgCode(err, '23505')) {
      fail('CONFLICT', `知识库 slug「${manifest.base.slug}」或内置 server 名称已被占用`);
    }
    throw err;
  }

  return {
    baseId,
    serverId,
    counts: {
      folders: manifest.folders.length,
      tags: manifest.tags.length,
      documents: manifest.documents.length,
      versions: versionId.size,
      chunks: chunkId.size,
      wikiPages: manifest.wikiPages.length,
    },
  };
}

/** 文件夹路径由父链重算，包里的 path 仅作说明，避免导入自相矛盾的层级。 */
function folderPath(folder: Manifest['folders'][number], manifest: Manifest): string {
  const byId = new Map(manifest.folders.map((entry) => [entry.id, entry]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: Manifest['folders'][number] | undefined = folder;
  while (current) {
    if (seen.has(current.id)) invalid(`文件夹「${folder.name}」层级存在循环`);
    seen.add(current.id);
    segments.unshift(current.name);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return `/${segments.join('/')}`;
}

async function storeBlob(
  knowledgeDir: string,
  expectedSha: string,
  data: Buffer,
  created: string[],
): Promise<void> {
  if (hash(data) !== expectedSha) invalid('原件内容与 manifest 的 sha256 不符');
  const target = join(knowledgeDir, 'blobs', expectedSha.slice(0, 2), expectedSha);
  if (await stat(target).catch(() => null)) return;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${newId('knowledgeJob')}`;
  await writeFile(temp, data);
  await rename(temp, target);
  created.push(target);
}

/** 包内引用必须是自洽的：路径存在性在 verifiedFiles 里已验证，这里只查 ID 关系。 */
function validateReferences(manifest: Manifest, contents: Map<string, Buffer>): void {
  const folderIds = new Set<string>();
  for (const folder of manifest.folders) {
    if (folderIds.has(folder.id)) invalid(`文件夹「${folder.name}」ID 重复`);
    folderIds.add(folder.id);
    if (!/^[^/]+$/.test(folder.name)) invalid(`文件夹名「${folder.name}」不能包含 /`);
  }
  for (const folder of manifest.folders) {
    if (folder.parentId !== null && !folderIds.has(folder.parentId)) {
      invalid(`文件夹「${folder.name}」引用了包内不存在的父文件夹`);
    }
  }
  const folderPaths = new Set<string>();
  for (const folder of manifest.folders) {
    const path = folderPath(folder, manifest);
    if (folderPaths.has(path)) invalid(`文件夹路径「${path}」重复`);
    folderPaths.add(path);
  }

  const tagNames = new Set<string>();
  for (const tag of manifest.tags) {
    if (!tagNames.add(tag.name)) invalid(`标签「${tag.name}」重复`);
  }

  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  const chunkIds = new Set<string>();
  for (const document of manifest.documents) {
    if (documentIds.has(document.id)) invalid(`文档「${document.title}」ID 重复`);
    documentIds.add(document.id);
    if (document.folderId !== null && !folderIds.has(document.folderId)) {
      invalid(`文档「${document.title}」引用了包内不存在的文件夹`);
    }
    for (const name of document.tags) {
      if (!tagNames.has(name)) invalid(`文档「${document.title}」引用了未声明的标签「${name}」`);
    }
    if (document.versions.length === 0) invalid(`文档「${document.title}」没有版本`);
    const numbers = new Set<number>();
    for (const version of document.versions) {
      if (versionIds.has(version.id)) invalid(`版本「${version.id}」ID 重复`);
      versionIds.add(version.id);
      if (!numbers.add(version.version)) invalid(`文档「${document.title}」版本号重复`);
      const original = contents.get(version.originalPath);
      if (!original) invalid(`版本「${version.id}」缺少原件`, version.originalPath);
      if (version.sizeBytes !== original.length) {
        invalid(`版本「${version.id}」声明大小与原件不符`, version.originalPath);
      }
      if (version.markdownPath !== null && !contents.has(version.markdownPath)) {
        invalid(`版本「${version.id}」缺少解析正文`, version.markdownPath);
      }
      if (version.markdownPath !== null && version.markdownSha256 === null) {
        invalid(`版本「${version.id}」有解析正文但缺少 sha256`, version.markdownPath);
      }
      const imageNames = new Set<string>();
      let imageBytes = 0;
      for (const image of version.images) {
        const problem = imageNameProblem(image.name);
        if (problem !== null) invalid(`版本「${version.id}」的${problem}`, image.path);
        if (!imageNames.add(image.name)) {
          invalid(`版本「${version.id}」的图片「${image.name}」重复`, image.path);
        }
        assertEntryPath(image.path);
        if (image.path !== imagePathFor(versionDirOf(version.originalPath), image.name)) {
          invalid(`版本「${version.id}」的图片路径必须是同版本 images/ 目录下的文件名`, image.path);
        }
        const data = contents.get(image.path);
        if (!data) invalid(`版本「${version.id}」缺少图片「${image.name}」`, image.path);
        if (data.length > MAX_IMAGE_BYTES) {
          invalid(`图片「${image.name}」超过 ${MAX_IMAGE_BYTES} 字节`, image.path);
        }
        imageBytes += data.length;
        if (imageBytes > MAX_VERSION_IMAGE_BYTES) {
          invalid(
            `版本「${version.id}」的图片总大小超过 ${MAX_VERSION_IMAGE_BYTES} 字节`,
            image.path,
          );
        }
        if (hash(data) !== image.sha256) {
          invalid(`图片「${image.name}」内容与清单 sha256 不符`, image.path);
        }
      }
      const ordinals = new Set<number>();
      for (const chunk of version.chunks) {
        if (chunkIds.has(chunk.id)) invalid(`分块「${chunk.id}」ID 重复`);
        chunkIds.add(chunk.id);
        if (!ordinals.add(chunk.ordinal)) {
          invalid(`版本「${version.id}」的分块序号 ${chunk.ordinal} 重复`);
        }
        // 图片定位只认本版本清单里的单段文件名，不接受越界路径或伪造 MIME。
        const hasImage = 'image' in chunk.metadata;
        const hasRole = 'imageRole' in chunk.metadata;
        if (!hasImage && !hasRole) continue;
        const parsed = knowledgeImageChunkMetadataSchema.safeParse(chunk.metadata);
        if (!parsed.success) {
          invalid(
            `版本「${version.id}」的分块图片定位不合法：${parsed.error.issues[0]?.message ?? ''}`,
          );
        }
        // 任一保留键都要求完整、自洽的图片身份：只有 image 没有角色、或角色没有图，
        // 都会让检索/读图对不上号，直接拒绝。
        if (chunk.kind !== 'image') {
          invalid(
            `版本「${version.id}」的分块 ${chunk.ordinal} 带图片 metadata 但 kind 不是 image`,
          );
        }
        if (!hasImage) {
          invalid(`版本「${version.id}」的分块 ${chunk.ordinal} 有 imageRole 但缺少 image`);
        }
        const image = version.images.find((entry) => entry.name === parsed.data.image.name);
        if (!image) {
          invalid(`版本「${version.id}」的分块引用了清单外的图片「${parsed.data.image.name}」`);
        }
        if (image.mimeType !== parsed.data.image.mimeType) {
          invalid(`版本「${version.id}」的分块 MIME 与图片清单不符`);
        }
        if (image.page !== parsed.data.image.page) {
          invalid(`版本「${version.id}」的分块页码与图片清单不符`);
        }
      }
    }
    if (document.currentVersionId !== null) {
      const current = document.versions.find((version) => version.id === document.currentVersionId);
      if (!current) invalid(`文档「${document.title}」的当前版本不在包内`);
    }
  }

  const wikiPageIds = new Set<string>();
  for (const page of manifest.wikiPages) {
    if (wikiPageIds.has(page.id)) invalid(`Wiki 页面「${page.slug}」ID 重复`);
    wikiPageIds.add(page.id);
    const numbers = new Set<number>();
    const pageVersionIds = new Set<string>();
    for (const version of page.versions) {
      if (!numbers.add(version.version)) invalid(`Wiki 页面「${page.slug}」版本号重复`);
      if (!pageVersionIds.add(version.id)) invalid(`Wiki 页面「${page.slug}」版本 ID 重复`);
      for (const id of version.sourceChunkIds) {
        if (!chunkIds.has(id)) invalid(`Wiki 页面「${page.slug}」引用了包内不存在的分块`);
      }
      for (const id of version.unresolvedSourceChunkIds) {
        // 已声明的失效引用只能指向包外；包内存在却标失效，说明清单自相矛盾。
        if (chunkIds.has(id)) {
          invalid(`Wiki 页面「${page.slug}」的失效引用「${id}」仍在包内`);
        }
      }
    }
    if (page.currentVersionId !== null && !pageVersionIds.has(page.currentVersionId)) {
      invalid(`Wiki 页面「${page.slug}」的当前版本不在包内`);
    }
    const sourceChunks = new Set<string>();
    for (const source of page.sources) {
      if (source.documentId !== null && !documentIds.has(source.documentId)) {
        invalid(`Wiki 页面「${page.slug}」引用了包内不存在的文档`);
      }
      if (source.versionId !== null && !versionIds.has(source.versionId)) {
        invalid(`Wiki 页面「${page.slug}」引用了包内不存在的版本`);
      }
      if (source.chunkId !== null) {
        if (!chunkIds.has(source.chunkId)) {
          invalid(`Wiki 页面「${page.slug}」引用了包内不存在的分块`);
        }
        if (!sourceChunks.add(source.chunkId)) {
          invalid(`Wiki 页面「${page.slug}」重复引用同一分块`);
        }
      }
    }
  }
}
