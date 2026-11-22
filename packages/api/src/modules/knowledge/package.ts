import { mkdir, rm, stat } from 'node:fs/promises';
import {
  fail,
  inspectKnowledgeAudio,
  isAppError,
  knowledgeBlobPath,
  knowledgeVersionDir,
  knowledgeVersionImagePath,
  knowledgeVersionImagesDir,
  knowledgeVersionMarkdownPath,
  segmentForSearch,
  sha256Hex,
} from '@agentport/core';
import { type CursorPage, type Database, newId, repo, schema } from '@agentport/db';
import {
  knowledgeAudioMetadataSchema,
  knowledgeBaseSettingsSchema,
  knowledgeBaseStatusSchema,
  knowledgeChunkIndexRoleSchema,
  knowledgeChunkKindSchema,
  knowledgeContentKindSchema,
  knowledgeDisabledReasonSchema,
  knowledgeDocumentStatusSchema,
  knowledgeEmbeddingProtocolSchema,
  knowledgeFaqSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeLocatorSchema,
  knowledgeParseStatusSchema,
  knowledgeSourceTypeSchema,
  knowledgeVersionOriginSchema,
  knowledgeWikiGeneratedBySchema,
  knowledgeWikiPageStatusSchema,
  slugSchema,
} from '@agentport/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { isPgCode } from '../../http/errors.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import {
  assertPackagePath,
  decodeZipEntries,
  inspectZipEntries,
  invalid,
  PACKAGE_PATH_SEGMENT_MESSAGE,
  ZIP_CORRUPT_MESSAGE,
  type ZipReadLimits,
} from '../agents/package-zip.js';
import { storeBlob as storeDocumentBlob, supportsImageVectors } from './service.js';
import { CHUNK_OVERLAP_INVALID_MESSAGE } from './use-cases/shared.js';

type Db = Database;

const KNOWLEDGE_PACKAGE_FORMAT = 'pace/knowledge@1';
export const KNOWLEDGE_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VERSION_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_FOLDERS = 2_000;
const MAX_TAGS = 2_000;
const MAX_DOCUMENTS = 2_000;
const MAX_WIKI_PAGES = 1_000;
const INSERT_BATCH = 500;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const ZIP_READ_LIMITS: ZipReadLimits = {
  maxEntries: MAX_ENTRIES,
  maxUncompressedBytes: MAX_EXPANDED_BYTES,
  maxEntryBytes: MAX_MANIFEST_BYTES,
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const pageMapEntrySchema = z.object({
  page: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
});

const chunkSchema = z.object({
  id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  parentOrdinal: z.number().int().nonnegative().nullable().default(null),
  indexRole: knowledgeChunkIndexRoleSchema.default('leaf'),
  kind: knowledgeChunkKindSchema,
  heading: z.string().max(300).nullable(),
  content: z.string(),
  enabled: z.boolean(),
  editedByUser: z.boolean(),
  pageFrom: z.number().int().nullable(),
  pageTo: z.number().int().nullable(),
  locator: knowledgeLocatorSchema.nullable().default(null),
  tokenCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const versionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  origin: knowledgeVersionOriginSchema.default('source'),
  parentVersionId: z.string().min(1).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  faq: knowledgeFaqSchema.nullable().default(null),
  originalPath: z.string(),
  markdownPath: z.string().nullable(),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(MAX_ORIGINAL_BYTES),
  blobSha256: sha256Schema,
  markdownSha256: sha256Schema.nullable(),
  sourceRevision: z.string().nullable(),
  parseStatus: knowledgeParseStatusSchema,
  pageMap: z.array(pageMapEntrySchema),
  images: z.array(
    z.object({
      name: z.string().min(1).max(255),
      sha256: sha256Schema,
      mimeType: z.string().min(1).max(255),
      page: z.number().int(),
      warnings: z.array(z.string().max(500)).default([]),
      path: z.string(),
    }),
  ),
  chunks: z.array(chunkSchema),
});

const pendingInputSchema = z.object({
  originalPath: z.string(),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(MAX_ORIGINAL_BYTES),
  blobSha256: sha256Schema,
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
  disabledReason: knowledgeDisabledReasonSchema.nullable().default(null),
  contentKind: knowledgeContentKindSchema.default('document'),
  currentVersionId: z.string().min(1).nullable(),
  tags: z.array(z.string().min(1).max(64)),
  metadata: z.record(z.string(), z.unknown()).default({}),
  lastSyncedAt: z.string().nullable().default(null),
  versions: z.array(versionSchema).default([]),
  pending: pendingInputSchema.nullable().default(null),
});

const wikiPageSchema = z.object({
  id: z.string().min(1),
  slug: slugSchema,
  title: z.string().min(1).max(300),
  parentId: z.string().min(1).nullable().default(null),
  position: z.number().int().default(0),
  status: knowledgeWikiPageStatusSchema,
  currentVersionId: z.string().min(1).nullable(),
  versions: z.array(
    z.object({
      id: z.string().min(1),
      version: z.number().int().positive(),
      markdown: z.string(),
      sourceChunkIds: z.array(z.string().min(1)),
      unresolvedSourceChunkIds: z.array(z.string().min(1)).default([]),
      model: z.string().min(1).max(200),
      generatedBy: knowledgeWikiGeneratedBySchema,
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
  base: z
    .object({
      slug: slugSchema,
      name: z.string().min(1).max(120),
      description: z.string().max(500),
      status: knowledgeBaseStatusSchema,
      settings: knowledgeBaseSettingsSchema,
      embeddingProfileName: z.string().min(1).max(120),
      rerankProfileName: z.string().min(1).max(120).nullable(),
      embeddingProfile: z.object({
        model: z.string().min(1).max(200),
        embeddingProtocol: knowledgeEmbeddingProtocolSchema,
        imageInputEnabled: z.boolean(),
      }),
      asrProfileName: z.string().min(1).max(120).nullable().default(null),
      asrProfile: z
        .object({
          protocol: z.literal('openai_transcriptions'),
          model: z.string().min(1).max(200),
        })
        .nullable()
        .default(null),
    })
    .refine(
      (value) =>
        (value.asrProfileName === null && value.asrProfile === null) ||
        (value.asrProfileName !== null && value.asrProfile !== null),
      { message: 'ASR profile 名称与协议必须同时存在或同时缺省', path: ['asrProfile'] },
    ),
  folders: z
    .array(
      z.object({
        id: z.string().min(1),
        parentId: z.string().min(1).nullable(),
        name: z.string().min(1).max(120),
        path: z.string(),
      }),
    )
    .max(MAX_FOLDERS),
  tags: z.array(z.object({ id: z.string().min(1), name: z.string().min(1).max(64) })).max(MAX_TAGS),
  documents: z.array(documentSchema).max(MAX_DOCUMENTS),
  wikiPages: z.array(wikiPageSchema).max(MAX_WIKI_PAGES),
  files: z
    .array(
      z.object({ path: z.string(), sha256: sha256Schema, size: z.number().int().nonnegative() }),
    )
    .default([]),
});

type Manifest = z.infer<typeof manifestSchema>;
type DocumentPackage = z.infer<typeof documentSchema>;

function withoutRuntimeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const { faqImport: _batch, faqImportJobId: _job, ...rest } = metadata;
  return rest;
}

function assertEntryPath(path: string): void {
  assertPackagePath(path);
  if (path.endsWith('/')) invalid(PACKAGE_PATH_SEGMENT_MESSAGE, path);
}

async function readZip(data: Buffer): Promise<Map<string, Buffer>> {
  if (data.length === 0) invalid('知识包是空的');
  if (data.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `知识包超过 ${KNOWLEDGE_PACKAGE_MAX_BYTES} 字节`);
  }
  try {
    return new Map(
      [...(await decodeZipEntries(data, ZIP_READ_LIMITS))].map(([path, entry]) => [
        path,
        entry.data,
      ]),
    );
  } catch (err) {
    if (isAppError(err)) throw err;
    invalid(ZIP_CORRUPT_MESSAGE);
  }
}

export function assertPackageCapacity(
  entries: Record<string, Uint8Array>,
  limits: ZipReadLimits = ZIP_READ_LIMITS,
): void {
  const paths = Object.keys(entries);
  if (paths.length > limits.maxEntries) {
    fail('CONFLICT', `知识包条目数超过 ${limits.maxEntries} 个，无法导出`);
  }
  let total = 0;
  for (const path of paths) {
    const size = entries[path]?.length ?? 0;
    if (limits.maxEntryBytes !== undefined && size > limits.maxEntryBytes) {
      fail('CONFLICT', `知识包条目「${path}」超过 ${limits.maxEntryBytes} 字节，无法导出`);
    }
    total += size;
    if (total > limits.maxUncompressedBytes) {
      fail(
        'CONFLICT',
        `知识包解压后总大小超过 ${limits.maxUncompressedBytes} 字节，请拆分知识库后重试`,
      );
    }
  }
}

function verifiedFiles(
  files: Map<string, Uint8Array>,
  manifest: Manifest,
): Map<string, Uint8Array> {
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
    if (entry.sha256 !== sha256Hex(data)) invalid(`「${path}」内容与 sha256 不符`, path);
  }
  const verified = new Map<string, Uint8Array>();
  for (const path of listed.keys()) {
    const data = files.get(path);
    if (data === undefined) invalid(`知识包缺少文件「${path}」`, path);
    verified.set(path, data);
  }
  return verified;
}

async function validateAudioPackage(
  manifest: Manifest,
  contents: Map<string, Uint8Array>,
  mode: 'export' | 'import',
): Promise<void> {
  const problem = (message: string, path: string): never => {
    if (mode === 'export') fail('CONFLICT', `知识包音频校验失败：${message}（${path}）`);
    invalid(message, path);
  };
  const checkOriginal = async (
    data: Uint8Array,
    filename: string,
    mimeType: string,
    path: string,
  ): Promise<void> => {
    let audio: Awaited<ReturnType<typeof inspectKnowledgeAudio>>;
    try {
      audio = await inspectKnowledgeAudio({ data, filename, mimeType });
    } catch (err) {
      if (!isAppError(err)) throw err;
      const message = `「${path}」${err.message}`;
      if (mode === 'export') fail('CONFLICT', `知识包音频校验失败：${message}`);
      fail(err.code, message, { path });
    }
    if (audio && audio.mimeType !== mimeType) {
      problem(`「${path}」实际音频格式与 MIME ${mimeType} 不一致`, path);
    }
  };

  for (const document of manifest.documents) {
    for (const version of document.versions) {
      const original = contents.get(version.originalPath);
      if (!original) continue;
      await checkOriginal(
        original,
        version.originalFilename,
        version.mimeType,
        version.originalPath,
      );
      if (!('audio' in version.metadata)) continue;
      const parsed = knowledgeAudioMetadataSchema.safeParse(version.metadata.audio);
      if (!parsed.success) {
        return problem(
          `版本「${version.id}」的 metadata.audio 不合法：${parsed.error.issues[0]?.message ?? ''}`,
          version.originalPath,
        );
      }
      if (parsed.data.segments.length === 0) continue;
      const markdownBytes =
        version.markdownPath === null ? undefined : contents.get(version.markdownPath);
      const markdown =
        markdownBytes === undefined
          ? null
          : new TextDecoder('utf-8', { ignoreBOM: true }).decode(markdownBytes);
      if (markdown === null) {
        return problem(`版本「${version.id}」有时码段但缺少解析正文`, version.originalPath);
      }
      let previousEnd = 0;
      for (const segment of parsed.data.segments) {
        if (segment.endOffset > markdown.length) {
          return problem(
            `版本「${version.id}」的音频段偏移超出解析正文长度 ${markdown.length}`,
            version.originalPath,
          );
        }
        if (segment.startOffset < previousEnd) {
          return problem(
            `版本「${version.id}」的音频段偏移未按顺序或互相重叠`,
            version.originalPath,
          );
        }
        previousEnd = segment.endOffset;
      }
    }
    if (document.pending !== null) {
      const original = contents.get(document.pending.originalPath);
      if (original) {
        await checkOriginal(
          original,
          document.pending.originalFilename,
          document.pending.mimeType,
          document.pending.originalPath,
        );
      }
    }
  }
}

function imageNameProblem(name: string): string | null {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return '图片名不能包含路径分隔符';
  }
  if ([...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) {
    return '图片名不能包含控制字符';
  }
  return null;
}

function isVectorRole(metadata: Record<string, unknown>): boolean {
  const parsed = knowledgeImageChunkMetadataSchema.safeParse(metadata);
  return parsed.success && parsed.data.imageRole === 'vector';
}

function imagePathFor(versionDir: string, name: string): string {
  return `${versionDir}/images/${name}`;
}

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

async function collectPages<T extends { id: string }>(
  fetchPage: (options: { cursor?: string; limit?: number }) => Promise<CursorPage<T> | null>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = requireCursorPage(await fetchPage({ limit: 200, ...cursorOption(cursor) }));
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
  const asr = base.asrProfileId
    ? await repo.knowledge.getModelProfileWithSecret(db, base.asrProfileId)
    : null;
  if (base.asrProfileId && asr?.kind !== 'asr') {
    fail('CONFLICT', '知识库引用的 ASR profile 不存在或类型不符，无法导出');
  }

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

  if (folders.length > MAX_FOLDERS) {
    fail('CONFLICT', `文件夹数量超过 ${MAX_FOLDERS} 个，请拆分知识库后重试`);
  }
  if (tags.length > MAX_TAGS) {
    fail('CONFLICT', `标签数量超过 ${MAX_TAGS} 个，请拆分知识库后重试`);
  }
  if (documents.length > MAX_DOCUMENTS) {
    fail('CONFLICT', `文档数量超过 ${MAX_DOCUMENTS} 个，请拆分知识库后重试`);
  }
  if (wikiPages.length > MAX_WIKI_PAGES) {
    fail('CONFLICT', `Wiki 页面数量超过 ${MAX_WIKI_PAGES} 个，请拆分知识库后重试`);
  }

  const entries: Record<string, Uint8Array> = {};
  const files: Manifest['files'] = [];
  const addFile = (path: string, data: Uint8Array) => {
    entries[path] = data;
    files.push({ path, sha256: sha256Hex(data), size: data.length });
  };

  const documentPackages: Manifest['documents'] = [];
  const exportedChunkIds = new Set<string>();
  for (const document of documents) {
    const versions = await collectPages((options) =>
      repo.knowledge.listVersions(db, document.id, options),
    );
    const { knowledgeSourceId: _source, ...documentMetadata } = document.metadata;
    if (versions.length === 0) {
      if (document.contentKind === 'wiki') continue;
      if (document.currentVersionId !== null) {
        fail('CONFLICT', `文档「${document.title}」的当前版本缺失，无法导出`);
      }
      const blobSha256 = document.contentHash;
      if (!blobSha256) {
        fail('CONFLICT', `文档「${document.title}」没有待处理的原件，无法导出`);
      }
      const original = await Bun.file(knowledgeBlobPath(knowledgeDir, blobSha256))
        .bytes()
        .catch(() => null);
      if (!original) {
        fail('CONFLICT', `文档「${document.title}」的待处理原件缺失，无法导出`);
      }
      if (sha256Hex(original) !== blobSha256) {
        fail('CONFLICT', `文档「${document.title}」的待处理原件与记录的 sha256 不符，无法导出`);
      }
      if (original.length > MAX_ORIGINAL_BYTES) {
        fail(
          'CONFLICT',
          `文档「${document.title}」的原件超过 ${MAX_ORIGINAL_BYTES} 字节，无法导出`,
        );
      }
      if (document.sizeBytes !== original.length) {
        fail('CONFLICT', `文档「${document.title}」的声明大小与待处理原件不符，无法导出`);
      }
      const storedName =
        typeof documentMetadata.originalFilename === 'string' &&
        documentMetadata.originalFilename.length > 0
          ? documentMetadata.originalFilename
          : `${document.title}.md`;
      const originalPath = `documents/${document.id}/pending/original`;
      addFile(originalPath, original);
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
        contentKind: document.contentKind,
        disabledReason: document.disabledReason,
        currentVersionId: null,
        tags: tagNames.get(document.id) ?? [],
        metadata: documentMetadata,
        lastSyncedAt: document.lastSyncedAt?.toISOString() ?? null,
        versions: [],
        pending: {
          originalPath,
          originalFilename: storedName.slice(0, 255),
          mimeType: document.mimeType,
          sizeBytes: original.length,
          blobSha256,
        },
      });
      continue;
    }
    const versionPackages: DocumentPackage['versions'] = [];
    for (const version of versions) {
      const original = await Bun.file(knowledgeBlobPath(knowledgeDir, version.blobSha256))
        .bytes()
        .catch(() => null);
      if (!original) {
        fail(
          'CONFLICT',
          `文档「${document.title}」的原件缺失（版本 ${version.version}），无法导出`,
        );
      }
      if (sha256Hex(original) !== version.blobSha256) {
        fail('CONFLICT', `文档「${document.title}」的原件与记录的 sha256 不符，无法导出`);
      }
      if (original.length > MAX_ORIGINAL_BYTES) {
        fail(
          'CONFLICT',
          `文档「${document.title}」的原件超过 ${MAX_ORIGINAL_BYTES} 字节（版本 ${version.version}），无法导出`,
        );
      }
      const markdown = await Bun.file(
        knowledgeVersionMarkdownPath(knowledgeDir, document.id, version.id),
      )
        .text()
        .catch(() => null);
      const chunks = await collectPages((options) =>
        repo.knowledge.listChunkSummaries(db, version.id, options),
      );
      for (const chunk of chunks) exportedChunkIds.add(chunk.id);
      const dir = `documents/${document.id}/${version.id}`;
      addFile(`${dir}/original`, original);
      if (markdown !== null) addFile(`${dir}/markdown.md`, Buffer.from(markdown, 'utf8'));
      const images: DocumentPackage['versions'][number]['images'] = [];
      const imageNames = new Set<string>();
      let imageBytes = 0;
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
        const data = await Bun.file(
          knowledgeVersionImagePath(knowledgeDir, document.id, version.id, image.name),
        )
          .bytes()
          .catch(() => null);
        if (!data) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片「${image.name}」缺失（版本 ${version.version}），无法导出`,
          );
        }
        if (sha256Hex(data) !== image.sha256) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片「${image.name}」与记录的 sha256 不符，无法导出`,
          );
        }
        if (data.length > MAX_IMAGE_BYTES) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片「${image.name}」超过 ${MAX_IMAGE_BYTES} 字节，无法导出`,
          );
        }
        imageBytes += data.length;
        if (imageBytes > MAX_VERSION_IMAGE_BYTES) {
          fail(
            'CONFLICT',
            `文档「${document.title}」的图片总大小超过 ${MAX_VERSION_IMAGE_BYTES} 字节（版本 ${version.version}），无法导出`,
          );
        }
        const path = imagePathFor(dir, image.name);
        addFile(path, data);
        images.push({ ...image, path });
      }
      versionPackages.push({
        id: version.id,
        version: version.version,
        origin: version.origin,
        parentVersionId: version.parentVersionId,
        metadata: withoutRuntimeMetadata(version.metadata),
        faq: version.faq,
        originalPath: `${dir}/original`,
        markdownPath: markdown === null ? null : `${dir}/markdown.md`,
        originalFilename: version.originalFilename,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        blobSha256: version.blobSha256,
        markdownSha256: markdown === null ? null : sha256Hex(Buffer.from(markdown, 'utf8')),
        sourceRevision: version.sourceRevision,
        parseStatus: version.parseStatus,
        pageMap: version.pageMap,
        images,
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          ordinal: chunk.ordinal,
          parentOrdinal: chunk.parentOrdinal,
          indexRole: chunk.indexRole,
          kind: chunk.kind,
          heading: chunk.heading,
          content: chunk.content,
          enabled: chunk.enabled,
          editedByUser: chunk.editedByUser,
          pageFrom: chunk.pageFrom,
          pageTo: chunk.pageTo,
          locator: chunk.locator,
          tokenCount: chunk.tokenCount,
          metadata: chunk.metadata,
        })),
      });
    }
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
      contentKind: document.contentKind,
      disabledReason: document.disabledReason,
      currentVersionId: document.currentVersionId,
      tags: tagNames.get(document.id) ?? [],
      metadata: documentMetadata,
      lastSyncedAt: document.lastSyncedAt?.toISOString() ?? null,
      versions: versionPackages,
      pending: null,
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
      parentId: page.parentId,
      position: page.position,
      status: page.status,
      currentVersionId: page.currentVersionId,
      versions: versions.map((version) => ({
        id: version.id,
        version: version.version,
        markdown: version.markdown,
        sourceChunkIds: version.sourceChunkIds.filter((id) => exportedChunkIds.has(id)),
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
      asrProfileName: asr?.name ?? null,
      asrProfile: asr ? { protocol: 'openai_transcriptions' as const, model: asr.model } : null,
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
  const checked = manifestSchema.safeParse(manifest);
  if (!checked.success) {
    const first = checked.error.issues[0];
    fail(
      'CONFLICT',
      `知识库内容不符合导入格式：${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }
  const contents = new Map(Object.entries(entries));
  validateReferences(checked.data, contents);
  await validateAudioPackage(checked.data, contents, 'export');
  entries['manifest.json'] = Buffer.from(JSON.stringify(checked.data), 'utf8');
  assertPackageCapacity(entries);
  const body = Buffer.from(zipSync(entries, { level: 6 }));
  if (body.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    fail('CONFLICT', `知识包压缩后超过 ${KNOWLEDGE_PACKAGE_MAX_BYTES} 字节，请拆分知识库后重试`);
  }
  try {
    await inspectZipEntries(body, ZIP_READ_LIMITS);
  } catch (err) {
    if (isAppError(err)) fail('CONFLICT', `导出的知识包不符合导入约束：${err.message}`);
    throw err;
  }
  return { filename: `${base.slug}.knowledge.zip`, body };
}

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

export async function importKnowledgePackage(
  db: Db,
  knowledgeDir: string,
  archive: Buffer,
  ownerBusinessId?: string,
): Promise<KnowledgePackageImportResult> {
  const files = await readZip(archive);
  const manifest = parseManifest(files);
  if (manifest.base.settings.chunkOverlap >= manifest.base.settings.chunkTokens) {
    fail('INVALID_INPUT', CHUNK_OVERLAP_INVALID_MESSAGE);
  }
  const contents = verifiedFiles(files, manifest);
  validateReferences(manifest, contents);
  await validateAudioPackage(manifest, contents, 'import');

  const requireEntry = <T>(value: T | undefined, key: string): T => {
    if (value === undefined) throw new Error(`知识库包导入缺少条目：${key}`);
    return value;
  };

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
    !supportsImageVectors(embedding)
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
  let asrId: string | null = null;
  if (manifest.base.asrProfileName !== null) {
    const expectedModel = manifest.base.asrProfile?.model;
    if (expectedModel === undefined) {
      fail('INVALID_INPUT', '包内 ASR profile 名称缺少协议与模型，无法匹配本机配置');
    }
    const [asr] = await db
      .select({
        id: schema.knowledgeModelProfiles.id,
        model: schema.knowledgeModelProfiles.model,
        enabled: schema.knowledgeModelProfiles.enabled,
      })
      .from(schema.knowledgeModelProfiles)
      .where(
        and(
          eq(schema.knowledgeModelProfiles.kind, 'asr'),
          eq(schema.knowledgeModelProfiles.name, manifest.base.asrProfileName),
        ),
      )
      .limit(1);
    if (!asr?.enabled || asr.model !== expectedModel) {
      fail(
        'CONFLICT',
        `缺少匹配的 ASR 模型 profile「${manifest.base.asrProfileName}」（需启用且 model=${expectedModel}）；请先创建同名 profile 再导入`,
      );
    }
    asrId = asr.id;
  }

  const existing = await repo.knowledge.getBase(db, manifest.base.slug);
  if (existing) {
    fail('CONFLICT', `知识库 slug「${manifest.base.slug}」已被占用；请先删除同名知识库再导入`);
  }

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
  const wikiVersionIdByOldId = new Map<string, string>();
  for (const page of manifest.wikiPages) {
    for (const version of page.versions) {
      const next = newId('knowledgeWikiVersion');
      wikiVersionId.set(`${page.id}/${version.id}`, next);
      wikiVersionIdByOldId.set(version.id, next);
    }
  }

  const remapMetadata = (
    metadata: Record<string, unknown>,
    maps: Record<string, Map<string, string>>,
  ): Record<string, unknown> => {
    const next = { ...metadata };
    for (const [key, map] of Object.entries(maps)) {
      const value = next[key];
      if (typeof value !== 'string') continue;
      const mapped = map.get(value);
      if (mapped === undefined) delete next[key];
      else next[key] = mapped;
    }
    return next;
  };

  const importedVersionMetadata = (metadata: Record<string, unknown>): Record<string, unknown> =>
    remapMetadata(withoutRuntimeMetadata(metadata), {
      wikiPageId,
      wikiVersionId: wikiVersionIdByOldId,
    });

  const baseId = newId('knowledgeBase');
  const serverId = newId('server');
  const createdDirs = new Set<string>();
  try {
    for (const document of manifest.documents) {
      const newDocumentId = requireEntry(documentId.get(document.id), document.id);
      for (const version of document.versions) {
        const original = requireEntry(contents.get(version.originalPath), version.originalPath);
        await storeBlob(knowledgeDir, version.blobSha256, original);
        const vId = requireEntry(versionId.get(version.id), version.id);
        const dir = knowledgeVersionDir(knowledgeDir, newDocumentId, vId);
        if (version.markdownPath !== null) {
          createdDirs.add(dir);
          await mkdir(dir, { recursive: true });
          await Bun.write(
            knowledgeVersionMarkdownPath(knowledgeDir, newDocumentId, vId),
            requireEntry(contents.get(version.markdownPath), version.markdownPath),
          );
        }
        if (version.images.length > 0) {
          createdDirs.add(dir);
          await mkdir(knowledgeVersionImagesDir(knowledgeDir, newDocumentId, vId), {
            recursive: true,
          });
          for (const image of version.images) {
            await Bun.write(
              knowledgeVersionImagePath(knowledgeDir, newDocumentId, vId, image.name),
              requireEntry(contents.get(image.path), image.path),
            );
          }
        }
      }
      if (document.pending !== null) {
        await storeBlob(
          knowledgeDir,
          document.pending.blobSha256,
          requireEntry(contents.get(document.pending.originalPath), document.pending.originalPath),
        );
      }
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.servers).values({
        id: serverId,
        name: `kb-${manifest.base.slug}`,
        kind: 'knowledge',
        config: {},
        secretsEncrypted: null,
        ownerBusinessId: ownerBusinessId ?? null,
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
        asrProfileId: asrId,
        settings: manifest.base.settings,
        ownerBusinessId: ownerBusinessId ?? null,
      });
      await tx
        .update(schema.servers)
        .set({ config: { knowledgeBaseId: baseId } })
        .where(eq(schema.servers.id, serverId));
      await repo.governance.assertKnowledgeDocumentQuota(tx, baseId, manifest.documents.length);

      for (const folder of [...manifest.folders].sort(
        (a, b) => folderPath(a, manifest).length - folderPath(b, manifest).length,
      )) {
        await tx.insert(schema.knowledgeFolders).values({
          id: requireEntry(folderId.get(folder.id), folder.id),
          baseId,
          parentId: folder.parentId === null ? null : folderId.get(folder.parentId),
          name: folder.name,
          path: folderPath(folder, manifest),
        });
      }
      if (manifest.tags.length > 0) {
        await tx.insert(schema.knowledgeTags).values(
          manifest.tags.map((tag) => ({
            id: requireEntry(tagId.get(tag.id), tag.id),
            baseId,
            name: tag.name,
          })),
        );
      }
      const tagByName = new Map(manifest.tags.map((tag) => [tag.name, tagId.get(tag.id)]));

      for (const document of manifest.documents) {
        const newDocumentId = requireEntry(documentId.get(document.id), document.id);
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
          folderId: document.folderId === null ? null : folderId.get(document.folderId),
          title: document.title,
          sourceType: document.sourceType,
          sourceId: document.sourceId,
          sourceUrl: document.sourceUrl,
          sourcePath: document.sourcePath,
          mimeType: document.mimeType,
          sizeBytes: document.sizeBytes,
          status,
          contentKind: document.contentKind,
          disabledReason: status === 'disabled' ? (document.disabledReason ?? 'manual') : null,
          sourceConnectionId: null,
          currentVersionId: null,
          contentHash: document.pending?.blobSha256 ?? currentPackage?.blobSha256 ?? null,
          metadata: remapMetadata(
            document.pending === null
              ? document.metadata
              : { ...document.metadata, originalFilename: document.pending.originalFilename },
            { wikiPageId },
          ),
          lastSyncedAt: document.lastSyncedAt === null ? null : new Date(document.lastSyncedAt),
        });
        for (const version of document.versions) {
          const newVersionId = requireEntry(versionId.get(version.id), version.id);
          await tx.insert(schema.knowledgeDocumentVersions).values({
            id: newVersionId,
            documentId: newDocumentId,
            version: version.version,
            origin: version.origin,
            parentVersionId: null,
            metadata: importedVersionMetadata(version.metadata),
            faq: version.faq,
            blobSha256: version.blobSha256,
            markdownSha256: version.markdownSha256 ?? EMPTY_SHA256,
            originalFilename: version.originalFilename,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            sourceRevision: version.sourceRevision,
            parseStatus: version.parseStatus,
            pageMap: version.pageMap,
            images: version.images.map(({ path: _path, ...image }) => image),
            embeddingProfileId: embedding.id,
          });
          for (let offset = 0; offset < version.chunks.length; offset += INSERT_BATCH) {
            const batch = version.chunks.slice(offset, offset + INSERT_BATCH);
            await tx.insert(schema.knowledgeChunks).values(
              batch.map((chunk) => ({
                id: requireEntry(chunkId.get(chunk.id), chunk.id),
                baseId,
                documentId: newDocumentId,
                versionId: newVersionId,
                folderId: document.folderId === null ? null : folderId.get(document.folderId),
                ordinal: chunk.ordinal,
                parentOrdinal: chunk.parentOrdinal,
                indexRole: chunk.indexRole,
                kind: chunk.kind,
                heading: chunk.heading,
                content: chunk.content,
                searchText: isVectorRole(chunk.metadata) ? '' : segmentForSearch(chunk.content),
                embedding: null,
                enabled: chunk.enabled,
                editedByUser: chunk.editedByUser,
                pageFrom: chunk.pageFrom,
                pageTo: chunk.pageTo,
                locator: chunk.locator,
                tokenCount: chunk.tokenCount,
                metadata: chunk.metadata,
              })),
            );
          }
        }
        for (const version of document.versions) {
          if (version.parentVersionId === null) continue;
          await tx
            .update(schema.knowledgeDocumentVersions)
            .set({ parentVersionId: versionId.get(version.parentVersionId) })
            .where(
              eq(
                schema.knowledgeDocumentVersions.id,
                requireEntry(versionId.get(version.id), version.id),
              ),
            );
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
        const newPageId = requireEntry(wikiPageId.get(page.id), page.id);
        await tx.insert(schema.knowledgeWikiPages).values({
          id: newPageId,
          baseId,
          slug: page.slug,
          title: page.title,
          parentId: null,
          position: page.position,
          status: page.status,
          currentVersionId: null,
        });
        for (const version of page.versions) {
          await tx.insert(schema.knowledgeWikiVersions).values({
            id: requireEntry(
              wikiVersionId.get(`${page.id}/${version.id}`),
              `${page.id}/${version.id}`,
            ),
            pageId: newPageId,
            version: version.version,
            markdown: version.markdown,
            sourceChunkIds: [
              ...version.sourceChunkIds.map((id) => requireEntry(chunkId.get(id), id)),
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
              documentId: source.documentId === null ? null : documentId.get(source.documentId),
              versionId: source.versionId === null ? null : versionId.get(source.versionId),
              chunkId: source.chunkId === null ? null : chunkId.get(source.chunkId),
              stale: source.stale,
            })),
          );
        }
      }
      for (const page of manifest.wikiPages) {
        if (page.parentId === null) continue;
        await tx
          .update(schema.knowledgeWikiPages)
          .set({ parentId: wikiPageId.get(page.parentId) })
          .where(eq(schema.knowledgeWikiPages.id, requireEntry(wikiPageId.get(page.id), page.id)));
      }
    });
  } catch (err) {
    await Promise.all([...createdDirs].map((dir) => rm(dir, { recursive: true, force: true })));
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
  data: Uint8Array,
): Promise<void> {
  if (sha256Hex(data) !== expectedSha) invalid('原件内容与 manifest 的 sha256 不符');
  const target = knowledgeBlobPath(knowledgeDir, expectedSha);
  if (await stat(target).catch(() => null)) return;
  await storeDocumentBlob(knowledgeDir, data);
}

function validateReferences(manifest: Manifest, contents: Map<string, Uint8Array>): void {
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
    if (tagNames.has(tag.name)) invalid(`标签「${tag.name}」重复`);
    tagNames.add(tag.name);
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
    if (document.versions.length === 0) {
      if (document.pending === null) invalid(`文档「${document.title}」没有版本或待处理原件`);
      if (document.currentVersionId !== null) {
        invalid(`文档「${document.title}」没有版本却声明了当前版本`);
      }
      if (document.contentKind === 'wiki') {
        invalid(`Wiki 索引文档「${document.title}」不能只有待处理原件`);
      }
      const pending = document.pending;
      assertEntryPath(pending.originalPath);
      const original = contents.get(pending.originalPath);
      if (!original) {
        invalid(`文档「${document.title}」的待处理原件缺失`, pending.originalPath);
      }
      if (document.sizeBytes !== original.length || pending.sizeBytes !== original.length) {
        invalid(`文档「${document.title}」的声明大小与待处理原件不符`, pending.originalPath);
      }
      if (sha256Hex(original) !== pending.blobSha256) {
        invalid(`文档「${document.title}」的待处理原件与 sha256 不符`, pending.originalPath);
      }
    } else if (document.pending !== null) {
      invalid(`文档「${document.title}」同时包含版本与待处理原件`);
    }
    const numbers = new Set<number>();
    for (const version of document.versions) {
      if (versionIds.has(version.id)) invalid(`版本「${version.id}」ID 重复`);
      versionIds.add(version.id);
      if (numbers.has(version.version)) invalid(`文档「${document.title}」版本号重复`);
      numbers.add(version.version);
      if (version.parentVersionId !== null) {
        if (!document.versions.some((entry) => entry.id === version.parentVersionId)) {
          invalid(`版本「${version.id}」的父版本不在同一文档内`);
        }
      }
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
      const imageByName = new Map<string, (typeof version.images)[number]>();
      let imageBytes = 0;
      for (const image of version.images) {
        const problem = imageNameProblem(image.name);
        if (problem !== null) invalid(`版本「${version.id}」的${problem}`, image.path);
        if (imageByName.has(image.name)) {
          invalid(`版本「${version.id}」的图片「${image.name}」重复`, image.path);
        }
        imageByName.set(image.name, image);
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
        if (sha256Hex(data) !== image.sha256) {
          invalid(`图片「${image.name}」内容与清单 sha256 不符`, image.path);
        }
      }
      const ordinals = new Set<number>();
      for (const chunk of version.chunks) {
        if (chunkIds.has(chunk.id)) invalid(`分块「${chunk.id}」ID 重复`);
        chunkIds.add(chunk.id);
        if (ordinals.has(chunk.ordinal)) {
          invalid(`版本「${version.id}」的分块序号 ${chunk.ordinal} 重复`);
        }
        ordinals.add(chunk.ordinal);
        const hasImage = 'image' in chunk.metadata;
        const hasRole = 'imageRole' in chunk.metadata;
        if (!hasImage && !hasRole) continue;
        const parsed = knowledgeImageChunkMetadataSchema.safeParse(chunk.metadata);
        if (!parsed.success) {
          invalid(
            `版本「${version.id}」的分块图片定位不合法：${parsed.error.issues[0]?.message ?? ''}`,
          );
        }
        if (chunk.kind !== 'image') {
          invalid(
            `版本「${version.id}」的分块 ${chunk.ordinal} 带图片 metadata 但 kind 不是 image`,
          );
        }
        if (!hasImage) {
          invalid(`版本「${version.id}」的分块 ${chunk.ordinal} 有 imageRole 但缺少 image`);
        }
        const image = imageByName.get(parsed.data.image.name);
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
    if (
      document.contentKind === 'faq' &&
      document.pending === null &&
      !document.versions.some((version) => version.faq !== null)
    ) {
      invalid(`FAQ 文档「${document.title}」缺少问答数据`);
    }
  }

  const wikiPageIds = new Set<string>();
  for (const page of manifest.wikiPages) {
    if (wikiPageIds.has(page.id)) invalid(`Wiki 页面「${page.slug}」ID 重复`);
    wikiPageIds.add(page.id);
    const numbers = new Set<number>();
    const pageVersionIds = new Set<string>();
    for (const version of page.versions) {
      if (numbers.has(version.version)) invalid(`Wiki 页面「${page.slug}」版本号重复`);
      numbers.add(version.version);
      if (pageVersionIds.has(version.id)) invalid(`Wiki 页面「${page.slug}」版本 ID 重复`);
      pageVersionIds.add(version.id);
      for (const id of version.sourceChunkIds) {
        if (!chunkIds.has(id)) invalid(`Wiki 页面「${page.slug}」引用了包内不存在的分块`);
      }
      for (const id of version.unresolvedSourceChunkIds) {
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
        if (sourceChunks.has(source.chunkId)) {
          invalid(`Wiki 页面「${page.slug}」重复引用同一分块`);
        }
        sourceChunks.add(source.chunkId);
      }
    }
  }

  const parentById = new Map(manifest.wikiPages.map((page) => [page.id, page.parentId]));
  for (const page of manifest.wikiPages) {
    if (page.parentId !== null && !wikiPageIds.has(page.parentId)) {
      invalid(`Wiki 页面「${page.slug}」的父页面不在包内`);
    }
    const seen = new Set<string>();
    let current: string | null = page.id;
    while (current !== null) {
      if (seen.has(current)) invalid(`Wiki 页面「${page.slug}」的目录关系存在循环`);
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
  }
}
