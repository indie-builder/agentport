import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  AppError,
  chunkBlocks,
  decryptSecrets,
  embedImages,
  embedTexts,
  encryptSecrets,
  fail,
  inspectKnowledgeAudio,
  isAppError,
  KnowledgeModelError,
  markdownBlocks,
  rerankDocuments,
  segmentForSearch,
  sha256Hex,
} from '@agentport/core';
import { type Database, newId, repo, schema } from '@agentport/db';
import type {
  KnowledgeBaseSettings,
  KnowledgeFaq,
  KnowledgeFaqImportIssue,
  KnowledgeFaqImportResponse,
  KnowledgeFaqImportResult,
  KnowledgeFaqImportState,
  KnowledgeJobPayload,
  KnowledgeSearchQuery,
  KnowledgeSearchResult,
  KnowledgeSourceInput,
  KnowledgeTarget,
} from '@agentport/shared';
import {
  knowledgeBaseSettingsSchema,
  knowledgeFaqImportMetadataSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeJobPayloadSchema,
  knowledgeSourceInputSchema,
  knowledgeSourceRangeExternalIdMax,
} from '@agentport/shared';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { isPgCode } from '../../http/errors.js';
import { INVALID_CRON_MESSAGE, isSchedulableCron } from '../../lib/cron.js';
import { publishKnowledgeCancel } from '../../queue/producer.js';
import { assertSafeUrl } from '../servers/ssrf.js';
import {
  FAQ_MAX_BYTES,
  type FaqExistingEntry,
  type FaqInput,
  type FaqTransferEntry,
  newFaqImportBatchId,
  normalizeFaqEntry,
  normalizeFaqQuestion,
  parseFaqImport,
  planFaqImport,
  serializeFaqExport,
} from './faq.js';
import {
  exportKnowledgePackage,
  importKnowledgePackage,
  KNOWLEDGE_PACKAGE_MAX_BYTES,
} from './package.js';
import { searchKnowledge } from './retrieval.js';
import {
  EVALUATION_MAX_BYTES,
  evaluateRetrieval,
  type RetrievalEvaluationReport,
} from './retrieval-evaluation.js';
import {
  blobPathFor,
  createJob,
  documentWire,
  enqueueKnowledgeJob,
  ensureKnowledgeServer,
  type KnowledgeDocumentRow,
  storeBlob,
  supportsImageVectors,
} from './service.js';

export type KnowledgeDeps = {
  db: Database;
  config: Config;
  log: Logger;
  requestId: string;
  actor: string;
};

export function depsOf(context: RequestContext): KnowledgeDeps {
  return {
    db: context.db,
    config: context.config,
    log: context.log,
    requestId: context.requestId,
    actor: actorOf(context),
  };
}

type PageQuery = { cursor?: string | undefined; limit?: number | undefined };

type RangeInput = KnowledgeSourceInput['ranges'][number];

type SourcePatch = {
  name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  secrets?: Record<string, string> | undefined;
  status?: 'active' | 'paused' | 'disabled' | undefined;
  syncCron?: string | null | undefined;
  ranges?: RangeInput[] | undefined;
};

export type KnowledgeSourceRow = typeof schema.knowledgeSources.$inferSelect;
type RangeRow = typeof schema.knowledgeSourceRanges.$inferSelect;
type SyncRunRow = typeof schema.knowledgeSyncRuns.$inferSelect;
type DocumentRow = KnowledgeDocumentRow;
type VersionRow = typeof schema.knowledgeDocumentVersions.$inferSelect;
type WikiPageRow = typeof schema.knowledgeWikiPages.$inferSelect;
type FolderRow = Awaited<ReturnType<typeof repo.knowledge.listFolders>>['items'][number];
type TagRow = Awaited<ReturnType<typeof repo.knowledge.listTags>>[number];
type ProfileRow = Awaited<ReturnType<typeof repo.knowledge.listModelProfiles>>[number];
type ChunkRow = Awaited<ReturnType<typeof repo.knowledge.listChunkSummaries>>['items'][number];
type FullChunkRow = typeof schema.knowledgeChunks.$inferSelect;

const URL_FETCH_TIMEOUT_MS = 20_000;
const MAX_URL_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const KNOWLEDGE_UPLOAD_BODY_LIMIT = 48 * 1024 * 1024;
const MANUAL_BODY_LIMIT = 2 * 1024 * 1024;
const FAQ_IMPORT_BODY_LIMIT = 3 * 1024 * 1024;

function assertBodyBytes(value: string, limit: number): void {
  if (Buffer.byteLength(value, 'utf8') > limit) {
    throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
  }
}
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ACCEPTED_TYPES: Record<string, string> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

function pageOptions(query: PageQuery): { cursor?: string; limit?: number } {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function notFound(what: string): never {
  throw new AppError('NOT_FOUND', `${what}不存在，可能已被删除；请刷新后重试`);
}

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

function toJob(
  row:
    | Awaited<ReturnType<typeof repo.knowledge.listJobs>>['items'][number]
    | NonNullable<Awaited<ReturnType<typeof repo.knowledge.getJob>>>,
) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    step: row.step,
    progress: row.progress,
    attempts: row.attempts,
    error: row.error,
    result: row.result,
    documentId: row.documentId,
    sourceId: row.sourceId,
    documentTitle: 'documentTitle' in row ? row.documentTitle : null,
    sourceName: 'sourceName' in row ? row.sourceName : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

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

function decodeBase64(value: string): Buffer | null {
  const data = Buffer.from(value, 'base64');
  if (data.length === 0) return null;
  return data.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? data : null;
}

function fileTitle(filename: string): string {
  const withoutExtension = basename(filename).replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return (withoutExtension.length > 0 ? withoutExtension : filename).slice(0, 300);
}

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

function imageCapabilityProblem(input: {
  kind: 'embedding' | 'rerank' | 'asr';
  model: string;
  embeddingProtocol: 'openai' | 'cohere_v2';
  imageInputEnabled: boolean;
}): string | null {
  if (!input.imageInputEnabled) return null;
  if (input.kind === 'asr') return 'ASR profile 不支持图片输入';
  if (input.kind !== 'embedding') return '只有 embedding profile 可以开启图片输入';
  if (!supportsImageVectors(input)) {
    return '图片输入需要 embeddingProtocol=cohere_v2 且 model=embed-v4.0';
  }
  return null;
}

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
  if (
    !settings.imageProcessing.imageVectorEnabled ||
    (embedding.enabled && supportsImageVectors(embedding))
  )
    return null;
  return (
    '图片向量需要当前 embedding profile 为 cohere_v2 + embed-v4.0 且开启图片输入；' +
    '请先创建并切换到满足条件的 profile'
  );
}

function relativePathParts(raw: string): string[] | null {
  if (raw.includes('\\')) return null;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  if ([...raw].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts;
}

async function folderForPath(
  db: Database,
  baseId: string,
  rootFolderId: string | null,
  parts: string[],
): Promise<string | null> {
  let parentId = rootFolderId;
  let parentPath = '';
  if (rootFolderId !== null) {
    const root = await repo.knowledge.getFolder(db, rootFolderId);
    if (!root || root.baseId !== baseId) throw new Error('root folder missing');
    parentPath = root.path;
  }
  for (const name of parts) {
    const path = `${parentPath}/${name}`;
    const existing = await db
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
        const created = await repo.knowledge.createFolder(db, { baseId, parentId, name, path });
        parentId = created.id;
      } catch (err) {
        if (!isPgCode(err, '23505')) throw err;
        const [row] = await db
          .select({ id: schema.knowledgeFolders.id })
          .from(schema.knowledgeFolders)
          .where(
            and(eq(schema.knowledgeFolders.baseId, baseId), eq(schema.knowledgeFolders.path, path)),
          )
          .limit(1);
        if (!row) throw err;
        parentId = row.id;
      }
    }
    parentPath = path;
  }
  return parentId;
}

async function collectChunks(db: Database, versionId: string): Promise<FullChunkRow[]> {
  const items: FullChunkRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await repo.knowledge.listChunks(db, versionId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === cursor) return items;
    cursor = page.nextCursor;
  }
}

function cloneChunk(chunk: FullChunkRow): repo.knowledge.NewChunk {
  return {
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
  };
}

function preparedVersionInput(
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
  versionId: string,
  markdown: string,
): repo.knowledge.EditDocumentChunksInput['preparedVersion'] {
  return {
    id: versionId,
    blobSha256: current.blobSha256,
    markdownSha256: sha256Hex(Buffer.from(markdown, 'utf8')),
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
  };
}

async function copyVersionImages(
  sourceDir: string,
  targetDir: string,
  images: Array<{ name: string }>,
): Promise<void> {
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
}

async function prepareVersionFiles(
  config: Config,
  documentId: string,
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getVersion>>>,
  versionId: string,
  markdown: string,
): Promise<string> {
  const dir = join(config.KNOWLEDGE_DIR, 'docs', documentId, versionId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'markdown.md'), markdown, 'utf8');
    await copyVersionImages(
      join(config.KNOWLEDGE_DIR, 'docs', documentId, current.id, 'images'),
      join(dir, 'images'),
      current.images,
    );
    return dir;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function discardUncommittedVersion(
  db: Database,
  dir: string,
  versionId: string,
): Promise<void> {
  try {
    if (await repo.knowledge.getVersion(db, versionId)) return;
  } catch {
    return;
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function enqueueChunkReindex(
  deps: KnowledgeDeps,
  baseId: string,
  documentId: string,
): Promise<string | null> {
  const job = await createJob(deps.db, {
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
    await deps.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
    deps.log.warn({ err, documentId }, 'knowledge chunk reindex enqueue failed');
    return null;
  }
}

async function sourceScopeAllowsEnable(db: Database, documentId: string): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(sql`
    select ${repo.knowledge.readableDocumentSql('probe')} as ok
    from (
      select d.id, 'ready'::text as status, d.current_version_id, null::text as disabled_reason,
             d.source_connection_id, d.base_id, d.source_path
      from knowledge_documents d
      where d.id = ${documentId}
    ) probe
  `);
  return result[0]?.ok === true;
}

async function sourceRow(db: Database, sourceId: string) {
  const source = await repo.knowledge.getSource(db, sourceId);
  if (!source) return null;
  return { source, ranges: await repo.knowledge.listRanges(db, source.id) };
}

const SENSITIVE_KEY = /(token|secret|password|apikey|credential)/i;

function publicConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !SENSITIVE_KEY.test(key)));
}

function toSource(row: KnowledgeSourceRow, ranges: RangeRow[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    type: row.type,
    name: row.name,
    config: publicConfig(row.config),
    hasSecret: row.secretsEncrypted !== null,
    status: row.status,
    syncCron: row.syncCron,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ranges: ranges.map((range) => ({
      id: range.id,
      kind: range.kind,
      externalId: range.externalId,
      ref: range.ref,
      paths: range.paths,
      enabled: range.enabled,
    })),
  };
}

function toRun(row: SyncRunRow) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    cursorBefore: row.cursorBefore,
    cursorAfter: row.cursorAfter,
    stats: row.stats,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

const GITHUB_OWNER = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/;

function githubRepoIssue(externalId: string): string | null {
  const [owner, repo, ...rest] = externalId.split('/');
  if (
    rest.length > 0 ||
    !owner ||
    !repo ||
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPO.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return `范围 ${externalId} 需为 owner/repo（owner 仅字母、数字、连字符，repo 不能是 . 或 ..）`;
  }
  return null;
}

const SOURCE_RANGE_KINDS: Partial<Record<KnowledgeSourceRow['type'], readonly string[]>> = {
  lark_wiki: ['wiki_space', 'wiki_node'],
  lark_drive: ['drive_folder'],
  notion: ['notion_page', 'notion_database', 'notion_data_source'],
  confluence: ['confluence_space', 'confluence_page'],
  yuque: ['yuque_repo'],
  dingtalk: ['dingtalk_workspace', 'dingtalk_node'],
  ima: ['ima_kb'],
  seafile: ['seafile_repo'],
  nextcloud: ['nextcloud_path'],
};

const SOURCE_IDENTITY_FIELDS: Partial<Record<KnowledgeSourceRow['type'], readonly string[]>> = {
  lark_wiki: ['appId'],
  lark_drive: ['appId'],
  confluence: ['authMode', 'baseUrl', 'email', 'cloudId'],
  dingtalk: ['clientId', 'operatorUnionId'],
  ima: ['clientId'],
  seafile: ['baseUrl'],
  nextcloud: ['baseUrl', 'username'],
};

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const ENCODED_PATH_BREAK = /%(25)*(2f|5c|00)/i;

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.endsWith('/')) return false;
  if (/[\\\0?#]/.test(value) || ENCODED_PATH_BREAK.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function siteUrlIssue(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '缺少 config.baseUrl';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'config.baseUrl 不是合法 URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'config.baseUrl 只支持 http/https';
  }
  if (url.username || url.password) return 'config.baseUrl 不能包含账号密码';
  if (url.search || url.hash) return 'config.baseUrl 不能包含查询串或片段';
  return null;
}

function identityIssues(
  type: KnowledgeSourceRow['type'],
  stored: Record<string, unknown>,
  submitted: Record<string, unknown>,
): string[] {
  const fields = SOURCE_IDENTITY_FIELDS[type];
  if (!fields) return [];
  const normalized = (value: unknown): unknown =>
    typeof value === 'string' ? value.trim() : (value ?? null);
  return fields
    .filter((field) => normalized(stored[field]) !== normalized(submitted[field]))
    .map((field) => `连接身份字段 config.${field} 创建后不可修改，请新建来源`);
}

type ConfigIssueRange = {
  kind: string;
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
};

function configIssues(
  type: KnowledgeSourceRow['type'],
  config: Record<string, unknown>,
  secrets: Record<string, string> | null,
  ranges: ConfigIssueRange[],
): string[] {
  const issues: string[] = [];
  const text = (key: string): string =>
    typeof config[key] === 'string' ? (config[key] as string).trim() : '';
  const validUrl = (key: string): boolean => {
    try {
      new URL(text(key));
      return true;
    } catch {
      return false;
    }
  };

  if (ranges.length === 0) issues.push('来源至少需要一个范围');
  else if (!ranges.some((range) => range.enabled)) issues.push('至少需要一个启用的范围');

  const allowedKinds = SOURCE_RANGE_KINDS[type];
  if (allowedKinds) {
    const maxExternalId = (
      knowledgeSourceRangeExternalIdMax as Partial<Record<KnowledgeSourceRow['type'], number>>
    )[type];
    for (const range of ranges) {
      if (maxExternalId !== undefined && range.externalId.length > maxExternalId) {
        issues.push(`范围 ${range.externalId.slice(0, 40)} 的 ID 超过 ${maxExternalId} 字符`);
      }
      if (range.ref !== null) issues.push(`范围 ${range.externalId} 不应填写 ref`);
      if (type === 'seafile') {
        if (new Set(range.paths).size !== range.paths.length) {
          issues.push(`范围 ${range.externalId} 的目录不能重复`);
        }
        for (const path of range.paths) {
          if (!safeRelativePath(path)) {
            issues.push(`范围 ${range.externalId} 的目录 ${path} 必须是库内相对路径`);
          }
        }
      } else if (range.paths.length > 0) {
        issues.push(`范围 ${range.externalId} 不支持 paths`);
      }
      if (!range.enabled) continue;
      if (!allowedKinds.includes(range.kind)) {
        issues.push(
          `范围 ${range.externalId} 的类型必须属于 ${allowedKinds.join('、')}（当前 ${range.kind}）`,
        );
      }
    }
  }

  if (type === 'feishu_wiki' || type === 'feishu_drive') {
    if (!text('appId')) issues.push('缺少 config.appId');
    if (!secrets?.appSecret) issues.push('缺少凭证 appSecret');
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
  }
  if (type === 'gitlab') {
    if (!validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
    if (!text('projectId')) issues.push('缺少 config.projectId');
    if (!text('ref')) issues.push('缺少 config.ref');
    if (!secrets?.token) issues.push('缺少凭证 token');
  }
  if (type === 'github') {
    if (text('baseUrl') && !validUrl('baseUrl')) issues.push('config.baseUrl 不是合法 URL');
    if (!text('projectId')) issues.push('缺少 config.projectId');
    if (!secrets?.token) issues.push('缺少凭证 token');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (range.kind !== 'github_repo') {
        issues.push(`范围 ${range.externalId} 的类型必须是仓库（github_repo）`);
        continue;
      }
      const issue = githubRepoIssue(range.externalId);
      if (issue) issues.push(issue);
    }
  }
  if (type === 'lark_wiki' || type === 'lark_drive') {
    if (!text('appId')) issues.push('缺少 config.appId');
    if (!secrets?.appSecret) issues.push('缺少凭证 appSecret');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!SAFE_TOKEN.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 不是合法的 Lark token`);
      }
    }
  }
  if (type === 'notion') {
    if (!secrets?.apiKey) issues.push('缺少凭证 apiKey');
    for (const range of ranges) {
      if (range.enabled && !UUID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 不是合法的 Notion UUID`);
      }
    }
  }
  if (type === 'confluence') {
    const authMode = text('authMode');
    if (authMode !== 'cloud_basic' && authMode !== 'cloud_scoped' && authMode !== 'dc_pat') {
      issues.push('config.authMode 必须是 cloud_basic、cloud_scoped 或 dc_pat');
    }
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (authMode === 'cloud_basic' || authMode === 'cloud_scoped') {
      if (!text('email')) issues.push('缺少 config.email');
      if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
      if (secrets?.pat) issues.push('凭证 pat 仅用于 dc_pat 模式');
      if (authMode === 'cloud_scoped' && !text('cloudId')) issues.push('缺少 config.cloudId');
    }
    if (authMode === 'dc_pat') {
      if (!secrets?.pat) issues.push('缺少凭证 pat');
      if (secrets?.apiToken) issues.push('凭证 apiToken 仅用于 Cloud 模式');
    }
    for (const range of ranges) {
      if (range.enabled && !POSITIVE_ID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Confluence 数字 ID`);
      }
    }
  }
  if (type === 'yuque') {
    if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
    for (const range of ranges) {
      if (!range.enabled) continue;
      if (!POSITIVE_ID.test(range.externalId) || !Number.isSafeInteger(Number(range.externalId))) {
        issues.push(`范围 ${range.externalId} 必须是正整数知识库 ID`);
      }
    }
  }
  if (type === 'dingtalk') {
    if (!text('clientId')) issues.push('缺少 config.clientId');
    if (!text('operatorUnionId')) issues.push('缺少 config.operatorUnionId');
    if (!secrets?.clientSecret) issues.push('缺少凭证 clientSecret');
  }
  if (type === 'ima') {
    if (!text('clientId')) issues.push('缺少 config.clientId');
    if (!secrets?.apiKey) issues.push('缺少凭证 apiKey');
  }
  if (type === 'seafile') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!secrets?.apiToken) issues.push('缺少凭证 apiToken');
    for (const range of ranges) {
      if (range.enabled && !UUID.test(range.externalId)) {
        issues.push(`范围 ${range.externalId} 必须是 Seafile 库 UUID`);
      }
    }
  }
  if (type === 'nextcloud') {
    const urlIssue = siteUrlIssue(config.baseUrl);
    if (urlIssue) issues.push(urlIssue);
    if (!text('username')) issues.push('缺少 config.username');
    if (!secrets?.appPassword) issues.push('缺少凭证 appPassword');
    for (const range of ranges) {
      if (!range.enabled) continue;
      const path = range.externalId;
      const valid = path === '/' || (path.startsWith('/') && safeRelativePath(path.slice(1)));
      if (!valid) issues.push(`范围 ${path} 必须是账号根目录下的绝对路径`);
    }
  }
  return issues;
}

async function fetchSource(rawUrl: string): Promise<{
  data: Buffer;
  mimeType: string;
  filename: string;
}> {
  let response: Response;
  try {
    response = await fetch(rawUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'agentport-knowledge-url/1.0',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
      },
    });
  } catch (err) {
    return fail('UPSTREAM_FAILED', '抓取目标地址失败，请确认地址可访问后重试', {
      cause: err,
      retryable: true,
    });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    fail('INVALID_URL', '目标地址返回重定向；请直接填写最终地址');
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail('UPSTREAM_FAILED', `目标地址返回 HTTP ${response.status}`, {
      retryable: response.status >= 500,
    });
  }
  const mimeType =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = ACCEPTED_TYPES[mimeType];
  if (extension === undefined) {
    await response.body?.cancel();
    fail(
      'UNSUPPORTED_MEDIA_TYPE',
      `不支持的类型 ${mimeType || '(未声明)'}；仅支持网页、PDF 与纯文本类文件`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_URL_BYTES) {
    await response.body?.cancel();
    fail('PAYLOAD_TOO_LARGE', '目标文件超过 32MiB 上限');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_URL_BYTES) {
        fail('PAYLOAD_TOO_LARGE', '目标文件超过 32MiB 上限');
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  const data = Buffer.concat(chunks);
  if (data.length === 0) fail('UPSTREAM_FAILED', '目标地址返回空内容');
  const path = new URL(rawUrl).pathname;
  const rawName = basename(path);
  const name = rawName.length > 0 && rawName !== '/' ? safeDecode(rawName) : 'index';
  const filename = extname(name) === '' ? `${name}.${extension}` : name;
  return { data, mimeType, filename };
}

// ---- bases ----------------------------------------------------------------

export async function listBases(deps: KnowledgeDeps, query: PageQuery) {
  const page = await repo.knowledge.listBases(deps.db, pageOptions(query));
  return { items: page.items.map(toBase), nextCursor: page.nextCursor };
}

export async function createBase(
  deps: KnowledgeDeps,
  input: {
    slug: string;
    name: string;
    description: string;
    embeddingProfileId: string;
    rerankProfileId: string | null;
    asrProfileId: string | null;
    /** 省略时按表默认 active；复制已有库时沿用源库状态。 */
    status?: 'active' | 'disabled' | undefined;
    settings: KnowledgeBaseSettings;
  },
) {
  const [embedding, rerank, asr] = await Promise.all([
    repo.knowledge.getModelProfileWithSecret(deps.db, input.embeddingProfileId),
    input.rerankProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, input.rerankProfileId)
      : null,
    input.asrProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, input.asrProfileId)
      : null,
  ]);
  if (!embedding || embedding.kind !== 'embedding' || !embedding.enabled) {
    throw new AppError('INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
  }
  if (input.rerankProfileId && (!rerank || rerank.kind !== 'rerank' || !rerank.enabled)) {
    throw new AppError('INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
  }
  if (input.asrProfileId && (!asr || asr.kind !== 'asr' || !asr.enabled)) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
  }
  const settingsProblem = await imageSettingsProblem(input.settings, embedding);
  if (settingsProblem !== null) throw new AppError('CONFLICT', settingsProblem);
  try {
    const server = await ensureKnowledgeServer(deps.db, { slug: input.slug });
    const row = await repo.knowledge.createBase(deps.db, {
      slug: input.slug,
      name: input.name,
      description: input.description,
      serverId: server.id,
      embeddingProfileId: input.embeddingProfileId,
      rerankProfileId: input.rerankProfileId,
      asrProfileId: input.asrProfileId,
      status: input.status,
      settings: input.settings,
    });
    await ensureKnowledgeServer(deps.db, { slug: row.slug, id: row.id, serverId: server.id });
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.base.created',
      target: row.id,
      input: { slug: row.slug },
      status: 'ok',
      requestId: deps.requestId,
    });
    return toBase(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '该 slug 已被占用，请换一个');
    throw err;
  }
}

export async function getBase(deps: KnowledgeDeps, id: string) {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  return toBase(row);
}

type UpdateBaseBody = {
  name?: string | undefined;
  description?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
  embeddingProfileId?: string | undefined;
  rerankProfileId?: string | null | undefined;
  asrProfileId?: string | null | undefined;
  settings?:
    | {
        chunkTokens?: number | undefined;
        chunkOverlap?: number | undefined;
        wikiAutoUpdate?: boolean | undefined;
        imageProcessing?: Partial<KnowledgeBaseSettings['imageProcessing']> | undefined;
      }
    | undefined;
};

function settingsChanged(current: KnowledgeBaseSettings, next: KnowledgeBaseSettings): boolean {
  if (
    current.chunkTokens !== next.chunkTokens ||
    current.chunkOverlap !== next.chunkOverlap ||
    current.wikiAutoUpdate !== next.wikiAutoUpdate
  ) {
    return true;
  }
  const keys = Object.keys(next.imageProcessing) as Array<
    keyof KnowledgeBaseSettings['imageProcessing']
  >;
  return keys.some((key) => current.imageProcessing[key] !== next.imageProcessing[key]);
}

/**
 * 审计只记被改动的字段名，不记值；空 patch 或提交了与原值相同的字段都不算变更，
 * 免得活动流里出现「更新知识库」却没有实际改动。
 */
function changedBaseFields(
  current: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>,
  body: UpdateBaseBody,
  settings: KnowledgeBaseSettings,
): string[] {
  const fields: string[] = [];
  if (body.name !== undefined && body.name !== current.name) fields.push('name');
  if (body.description !== undefined && body.description !== current.description) {
    fields.push('description');
  }
  if (body.status !== undefined && body.status !== current.status) fields.push('status');
  if (
    body.embeddingProfileId !== undefined &&
    body.embeddingProfileId !== current.embeddingProfileId
  ) {
    fields.push('embeddingProfileId');
  }
  if (body.rerankProfileId !== undefined && body.rerankProfileId !== current.rerankProfileId) {
    fields.push('rerankProfileId');
  }
  if (body.asrProfileId !== undefined && body.asrProfileId !== current.asrProfileId) {
    fields.push('asrProfileId');
  }
  if (body.settings !== undefined && settingsChanged(current.settings, settings)) {
    fields.push('settings');
  }
  return fields;
}

export async function updateBase(deps: KnowledgeDeps, id: string, body: UpdateBaseBody) {
  const current = await repo.knowledge.getBase(deps.db, id);
  if (!current) notFound('知识库');
  const settingsPatch = body.settings;
  const merged = knowledgeBaseSettingsSchema.safeParse({
    chunkTokens: settingsPatch?.chunkTokens ?? current.settings.chunkTokens,
    chunkOverlap: settingsPatch?.chunkOverlap ?? current.settings.chunkOverlap,
    wikiAutoUpdate: settingsPatch?.wikiAutoUpdate ?? current.settings.wikiAutoUpdate,
    imageProcessing: {
      ...current.settings.imageProcessing,
      ...settingsPatch?.imageProcessing,
    },
  });
  if (!merged.success) {
    throw new AppError('INVALID_INPUT', merged.error.issues[0]?.message ?? '知识库设置不合法');
  }
  const settings: KnowledgeBaseSettings = merged.data;
  const nextEmbeddingProfileId = body.embeddingProfileId ?? current.embeddingProfileId;
  const nextRerankProfileId =
    body.rerankProfileId === undefined ? current.rerankProfileId : body.rerankProfileId;
  const nextAsrProfileId =
    body.asrProfileId === undefined ? current.asrProfileId : body.asrProfileId;
  const [embedding, rerank, asr] = await Promise.all([
    repo.knowledge.getModelProfileWithSecret(deps.db, nextEmbeddingProfileId),
    nextRerankProfileId
      ? repo.knowledge.getModelProfileWithSecret(deps.db, nextRerankProfileId)
      : null,
    nextAsrProfileId ? repo.knowledge.getModelProfileWithSecret(deps.db, nextAsrProfileId) : null,
  ]);
  if (nextEmbeddingProfileId !== current.embeddingProfileId) {
    if (!embedding || embedding.kind !== 'embedding' || !embedding.enabled) {
      throw new AppError('INVALID_INPUT', 'embedding profile 不存在、类型不符或已禁用');
    }
  } else if (!embedding) {
    throw new AppError('INVALID_INPUT', 'embedding profile 不存在，可能已被删除');
  }
  if (nextRerankProfileId !== current.rerankProfileId) {
    if (nextRerankProfileId && (!rerank || rerank.kind !== 'rerank' || !rerank.enabled)) {
      throw new AppError('INVALID_INPUT', 'rerank profile 不存在、类型不符或已禁用');
    }
  }
  if (nextAsrProfileId !== current.asrProfileId) {
    if (nextAsrProfileId && (!asr || asr.kind !== 'asr' || !asr.enabled)) {
      throw new AppError('INVALID_INPUT', 'ASR profile 不存在、类型不符或已禁用');
    }
  } else if (nextAsrProfileId && !asr) {
    throw new AppError('INVALID_INPUT', 'ASR profile 不存在，可能已被删除');
  }
  const settingsProblem = await imageSettingsProblem(settings, embedding);
  if (settingsProblem !== null) throw new AppError('CONFLICT', settingsProblem);
  const { settings: _settings, ...rest } = body;
  const fields = changedBaseFields(current, body, settings);
  const row = await repo.knowledge.updateBase(deps.db, current.id, {
    ...rest,
    ...(settingsPatch === undefined ? {} : { settings }),
  });
  if (!row) notFound('知识库');
  if (fields.length > 0) {
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.base.updated',
      target: row.id,
      input: { fields },
      status: 'ok',
      requestId: deps.requestId,
    });
  }
  return toBase(row);
}

export async function deleteBase(deps: KnowledgeDeps, id: string): Promise<void> {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  const unbound = await deps.db.execute<{ agent_id: string }>(
    sql`select agent_id from agent_servers where server_id = ${row.serverId}`,
  );
  await repo.servers.deleteServer(deps.db, row.serverId);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.deleted',
    target: row.id,
    input: { unboundAgents: unbound.map((entry) => entry.agent_id) },
    status: 'ok',
    requestId: deps.requestId,
  });
}

export async function getBaseSummary(deps: KnowledgeDeps, id: string) {
  const summary = await repo.knowledge.getBaseSummary(deps.db, id);
  if (!summary) notFound('知识库');
  return {
    documents: summary.documents,
    faqs: summary.faqs,
    wikiPages: summary.wikiPages,
    sources: summary.sources,
    folders: summary.folders,
    tags: summary.tags,
    lastJob:
      summary.lastJob === null
        ? null
        : {
            id: summary.lastJob.id,
            type: summary.lastJob.type,
            status: summary.lastJob.status,
            createdAt: summary.lastJob.createdAt.toISOString(),
            updatedAt: summary.lastJob.updatedAt.toISOString(),
          },
  };
}

/**
 * 活动流只读：库不存在按对象不存在处理，其余口径由 repo 的单条 SQL 决定。
 * 与概览其它读数一致，时间统一转 ISO 字符串出 wire。
 */
export async function listBaseActivity(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listBaseActivity(deps.db, id, pageOptions(query));
  return {
    items: page.items.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actor: entry.actor,
      status: entry.status,
      targetKind: entry.targetKind,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

const CHUNK_PREVIEW_MAX_CHUNKS = 50;

/**
 * 分块预览：只按传入样本与当前/草稿分块参数算一次切分，不读写库内容、不入队、不调模型。
 * chunkTokens 是字符预算，与 worker 摄取时的口径一致。
 */
export async function previewChunks(
  deps: KnowledgeDeps,
  id: string,
  body: { sample: string; chunkTokens?: number | undefined; chunkOverlap?: number | undefined },
) {
  const row = await repo.knowledge.getBase(deps.db, id);
  if (!row) notFound('知识库');
  const chunkTokens = body.chunkTokens ?? row.settings.chunkTokens;
  const chunkOverlap = body.chunkOverlap ?? row.settings.chunkOverlap;
  if (chunkOverlap >= chunkTokens) {
    throw new AppError('INVALID_INPUT', '分块重叠必须小于分块长度');
  }
  const blocks = markdownBlocks(body.sample, (line, offset = 0, endOffset = offset) => ({
    page: 'unknown',
    line,
    startOffset: offset,
    endOffset,
  }));
  // 与摄取共用 chunkBlocks：clamp 超长块、表格/代码独立成块，预览块数才与真实分块一致。
  const chunks = chunkBlocks(blocks, body.sample, {
    chunkSize: chunkTokens,
    chunkOverlap,
  });
  const lengths = chunks.map((chunk) => chunk.content.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return {
    chunks: chunks.slice(0, CHUNK_PREVIEW_MAX_CHUNKS).map((chunk, index) => ({
      index,
      heading: chunk.heading,
      content: chunk.content,
      length: chunk.content.length,
    })),
    stats: {
      count: chunks.length,
      avgChars: lengths.length === 0 ? 0 : Math.round(total / lengths.length),
      minChars: lengths.length === 0 ? 0 : Math.min(...lengths),
      maxChars: lengths.length === 0 ? 0 : Math.max(...lengths),
    },
    truncated: chunks.length > CHUNK_PREVIEW_MAX_CHUNKS,
  };
}

const DUPLICATE_NAME_MAX = 120;
const DUPLICATE_SLUG_MAX = 64;
const DUPLICATE_SLUG_SUFFIX = '-copy';

/** slug 上限 64：截断源 slug 让后缀完整保留；末尾字符仍是源 slug 的合法字符。 */
function slugWithSuffix(sourceSlug: string, suffix: string): string {
  return `${sourceSlug.slice(0, DUPLICATE_SLUG_MAX - suffix.length)}${suffix}`;
}

/**
 * 副本 slug：先试 `-copy`，被占用就依次试 `-2`、`-3`……直到找到空位。
 * 每个候选都查唯一索引，命中数量受库里已有副本数限制，不会无限循环；
 * 真正的并发抢占仍由 knowledge_bases_slug_idx 与 createBase 的冲突映射兜底。
 */
async function availableCopySlug(deps: KnowledgeDeps, sourceSlug: string): Promise<string> {
  const preferred = slugWithSuffix(sourceSlug, DUPLICATE_SLUG_SUFFIX);
  if (!(await repo.knowledge.baseSlugExists(deps.db, preferred))) return preferred;
  for (let index = 2; ; index += 1) {
    const candidate = slugWithSuffix(sourceSlug, `-${index}`);
    if (!(await repo.knowledge.baseSlugExists(deps.db, candidate))) return candidate;
  }
}

/**
 * 复制知识库只派生配置，不搬内容：profiles / settings / status / description 沿用源库，
 * 文档、FAQ、Wiki、来源、文件夹、标签都留在源库。创建路径仍走 createBase，不另写一套。
 */
export async function duplicateBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    name?: string | undefined;
    slug?: string | undefined;
    description?: string | undefined;
  },
) {
  const source = await repo.knowledge.getBase(deps.db, id);
  if (!source) notFound('知识库');
  const row = await createBase(deps, {
    slug: body.slug ?? (await availableCopySlug(deps, source.slug)),
    name: body.name ?? `${source.name.slice(0, DUPLICATE_NAME_MAX - 3)} 副本`,
    description: body.description ?? source.description,
    embeddingProfileId: source.embeddingProfileId,
    rerankProfileId: source.rerankProfileId,
    asrProfileId: source.asrProfileId,
    status: source.status,
    settings: source.settings,
  });
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.duplicated',
    target: row.id,
    input: { sourceId: source.id, slug: row.slug },
    status: 'ok',
    requestId: deps.requestId,
  });
  return row;
}

// ---- folders / tags -------------------------------------------------------

export async function listFolders(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listFolders(deps.db, id, pageOptions(query));
  return page.items.map(toFolder);
}

export async function createFolder(
  deps: KnowledgeDeps,
  id: string,
  body: { parentId: string | null; name: string },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const parent = body.parentId ? await repo.knowledge.getFolder(deps.db, body.parentId) : null;
  if (body.parentId && (!parent || parent.baseId !== base.id)) {
    throw new AppError('INVALID_INPUT', '父文件夹不存在或属于其他知识库');
  }
  try {
    const row = await repo.knowledge.createFolder(deps.db, {
      baseId: base.id,
      parentId: parent?.id ?? null,
      name: body.name,
      path: parent ? `${parent.path}/${body.name}` : `/${body.name}`,
    });
    return toFolder(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同级下已有同名文件夹');
    throw err;
  }
}

export async function updateFolder(
  deps: KnowledgeDeps,
  folderId: string,
  body: { name?: string | undefined; parentId?: string | null | undefined },
) {
  const current = await repo.knowledge.getFolder(deps.db, folderId);
  if (!current) notFound('文件夹');
  try {
    const row = (await repo.knowledge.updateFolder(deps.db, current.id, body)) ?? current;
    return toFolder(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同级下已有同名文件夹');
    throw err;
  }
}

export async function deleteFolder(deps: KnowledgeDeps, folderId: string): Promise<void> {
  if (!(await repo.knowledge.deleteFolder(deps.db, folderId))) notFound('文件夹');
}

export async function listTags(deps: KnowledgeDeps, id: string) {
  const rows = await repo.knowledge.listTags(deps.db, id);
  return rows.map(toTag);
}

export async function createTag(deps: KnowledgeDeps, id: string, name: string) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const row = await repo.knowledge.upsertTag(deps.db, id, name);
  return toTag(row);
}

export async function renameTag(deps: KnowledgeDeps, tagId: string, name: string) {
  try {
    const row = await repo.knowledge.updateTag(deps.db, tagId, name);
    if (!row) notFound('标签');
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.tag.renamed',
      target: row.id,
      input: { name: row.name, baseId: row.baseId },
      status: 'ok',
      requestId: deps.requestId,
    });
    return toTag(row);
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同名标签已存在');
    throw err;
  }
}

export async function deleteTag(deps: KnowledgeDeps, tagId: string): Promise<void> {
  if (!(await repo.knowledge.deleteTag(deps.db, tagId))) notFound('标签');
}

// ---- documents ------------------------------------------------------------

export async function listDocuments(
  deps: KnowledgeDeps,
  id: string,
  query: PageQuery & {
    folderId?: string | undefined;
    tag?: string | undefined;
    status?: 'pending' | 'processing' | 'ready' | 'failed' | 'disabled' | undefined;
    q?: string | undefined;
  },
) {
  const { folderId, tag, status, q, ...rest } = query;
  const page = await repo.knowledge.listDocuments(deps.db, {
    ...pageOptions(rest),
    baseId: id,
    contentKind: 'document',
    ...(folderId === undefined ? {} : { folderId: folderId === 'null' ? null : folderId }),
    ...(tag === undefined ? {} : { tag }),
    ...(status === undefined ? {} : { status }),
    ...(q === undefined ? {} : { q }),
  });
  const tags = await repo.knowledge.getDocumentTagNames(
    deps.db,
    page.items.map((row) => row.id),
  );
  return {
    items: page.items.map((row) => documentWire(row, tags.get(row.id) ?? [])),
    nextCursor: page.nextCursor,
  };
}

async function documentWithTags(deps: KnowledgeDeps, row: DocumentRow) {
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [row.id]);
  return documentWire(row, tags.get(row.id) ?? []);
}

async function enqueue(
  deps: KnowledgeDeps,
  payload: KnowledgeJobPayload,
  refs: {
    baseId: string | null;
    documentId: string | null;
    sourceId?: string | null | undefined;
  },
) {
  const job = await createJob(deps.db, {
    baseId: refs.baseId,
    documentId: refs.documentId,
    ...(refs.sourceId === undefined ? {} : { sourceId: refs.sourceId }),
    payload,
  });
  await enqueueKnowledgeJob(job);
  return job;
}

export async function uploadDocument(
  deps: KnowledgeDeps,
  id: string,
  body: {
    filename: string;
    mimeType: string;
    dataBase64: string;
    title?: string | undefined;
    folderId: string | null;
    relativePath?: string | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  assertBodyBytes(body.dataBase64, KNOWLEDGE_UPLOAD_BODY_LIMIT);
  const data = decodeBase64(body.dataBase64);
  if (!data) throw new AppError('INVALID_INPUT', 'dataBase64 不是合法的 base64');
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '文件解码后超过 32MiB 上限');
  }
  const audio = await inspectKnowledgeAudio({
    data,
    filename: body.filename,
    mimeType: body.mimeType,
  });
  if (audio) {
    if (base.status !== 'active') throw new AppError('CONFLICT', '知识库未启用，不能上传音频');
    if (!base.asrProfileId) {
      throw new AppError('CONFLICT', '知识库未绑定音频转录模型，不能上传音频');
    }
    const asrProfile = await repo.knowledge.getModelProfileWithSecret(deps.db, base.asrProfileId);
    if (!asrProfile || asrProfile.kind !== 'asr' || !asrProfile.enabled) {
      throw new AppError('CONFLICT', '知识库绑定的音频转录模型不存在或已禁用');
    }
  }
  const mimeType = audio?.mimeType ?? body.mimeType;
  if (body.folderId) {
    const folder = await repo.knowledge.getFolder(deps.db, body.folderId);
    if (!folder || folder.baseId !== base.id) {
      throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
    }
  }
  let folderId = body.folderId;
  let title = body.title ?? fileTitle(body.filename);
  if (body.relativePath !== undefined) {
    const parts = relativePathParts(body.relativePath);
    if (!parts) {
      throw new AppError(
        'INVALID_INPUT',
        'relativePath 必须是安全的相对路径（不能是绝对路径、.. 或空段）',
      );
    }
    folderId =
      parts.length > 1
        ? await folderForPath(deps.db, base.id, body.folderId, parts.slice(0, -1))
        : body.folderId;
    title = body.title ?? fileTitle(parts.at(-1)!);
  }
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, data);
  const document = await repo.knowledge.createDocument(deps.db, {
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
      originalFilename: body.filename,
      ...(body.relativePath === undefined ? {} : { relativePath: body.relativePath }),
    },
  });
  await repo.knowledge.updateDocument(deps.db, document.id, { contentHash: sha });
  const job = await enqueue(
    deps,
    { type: 'ingest', documentId: document.id, publish: 'automatic' },
    { baseId: base.id, documentId: document.id },
  );
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.document.uploaded',
    target: document.id,
    input: { filename: body.filename, sizeBytes: data.length },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { documentId: document.id, jobId: job.id };
}

export async function getDocument(deps: KnowledgeDeps, documentId: string) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  return documentWithTags(deps, row);
}

export async function updateDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: {
    title?: string | undefined;
    folderId?: string | null | undefined;
    status?: 'ready' | 'disabled' | undefined;
    tags?: string[] | undefined;
  },
) {
  const current = await repo.knowledge.getDocument(deps.db, documentId);
  if (!current) notFound('文档');
  const { tags, ...patch } = body;
  if (current.status === 'disabled' && patch.status === 'ready' && current.sourceConnectionId) {
    if (!(await sourceScopeAllowsEnable(deps.db, current.id))) {
      throw new AppError('CONFLICT', '来源授权已失效，需成功同步重新确认范围后才能启用');
    }
  }
  if (patch.folderId) {
    const folder = await repo.knowledge.getFolder(deps.db, patch.folderId);
    if (!folder || folder.baseId !== current.baseId) {
      throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
    }
  }
  if (current.status === 'disabled' && patch.status === 'ready') {
    const chunks = current.currentVersionId
      ? await repo.knowledge.listChunkSummaries(deps.db, current.currentVersionId, { limit: 1 })
      : null;
    if (!chunks || chunks.items.length === 0) {
      throw new AppError('CONFLICT', '当前版本没有可用分块，请先重新摄取');
    }
  }
  const row = await repo.knowledge.updateDocument(deps.db, current.id, {
    ...patch,
    ...(patch.status === 'disabled' ? { disabledReason: 'manual' } : {}),
    ...(patch.status === 'ready' ? { disabledReason: null } : {}),
  });
  if (!row) notFound('文档');
  if (patch.status === 'disabled' && current.status !== 'disabled') {
    await repo.knowledge.markWikiStaleByDocument(deps.db, row.id);
  }
  if (tags !== undefined) {
    const rows = await repo.knowledge.upsertTags(deps.db, current.baseId, tags);
    const idByName = new Map(rows.map((tag) => [tag.name, tag.id]));
    await repo.knowledge.setDocumentTags(
      deps.db,
      row.id,
      tags.map((name) => idByName.get(name)!),
    );
  }
  return documentWithTags(deps, row);
}

export async function deleteDocument(deps: KnowledgeDeps, documentId: string) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  const wikiPagesMarkedStale = await repo.knowledge.markWikiStaleByDocument(deps.db, row.id);
  await repo.knowledge.deleteDocument(deps.db, row.id);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.document.deleted',
    target: row.id,
    input: { wikiPagesMarkedStale },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { wikiPagesMarkedStale };
}

export async function reprocessDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { confirmOverwriteManualChunks: boolean },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  if (row.status === 'disabled' || row.disabledReason !== null) {
    throw new AppError('CONFLICT', '文档已停用，不能通过重解析恢复；请先完成来源同步或显式启用');
  }
  if (!row.currentVersionId) throw new AppError('CONFLICT', '文档还没有成功解析的版本');
  const manualChunkCount = await repo.knowledge.countEditedChunks(deps.db, row.currentVersionId);
  if (manualChunkCount > 0 && !body.confirmOverwriteManualChunks) {
    throw new AppError(
      'CONFLICT',
      `存在 ${manualChunkCount} 个人工编辑的分块，重解析会丢弃这些修改；请确认后重试`,
    );
  }
  const job = await enqueue(
    deps,
    {
      type: 'reindex',
      baseId: row.baseId,
      documentIds: [row.id],
      chunksOnly: false,
      confirmOverwriteManualChunks: body.confirmOverwriteManualChunks,
    },
    { baseId: row.baseId, documentId: row.id },
  );
  return { jobId: job.id };
}

export async function listChunks(
  deps: KnowledgeDeps,
  documentId: string,
  query: PageQuery & { versionId?: string | undefined },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  const versionId = query.versionId ?? row.currentVersionId;
  if (!versionId) return { items: [], nextCursor: null };
  if (versionId !== row.currentVersionId) {
    const version = await repo.knowledge.getVersion(deps.db, versionId);
    if (!version || version.documentId !== row.id) {
      throw new AppError('INVALID_INPUT', '版本不存在或不属于该文档');
    }
  }
  const page = await repo.knowledge.listChunkSummaries(deps.db, versionId, pageOptions(query));
  return { items: page.items.map(toChunk), nextCursor: page.nextCursor };
}

function editableChunkDocument(document: DocumentRow): boolean {
  if (document.contentKind === 'document') return true;
  throw new AppError('CONFLICT', 'FAQ/Wiki 内部索引不能直接编辑分块，请使用各自入口');
}

async function currentVersionForChunk(
  deps: KnowledgeDeps,
  chunk: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getChunk>>>,
  expectedVersionId: string,
) {
  const document = await repo.knowledge.getDocument(deps.db, chunk.documentId);
  if (!document) notFound('文档');
  editableChunkDocument(document);
  if (
    !document.currentVersionId ||
    chunk.versionId !== document.currentVersionId ||
    expectedVersionId !== document.currentVersionId
  ) {
    throw new AppError('CONFLICT_STALE', '只能修改当前版本的分块，请刷新后重试');
  }
  const version = await repo.knowledge.getVersion(deps.db, document.currentVersionId);
  if (!version) throw new AppError('CONFLICT', '文档当前版本已失效');
  return { document, version };
}

export async function createChunk(
  deps: KnowledgeDeps,
  documentId: string,
  body: {
    expectedVersionId: string;
    kind: 'text' | 'table' | 'image';
    heading: string | null;
    content: string;
    enabled: boolean;
  },
) {
  const row = await repo.knowledge.getDocument(deps.db, documentId);
  if (!row) notFound('文档');
  editableChunkDocument(row);
  if (!row.currentVersionId) throw new AppError('CONFLICT', '文档还没有可用版本');
  if (body.expectedVersionId !== row.currentVersionId) {
    throw new AppError('CONFLICT_STALE', '文档版本已变化，请刷新后重试');
  }
  const current = await repo.knowledge.getVersion(deps.db, row.currentVersionId);
  if (!current) throw new AppError('CONFLICT', '文档当前版本已失效');
  const currentChunks = await collectChunks(deps.db, current.id);
  const added = {
    kind: body.kind,
    heading: body.heading,
    content: body.content,
    searchText: segmentForSearch(body.content),
    embedding: null,
    tokenCount: 0,
    metadata: {},
    enabled: body.enabled,
  };
  const markdown = [...currentChunks.map((chunk) => chunk.content), added.content].join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(deps.config, row.id, current, versionId, markdown);
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: row.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'add', chunk: added },
      preparedVersion: preparedVersionInput(current, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  const jobId = await enqueueChunkReindex(deps, row.baseId, row.id);
  return {
    document: await documentWithTags(deps, result.document),
    chunk: result.chunk ? toChunk(result.chunk) : null,
    jobId,
  };
}

export async function updateChunk(
  deps: KnowledgeDeps,
  chunkId: string,
  body: {
    expectedVersionId: string;
    content?: string | undefined;
    heading?: string | null | undefined;
    enabled?: boolean | undefined;
  },
) {
  const current = await repo.knowledge.getChunk(deps.db, chunkId);
  if (!current) notFound('分块');
  const imageMetadata = knowledgeImageChunkMetadataSchema.safeParse(current.metadata);
  if (
    imageMetadata.success &&
    imageMetadata.data.imageRole === 'vector' &&
    (body.content !== undefined || body.heading !== undefined)
  ) {
    throw new AppError('CONFLICT', '图片向量分块只能启停，正文来自原图描述，不能手改');
  }
  const target = await currentVersionForChunk(deps, current, body.expectedVersionId);
  const chunks = await collectChunks(deps.db, target.version.id);
  const index = chunks.findIndex((chunk) => chunk.id === current.id);
  if (index < 0) notFound('分块');
  const contentChanged = body.content !== undefined && body.content !== current.content;
  const headingChanged = body.heading !== undefined && body.heading !== current.heading;
  const patch = {
    ...(contentChanged
      ? { content: body.content!, searchText: segmentForSearch(body.content!), embedding: null }
      : {}),
    ...(headingChanged ? { heading: body.heading ?? null } : {}),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
  };
  const nextChunks = chunks.map((chunk) =>
    chunk.id === current.id
      ? {
          content: body.content ?? chunk.content,
          heading: headingChanged ? (body.heading ?? null) : chunk.heading,
        }
      : chunk,
  );
  const markdown = nextChunks.map((chunk) => chunk.content).join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(
    deps.config,
    target.document.id,
    target.version,
    versionId,
    markdown,
  );
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: target.document.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'update', chunkId: current.id, patch },
      preparedVersion: preparedVersionInput(target.version, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  const jobId = contentChanged
    ? await enqueueChunkReindex(deps, target.document.baseId, target.document.id)
    : null;
  return {
    document: await documentWithTags(deps, result.document),
    chunk: result.chunk ? toChunk(result.chunk) : null,
    jobId,
  };
}

export async function deleteChunk(
  deps: KnowledgeDeps,
  chunkId: string,
  body: { expectedVersionId: string },
) {
  const chunk = await repo.knowledge.getChunk(deps.db, chunkId);
  if (!chunk) notFound('分块');
  const target = await currentVersionForChunk(deps, chunk, body.expectedVersionId);
  const chunks = (await collectChunks(deps.db, target.version.id)).filter(
    (row) => row.id !== chunk.id,
  );
  const markdown = chunks.map((row) => row.content).join('\n\n');
  const versionId = newId('knowledgeVersion');
  const dir = await prepareVersionFiles(
    deps.config,
    target.document.id,
    target.version,
    versionId,
    markdown,
  );
  let result: Awaited<ReturnType<typeof repo.knowledge.editDocumentChunks>>;
  try {
    result = await repo.knowledge.editDocumentChunks(deps.db, {
      documentId: target.document.id,
      expectedVersionId: body.expectedVersionId,
      mutation: { type: 'delete', chunkId: chunk.id },
      preparedVersion: preparedVersionInput(target.version, versionId, markdown),
    });
  } catch (err) {
    await discardUncommittedVersion(deps.db, dir, versionId);
    throw err;
  }
  return {
    document: await documentWithTags(deps, result.document),
    chunk: null,
    jobId: null,
  };
}

export async function listVersions(deps: KnowledgeDeps, documentId: string, query: PageQuery) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  const page = await repo.knowledge.listDocumentVersions(deps.db, document.id, pageOptions(query));
  return {
    items: page.items.map((row) => toDocumentVersion(row, document.currentVersionId)),
    nextCursor: page.nextCursor,
  };
}

export async function rollbackDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  const version = await repo.knowledge.getVersion(deps.db, body.versionId);
  if (!version || version.documentId !== document.id) {
    throw new AppError('NOT_FOUND', '版本不存在或不属于该文档');
  }
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  if (version.embeddingProfileId !== base.embeddingProfileId) {
    throw new AppError('CONFLICT', '该版本来自不同 embedding 空间，需重建后才能切换');
  }
  const row = await repo.knowledge.activateDocumentVersion(deps.db, {
    documentId: document.id,
    versionId: version.id,
    expectedVersionId: body.expectedVersionId,
  });
  return documentWithTags(deps, row);
}

// ---- manual documents -----------------------------------------------------

async function manualDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (!document) notFound('文档');
  if (document.sourceType !== 'manual' || document.contentKind !== 'document') {
    throw new AppError('INVALID_INPUT', '只有手写文档可以编辑正文');
  }
  return document;
}

async function readVersionContent(
  deps: KnowledgeDeps,
  documentId: string,
  versionId: string,
): Promise<string | null> {
  return readFile(
    join(deps.config.KNOWLEDGE_DIR, 'docs', documentId, versionId, 'markdown.md'),
    'utf8',
  ).catch(() => null);
}

function pendingDraftVersion(
  document: DocumentRow,
  versions: Awaited<ReturnType<typeof repo.knowledge.listDocumentVersions>>['items'],
) {
  return (
    versions.find(
      (row) => row.metadata.publication === 'draft' && row.id !== document.currentVersionId,
    ) ?? null
  );
}

export async function getManualDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await manualDocument(deps, documentId);
  const versions = await repo.knowledge.listDocumentVersions(deps.db, document.id, { limit: 200 });
  const draft = pendingDraftVersion(document, versions.items);
  if (draft) {
    const content = await readVersionContent(deps, document.id, draft.id);
    if (content === null) throw new AppError('NOT_FOUND', '草稿正文缺失，请重新保存');
    return { content, versionId: draft.id, status: 'draft' as const };
  }
  if (!document.currentVersionId) {
    throw new AppError('CONFLICT', '文档还没有可编辑的正文');
  }
  const content = await readVersionContent(deps, document.id, document.currentVersionId);
  if (content === null) throw new AppError('NOT_FOUND', '正文文件缺失，请重新解析该版本');
  return { content, versionId: document.currentVersionId, status: 'published' as const };
}

export async function saveManualDraft(
  deps: KnowledgeDeps,
  documentId: string,
  body: { content: string; expectedVersionId: string },
) {
  const document = await manualDocument(deps, documentId);
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  assertBodyBytes(body.content, MANUAL_BODY_LIMIT);
  const versions = await repo.knowledge.listDocumentVersions(deps.db, document.id, { limit: 200 });
  const draft = pendingDraftVersion(document, versions.items);
  const editableVersionId = draft?.id ?? document.currentVersionId;
  if (!editableVersionId || body.expectedVersionId !== editableVersionId) {
    throw new AppError('CONFLICT_STALE', '正文已被修改，请刷新后重试');
  }
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, Buffer.from(body.content, 'utf8'));
  const filename =
    typeof document.metadata.originalFilename === 'string'
      ? document.metadata.originalFilename
      : `${document.title}.md`;
  const job = await deps.db.transaction((tx) =>
    createJob(tx, {
      baseId: base.id,
      documentId: document.id,
      payload: {
        type: 'ingest',
        documentId: document.id,
        publish: 'draft',
        input: {
          blobSha256: sha,
          filename,
          mimeType: document.mimeType,
          expectedCurrentVersionId: document.currentVersionId,
        },
      },
    }),
  );
  try {
    await enqueueKnowledgeJob(job);
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: 'knowledge.document.manual_draft_saved',
      target: document.id,
      input: { versionId: body.expectedVersionId },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { documentId: document.id, jobId: job.id };
  } catch (err) {
    await deps.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
    if (isAppError(err)) throw err;
    fail('SERVICE_UNAVAILABLE', '草案任务未能提交，请稍后重试', {
      cause: err,
      retryable: true,
    });
  }
}

async function tagNames(deps: KnowledgeDeps, documentId: string): Promise<string[]> {
  return (await repo.knowledge.getDocumentTagNames(deps.db, [documentId])).get(documentId) ?? [];
}

export async function publishManualDocument(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await manualDocument(deps, documentId);
  const version = await repo.knowledge.getVersion(deps.db, body.versionId);
  if (!version || version.documentId !== document.id) {
    throw new AppError('NOT_FOUND', '版本不存在或不属于该文档');
  }
  const row = await repo.knowledge.activateDocumentVersion(deps.db, {
    documentId: document.id,
    versionId: version.id,
    expectedVersionId: body.expectedVersionId,
  });
  const published =
    row.status === 'ready' && row.disabledReason === null
      ? row
      : await repo.knowledge.updateDocument(deps.db, row.id, {
          status: 'ready',
          disabledReason: null,
        });
  return documentWire(published ?? row, await tagNames(deps, published?.id ?? row.id));
}

async function importDocument(
  deps: KnowledgeDeps,
  input: {
    baseId: string;
    folderId: string | null;
    title: string;
    sourceType: 'manual' | 'url';
    sourceUrl: string | null;
    mimeType: string;
    originalFilename: string;
    data: Buffer;
    tags: string[];
    publish?: 'draft' | 'automatic' | undefined;
  },
) {
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, input.data);
  const document = await repo.knowledge.createDocument(deps.db, {
    baseId: input.baseId,
    folderId: input.folderId,
    title: input.title,
    sourceType: input.sourceType,
    sourceId: null,
    sourceUrl: input.sourceUrl,
    sourcePath: null,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    metadata: { originalFilename: input.originalFilename },
  });
  try {
    await repo.knowledge.updateDocument(deps.db, document.id, { contentHash: sha });
    if (input.tags.length > 0) {
      const rows = await repo.knowledge.upsertTags(deps.db, input.baseId, input.tags);
      await repo.knowledge.setDocumentTags(
        deps.db,
        document.id,
        rows.map((tag) => tag.id),
      );
    }
    const job = await enqueue(
      deps,
      {
        type: 'ingest',
        documentId: document.id,
        publish: input.publish ?? 'automatic',
        input: {
          blobSha256: sha,
          filename: input.originalFilename,
          mimeType: input.mimeType,
          expectedCurrentVersionId: null,
        },
      },
      { baseId: input.baseId, documentId: document.id },
    );
    await repo.audit.writeAudit(deps.db, deps.log, {
      actor: deps.actor,
      action: `knowledge.document.${input.sourceType}_imported`,
      target: document.id,
      input: {
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        sizeBytes: input.data.length,
      },
      status: 'ok',
      requestId: deps.requestId,
    });
    return { documentId: document.id, jobId: job.id };
  } catch (err) {
    await repo.knowledge.deleteDocument(deps.db, document.id).catch(() => undefined);
    if (isAppError(err)) throw err;
    fail('SERVICE_UNAVAILABLE', '导入任务未能提交，请稍后重试', { cause: err, retryable: true });
  }
}

async function loadActiveBase(deps: KnowledgeDeps, id: string) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再导入');
  return base;
}

async function folderIssue(deps: KnowledgeDeps, baseId: string, folderId: string | null) {
  if (!folderId) return false;
  const folder = await repo.knowledge.getFolder(deps.db, folderId);
  return !folder || folder.baseId !== baseId;
}

export async function createManualDocument(
  deps: KnowledgeDeps,
  id: string,
  body: {
    title: string;
    content: string;
    folderId: string | null;
    tags: string[];
  },
) {
  const base = await loadActiveBase(deps, id);
  if (await folderIssue(deps, base.id, body.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  assertBodyBytes(body.content, MANUAL_BODY_LIMIT);
  return importDocument(deps, {
    baseId: base.id,
    folderId: body.folderId,
    title: body.title,
    sourceType: 'manual',
    sourceUrl: null,
    mimeType: 'text/markdown',
    originalFilename: `${body.title.replace(/[/\\]/g, '-')}.md`,
    data: Buffer.from(body.content, 'utf8'),
    tags: body.tags,
    publish: 'draft',
  });
}

export async function createUrlDocument(
  deps: KnowledgeDeps,
  id: string,
  body: { url: string; title?: string | undefined; folderId: string | null },
) {
  const base = await loadActiveBase(deps, id);
  if (await folderIssue(deps, base.id, body.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  const sourceUrl = new URL(body.url).href;
  await assertSafeUrl(sourceUrl, deps.config.NODE_ENV);
  const fetched = await fetchSource(sourceUrl);
  return importDocument(deps, {
    baseId: base.id,
    folderId: body.folderId,
    title: body.title ?? titleFromFilename(fetched.filename),
    sourceType: 'url',
    sourceUrl,
    mimeType: fetched.mimeType,
    originalFilename: fetched.filename,
    data: fetched.data,
    tags: [],
  });
}

// ---- search / rebuild / batch --------------------------------------------

export async function searchBase(
  deps: KnowledgeDeps,
  id: string,
  query: KnowledgeSearchQuery,
): Promise<KnowledgeSearchResult> {
  return searchKnowledge(deps.db, id, query, {
    secretKey: deps.config.APP_SECRET_KEY,
  });
}

export async function rebuildBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    documentIds?: string[] | undefined;
    chunksOnly: boolean;
    confirmOverwriteManualChunks: boolean;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const ids = body.documentIds ? [...new Set(body.documentIds)] : null;
  if (ids && ids.length > 0) {
    const rows = await deps.db
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, base.id),
          inArray(schema.knowledgeDocuments.id, ids),
        ),
      );
    if (rows.length !== ids.length) {
      throw new AppError('INVALID_INPUT', '存在不属于该知识库的文档');
    }
  }
  if (!body.chunksOnly && !body.confirmOverwriteManualChunks) {
    const [edited] = await deps.db
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
      throw new AppError(
        'CONFLICT',
        `存在 ${editedCount} 个人工编辑的分块，完整重建会丢弃这些修改；请确认后重试`,
      );
    }
  }
  const job = await enqueue(
    deps,
    {
      type: 'reindex',
      baseId: base.id,
      ...(body.documentIds ? { documentIds: body.documentIds } : {}),
      chunksOnly: body.chunksOnly,
      confirmOverwriteManualChunks: body.confirmOverwriteManualChunks,
    },
    { baseId: base.id, documentId: null },
  );
  return { jobId: job.id };
}

type BatchResult = {
  documentId: string;
  status: 'succeeded' | 'failed';
  newDocumentId?: string | undefined;
  jobId?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
};

async function copyDocument(deps: KnowledgeDeps, document: DocumentRow): Promise<string> {
  if (document.contentKind === 'wiki') {
    throw new AppError('CONFLICT', 'Wiki 索引文档不能复制为普通文档');
  }
  const version = document.currentVersionId
    ? await repo.knowledge.getVersion(deps.db, document.currentVersionId)
    : null;
  if (!version) throw new AppError('CONFLICT', '文档还没有成功解析的版本，无法复制');
  const chunks = await collectChunks(deps.db, version.id);
  const newDocumentId = newId('knowledgeDocument');
  const newVersionId = newId('knowledgeVersion');
  const sourceDir = join(deps.config.KNOWLEDGE_DIR, 'docs', document.id, version.id);
  const targetDir = join(deps.config.KNOWLEDGE_DIR, 'docs', newDocumentId, newVersionId);
  await mkdir(targetDir, { recursive: true });
  try {
    const markdown =
      (await readFile(join(sourceDir, 'markdown.md'), 'utf8').catch(() => null)) ??
      chunks.map((chunk) => chunk.content).join('\n\n');
    await writeFile(join(targetDir, 'markdown.md'), markdown, 'utf8');
    await copyVersionImages(
      join(sourceDir, 'images'),
      join(targetDir, 'images'),
      version.images ?? [],
    );
    const tags =
      (await repo.knowledge.getDocumentTagNames(deps.db, [document.id])).get(document.id) ?? [];
    await deps.db.transaction(async (tx) => {
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
        markdownSha256: sha256Hex(Buffer.from(markdown, 'utf8')),
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
      if (tags.length > 0) {
        const rows = await repo.knowledge.upsertTags(tx, document.baseId, tags);
        await tx
          .insert(schema.knowledgeDocumentTags)
          .values(rows.map((tag) => ({ documentId: newDocumentId, tagId: tag.id })));
      }
    });
    return newDocumentId;
  } catch (err) {
    await rm(join(deps.config.KNOWLEDGE_DIR, 'docs', newDocumentId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw err;
  }
}

export async function batchDocuments(
  deps: KnowledgeDeps,
  id: string,
  input: {
    documentIds: string[];
    action: 'move' | 'copy' | 'tag' | 'delete' | 'reprocess';
    folderId?: string | null | undefined;
    tags?: string[] | undefined;
    tagMode?: 'add' | 'remove' | 'replace' | undefined;
    confirmOverwriteManualChunks: boolean;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.action === 'move') {
    if (input.folderId === undefined) {
      throw new AppError('INVALID_INPUT', '移动文档需要 folderId（根目录传 null）');
    }
    if (input.folderId !== null) {
      const folder = await repo.knowledge.getFolder(deps.db, input.folderId);
      if (!folder || folder.baseId !== base.id) {
        throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
      }
    }
  }
  if (input.action === 'tag' && (!input.tags || !input.tagMode)) {
    throw new AppError('INVALID_INPUT', '批量标签需要 tags 与 tagMode');
  }
  const results: BatchResult[] = [];
  for (const documentId of input.documentIds) {
    const document = await repo.knowledge.getDocument(deps.db, documentId);
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
        await repo.knowledge.updateDocument(deps.db, document.id, {
          folderId: input.folderId ?? null,
        });
        results.push({ documentId, status: 'succeeded' });
      } else if (input.action === 'copy') {
        results.push({
          documentId,
          status: 'succeeded',
          newDocumentId: await copyDocument(deps, document),
        });
      } else if (input.action === 'tag') {
        const currentNames =
          (await repo.knowledge.getDocumentTagNames(deps.db, [document.id])).get(document.id) ?? [];
        const tags = input.tags ?? [];
        const names =
          input.tagMode === 'replace'
            ? tags
            : input.tagMode === 'remove'
              ? currentNames.filter((name) => !tags.includes(name))
              : [...new Set([...currentNames, ...tags])];
        const rows = await repo.knowledge.upsertTags(deps.db, base.id, names);
        await repo.knowledge.setDocumentTags(
          deps.db,
          document.id,
          rows.map((tag) => tag.id),
        );
        results.push({ documentId, status: 'succeeded' });
      } else if (input.action === 'delete') {
        await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
        await repo.knowledge.deleteDocument(deps.db, document.id);
        results.push({ documentId, status: 'succeeded' });
      } else {
        if (document.status === 'disabled' || document.disabledReason !== null) {
          throw new AppError('CONFLICT', '文档已停用，不能通过重解析恢复');
        }
        if (!document.currentVersionId) {
          throw new AppError('CONFLICT', '文档还没有成功解析的版本');
        }
        if (!input.confirmOverwriteManualChunks) {
          const edited = await repo.knowledge.countEditedChunks(deps.db, document.currentVersionId);
          if (edited > 0) {
            throw new AppError('CONFLICT', `存在 ${edited} 个人工编辑的分块，重解析会丢弃这些修改`);
          }
        }
        const job = await enqueue(
          deps,
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
      if (!isAppError(err)) deps.log.error({ err, documentId }, 'knowledge batch item failed');
    }
  }
  return { results };
}

// ---- sources --------------------------------------------------------------

export async function listSources(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listSources(deps.db, id, pageOptions(query));
  const items = await Promise.all(
    page.items.map(async (row) => toSource(row, await repo.knowledge.listRanges(deps.db, row.id))),
  );
  return { items, nextCursor: page.nextCursor };
}

function encryptIfAny(
  deps: KnowledgeDeps,
  secrets: Record<string, string> | undefined,
): string | null | undefined {
  if (secrets === undefined) return undefined;
  return Object.keys(secrets).length > 0
    ? encryptSecrets(secrets, deps.config.APP_SECRET_KEY)
    : null;
}

export async function createSource(
  deps: KnowledgeDeps,
  id: string,
  input: {
    type: KnowledgeSourceRow['type'];
    name: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    syncCron: string | null;
    ranges: RangeInput[];
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.syncCron !== null && !isSchedulableCron(input.syncCron)) {
    throw new AppError('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/syncCron' });
  }
  const issues = configIssues(input.type, input.config, input.secrets, input.ranges);
  if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  const source = await repo.knowledge.createSource(deps.db, {
    baseId: base.id,
    type: input.type,
    name: input.name,
    config: input.config,
    secretsEncrypted: encryptIfAny(deps, input.secrets) ?? null,
    syncCron: input.syncCron,
  });
  try {
    const ranges = await repo.knowledge.replaceRanges(deps.db, source.id, input.ranges);
    return toSource(source, ranges);
  } catch (err) {
    await repo.knowledge.deleteSource(deps.db, source.id);
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '存在重复的来源范围');
    throw err;
  }
}

function parsePatchInput(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  ranges: RangeRow[],
  body: SourcePatch,
) {
  if (body.config === undefined && body.secrets === undefined && body.ranges === undefined) {
    return null;
  }
  const storedSecrets = source.secretsEncrypted
    ? (() => {
        try {
          return decryptSecrets(source.secretsEncrypted, deps.config.APP_SECRET_KEY);
        } catch {
          return null;
        }
      })()
    : null;
  const parsed = knowledgeSourceInputSchema.safeParse({
    type: source.type,
    name: body.name ?? source.name,
    syncCron: body.syncCron === undefined ? source.syncCron : body.syncCron,
    config: body.config ?? source.config,
    secrets: body.secrets ?? storedSecrets ?? {},
    ranges: body.ranges ?? ranges,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.');
    throw new AppError('INVALID_INPUT', issue?.message ?? '配置不合法', {
      ...(path ? { path } : {}),
    });
  }
  return parsed.data;
}

export async function updateSource(deps: KnowledgeDeps, sourceId: string, body: SourcePatch) {
  const found = await sourceRow(deps.db, sourceId);
  if (!found) notFound('来源');
  if (body.syncCron !== undefined && body.syncCron !== null && !isSchedulableCron(body.syncCron)) {
    throw new AppError('INVALID_INPUT', INVALID_CRON_MESSAGE, { path: '/syncCron' });
  }
  const { source, ranges } = found;
  if (body.config !== undefined) {
    const issues = identityIssues(source.type, source.config, body.config);
    if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  }
  const parsed = parsePatchInput(deps, source, ranges, body);
  if (parsed !== null) {
    const issues = configIssues(source.type, parsed.config, parsed.secrets, parsed.ranges);
    if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  }
  const nextConfig = parsed !== null && body.config !== undefined ? parsed.config : undefined;
  const nextSecrets =
    parsed !== null && body.secrets !== undefined
      ? (parsed.secrets as Record<string, string>)
      : undefined;
  const nextRanges = parsed !== null && body.ranges !== undefined ? parsed.ranges : undefined;
  const encrypted = encryptIfAny(deps, nextSecrets);
  try {
    const result = await repo.knowledge.replaceSourceScope(deps.db, source.id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(nextConfig === undefined ? {} : { config: nextConfig }),
      ...(encrypted === undefined ? {} : { secretsEncrypted: encrypted }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.syncCron === undefined ? {} : { syncCron: body.syncCron }),
      ...(nextRanges === undefined ? {} : { ranges: nextRanges }),
    });
    return {
      ...toSource(result.source, result.ranges),
      disabledDocumentIds: result.disabledDocumentIds,
    };
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '存在重复的来源范围');
    throw err;
  }
}

export async function deleteSource(
  deps: KnowledgeDeps,
  sourceId: string,
  documents: 'keep' | 'delete',
) {
  const source = await repo.knowledge.getSource(deps.db, sourceId);
  if (!source) notFound('来源');
  let affected: number;
  if (documents === 'keep') {
    const disabled = await repo.knowledge.disableDocumentsBySource(deps.db, source.id);
    for (const document of disabled) {
      await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
    }
    affected = disabled.length;
  } else {
    const rows = await deps.db
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.sourceConnectionId, source.id));
    for (const row of rows) {
      await repo.knowledge.markWikiStaleByDocument(deps.db, row.id);
      await repo.knowledge.deleteDocument(deps.db, row.id);
    }
    affected = rows.length;
  }
  await repo.knowledge.deleteSource(deps.db, source.id);
  return { documents, affected };
}

export async function testSource(deps: KnowledgeDeps, sourceId: string) {
  const found = await sourceRow(deps.db, sourceId);
  if (!found) notFound('来源');
  const { source, ranges } = found;
  const issues: string[] = [];
  let secrets: Record<string, string> | null = null;
  if (source.secretsEncrypted) {
    try {
      secrets = decryptSecrets(source.secretsEncrypted, deps.config.APP_SECRET_KEY);
    } catch {
      issues.push('已保存的凭证无法解密，请重新填写');
    }
  }
  issues.push(...configIssues(source.type, source.config, secrets, ranges));
  if (issues.length > 0) throw new AppError('INVALID_INPUT', issues.join('；'));
  const job = await createJob(deps.db, {
    baseId: source.baseId,
    documentId: null,
    sourceId: source.id,
    payload: { type: 'source_probe', sourceId: source.id },
  });
  try {
    await enqueueKnowledgeJob(job);
  } catch (err) {
    await deps.db.delete(schema.knowledgeJobs).where(eq(schema.knowledgeJobs.id, job.id));
    if (isAppError(err)) throw err;
    throw new AppError('SERVICE_UNAVAILABLE', '测试任务未能提交，请稍后重试');
  }
  return { jobId: job.id };
}

export async function syncSource(deps: KnowledgeDeps, sourceId: string) {
  const created = await repo.knowledge.createSyncJob(deps.db, sourceId);
  if (created.status === 'not_found') notFound('来源');
  if (created.status === 'not_active') throw new AppError('CONFLICT', '来源未启用，无法同步');
  if (created.status === 'in_progress') {
    throw new AppError('CONFLICT', '该来源已有同步任务在进行中');
  }
  await enqueueKnowledgeJob(created.job);
  return { jobId: created.job.id, syncRunId: created.run.id };
}

export async function listSourceRuns(deps: KnowledgeDeps, sourceId: string, query: PageQuery) {
  if (!(await repo.knowledge.getSource(deps.db, sourceId))) notFound('来源');
  const page = await repo.knowledge.listSyncRuns(deps.db, sourceId, pageOptions(query));
  return { items: page.items.map(toRun), nextCursor: page.nextCursor };
}

export async function listSourceRunItems(
  deps: KnowledgeDeps,
  sourceId: string,
  syncRunId: string,
  query: PageQuery & { status?: 'failed' | 'skipped' | undefined },
) {
  const source = await repo.knowledge.getSource(deps.db, sourceId);
  if (!source) notFound('来源');
  const [run] = await deps.db
    .select({ id: schema.knowledgeSyncRuns.id })
    .from(schema.knowledgeSyncRuns)
    .where(
      and(
        eq(schema.knowledgeSyncRuns.id, syncRunId),
        eq(schema.knowledgeSyncRuns.sourceId, source.id),
      ),
    )
    .limit(1);
  if (!run) throw new AppError('NOT_FOUND', '同步记录不存在或不属于该来源');
  const page = await repo.knowledge.listSyncItems(deps.db, run.id, {
    ...pageOptions(query),
    ...(query.status === undefined ? {} : { status: query.status }),
  });
  return {
    items: page.items.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    nextCursor: page.nextCursor,
  };
}

// ---- wiki -----------------------------------------------------------------

function toWikiPage(row: WikiPageRow) {
  return {
    id: row.id,
    baseId: row.baseId,
    slug: row.slug,
    title: row.title,
    parentId: row.parentId,
    position: row.position,
    status: row.status,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWikiVersion(row: typeof schema.knowledgeWikiVersions.$inferSelect) {
  return {
    id: row.id,
    pageId: row.pageId,
    version: row.version,
    markdown: row.markdown,
    sourceChunkIds: row.sourceChunkIds,
    model: row.model,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

const WIKI_LINK_PATTERN = /\[\[([^[\]]+)\]\]/g;

interface WikiLinkToken {
  slug: string;
  anchor: string | null;
}

function parseWikiLinkToken(raw: string): WikiLinkToken | null {
  const target = raw.split('|')[0]?.trim() ?? '';
  if (target.length === 0) return null;
  const [slugPart, ...anchorParts] = target.split('#');
  const slug = (slugPart ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (slug.length === 0) return null;
  const anchor = anchorParts.join('#').trim();
  return { slug, anchor: anchor.length > 0 ? anchor : null };
}

interface MarkdownNode {
  type: string;
  value?: string | undefined;
  children?: MarkdownNode[] | undefined;
}

function extractWikiLinks(markdown: string): WikiLinkToken[] {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const links: WikiLinkToken[] = [];
  const seen = new Set<string>();
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
    if (node.type === 'text' && node.value) {
      for (const match of node.value.matchAll(WIKI_LINK_PATTERN)) {
        const token = parseWikiLinkToken(match[1] ?? '');
        if (!token) continue;
        const key = `${token.slug}#${token.anchor ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(token);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}

const pageMarkdownRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  markdown: z.string().nullable(),
});

type PageMarkdownRow = z.infer<typeof pageMarkdownRowSchema>;

async function latestPageMarkdowns(db: Database, baseId: string): Promise<PageMarkdownRow[]> {
  const result = await db.execute<{ id: string; slug: string; markdown: string | null }>(sql`
    select p.id, p.slug, v.markdown
    from knowledge_wiki_pages p
    left join lateral (
      select wv.markdown
      from knowledge_wiki_versions wv
      where wv.page_id = p.id
      order by wv.version desc
      limit 1
    ) v on true
    where p.base_id = ${baseId}
    order by p.created_at, p.id
  `);
  return z.array(pageMarkdownRowSchema).parse(result);
}

async function latestWikiVersion(
  db: Database,
  pageId: string,
): Promise<typeof schema.knowledgeWikiVersions.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(eq(schema.knowledgeWikiVersions.pageId, pageId))
    .orderBy(desc(schema.knowledgeWikiVersions.version))
    .limit(1);
  return row ?? null;
}

type PreparedWikiIndex = {
  versionId: string;
  sizeBytes: number;
  input: {
    blobSha256: string;
    filename: string;
    mimeType: string;
    expectedCurrentVersionId: string | null;
  };
};

async function prepareWikiIndex(
  deps: KnowledgeDeps,
  page: WikiPageRow,
  versionId: string,
): Promise<PreparedWikiIndex | null> {
  const [version] = await deps.db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(
      and(
        eq(schema.knowledgeWikiVersions.id, versionId),
        eq(schema.knowledgeWikiVersions.pageId, page.id),
      ),
    )
    .limit(1);
  if (!version) return null;
  const data = Buffer.from(version.markdown, 'utf8');
  const sha = await storeBlob(deps.config.KNOWLEDGE_DIR, data);
  return {
    versionId: version.id,
    sizeBytes: data.length,
    input: {
      blobSha256: sha,
      filename: `${page.slug}.md`,
      mimeType: 'text/markdown',
      expectedCurrentVersionId: null,
    },
  };
}

async function publishWithWikiIndex(
  deps: KnowledgeDeps,
  page: WikiPageRow,
  prepared: PreparedWikiIndex,
): Promise<WikiPageRow | null> {
  const committed = await deps.db.transaction(async (tx) => {
    const updated = await repo.knowledge.publishWikiVersionTx(tx, page.id, prepared.versionId);
    if (!updated) return null;
    const [existing] = await tx
      .select()
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, page.baseId),
          eq(schema.knowledgeDocuments.contentKind, 'wiki'),
          sql`${schema.knowledgeDocuments.metadata} ->> 'wikiPageId' = ${page.id}`,
        ),
      )
      .limit(1);
    const metadata = {
      ...(existing?.metadata ?? {}),
      wikiPageId: page.id,
      wikiVersionId: prepared.versionId,
      originalFilename: prepared.input.filename,
    };
    const document = existing
      ? ((await repo.knowledge.updateDocument(tx, existing.id, {
          title: updated.title,
          metadata,
        })) ?? existing)
      : await repo.knowledge.createDocument(tx, {
          baseId: page.baseId,
          folderId: null,
          title: updated.title,
          sourceType: 'manual',
          sourceId: null,
          sourceUrl: null,
          sourcePath: null,
          mimeType: 'text/markdown',
          sizeBytes: prepared.sizeBytes,
          contentKind: 'wiki',
          metadata,
        });
    const job = await createJob(tx, {
      baseId: page.baseId,
      documentId: document.id,
      payload: {
        type: 'ingest',
        documentId: document.id,
        publish: 'automatic',
        input: {
          ...prepared.input,
          expectedCurrentVersionId: document.currentVersionId,
        },
        versionMetadata: { wikiPageId: page.id, wikiVersionId: prepared.versionId },
      },
    });
    return { page: updated, jobId: job.id };
  });
  if (!committed) return null;
  await enqueueKnowledgeJob({ id: committed.jobId }).catch((err: unknown) => {
    deps.log.warn({ err, jobId: committed.jobId }, 'Wiki 索引任务入队失败，等待对账补投');
  });
  return committed.page;
}

export async function listWikiPages(deps: KnowledgeDeps, id: string, query: PageQuery) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  const page = await repo.knowledge.listWikiPages(deps.db, id, pageOptions(query));
  return { items: page.items.map(toWikiPage), nextCursor: page.nextCursor };
}

export async function createWikiPage(
  deps: KnowledgeDeps,
  id: string,
  body: {
    slug: string;
    title: string;
    parentId?: string | null | undefined;
    position?: number | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const row = await repo.knowledge.createWikiPage(deps.db, {
    baseId: base.id,
    slug: body.slug,
    title: body.title,
  });
  if (body.parentId !== undefined || body.position !== undefined) {
    try {
      const updated = await repo.knowledge.updateWikiPageStructure(deps.db, row.id, {
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.position === undefined ? {} : { position: body.position }),
      });
      return toWikiPage(updated ?? row);
    } catch (err) {
      await deps.db
        .delete(schema.knowledgeWikiPages)
        .where(eq(schema.knowledgeWikiPages.id, row.id))
        .catch(() => undefined);
      throw err;
    }
  }
  return toWikiPage(row);
}

export async function getWikiPage(deps: KnowledgeDeps, pageId: string, query: PageQuery) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const versions = await repo.knowledge.listWikiVersions(deps.db, page.id, pageOptions(query));
  return {
    ...toWikiPage(page),
    versions: versions.items.map(toWikiVersion),
    nextCursor: versions.nextCursor,
  };
}

export async function updateWikiPage(
  deps: KnowledgeDeps,
  pageId: string,
  body: {
    title?: string | undefined;
    markdown?: string | undefined;
    parentId?: string | null | undefined;
    position?: number | undefined;
    expectedVersion?: string | null | undefined;
  },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const structure = {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
    ...(body.position === undefined ? {} : { position: body.position }),
  };
  const hasStructure = Object.keys(structure).length > 0;
  if (body.markdown !== undefined) {
    const previous = await latestWikiVersion(deps.db, page.id);
    await repo.knowledge.saveWikiDraft(deps.db, page.id, {
      markdown: body.markdown,
      sourceChunkIds: previous?.sourceChunkIds ?? [],
      model: 'manual',
      generatedBy: 'manual',
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
      ...(hasStructure ? { structure } : {}),
    });
  } else if (hasStructure) {
    await repo.knowledge.updateWikiPageStructure(deps.db, page.id, {
      ...structure,
      ...(body.expectedVersion === undefined ? {} : { expectedVersionId: body.expectedVersion }),
    });
  }
  const updated = await repo.knowledge.getWikiPage(deps.db, page.id);
  if (!updated) notFound('Wiki 页面');
  return toWikiPage(updated);
}

export async function generateWiki(
  deps: KnowledgeDeps,
  pageId: string,
  body: { instruction?: string | undefined; sourceDocumentIds?: string[] | undefined },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const job = await createJob(deps.db, {
    baseId: page.baseId,
    documentId: null,
    payload: {
      type: 'wiki_generate',
      baseId: page.baseId,
      pageId: page.id,
      ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
      ...(body.sourceDocumentIds === undefined
        ? {}
        : { sourceDocumentIds: body.sourceDocumentIds }),
    },
  });
  await enqueueKnowledgeJob(job);
  return { jobId: job.id };
}

export async function listWikiVersions(deps: KnowledgeDeps, pageId: string, query: PageQuery) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const versions = await repo.knowledge.listWikiVersions(deps.db, page.id, pageOptions(query));
  return { items: versions.items.map(toWikiVersion), nextCursor: versions.nextCursor };
}

export async function wikiLinks(deps: KnowledgeDeps, pageId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const rows = await latestPageMarkdowns(deps.db, page.baseId);
  const bySlug = new Map(rows.map((row) => [row.slug.toLowerCase(), row.id]));
  const current = rows.find((row) => row.id === page.id);
  const outgoing = (current?.markdown ? extractWikiLinks(current.markdown) : []).map((link) => ({
    targetPageId: bySlug.get(link.slug) ?? null,
    anchor: link.anchor,
  }));
  const incoming = rows.flatMap((row) => {
    if (row.id === page.id || !row.markdown) return [];
    return extractWikiLinks(row.markdown).flatMap((link) =>
      bySlug.get(link.slug) === page.id ? [{ sourcePageId: row.id, anchor: link.anchor }] : [],
    );
  });
  return { outgoing, incoming };
}

export async function wikiDiff(
  deps: KnowledgeDeps,
  pageId: string,
  query: { fromVersionId: string; toVersionId: string },
) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const diff = await repo.knowledge.getWikiVersionDiff(
    deps.db,
    page.id,
    query.fromVersionId,
    query.toVersionId,
  );
  if (!diff) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  return diff;
}

export async function publishWiki(deps: KnowledgeDeps, pageId: string, versionId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const prepared = await prepareWikiIndex(deps, page, versionId);
  if (!prepared) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const updated = await publishWithWikiIndex(deps, page, prepared);
  if (!updated) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  return toWikiPage(updated);
}

export async function rollbackWiki(deps: KnowledgeDeps, pageId: string, versionId: string) {
  const page = await repo.knowledge.getWikiPage(deps.db, pageId);
  if (!page) notFound('Wiki 页面');
  const [source] = await deps.db
    .select()
    .from(schema.knowledgeWikiVersions)
    .where(
      and(
        eq(schema.knowledgeWikiVersions.id, versionId),
        eq(schema.knowledgeWikiVersions.pageId, page.id),
      ),
    )
    .limit(1);
  if (!source) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const draft = await repo.knowledge.saveWikiDraft(deps.db, page.id, {
    markdown: source.markdown,
    sourceChunkIds: source.sourceChunkIds,
    model: source.model,
    generatedBy: source.generatedBy,
  });
  if (!draft) notFound('Wiki 页面');
  const prepared = await prepareWikiIndex(deps, page, draft.id);
  if (!prepared) throw new AppError('NOT_FOUND', '版本不存在或不属于该页面');
  const published = await publishWithWikiIndex(deps, page, prepared);
  if (!published) notFound('Wiki 页面');
  return toWikiVersion(draft);
}

// ---- FAQ ------------------------------------------------------------------

function faqMarkdown(faq: KnowledgeFaq): string {
  return [`# ${faq.question}`, ...faq.answers.filter((answer) => answer.trim().length > 0)].join(
    '\n\n',
  );
}

function toFaqDocument(row: DocumentRow, tags: string[]) {
  return {
    id: row.id,
    baseId: row.baseId,
    folderId: row.folderId,
    title: row.title,
    contentKind: row.contentKind,
    status: row.status,
    disabledReason: row.disabledReason,
    currentVersionId: row.currentVersionId,
    tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toFaqVersion(row: VersionRow, isCurrent: boolean) {
  return {
    id: row.id,
    documentId: row.documentId,
    version: row.version,
    origin: row.origin,
    parentVersionId: row.parentVersionId,
    metadata: row.metadata,
    faq: row.faq,
    isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadFaqDocument(deps: KnowledgeDeps, documentId: string) {
  const document = await repo.knowledge.getDocument(deps.db, documentId);
  if (document?.contentKind !== 'faq' || document.sourceType !== 'manual') notFound('FAQ');
  return document;
}

async function latestFaqVersion(deps: KnowledgeDeps, documentId: string) {
  const [row] = await deps.db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(eq(schema.knowledgeDocumentVersions.documentId, documentId))
    .orderBy(desc(schema.knowledgeDocumentVersions.version))
    .limit(1);
  return row ?? null;
}

function isPublishedFaqVersion(document: DocumentRow, version: VersionRow): boolean {
  return version.id === document.currentVersionId || version.metadata?.publication === 'published';
}

function faqEnabledForVersion(document: DocumentRow, version: VersionRow): boolean {
  if (!isPublishedFaqVersion(document, version)) {
    const imported = knowledgeFaqImportMetadataSchema.safeParse(version.metadata?.faqImport);
    if (imported.success) return imported.data.enabled;
  }
  return document.status !== 'disabled' && document.disabledReason === null;
}

function cleanFaqInput(input: FaqInput): {
  faq: KnowledgeFaq;
  issues: KnowledgeFaqImportIssue[];
} {
  const normalized = normalizeFaqEntry(input);
  if (!normalized.entry) {
    fail('INVALID_INPUT', normalized.issues[0]?.message ?? 'FAQ 内容不合法');
  }
  const entry = normalized.entry;
  return {
    faq: {
      question: entry.question,
      similarQuestions: entry.similarQuestions,
      negativeQuestions: entry.negativeQuestions,
      answers: entry.answers,
      answerStrategy: entry.answerStrategy,
      isRecommended: entry.isRecommended,
    },
    issues: normalized.issues,
  };
}

async function loadExistingFaqEntries(
  deps: KnowledgeDeps,
  baseId: string,
): Promise<FaqExistingEntry[]> {
  const documents = await deps.db
    .select()
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.baseId, baseId),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
      ),
    )
    .orderBy(schema.knowledgeDocuments.id);
  if (documents.length === 0) return [];
  const versions = await deps.db
    .select()
    .from(schema.knowledgeDocumentVersions)
    .where(
      and(
        inArray(
          schema.knowledgeDocumentVersions.documentId,
          documents.map((document) => document.id),
        ),
        isNotNull(schema.knowledgeDocumentVersions.faq),
      ),
    )
    .orderBy(desc(schema.knowledgeDocumentVersions.version));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const latestByDocument = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!latestByDocument.has(version.documentId))
      latestByDocument.set(version.documentId, version);
  }
  return documents.flatMap((document) => {
    const latest = latestByDocument.get(document.id);
    const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : null;
    const published = document.currentVersionId
      ? versionById.get(document.currentVersionId)
      : undefined;
    const current = draft ?? published;
    if (!current?.faq) return [];
    return [
      {
        documentId: document.id,
        faq: current.faq,
        enabled: faqEnabledForVersion(document, current),
        latestDraftVersionId: draft?.id ?? null,
        publishedVersionId: document.currentVersionId,
        updatedAt: document.updatedAt.toISOString(),
      },
    ];
  });
}

function existingState(entry: FaqExistingEntry): KnowledgeFaqImportState {
  return {
    documentId: entry.documentId,
    currentVersionId: entry.publishedVersionId,
    latestDraftVersionId: entry.latestDraftVersionId,
    updatedAt: entry.updatedAt,
  };
}

function positiveKeysOf(faq: KnowledgeFaq): string[] {
  return [faq.question, ...faq.similarQuestions].map(normalizeFaqQuestion);
}

async function assertNoPositiveConflict(
  deps: KnowledgeDeps,
  baseId: string,
  faq: KnowledgeFaq,
  options: { ignoreDocumentId?: string } = {},
): Promise<void> {
  const existing = await loadExistingFaqEntries(deps, baseId);
  const incoming = new Set(positiveKeysOf(faq));
  for (const entry of existing) {
    if (entry.documentId === options.ignoreDocumentId) continue;
    const conflict = positiveKeysOf(entry.faq).find((key) => incoming.has(key));
    if (conflict) fail('CONFLICT', 'FAQ 正向问已存在，请修改问题或答案');
  }
}

interface WriteFaqVersionInput {
  base: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>;
  document: DocumentRow;
  faq: KnowledgeFaq;
  title: string;
  tags: string[] | undefined;
  parentVersionId: string | null;
  auditAction: string;
}

async function writeVersionFiles(
  deps: KnowledgeDeps,
  documentId: string,
  versionId: string,
  markdown: string,
  faqJson: string,
): Promise<void> {
  const markdownPath = join(
    deps.config.KNOWLEDGE_DIR,
    'docs',
    documentId,
    versionId,
    'markdown.md',
  );
  await storeBlob(deps.config.KNOWLEDGE_DIR, Buffer.from(faqJson, 'utf8'));
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown);
}

async function writeFaqVersion(deps: KnowledgeDeps, input: WriteFaqVersionInput) {
  if (input.tags !== undefined) {
    const tags =
      input.tags.length === 0
        ? []
        : (await repo.knowledge.upsertTags(deps.db, input.base.id, input.tags)).map(
            (tag) => tag.id,
          );
    await repo.knowledge.setDocumentTags(deps.db, input.document.id, tags);
  }
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const originalFilename = `${input.title}.faq.json`;
  const mimeType = 'application/json';
  const blobSha = sha256Hex(faqJson);
  const markdownSha256 = sha256Hex(markdown);
  await writeVersionFiles(deps, input.document.id, versionId, markdown, faqJson);
  const payload: KnowledgeJobPayload = {
    type: 'ingest',
    documentId: input.document.id,
    publish: 'draft',
    versionId,
    input: {
      blobSha256: blobSha,
      filename: originalFilename,
      mimeType,
      expectedCurrentVersionId: input.parentVersionId,
    },
  };
  const { version, job } = await deps.db.transaction(async (tx) => {
    const job = await createJob(tx, {
      baseId: input.base.id,
      documentId: input.document.id,
      payload,
    });
    const version = await repo.knowledge.createVersion(tx, {
      id: versionId,
      documentId: input.document.id,
      blobSha256: blobSha,
      markdownSha256,
      originalFilename,
      mimeType,
      sizeBytes: Buffer.byteLength(faqJson, 'utf8'),
      sourceRevision: null,
      origin: 'faq',
      parentVersionId: input.parentVersionId,
      metadata: { publication: 'draft', indexingJobId: job.id },
      faq: input.faq,
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: input.base.embeddingProfileId,
    });
    return { version, job };
  });
  await enqueueKnowledgeJob(job);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: input.auditAction,
    target: input.document.id,
    input: { title: input.title, question: input.faq.question },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { version, jobId: job.id };
}

interface CreateFaqInput extends Omit<WriteFaqVersionInput, 'document'> {
  folderId: string | null;
}

async function createFaqDraft(deps: KnowledgeDeps, input: CreateFaqInput) {
  const document = await repo.knowledge.createDocument(deps.db, {
    baseId: input.base.id,
    folderId: input.folderId,
    title: input.title,
    sourceType: 'manual',
    sourceId: null,
    sourceUrl: null,
    sourcePath: null,
    mimeType: 'application/json',
    sizeBytes: Buffer.byteLength(JSON.stringify(input.faq), 'utf8'),
    contentKind: 'faq',
    metadata: { originalFilename: `${input.title}.faq.json` },
  });
  try {
    const result = await writeFaqVersion(deps, { ...input, document });
    return { document, ...result };
  } catch (err) {
    await repo.knowledge.deleteDocument(deps.db, document.id).catch(() => undefined);
    throw err;
  }
}

async function publishFaqVersion(
  deps: KnowledgeDeps,
  document: DocumentRow,
  versionId: string,
  expectedVersionId: string | null,
) {
  if ((document.currentVersionId ?? null) !== expectedVersionId) {
    fail('CONFLICT_STALE', 'FAQ 版本已变化，请刷新后重试');
  }
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version || version.documentId !== document.id || version.faq === null) {
    fail('NOT_FOUND', '版本不存在或不属于该 FAQ');
  }
  const [indexJob] = await deps.db
    .select({ status: schema.knowledgeJobs.status })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.documentId, document.id),
        eq(schema.knowledgeJobs.type, 'ingest'),
        sql`${schema.knowledgeJobs.payload} ->> 'versionId' = ${versionId}`,
      ),
    )
    .orderBy(desc(schema.knowledgeJobs.createdAt), desc(schema.knowledgeJobs.id))
    .limit(1);
  if (indexJob?.status !== 'succeeded') {
    fail('CONFLICT', 'FAQ 草稿索引尚未完成，完成后再发布');
  }
  const [chunkCount] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.versionId, versionId));
  if (!chunkCount || chunkCount.count === 0) {
    fail('CONFLICT', 'FAQ 草稿索引尚未就绪，完成后再发布');
  }
  const updated = await repo.knowledge.setCurrentVersion(deps.db, document.id, versionId);
  if (!updated) fail('CONFLICT', 'FAQ 已停用、批次草稿或版本不可发布，请刷新后重试');
  return updated;
}

async function setFaqEnabled(deps: KnowledgeDeps, document: DocumentRow, enabled: boolean) {
  const status = enabled ? (document.currentVersionId ? 'ready' : 'pending') : 'disabled';
  const updated = await repo.knowledge.updateDocument(deps.db, document.id, {
    status,
    disabledReason: enabled ? null : 'manual',
  });
  if (!updated) fail('NOT_FOUND', 'FAQ 不存在，可能已被删除');
  return updated;
}

interface PreparedDraft {
  draft: {
    operation: 'add' | 'merge';
    documentId: string;
    faq: KnowledgeFaq;
    enabled: boolean;
    version: {
      id: string;
      blobSha256: string;
      markdownSha256: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      sourceRevision: null;
      parseStatus: 'parsed';
      pageMap: [];
      images: [];
      embeddingProfileId: string;
    };
    title?: string | undefined;
    folderId?: string | null | undefined;
  };
}

async function prepareImportDraft(
  deps: KnowledgeDeps,
  base: NonNullable<Awaited<ReturnType<typeof repo.knowledge.getBase>>>,
  input: {
    operation: 'add' | 'merge';
    documentId: string;
    faq: KnowledgeFaq;
    enabled: boolean;
  },
): Promise<PreparedDraft> {
  const versionId = newId('knowledgeVersion');
  const markdown = faqMarkdown(input.faq);
  const faqJson = JSON.stringify(input.faq, null, 2);
  const blobSha = sha256Hex(faqJson);
  await writeVersionFiles(deps, input.documentId, versionId, markdown, faqJson);
  return {
    draft: {
      ...input,
      version: {
        id: versionId,
        blobSha256: blobSha,
        markdownSha256: sha256Hex(markdown),
        originalFilename: `${input.faq.question.slice(0, 300)}.faq.json`,
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(faqJson, 'utf8'),
        sourceRevision: null,
        parseStatus: 'parsed',
        pageMap: [],
        images: [],
        embeddingProfileId: base.embeddingProfileId,
      },
      ...(input.operation === 'add'
        ? { title: input.faq.question.slice(0, 300), folderId: null }
        : {}),
    },
  };
}

export async function listFaqs(
  deps: KnowledgeDeps,
  id: string,
  query: PageQuery & {
    q?: string | undefined;
    status?: 'pending' | 'processing' | 'ready' | 'failed' | 'disabled' | undefined;
    folderId?: string | undefined;
    isRecommended?: boolean | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const filters = [
    eq(schema.knowledgeDocuments.baseId, base.id),
    eq(schema.knowledgeDocuments.contentKind, 'faq'),
  ];
  if (query.folderId !== undefined) {
    filters.push(
      query.folderId === 'null'
        ? sql`${schema.knowledgeDocuments.folderId} is null`
        : eq(schema.knowledgeDocuments.folderId, query.folderId),
    );
  }
  if (query.status) filters.push(eq(schema.knowledgeDocuments.status, query.status));
  if (query.q) {
    filters.push(sql`${schema.knowledgeDocuments.title} ilike ${`%${query.q}%`}`);
  }
  if (query.isRecommended !== undefined) {
    filters.push(sql`coalesce((
      select v.faq ->> 'isRecommended'
      from knowledge_document_versions v
      where v.document_id = ${schema.knowledgeDocuments.id} and v.faq is not null
      order by v.version desc limit 1
    ), 'true') = ${String(query.isRecommended)}`);
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  if (query.cursor) {
    filters.push(
      sql`(${schema.knowledgeDocuments.updatedAt}, ${schema.knowledgeDocuments.id}) < (
        select b.updated_at, b.id from knowledge_documents b where b.id = ${query.cursor}
      )`,
    );
  }
  const rows = await deps.db
    .select()
    .from(schema.knowledgeDocuments)
    .where(and(...filters))
    .orderBy(desc(schema.knowledgeDocuments.updatedAt), desc(schema.knowledgeDocuments.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const ids = items.map((row) => row.id);
  const [tags, versions] = await Promise.all([
    repo.knowledge.getDocumentTagNames(deps.db, ids),
    ids.length === 0
      ? Promise.resolve([] as VersionRow[])
      : deps.db
          .select()
          .from(schema.knowledgeDocumentVersions)
          .where(
            and(
              inArray(schema.knowledgeDocumentVersions.documentId, ids),
              isNotNull(schema.knowledgeDocumentVersions.faq),
            ),
          )
          .orderBy(desc(schema.knowledgeDocumentVersions.version)),
  ]);
  const latest = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!latest.has(version.documentId)) latest.set(version.documentId, version);
  }
  return {
    items: items.map((row) => ({
      ...toFaqDocument(row, tags.get(row.id) ?? []),
      faq: latest.get(row.id)?.faq ?? null,
    })),
    nextCursor: rows.length > limit ? (items[limit - 1]?.id ?? null) : null,
  };
}

async function activeFaqBase(deps: KnowledgeDeps, id: string) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
  return base;
}

export async function createFaq(
  deps: KnowledgeDeps,
  id: string,
  body: {
    title?: string | undefined;
    faq: FaqInput;
    folderId: string | null;
    tags: string[];
  },
) {
  const base = await activeFaqBase(deps, id);
  if (await folderIssue(deps, base.id, body.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  const cleaned = cleanFaqInput(body.faq);
  await assertNoPositiveConflict(deps, base.id, cleaned.faq);
  const result = await createFaqDraft(deps, {
    base,
    faq: cleaned.faq,
    title: body.title ?? cleaned.faq.question.slice(0, 300),
    folderId: body.folderId,
    tags: body.tags,
    parentVersionId: null,
    auditAction: 'knowledge.faq.created',
  });
  return {
    documentId: result.document.id,
    jobId: result.jobId,
    ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
  };
}

async function faqDetail(deps: KnowledgeDeps, document: DocumentRow) {
  const [published, latest, tags] = await Promise.all([
    document.currentVersionId
      ? repo.knowledge.getVersion(deps.db, document.currentVersionId)
      : null,
    latestFaqVersion(deps, document.id),
    repo.knowledge.getDocumentTagNames(deps.db, [document.id]),
  ]);
  const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : null;
  return {
    document: toFaqDocument(document, tags.get(document.id) ?? []),
    draftVersion: draft ? toFaqVersion(draft, false) : null,
    publishedVersion: published
      ? toFaqVersion(published, published.id === document.currentVersionId)
      : null,
    faq: draft?.faq ?? published?.faq ?? null,
  };
}

export async function getFaq(deps: KnowledgeDeps, documentId: string) {
  const document = await loadFaqDocument(deps, documentId);
  return faqDetail(deps, document);
}

export async function updateFaq(
  deps: KnowledgeDeps,
  documentId: string,
  body: {
    title?: string | undefined;
    faq: FaqInput;
    folderId?: string | null | undefined;
    tags?: string[] | undefined;
    expectedVersionId: string;
  },
) {
  const document = await loadFaqDocument(deps, documentId);
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) notFound('知识库');
  if (base.status !== 'active') throw new AppError('CONFLICT', '知识库已禁用，启用后再编辑 FAQ');
  const latest = await latestFaqVersion(deps, document.id);
  const latestIsDraft = latest !== null && !isPublishedFaqVersion(document, latest);
  const expectedVersionId = latestIsDraft ? latest.id : (document.currentVersionId ?? null);
  if (expectedVersionId !== body.expectedVersionId) {
    throw new AppError('CONFLICT_STALE', 'FAQ 已被修改，请刷新后重试');
  }
  if (await folderIssue(deps, base.id, body.folderId ?? document.folderId)) {
    throw new AppError('INVALID_INPUT', '文件夹不存在或属于其他知识库');
  }
  const cleaned = cleanFaqInput(body.faq);
  await assertNoPositiveConflict(deps, base.id, cleaned.faq, { ignoreDocumentId: document.id });
  const result = await writeFaqVersion(deps, {
    base,
    document,
    faq: cleaned.faq,
    title: body.title ?? document.title,
    tags: body.tags,
    parentVersionId: body.expectedVersionId,
    auditAction: 'knowledge.faq.updated',
  });
  const documentPatch: { title?: string; folderId?: string | null } = {};
  if (body.title !== undefined) documentPatch.title = body.title;
  if (body.folderId !== undefined) documentPatch.folderId = body.folderId;
  if (Object.keys(documentPatch).length > 0) {
    await repo.knowledge.updateDocument(deps.db, document.id, documentPatch);
  }
  return {
    documentId: document.id,
    jobId: result.jobId,
    ...(cleaned.issues.length > 0 ? { issues: cleaned.issues } : {}),
  };
}

export async function deleteFaq(deps: KnowledgeDeps, documentId: string): Promise<void> {
  const document = await loadFaqDocument(deps, documentId);
  await repo.knowledge.deleteDocument(deps.db, document.id);
}

export async function publishFaq(
  deps: KnowledgeDeps,
  documentId: string,
  body: { versionId: string; expectedVersionId: string | null },
) {
  const document = await loadFaqDocument(deps, documentId);
  const updated = await publishFaqVersion(deps, document, body.versionId, body.expectedVersionId);
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [updated.id]);
  return toFaqDocument(updated, tags.get(updated.id) ?? []);
}

export async function setFaqStatus(deps: KnowledgeDeps, documentId: string, enabled: boolean) {
  const document = await loadFaqDocument(deps, documentId);
  const updated = await setFaqEnabled(deps, document, enabled);
  const tags = await repo.knowledge.getDocumentTagNames(deps.db, [updated.id]);
  return toFaqDocument(updated, tags.get(updated.id) ?? []);
}

export async function faqBatch(
  deps: KnowledgeDeps,
  id: string,
  input: {
    action: 'publish' | 'enable' | 'disable' | 'delete';
    items: Array<{
      documentId: string;
      versionId?: string | undefined;
      expectedVersionId?: string | null | undefined;
    }>;
    importBatchId?: string | undefined;
  },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  if (input.importBatchId !== undefined) {
    if (input.action !== 'publish' || input.items.length > 500) {
      throw new AppError('INVALID_INPUT', '导入批次只能整批发布，最多 500 条');
    }
    const published = await repo.knowledge.publishFaqImport(deps.db, {
      baseId: base.id,
      importBatchId: input.importBatchId,
      items: input.items.map((item) => {
        if (item.versionId === undefined || item.expectedVersionId === undefined) {
          fail('INVALID_INPUT', '发布需要 versionId 与 expectedVersionId');
        }
        return {
          documentId: item.documentId,
          versionId: item.versionId,
          expectedVersionId: item.expectedVersionId,
        };
      }),
    });
    return {
      results: published.map((document) => ({
        documentId: document.id,
        status: 'succeeded' as const,
      })),
    };
  }
  if (input.items.length > 100) {
    throw new AppError('INVALID_INPUT', '普通批量操作最多 100 条');
  }
  const results: Array<{
    documentId: string;
    status: 'succeeded' | 'failed';
    code?: string | undefined;
    message?: string | undefined;
  }> = [];
  for (const item of input.items) {
    const document = await repo.knowledge.getDocument(deps.db, item.documentId).catch(() => null);
    if (!document || document.baseId !== base.id || document.contentKind !== 'faq') {
      results.push({
        documentId: item.documentId,
        status: 'failed',
        code: 'NOT_FOUND',
        message: 'FAQ 不存在或不属于该知识库',
      });
      continue;
    }
    try {
      if (input.action === 'publish') {
        if (item.versionId === undefined || item.expectedVersionId === undefined) {
          fail('INVALID_INPUT', '发布需要 versionId 与 expectedVersionId');
        }
        await publishFaqVersion(deps, document, item.versionId, item.expectedVersionId);
      } else if (input.action === 'delete') {
        await repo.knowledge.deleteDocument(deps.db, document.id);
      } else {
        await setFaqEnabled(deps, document, input.action === 'enable');
      }
      results.push({ documentId: document.id, status: 'succeeded' });
    } catch (err) {
      results.push({
        documentId: document.id,
        status: 'failed',
        code: isAppError(err) ? err.code : 'INTERNAL_ERROR',
        message: isAppError(err) ? err.message : '操作失败',
      });
    }
  }
  return { results };
}

export async function importFaqs(
  deps: KnowledgeDeps,
  id: string,
  input: {
    format: 'json' | 'csv' | 'xlsx';
    content: string;
    mode: 'append' | 'replace';
    dryRun: boolean;
  },
) {
  const base = await activeFaqBase(deps, id);
  assertBodyBytes(input.content, FAQ_IMPORT_BODY_LIMIT);
  const rows = await parseFaqImport({ format: input.format, content: input.content });
  const existing = await loadExistingFaqEntries(deps, base.id);
  const plan = planFaqImport({
    mode: input.mode,
    rows,
    existing,
    newDocumentId: () => newId('knowledgeDocument'),
  });
  const response: KnowledgeFaqImportResponse = {
    dryRun: input.dryRun,
    mode: input.mode,
    committed: false,
    importBatchId: null as string | null,
    counts: plan.counts,
    results: plan.results as unknown as KnowledgeFaqImportResult[],
  };
  if (input.dryRun) return response;
  if (plan.counts.failed > 0) return response;
  if (plan.drafts.length === 0) {
    if (input.mode === 'replace') {
      throw new AppError('INVALID_INPUT', '替换批次为空，未执行删除');
    }
    return response;
  }
  const importBatchId = newFaqImportBatchId();
  const existingById = new Map(existing.map((entry) => [entry.documentId, entry]));
  const targets =
    input.mode === 'replace'
      ? existing
      : plan.drafts.flatMap((draft) => {
          const entry = existingById.get(draft.documentId);
          return entry ? [entry] : [];
        });
  const prepared: PreparedDraft[] = [];
  for (const draft of plan.drafts) {
    prepared.push(
      await prepareImportDraft(deps, base, {
        operation: draft.operation,
        documentId: draft.documentId,
        faq: draft.faq,
        enabled: draft.enabled,
      }),
    );
  }
  const saved = await repo.knowledge.saveFaqImportDrafts(deps.db, {
    baseId: base.id,
    importBatchId,
    mode: input.mode,
    expectedState: targets.map(existingState),
    drafts: prepared.map(
      (item) =>
        item.draft as unknown as Parameters<
          typeof repo.knowledge.saveFaqImportDrafts
        >[1]['drafts'][number],
    ),
  });
  const jobs = new Map(saved.items.map((item) => [item.documentId, item]));
  for (const item of saved.items) {
    await enqueueKnowledgeJob({ id: item.jobId }).catch((err: unknown) => {
      deps.log.warn({ err, jobId: item.jobId }, 'FAQ 导入任务入队失败，等待对账补投');
    });
  }
  const results = plan.results.map((result) => {
    const item = result.documentId ? jobs.get(result.documentId) : undefined;
    return item
      ? { ...result, expectedVersionId: item.expectedVersionId, jobId: item.jobId }
      : result;
  });
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.faq.imported',
    target: base.id,
    input: { importBatchId, mode: input.mode, counts: plan.counts },
    status: 'ok',
    requestId: deps.requestId,
  });
  return { ...response, committed: true, importBatchId, results };
}

export async function testFaqs(
  deps: KnowledgeDeps,
  id: string,
  body: {
    q: string;
    limit: number;
    rerank: boolean;
    minVectorScore: number;
    onlyRecommended: boolean;
    faqPriority: boolean;
    faqDirectAnswerThreshold: number;
  },
) {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  return searchKnowledge(
    deps.db,
    id,
    {
      q: body.q,
      kinds: ['faq'],
      folders: [],
      tags: [],
      limit: body.limit,
      rerank: body.rerank,
      minVectorScore: body.minVectorScore,
      diagnostics: false,
      onlyRecommended: body.onlyRecommended,
      faqPriority: body.faqPriority,
      faqDirectAnswerThreshold: body.faqDirectAnswerThreshold,
    },
    { secretKey: deps.config.APP_SECRET_KEY },
  );
}

export async function exportFaqs(
  deps: KnowledgeDeps,
  id: string,
  query: { format: 'json' | 'csv'; version: 'published' | 'draft' },
) {
  const base = await repo.knowledge.getBase(deps.db, id);
  if (!base) notFound('知识库');
  const documents = await deps.db
    .select()
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.baseId, base.id),
        eq(schema.knowledgeDocuments.contentKind, 'faq'),
      ),
    )
    .orderBy(desc(schema.knowledgeDocuments.createdAt), desc(schema.knowledgeDocuments.id))
    .limit(501);
  if (documents.length > 500) {
    throw new AppError('CONFLICT', 'FAQ 超过 500 条，无法一次导出');
  }
  const ids = documents.map((document) => document.id);
  const versions =
    ids.length === 0
      ? []
      : await deps.db
          .select()
          .from(schema.knowledgeDocumentVersions)
          .where(
            and(
              inArray(schema.knowledgeDocumentVersions.documentId, ids),
              isNotNull(schema.knowledgeDocumentVersions.faq),
            ),
          )
          .orderBy(desc(schema.knowledgeDocumentVersions.version));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const latestByDocument = new Map<string, VersionRow>();
  for (const version of versions) {
    if (!latestByDocument.has(version.documentId))
      latestByDocument.set(version.documentId, version);
  }
  const items = documents.flatMap((document) => {
    const latest = latestByDocument.get(document.id);
    const published = document.currentVersionId
      ? versionById.get(document.currentVersionId)
      : undefined;
    const draft = latest && !isPublishedFaqVersion(document, latest) ? latest : undefined;
    const version = query.version === 'published' ? published : (draft ?? published);
    if (!version?.faq) return [];
    return [
      {
        ...version.faq,
        enabled: faqEnabledForVersion(document, version),
      } satisfies FaqTransferEntry,
    ];
  });
  const content = serializeFaqExport(query.format, items);
  if (Buffer.byteLength(content, 'utf8') > FAQ_MAX_BYTES) {
    throw new AppError('CONFLICT', 'FAQ 导出内容超过 2MiB，请缩小范围');
  }
  return {
    content,
    contentType: query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    filename: `faqs.${query.format}`,
  };
}

// ---- jobs -----------------------------------------------------------------

export async function listJobs(
  deps: KnowledgeDeps,
  query: PageQuery & {
    baseId?: string | undefined;
    documentId?: string | undefined;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | undefined;
  },
) {
  const { baseId, documentId, status, ...rest } = query;
  const page = await repo.knowledge.listJobs(deps.db, {
    ...pageOptions(rest),
    ...(baseId === undefined ? {} : { baseId }),
    ...(documentId === undefined ? {} : { documentId }),
    ...(status === undefined ? {} : { status }),
  });
  return { items: page.items.map(toJob), nextCursor: page.nextCursor };
}

export async function getJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  return toJob(row);
}

export async function retryJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  if (row.status !== 'failed' && row.status !== 'cancelled') {
    throw new AppError('CONFLICT', '只有失败或已取消的任务可以重试');
  }
  const payload = knowledgeJobPayloadSchema.parse(row.payload);
  if (payload.type === 'sync') {
    const created = await repo.knowledge.createSyncJob(deps.db, payload.sourceId);
    if (created.status === 'not_found') notFound('来源');
    if (created.status === 'not_active') throw new AppError('CONFLICT', '来源未启用，无法同步');
    if (created.status === 'in_progress') {
      throw new AppError('CONFLICT', '该来源已有同步任务在进行中');
    }
    await enqueueKnowledgeJob(created.job);
    return { jobId: created.job.id };
  }
  let faqDraftBinding: {
    versionId: string;
    jobKey: 'indexingJobId' | 'faqImportJobId';
  } | null = null;
  if (payload.type === 'ingest' && payload.publish === 'draft' && payload.versionId !== undefined) {
    const document = await repo.knowledge.getDocument(deps.db, payload.documentId);
    const version = document ? await repo.knowledge.getVersion(deps.db, payload.versionId) : null;
    if (
      document?.contentKind === 'faq' &&
      document.id === row.documentId &&
      document.baseId === row.baseId &&
      version?.documentId === document.id &&
      version.metadata.publication === 'draft'
    ) {
      if (version.metadata.faqImport === undefined) {
        faqDraftBinding = { versionId: version.id, jobKey: 'indexingJobId' };
      } else if (knowledgeFaqImportMetadataSchema.safeParse(version.metadata.faqImport).success) {
        faqDraftBinding = { versionId: version.id, jobKey: 'faqImportJobId' };
      }
    }
  }
  if (faqDraftBinding) {
    const { versionId, jobKey } = faqDraftBinding;
    const job = await deps.db.transaction(async (tx) => {
      const created = await createJob(tx, {
        baseId: row.baseId,
        documentId: row.documentId,
        sourceId: row.sourceId,
        payload,
      });
      const rebind =
        jobKey === 'indexingJobId'
          ? sql`jsonb_build_object('indexingJobId', ${created.id}::text)`
          : sql`jsonb_build_object('faqImportJobId', ${created.id}::text)`;
      const [bound] = await tx
        .update(schema.knowledgeDocumentVersions)
        .set({ metadata: sql`${schema.knowledgeDocumentVersions.metadata} || ${rebind}` })
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
    return { jobId: job.id };
  }
  const job = await enqueue(deps, payload, {
    baseId: row.baseId,
    documentId: row.documentId,
    sourceId: row.sourceId,
  });
  return { jobId: job.id };
}

export async function cancelJob(deps: KnowledgeDeps, jobId: string) {
  const row = await repo.knowledge.getJob(deps.db, jobId);
  if (!row) notFound('任务');
  if (row.status === 'queued') {
    const cancelled = await repo.knowledge.finishJob(deps.db, row.id, {
      fromStatus: 'queued',
      status: 'cancelled',
      error: 'cancelled',
    });
    if (cancelled) return toJob(cancelled);
    const claimed = await repo.knowledge.getJob(deps.db, row.id);
    if (!claimed || claimed.status !== 'running') {
      throw new AppError('CONFLICT', '任务已结束，无法取消');
    }
    await publishKnowledgeCancel(claimed.id);
    return toJob(claimed);
  }
  if (row.status !== 'running') throw new AppError('CONFLICT', '任务已结束，无法取消');
  await publishKnowledgeCancel(row.id);
  return toJob(row);
}

// ---- model profiles -------------------------------------------------------

export async function listModelProfiles(deps: KnowledgeDeps, view: 'selection' | undefined) {
  const rows = await repo.knowledge.listModelProfiles(deps.db);
  if (view !== 'selection') return rows.map(toProfile);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    supportsImageVectors: row.kind === 'embedding' && row.enabled && supportsImageVectors(row),
  }));
}

export async function createModelProfile(
  deps: KnowledgeDeps,
  input: {
    kind: 'embedding' | 'rerank' | 'asr';
    name: string;
    endpointUrl: string;
    model: string;
    embeddingProtocol: 'openai' | 'cohere_v2';
    imageInputEnabled: boolean;
    apiKey?: string | undefined;
    enabled: boolean;
  },
) {
  const capabilityProblem = imageCapabilityProblem(input);
  if (capabilityProblem !== null) throw new AppError('INVALID_INPUT', capabilityProblem);
  try {
    await assertKnowledgeEndpoint(input.endpointUrl, deps.config);
    const row = await repo.knowledge.createModelProfile(deps.db, {
      kind: input.kind,
      name: input.name,
      endpointUrl: input.endpointUrl,
      model: input.model,
      embeddingProtocol: input.embeddingProtocol,
      imageInputEnabled: input.imageInputEnabled,
      dimensions: input.kind === 'embedding' ? 1024 : null,
      secretsEncrypted: input.apiKey
        ? encryptSecrets({ apiKey: input.apiKey }, deps.config.APP_SECRET_KEY)
        : null,
      enabled: input.enabled,
    });
    return toProfile({ ...row, hasSecret: row.secretsEncrypted !== null });
  } catch (err) {
    if (isPgCode(err, '23505')) throw new AppError('CONFLICT', '同类型下已有同名 profile');
    throw err;
  }
}

export async function updateModelProfile(
  deps: KnowledgeDeps,
  profileId: string,
  body: {
    name?: string | undefined;
    endpointUrl?: string | undefined;
    model?: string | undefined;
    embeddingProtocol?: 'openai' | 'cohere_v2' | undefined;
    imageInputEnabled?: boolean | undefined;
    apiKey?: string | null | undefined;
    enabled?: boolean | undefined;
  },
) {
  const { apiKey, ...rest } = body;
  if (rest.endpointUrl !== undefined) await assertKnowledgeEndpoint(rest.endpointUrl, deps.config);
  const current = await repo.knowledge.getModelProfileWithSecret(deps.db, profileId);
  if (!current) notFound('模型 profile');
  if (
    current.kind === 'asr' &&
    rest.embeddingProtocol !== undefined &&
    rest.embeddingProtocol !== 'openai'
  ) {
    throw new AppError('INVALID_INPUT', 'ASR profile 固定使用 openai 转录协议');
  }
  const next = {
    kind: current.kind,
    model: rest.model ?? current.model,
    embeddingProtocol: rest.embeddingProtocol ?? current.embeddingProtocol,
    imageInputEnabled: rest.imageInputEnabled ?? current.imageInputEnabled,
  };
  const capabilityProblem = imageCapabilityProblem(next);
  if (capabilityProblem !== null) throw new AppError('INVALID_INPUT', capabilityProblem);
  if (
    (rest.model !== undefined && rest.model !== current.model) ||
    (rest.embeddingProtocol !== undefined &&
      rest.embeddingProtocol !== current.embeddingProtocol) ||
    (rest.imageInputEnabled !== undefined && rest.imageInputEnabled !== current.imageInputEnabled)
  ) {
    const result = await deps.db.execute<{ referenced: boolean }>(sql`
      select exists(
        select 1 from knowledge_bases where embedding_profile_id = ${current.id}
        union all
        select 1 from knowledge_bases where asr_profile_id = ${current.id}
        union all
        select 1 from knowledge_document_versions where embedding_profile_id = ${current.id}
      ) as referenced
    `);
    if (result[0]?.referenced) {
      throw new AppError(
        'CONFLICT',
        '该 profile 已被知识库引用，不能原地更换模型、协议或图片能力；请新建 profile 后切换并重建',
      );
    }
  }
  const row = await repo.knowledge.updateModelProfile(deps.db, profileId, {
    ...rest,
    ...(apiKey === undefined
      ? {}
      : {
          secretsEncrypted:
            apiKey === null ? null : encryptSecrets({ apiKey }, deps.config.APP_SECRET_KEY),
        }),
  });
  if (!row) notFound('模型 profile');
  return toProfile({ ...row, hasSecret: row.secretsEncrypted !== null });
}

export async function deleteModelProfile(deps: KnowledgeDeps, profileId: string): Promise<void> {
  try {
    const result = await deps.db.execute(
      sql`delete from knowledge_model_profiles where id = ${profileId} returning id`,
    );
    if (result.length === 0) notFound('模型 profile');
  } catch (err) {
    if (isPgCode(err, '23001') || isPgCode(err, '23503')) {
      throw new AppError('CONFLICT', '该 profile 仍被知识库使用，请先切换或删除知识库');
    }
    throw err;
  }
}

export async function testModelProfile(
  deps: KnowledgeDeps,
  profileId: string,
): Promise<{ ok: true } | { ok: false; kind: KnowledgeModelError['kind'] }> {
  const row = await repo.knowledge.getModelProfileWithSecret(deps.db, profileId);
  if (!row) notFound('模型 profile');
  if (row.kind === 'asr') {
    throw new AppError('CONFLICT', 'ASR 请通过显式音频上传验证');
  }
  await assertKnowledgeEndpoint(row.endpointUrl, deps.config);
  const apiKey = row.secretsEncrypted
    ? decryptSecrets(row.secretsEncrypted, deps.config.APP_SECRET_KEY).apiKey
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
    return { ok: true as const };
  } catch (err) {
    if (err instanceof KnowledgeModelError) return { ok: false as const, kind: err.kind };
    throw err;
  }
}

// ---- retrieval evaluation -------------------------------------------------

export async function evaluateBase(
  deps: KnowledgeDeps,
  id: string,
  body: {
    cases: Array<{
      q: string;
      expectedTargets: KnowledgeTarget[];
      expectedChunkIds?: string[] | undefined;
    }>;
    limit: number;
    rerank: boolean;
    minVectorScore: number;
  },
): Promise<RetrievalEvaluationReport> {
  if (!(await repo.knowledge.getBase(deps.db, id))) notFound('知识库');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > EVALUATION_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '评估内容超过 1MiB 上限');
  }
  for (const testCase of body.cases) {
    for (const target of testCase.expectedTargets) {
      if (target.kind === 'wiki') {
        const page = await repo.knowledge.getWikiPage(deps.db, target.id);
        if (!page || page.baseId !== id) {
          throw new AppError('INVALID_INPUT', `期望 Wiki 页面不属于该知识库：${target.id}`);
        }
        continue;
      }
      const document = await repo.knowledge.getDocument(deps.db, target.id);
      const expectedKind = target.kind === 'faq' ? 'faq' : 'document';
      if (!document || document.baseId !== id || document.contentKind !== expectedKind) {
        throw new AppError('INVALID_INPUT', `期望目标不属于该知识库：${target.id}`);
      }
    }
    for (const chunkId of testCase.expectedChunkIds ?? []) {
      const chunk = await repo.knowledge.getChunk(deps.db, chunkId);
      if (!chunk || chunk.baseId !== id) {
        throw new AppError('INVALID_INPUT', `期望分块不属于该知识库：${chunkId}`);
      }
    }
  }
  return evaluateRetrieval({
    cases: body.cases,
    limit: body.limit,
    rerank: body.rerank,
    minVectorScore: body.minVectorScore,
    search: (query) =>
      searchKnowledge(deps.db, id, query, { secretKey: deps.config.APP_SECRET_KEY }),
  });
}

// ---- binary / native ------------------------------------------------------

export async function getVersionDetails(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) throw new AppError('NOT_FOUND', '版本不存在，可能已被删除');
  return {
    id: version.id,
    documentId: version.documentId,
    version: version.version,
    originalFilename: version.originalFilename,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    sourceRevision: version.sourceRevision,
    parseStatus: version.parseStatus,
    pageMap: version.pageMap as Array<Record<string, unknown>>,
    images: version.images,
    createdAt: version.createdAt.toISOString(),
  };
}

export async function getVersionContent(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) notFound('版本');
  const data = await readFile(blobPathFor(deps.config.KNOWLEDGE_DIR, version.blobSha256)).catch(
    () => null,
  );
  if (!data) notFound('原件');
  return { data, mimeType: version.mimeType, filename: version.originalFilename };
}

export async function getVersionMarkdown(deps: KnowledgeDeps, versionId: string) {
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) notFound('版本');
  const [document, markdown] = await Promise.all([
    repo.knowledge.getDocument(deps.db, version.documentId),
    readFile(
      join(deps.config.KNOWLEDGE_DIR, 'docs', version.documentId, version.id, 'markdown.md'),
      'utf8',
    ).catch(() => null),
  ]);
  if (markdown === null) notFound('解析正文');
  return { markdown, status: document?.status ?? 'unknown' };
}

export async function getVersionImage(
  deps: KnowledgeDeps,
  versionId: string,
  name: string,
): Promise<{ data: Buffer; mimeType: string }> {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new AppError('INVALID_INPUT', '图片名不合法');
  }
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version) throw new AppError('NOT_FOUND', '版本不存在，可能已被删除');
  const image = version.images.find((entry) => entry.name === name);
  if (!image) throw new AppError('NOT_FOUND', '图片不存在或不属于该版本');
  const data = await readFile(
    join(deps.config.KNOWLEDGE_DIR, 'docs', version.documentId, version.id, 'images', image.name),
  ).catch(() => null);
  if (!data) throw new AppError('NOT_FOUND', '图片文件缺失，请重新解析该版本');
  return {
    data,
    mimeType: /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(image.mimeType)
      ? image.mimeType
      : 'application/octet-stream',
  };
}

export async function exportPackage(deps: KnowledgeDeps, id: string) {
  const pkg = await exportKnowledgePackage(deps.db, deps.config.KNOWLEDGE_DIR, id);
  if (!pkg) notFound('知识库');
  return pkg;
}

export async function importPackage(deps: KnowledgeDeps, archive: Buffer) {
  if (archive.length > KNOWLEDGE_PACKAGE_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', '请求体超出大小限制，请减少内容后重试');
  }
  const result = await importKnowledgePackage(deps.db, deps.config.KNOWLEDGE_DIR, archive);
  await repo.audit.writeAudit(deps.db, deps.log, {
    actor: deps.actor,
    action: 'knowledge.base.imported',
    target: result.baseId,
    input: result.counts,
    status: 'ok',
    requestId: deps.requestId,
  });
  return result;
}
