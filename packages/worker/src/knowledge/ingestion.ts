import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AsrProfile,
  embedImages,
  embedTexts,
  ensureKnowledgeBlob,
  KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE,
  KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE,
  KnowledgeModelError,
  knowledgeBlobPath,
  knowledgeBlobsRoot,
  knowledgeDocsRoot,
  knowledgeVersionDir,
  knowledgeVersionImagePath,
  knowledgeVersionImagesDir,
  knowledgeVersionMarkdownPath,
  segmentForSearch,
  sha256Hex,
} from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import type {
  KnowledgeImageProcessing,
  KnowledgeLocator,
  KnowledgeSourceProbeResult,
} from '@agentport/shared';
import {
  errorText,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  knowledgeBaseSettingsSchema,
  knowledgeImageChunkMetadataSchema,
  knowledgeJobPayloadSchema,
  supportsKnowledgeImageVectors,
} from '@agentport/shared';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import { ONE_SHOT_NO_RESULT_MESSAGE, type OneShotSdkOutcome } from '../one-shot-sdk.js';
import { describeKnowledgeImage, type ImageQueryFn } from './image-processing.js';
import { KnowledgeParseError, type ParsedDocument, type ParsedImage } from './parsing.js';
import { sourceNetworkOptions } from './source-http.js';
import { SourceAuthError } from './sources.js';

type KnowledgeDocumentRow = typeof schema.knowledgeDocuments.$inferSelect;
type KnowledgeJobRow = typeof schema.knowledgeJobs.$inferSelect;
type KnowledgeSourceRow = typeof schema.knowledgeSources.$inferSelect;
type KnowledgeBaseRow = typeof schema.knowledgeBases.$inferSelect;

const OVERVIEW_SLUG = 'overview';
const OVERVIEW_TITLE = '知识库概览';
const OVERVIEW_INSTRUCTION =
  '这是知识库的索引页：概括知识库主题与主要文档，给出推荐阅读顺序；只为实际检索到的当前内容建立引用。';

export interface WikiUpdateInput {
  baseId: string;
  jobIds: string[];
}

type IngestionDocument = Omit<ParsedDocument, 'blocks'> & Partial<Pick<ParsedDocument, 'blocks'>>;

export interface ChunkDraft {
  kind: 'text' | 'table' | 'image';
  heading: string | null;
  content: string;
  pageFrom: number | null;
  pageTo: number | null;
  parentOrdinal?: number | null;
  indexRole?: 'leaf' | 'parent';
  locator?: KnowledgeLocator | null;
  metadata?: Record<string, unknown>;
  searchText?: string;
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
  deleted?: boolean;
  completeness?: 'full' | 'summary';
  rangeId?: string;
  failure?: { code: string; message: string; retryable: boolean };
}

export interface SourceCheckpoint {
  complete: boolean;
}

export interface ConnectorNetwork {
  trustedHosts?: readonly string[];
  allowLoopback?: boolean;
}

export interface KnowledgeConnector {
  sync(input: {
    connectionId: string;
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    ranges: Array<{
      id?: string;
      kind: string;
      externalId: string;
      ref: string | null;
      paths: string[];
    }>;
    cursor: Record<string, unknown>;
    signal: AbortSignal;
    network?: ConnectorNetwork;
    onCheckpoint(cursor: Record<string, unknown>, checkpoint: SourceCheckpoint): Promise<void>;
  }): AsyncIterable<SourceItem>;
  probe?(input: {
    config: Record<string, unknown>;
    secrets: Record<string, string>;
    range: { kind: string; externalId: string; ref: string | null; paths: string[] };
    signal: AbortSignal;
    network?: ConnectorNetwork;
  }): Promise<void>;
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
    asr?: AsrProfile;
    asrProfileName?: string;
  }) => Promise<IngestionDocument>;
  chunkMarkdown: (
    markdown: string,
    pageMap: IngestionDocument['pageMap'],
    options: { chunkTokens: number; overlap: number },
    blocks?: IngestionDocument['blocks'],
  ) => ChunkDraft[];
  connectors: Partial<Record<KnowledgeSourceRow['type'], KnowledgeConnector>>;
  decrypt: (payload: string) => Record<string, string> | Promise<Record<string, string>>;
  onWikiUpdate?: (input: WikiUpdateInput) => Promise<void>;
  summaryModel?: string | undefined;
  onSummaryJobs?: (input: { baseId: string; jobIds: string[] }) => Promise<void>;
  trustedHosts?: readonly string[];
  allowLoopback?: boolean;
  imageQueryFn?: ImageQueryFn;
  anthropicBaseUrl: string | undefined;
}

const EMBED_BATCH = 32;
const MODEL_CONCURRENCY = 2;
const SYNC_CHECKPOINT_ITEMS = 50;
const SYNC_CHECKPOINT_MS = 30_000;
const BLOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE = 200;

const RETRYABLE = new Set(['timeout', 'rate_limit', 'unavailable']);

const MODEL_RETRY_ATTEMPTS = 3;
const MODEL_RETRY_BASE_DELAY_MS = 1_000;

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

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await Bun.sleep(ms);
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Bun.sleep(ms),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function withModelRetry<T>(
  call: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (attempt + 1 >= MODEL_RETRY_ATTEMPTS || !isRetryableKnowledgeError(err)) throw err;
      await delay(MODEL_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 100, signal);
    }
  }
}

export function describeKnowledgeError(err: unknown): string {
  const message = errorText(err);
  const kind =
    err instanceof KnowledgeModelError
      ? `${err.kind}: `
      : err instanceof KnowledgeParseError
        ? `parse_${err.code}: `
        : '';
  return `${kind}${message}`.slice(0, 500);
}

export class KnowledgeCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export function requireOneShotSuccess(outcome: OneShotSdkOutcome): void {
  if (outcome.status === 'aborted') throw new KnowledgeCancelled();
  if (outcome.status === 'no_result') throw new Error(ONE_SHOT_NO_RESULT_MESSAGE);
  if (outcome.status === 'failure') throw new Error(outcome.message);
}

class KnowledgeProfileMismatch extends Error {}

class SourceSnapshotStale extends Error {}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new KnowledgeCancelled();
}

async function runBounded<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  task: (item: T, taskSignal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(MODEL_CONCURRENCY);
  const controller = new AbortController();
  const taskSignal = AbortSignal.any([signal, controller.signal]);
  let failed = false;
  let firstError: unknown;
  const settled = await Promise.allSettled(
    items.map((item) =>
      limit(async () => {
        if (failed) throw firstError;
        try {
          return await task(item, taskSignal);
        } catch (err) {
          if (!failed) {
            failed = true;
            firstError = err;
            controller.abort();
          }
          throw err;
        }
      }),
    ),
  );
  if (failed) throw firstError;
  return settled.map((result) => (result as PromiseFulfilledResult<R>).value);
}

async function ensureJobRunning(
  deps: KnowledgeDeps,
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  checkAborted(signal);
  const job = await repo.knowledge.getJob(deps.db, jobId);
  if (job?.status !== 'running') throw new KnowledgeCancelled();
}

async function writeParsed(
  knowledgeDir: string,
  documentId: string,
  versionId: string,
  parsed: IngestionDocument,
): Promise<void> {
  const dir = knowledgeVersionDir(knowledgeDir, documentId, versionId);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    knowledgeVersionMarkdownPath(knowledgeDir, documentId, versionId),
    parsed.markdown,
  );
  if (parsed.images.length === 0) return;
  const imageDir = knowledgeVersionImagesDir(knowledgeDir, documentId, versionId);
  await mkdir(imageDir, { recursive: true });
  for (const image of parsed.images) {
    await Bun.write(
      knowledgeVersionImagePath(knowledgeDir, documentId, versionId, image.name),
      image.data,
    );
  }
}

interface EmbeddingClient {
  profileId: string;
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
    ? (await deps.decrypt(profile.secretsEncrypted)).apiKey
    : undefined;
  const settings = {
    endpointUrl: profile.endpointUrl,
    model: profile.model,
    dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    ...(apiKey ? { apiKey } : {}),
    embeddingProtocol: profile.embeddingProtocol,
    imageInputEnabled: profile.imageInputEnabled,
  };
  return {
    profileId: profile.id,
    imageVectors: supportsKnowledgeImageVectors({
      protocol: profile.embeddingProtocol,
      model: profile.model,
      supportsImageInput: profile.imageInputEnabled,
    }),
    embed: (texts, signal) => withModelRetry(() => embedTexts(settings, texts, signal), signal),
    embedImage: async (image, signal) =>
      withModelRetry(async () => {
        const [vector] = await embedImages(settings, [image], signal);
        if (!vector) throw new Error('图片向量返回为空');
        return vector;
      }, signal),
  };
}

async function embedAll(
  client: EmbeddingClient,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const batches = Array.from({ length: Math.ceil(texts.length / EMBED_BATCH) }, (_, index) =>
    texts.slice(index * EMBED_BATCH, (index + 1) * EMBED_BATCH),
  );
  const vectors = await runBounded(batches, signal, (batch, taskSignal) => {
    checkAborted(taskSignal);
    return client.embed(batch, taskSignal);
  });
  return vectors.flat();
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

async function linkWikiAfterIngest(
  deps: KnowledgeDeps,
  base: KnowledgeBaseRow,
  document: KnowledgeDocumentRow,
): Promise<void> {
  if (document.contentKind !== 'document') return;
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
    if (anyPage?.items.length === 0) {
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
    deps.logger.warn(
      { err, baseId: base.id, jobIds },
      'wiki job enqueue failed; awaiting reconcile',
    );
  }
}

async function requestAutoSummary(
  deps: KnowledgeDeps,
  base: KnowledgeBaseRow,
  document: KnowledgeDocumentRow,
): Promise<void> {
  if (document.contentKind !== 'document') return;
  if (base.settings.autoSummary !== true) return;
  if (!deps.summaryModel || !deps.onSummaryJobs) return;
  const versionId = document.currentVersionId;
  if (!versionId) return;
  const pending = await deps.db
    .select({ payload: schema.knowledgeJobs.payload })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.documentId, document.id),
        eq(schema.knowledgeJobs.type, 'summary'),
        inArray(schema.knowledgeJobs.status, ['queued', 'running']),
      ),
    );
  const alreadyQueued = pending.some((row) => {
    const parsed = knowledgeJobPayloadSchema.safeParse(row.payload);
    return parsed.success && parsed.data.type === 'summary' && parsed.data.versionId === versionId;
  });
  if (alreadyQueued) return;
  const job = await deps.db.transaction(async (tx) => {
    const begun = await repo.knowledge.beginDocumentSummary(
      tx,
      document.id,
      versionId,
      'pending',
      versionId,
    );
    if (!begun) return null;
    return repo.knowledge.createJob(tx, {
      type: 'summary',
      baseId: base.id,
      documentId: document.id,
      sourceId: null,
      payload: {
        type: 'summary',
        baseId: base.id,
        documentId: document.id,
        versionId,
      },
    });
  });
  if (!job) return;
  try {
    await deps.onSummaryJobs({ baseId: base.id, jobIds: [job.id] });
  } catch (err) {
    const current = await repo.knowledge.getDocument(deps.db, document.id);
    if (current?.summaryStatus === 'pending' && current.summaryVersionId === versionId) {
      await repo.knowledge
        .setDocumentSummary(
          deps.db,
          document.id,
          {
            summaryStatus: 'none',
            summaryVersionId: versionId,
            summary: null,
            summaryGeneratedAt: null,
            summaryError: null,
          },
          versionId,
        )
        .catch(() => undefined);
    }
    deps.logger.warn(
      { err, baseId: base.id, jobIds: [job.id] },
      'summary job enqueue failed; awaiting reconcile',
    );
  }
}

async function requestAutoTag(
  deps: KnowledgeDeps,
  base: KnowledgeBaseRow,
  document: KnowledgeDocumentRow,
): Promise<void> {
  if (document.contentKind !== 'document') return;
  if (base.settings.autoTag !== true) return;
  if (!deps.summaryModel || !deps.onSummaryJobs) return;
  if (!document.currentVersionId) return;
  const versionId = document.currentVersionId;
  const pending = await deps.db
    .select({ payload: schema.knowledgeJobs.payload })
    .from(schema.knowledgeJobs)
    .where(
      and(
        eq(schema.knowledgeJobs.documentId, document.id),
        eq(schema.knowledgeJobs.type, 'tag_generate'),
        inArray(schema.knowledgeJobs.status, ['queued', 'running']),
      ),
    );
  const alreadyQueued = pending.some((row) => {
    const parsed = knowledgeJobPayloadSchema.safeParse(row.payload);
    return (
      parsed.success && parsed.data.type === 'tag_generate' && parsed.data.versionId === versionId
    );
  });
  if (alreadyQueued) return;
  const job = await repo.knowledge.createJob(deps.db, {
    type: 'tag_generate',
    baseId: base.id,
    documentId: document.id,
    sourceId: null,
    payload: { type: 'tag_generate', baseId: base.id, documentId: document.id, versionId },
  });
  try {
    await deps.onSummaryJobs({ baseId: base.id, jobIds: [job.id] });
  } catch (err) {
    deps.logger.warn(
      { err, baseId: base.id, jobIds: [job.id] },
      'tag job enqueue failed; awaiting reconcile',
    );
  }
}

function imageRefOf(image: ParsedImage) {
  return { name: image.name, mimeType: image.mimeType, page: image.page };
}

async function imageDrafts(
  deps: KnowledgeDeps,
  client: EmbeddingClient,
  parsed: IngestionDocument,
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

  const processImage = async (image: ParsedImage, taskSignal: AbortSignal) => {
    checkAborted(taskSignal);
    const described = await describeKnowledgeImage(
      {
        image: { mimeType: image.mimeType, data: image.data },
        settings,
        signal: taskSignal,
      },
      {
        ...(deps.imageQueryFn === undefined ? {} : { queryFn: deps.imageQueryFn }),
        anthropicBaseUrl: deps.anthropicBaseUrl,
      },
    );
    checkAborted(taskSignal);
    const own = [...described.warnings];
    if (vectorWarning) own.push(vectorWarning);
    if (described.ocr === null && described.caption === null) {
      throw new Error(`图片 ${image.name} 没有可用的 OCR 或描述：${own.join('; ')}`);
    }
    const ownDrafts: ChunkDraft[] = [];
    const metadata = (role: 'ocr' | 'caption' | 'vector') =>
      knowledgeImageChunkMetadataSchema.parse({ image: imageRefOf(image), imageRole: role });
    if (described.ocr !== null) {
      ownDrafts.push({
        kind: 'image',
        heading: null,
        content: described.ocr,
        pageFrom: image.page,
        pageTo: image.page,
        locator: { pageFrom: image.page, pageTo: image.page },
        metadata: metadata('ocr'),
      });
    }
    if (described.caption !== null) {
      ownDrafts.push({
        kind: 'image',
        heading: null,
        content: described.caption,
        pageFrom: image.page,
        pageTo: image.page,
        locator: { pageFrom: image.page, pageTo: image.page },
        metadata: metadata('caption'),
      });
    }
    const description = described.caption ?? described.ocr ?? '';
    if (vectorEnabled) {
      try {
        const embedding = await client.embedImage(
          { mimeType: image.mimeType, dataBase64: Buffer.from(image.data).toString('base64') },
          taskSignal,
        );
        ownDrafts.push({
          kind: 'image',
          heading: null,
          content: description,
          pageFrom: image.page,
          pageTo: image.page,
          locator: { pageFrom: image.page, pageTo: image.page },
          metadata: metadata('vector'),
          searchText: '',
          embedding,
        });
      } catch (err) {
        if (taskSignal.aborted) throw err;
        ownDrafts.push({
          kind: 'image',
          heading: null,
          content: description,
          pageFrom: image.page,
          pageTo: image.page,
          locator: { pageFrom: image.page, pageTo: image.page },
          metadata: metadata('vector'),
          searchText: '',
          embedding: null,
        });
        own.push(`图片向量失败，已降级为描述检索：${describeKnowledgeError(err)}`);
      }
    }
    return { name: image.name, drafts: ownDrafts, warnings: own };
  };

  const results = await runBounded(parsed.images, signal, processImage);
  for (const result of results) {
    drafts.push(...result.drafts);
    if (result.warnings.length > 0) warnings.set(result.name, result.warnings);
  }
  return { drafts, warnings };
}

function withParentChunks(drafts: ChunkDraft[]): ChunkDraft[] {
  const groups: Array<{ heading: string | null; image: boolean; indexes: number[] }> = [];
  for (const [index, draft] of drafts.entries()) {
    const last = groups.at(-1);
    if (
      last &&
      !last.image &&
      draft.kind !== 'image' &&
      last.heading !== null &&
      last.heading === draft.heading
    ) {
      last.indexes.push(index);
    } else {
      groups.push({ heading: draft.heading, image: draft.kind === 'image', indexes: [index] });
    }
  }
  const output: ChunkDraft[] = [];
  for (const group of groups) {
    const members = group.indexes.map((index) => drafts[index] as ChunkDraft);
    if (group.heading === null || members.length === 1) {
      output.push(...members);
      continue;
    }
    const pages = members
      .flatMap((member) => [member.pageFrom, member.pageTo])
      .filter((page): page is number => typeof page === 'number');
    const parentOrdinal = output.length;
    output.push({
      kind: 'text',
      heading: group.heading,
      content: members.map((member) => member.content).join('\n\n'),
      pageFrom: pages.length > 0 ? Math.min(...pages) : null,
      pageTo: pages.length > 0 ? Math.max(...pages) : null,
      indexRole: 'parent',
      searchText: '',
      embedding: null,
    });
    for (const member of members) output.push({ ...member, indexRole: 'leaf', parentOrdinal });
  }
  return output;
}

async function buildFaqChunks(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  jobId: string,
  versionId: string,
  signal: AbortSignal,
): Promise<repo.knowledge.NewChunk[]> {
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) throw new Error('知识库不存在，文档可能已删除');
  const version = await repo.knowledge.getVersion(deps.db, versionId);
  if (!version || version.documentId !== document.id) {
    throw new Error('FAQ job 指定的版本不存在或不属于该文档');
  }
  if (!version.faq) throw new Error('FAQ 版本不存在或缺少 FAQ 数据');
  if (version.embeddingProfileId !== base.embeddingProfileId) {
    throw new Error('FAQ 版本的 embedding profile 与知识库不一致，请重新保存');
  }
  const client = await embeddingClient(deps, base.embeddingProfileId);
  const faq = version.faq;
  const questions = [
    { text: faq.question, questionKind: 'standard' as const },
    ...faq.similarQuestions.map((text) => ({ text, questionKind: 'similar' as const })),
  ];
  await setStep(deps, jobId, 'embedding', 40);
  const vectors = await embedAll(
    client,
    questions.map((question) => question.text),
    signal,
  );
  checkAborted(signal);

  const drafts: ChunkDraft[] = [
    {
      kind: 'text',
      heading: faq.question,
      content: faq.answers.join('\n\n'),
      pageFrom: null,
      pageTo: null,
      indexRole: 'parent',
      searchText: '',
      embedding: null,
      metadata: { answerOrdinal: 0, answerCount: faq.answers.length },
    },
    ...questions.map((question, index) => ({
      kind: 'text' as const,
      heading: faq.question,
      content: question.text,
      pageFrom: null,
      pageTo: null,
      indexRole: 'leaf' as const,
      parentOrdinal: 0,
      searchText: segmentForSearch(question.text),
      embedding: vectors[index] ?? null,
      metadata: {
        questionKind: question.questionKind,
        matchedQuestion: question.text,
        answerOrdinal: 0,
      },
    })),
  ];
  await setStep(deps, jobId, 'indexing', 80);
  checkAborted(signal);
  return drafts.map((draft, ordinal) => ({
    ordinal,
    parentOrdinal: draft.parentOrdinal ?? null,
    indexRole: draft.indexRole ?? 'leaf',
    kind: draft.kind,
    heading: draft.heading,
    content: draft.content,
    searchText: draft.searchText ?? segmentForSearch(draft.content),
    embedding: draft.embedding ?? null,
    pageFrom: draft.pageFrom,
    pageTo: draft.pageTo,
    locator: null,
    tokenCount: Math.ceil(draft.content.length / 2),
    ...(draft.metadata ? { metadata: draft.metadata } : {}),
  }));
}

async function ingestFaqVersion(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  jobId: string,
  versionId: string,
  signal: AbortSignal,
): Promise<void> {
  const chunks = await buildFaqChunks(deps, document, jobId, versionId, signal);
  try {
    await repo.knowledge.replaceChunks(deps.db, {
      baseId: document.baseId,
      documentId: document.id,
      versionId,
      folderId: document.folderId,
      jobId,
      isAborted: () => signal.aborted,
      chunks,
    });
  } catch (err) {
    await ensureJobRunning(deps, jobId, signal);
    throw err;
  }
  await ensureJobRunning(deps, jobId, signal);
}

async function resolveAsrProfile(
  deps: KnowledgeDeps,
  base: KnowledgeBaseRow,
): Promise<{ profile: AsrProfile; name: string } | undefined> {
  if (!base.asrProfileId) return undefined;
  const profile = await repo.knowledge.getModelProfileWithSecret(deps.db, base.asrProfileId);
  if (profile?.kind !== 'asr' || !profile.enabled) return undefined;
  const apiKey = profile.secretsEncrypted
    ? (await deps.decrypt(profile.secretsEncrypted)).apiKey
    : undefined;
  return {
    profile: {
      endpointUrl: profile.endpointUrl,
      model: profile.model,
      ...(apiKey ? { apiKey } : {}),
    },
    name: profile.name,
  };
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
    origin: 'source' | 'manual' | 'faq' | 'wiki';
    versionMetadata?: Record<string, unknown>;
    publish?: 'draft' | 'automatic';
    expectedCurrentVersionId: string | null;
    forbidUnpublishedDraft?: boolean;
    sourceSnapshot?: repo.knowledge.SourceReadSnapshot | undefined;
    signal: AbortSignal;
    jobId: string;
  },
): Promise<string> {
  const publish = input.publish ?? 'automatic';
  const draft = publish === 'draft';
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) throw new Error('知识库不存在，文档可能已删除');
  const client = await embeddingClient(deps, base.embeddingProfileId);
  const settings = knowledgeBaseSettingsSchema.parse(base.settings);

  const blobSha = sha256Hex(input.data);
  await ensureKnowledgeBlob(deps.knowledgeDir, blobSha, input.data);
  await setStep(deps, input.jobId, 'parsing', 10);
  const audio = input.markdown === undefined ? await resolveAsrProfile(deps, base) : undefined;
  const parsed: IngestionDocument =
    input.markdown === undefined
      ? await deps
          .parse({
            filename: input.filename,
            mimeType: input.mimeType,
            data: input.data,
            signal: input.signal,
            ...(audio ? { asr: audio.profile, asrProfileName: audio.name } : {}),
          })
          .catch((err: unknown) => {
            if (input.signal.aborted) throw new KnowledgeCancelled();
            throw err;
          })
      : { markdown: input.markdown, images: [], pageMap: [] };
  checkAborted(input.signal);
  if (parsed.markdown.trim() === '') throw new Error('解析结果为空');

  const drafts = withParentChunks(
    deps.chunkMarkdown(
      parsed.markdown,
      parsed.pageMap,
      {
        chunkTokens: base.settings.chunkTokens,
        overlap: base.settings.chunkOverlap,
      },
      parsed.blocks,
    ),
  );
  if (drafts.length === 0) throw new Error('分块结果为空');

  let imageWarnings = new Map<string, string[]>();
  const imageDraftList: ChunkDraft[] = [];
  if (parsed.images.length > 0) {
    if (!settings.imageProcessing.enabled) {
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
  const textual = allDrafts
    .map((draft, index) => ({ draft, index }))
    .filter(
      (entry) =>
        entry.draft.indexRole !== 'parent' &&
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
  const latest = await repo.knowledge.getBase(deps.db, document.baseId);
  if (latest?.status !== 'active') throw new Error('知识库已停用，未发布本次结果');
  if (
    latest.embeddingProfileId !== client.profileId ||
    JSON.stringify(knowledgeBaseSettingsSchema.parse(latest.settings).imageProcessing) !==
      JSON.stringify(settings.imageProcessing)
  ) {
    throw new Error('知识库配置已变化，请重试本次摄取');
  }
  if (parsed.audio && (latest.asrProfileId ?? null) !== (base.asrProfileId ?? null)) {
    throw new Error('知识库音频转录配置已变化，请重试本次摄取');
  }

  const version = await repo.knowledge.createVersion(deps.db, {
    documentId: document.id,
    blobSha256: blobSha,
    markdownSha256: sha256Hex(parsed.markdown),
    originalFilename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    sourceRevision: input.sourceRevision,
    origin: input.origin,
    parentVersionId: input.expectedCurrentVersionId,
    metadata: {
      ...(input.versionMetadata ?? {}),
      ...(parsed.audio ? { audio: parsed.audio } : {}),
      ...(draft ? { publication: 'draft' as const, indexingJobId: input.jobId } : {}),
    },
    parseStatus: 'parsed',
    pageMap: parsed.pageMap,
    images: parsed.images.map((image) => ({
      name: image.name,
      sha256: sha256Hex(Buffer.from(image.data)),
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
      parentOrdinal: draft.parentOrdinal ?? null,
      indexRole: draft.indexRole ?? 'leaf',
      kind: draft.kind,
      heading: draft.heading,
      content: draft.content,
      searchText: draft.searchText ?? segmentForSearch(draft.content),
      embedding: embeddings[index] ?? null,
      pageFrom: draft.pageFrom,
      pageTo: draft.pageTo,
      locator: draft.locator ?? null,
      tokenCount: Math.ceil(draft.content.length / 2),
      ...(draft.metadata ? { metadata: draft.metadata } : {}),
    })),
  });
  await ensureJobRunning(deps, input.jobId, input.signal);
  if (draft) {
    await settleDocumentStatus(deps, document, document.currentVersionId ? 'ready' : 'pending');
    checkAborted(input.signal);
    return version.id;
  }
  const published = await repo.knowledge.setCurrentVersion(
    deps.db,
    document.id,
    version.id,
    {
      jobId: input.jobId,
      baseId: document.baseId,
      embeddingProfileId: client.profileId,
      imageProcessingJson: JSON.stringify(settings.imageProcessing),
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      ...(parsed.audio ? { asrProfileId: base.asrProfileId } : {}),
      ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
      isAborted: () => input.signal.aborted,
    },
    input.forbidUnpublishedDraft
      ? {
          expectedCurrentVersionId: input.expectedCurrentVersionId,
          forbidUnpublishedDraft: true,
        }
      : undefined,
  );
  if (!published) throw new Error('知识库配置已变化或已停用，未发布本次结果');
  await repo.knowledge.updateDocument(deps.db, document.id, {
    lastSyncedAt: new Date(),
  });
  await linkWikiAfterIngest(deps, base, document);
  await requestAutoSummary(deps, base, published);
  await requestAutoTag(deps, base, published);
  return version.id;
}

function requirePayload(job: KnowledgeJobRow) {
  const parsed = knowledgeJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`job payload 不合法: ${parsed.error.message}`);
  return parsed.data;
}

async function settleDocumentStatus(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  status: KnowledgeDocumentRow['status'],
): Promise<void> {
  await deps.db
    .update(schema.knowledgeDocuments)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(schema.knowledgeDocuments.id, document.id),
        document.currentVersionId === null
          ? isNull(schema.knowledgeDocuments.currentVersionId)
          : eq(schema.knowledgeDocuments.currentVersionId, document.currentVersionId),
        ne(schema.knowledgeDocuments.status, 'disabled'),
        isNull(schema.knowledgeDocuments.disabledReason),
      ),
    );
}

function filenameOf(document: KnowledgeDocumentRow): string {
  const stored = document.metadata.originalFilename;
  return typeof stored === 'string' ? stored : document.title;
}

function originOf(document: KnowledgeDocumentRow): 'source' | 'manual' | 'faq' | 'wiki' {
  if (document.contentKind === 'faq') return 'faq';
  if (document.contentKind === 'wiki') return 'wiki';
  return document.sourceConnectionId === null ? 'manual' : 'source';
}

export async function runIngest(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<void> {
  const payload = requirePayload(job);
  if (payload.type !== 'ingest') throw new Error('job 类型不是 ingest');
  const document = await repo.knowledge.getDocument(deps.db, payload.documentId);
  if (!document) throw new Error(KNOWLEDGE_DOCUMENT_NOT_FOUND_MESSAGE);
  if (document.contentKind === 'faq') {
    try {
      if (!payload.versionId) throw new Error('FAQ ingest job 缺少 versionId');
      await ingestFaqVersion(deps, document, job.id, payload.versionId, signal);
    } catch (err) {
      await settleDocumentStatus(deps, document, document.currentVersionId ? 'ready' : 'pending');
      throw err;
    }
    return;
  }
  if (document.status === 'disabled' || document.disabledReason !== null) return;
  const snapshot = payload.input;
  const blobSha = snapshot?.blobSha256 ?? document.contentHash;
  if (!blobSha) throw new Error('文档没有已上传的原件');
  const expectedCurrentVersionId =
    document.contentKind === 'wiki'
      ? document.currentVersionId
      : snapshot
        ? snapshot.expectedCurrentVersionId
        : document.currentVersionId;
  if (!document.currentVersionId) {
    await repo.knowledge.updateDocument(deps.db, document.id, { status: 'processing' });
  }
  try {
    const data = await readFile(knowledgeBlobPath(deps.knowledgeDir, blobSha));
    await ingestContent(deps, document, {
      filename: snapshot?.filename ?? filenameOf(document),
      mimeType: snapshot?.mimeType ?? document.mimeType,
      data,
      sourceRevision: null,
      origin: originOf(document),
      versionMetadata: payload.versionMetadata ?? {},
      publish: payload.publish,
      expectedCurrentVersionId,
      signal,
      jobId: job.id,
    });
  } catch (err) {
    await settleDocumentStatus(deps, document, document.currentVersionId ? 'ready' : 'failed');
    throw err;
  }
}

async function listAllPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null } | null>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    if (page === null) throw new Error('知识库分页游标已失效');
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
  const candidates = chunks.filter(
    (chunk) =>
      chunk.embedding === null &&
      chunk.indexRole !== 'parent' &&
      (imageProcessing.enabled || !roleOf(chunk)),
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
  const whitelist = new Map((version.images ?? []).map((image) => [image.name, image.mimeType]));
  for (const { chunk, image } of vectorChunks) {
    checkAborted(signal);
    const mimeType = whitelist.get(image.name);
    if (!mimeType) throw new Error(`图片 ${image.name} 不在版本清单中`);
    const data = await readFile(
      knowledgeVersionImagePath(deps.knowledgeDir, document.id, versionId, image.name),
    ).catch(() => null);
    if (!data) throw new Error(`图片 ${image.name} 的文件缺失`);
    const embedding = await client.embedImage(
      { mimeType, dataBase64: data.toString('base64') },
      signal,
    );
    await repo.knowledge.patchChunk(deps.db, chunk.id, { embedding });
  }
}

async function rebuildFaqDocument(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
  jobId: string,
  signal: AbortSignal,
): Promise<string> {
  const current = document.currentVersionId
    ? await repo.knowledge.getVersion(deps.db, document.currentVersionId)
    : null;
  if (!current?.faq) throw new Error('FAQ 文档没有可重建的已发布问答数据');
  const base = await repo.knowledge.getBase(deps.db, document.baseId);
  if (!base) throw new Error('知识库不存在，文档可能已删除');
  const settings = knowledgeBaseSettingsSchema.parse(base.settings);
  const version = await repo.knowledge.createVersion(deps.db, {
    documentId: document.id,
    blobSha256: current.blobSha256,
    markdownSha256: current.markdownSha256,
    originalFilename: current.originalFilename,
    mimeType: current.mimeType,
    sizeBytes: current.sizeBytes,
    sourceRevision: null,
    origin: 'faq',
    parentVersionId: current.id,
    faq: current.faq,
    parseStatus: 'parsed',
    pageMap: current.pageMap,
    images: current.images,
    embeddingProfileId: base.embeddingProfileId,
  });
  const chunks = await buildFaqChunks(deps, document, jobId, version.id, signal);
  await repo.knowledge.insertChunks(deps.db, {
    baseId: document.baseId,
    documentId: document.id,
    versionId: version.id,
    folderId: document.folderId,
    chunks,
  });
  await ensureJobRunning(deps, jobId, signal);
  const published = await repo.knowledge.setCurrentVersion(
    deps.db,
    document.id,
    version.id,
    {
      jobId,
      baseId: document.baseId,
      embeddingProfileId: base.embeddingProfileId,
      imageProcessingJson: JSON.stringify(settings.imageProcessing),
      expectedCurrentVersionId: current.id,
      isAborted: () => signal.aborted,
    },
    { expectedCurrentVersionId: current.id, forbidUnpublishedDraft: true },
  );
  if (!published) {
    await ensureJobRunning(deps, jobId, signal);
    throw new Error('知识库配置已变化或已停用，未发布本次结果');
  }
  return version.id;
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
  const confirmOverwriteManualChunks = payload.confirmOverwriteManualChunks;
  for (const [index, document] of documents.entries()) {
    checkAborted(signal);
    try {
      if (payload.chunksOnly) {
        if (!document.currentVersionId) {
          deps.logger.warn(
            { documentId: document.id },
            'chunksOnly skipped: document has no current version',
          );
          continue;
        }
        await reembedMissing(deps, document, signal);
        continue;
      }
      if (document.status === 'disabled' || document.disabledReason !== null) {
        deps.logger.warn({ documentId: document.id }, 'reindex skipped disabled document');
        continue;
      }
      if (await repo.knowledge.hasUnpublishedDraft(deps.db, document)) {
        deps.logger.warn(
          { documentId: document.id },
          'reindex skipped: unpublished draft requires explicit publish',
        );
        continue;
      }
      if (
        document.sourceType === 'manual' &&
        document.contentKind === 'document' &&
        document.currentVersionId === null
      ) {
        deps.logger.warn(
          { documentId: document.id },
          'reindex skipped: manual document requires explicit ingest',
        );
        continue;
      }
      if (!confirmOverwriteManualChunks && (await hasManualEdits(deps, document))) {
        deps.logger.warn(
          { documentId: document.id },
          'reindex skipped: manual edits require confirmOverwriteManualChunks',
        );
        continue;
      }
      if (document.contentKind === 'faq') {
        await rebuildFaqDocument(deps, document, job.id, signal);
        continue;
      }
      if (!document.contentHash) throw new Error('文档没有已上传的原件');
      if (!document.currentVersionId) {
        await repo.knowledge.updateDocument(deps.db, document.id, { status: 'processing' });
      }
      const data = await readFile(knowledgeBlobPath(deps.knowledgeDir, document.contentHash));
      const sourceSnapshot = document.sourceConnectionId
        ? (await repo.knowledge.getSourceReadSnapshot(deps.db, document.sourceConnectionId))
            ?.snapshot
        : undefined;
      if (document.sourceConnectionId && !sourceSnapshot) {
        throw new Error('来源不存在，未发布本次结果');
      }
      await setStep(
        deps,
        job.id,
        `reindex:${index + 1}/${documents.length}`,
        Math.round((index / documents.length) * 100),
      );
      const indexedWikiVersion =
        document.contentKind === 'wiki' && document.currentVersionId
          ? await repo.knowledge.getVersion(deps.db, document.currentVersionId)
          : null;
      await ingestContent(deps, document, {
        filename: filenameOf(document),
        mimeType: document.mimeType,
        data,
        sourceRevision: null,
        origin: originOf(document),
        versionMetadata: {
          ...(typeof document.metadata.contentCompleteness === 'string'
            ? { contentCompleteness: document.metadata.contentCompleteness }
            : {}),
          ...(indexedWikiVersion
            ? {
                wikiPageId: indexedWikiVersion.metadata.wikiPageId,
                wikiVersionId: indexedWikiVersion.metadata.wikiVersionId,
              }
            : {}),
        },
        expectedCurrentVersionId: document.currentVersionId,
        forbidUnpublishedDraft: true,
        ...(sourceSnapshot ? { sourceSnapshot } : {}),
        signal,
        jobId: job.id,
      });
    } catch (err) {
      if (!document.currentVersionId) {
        await settleDocumentStatus(deps, document, 'failed');
      }
      if (err instanceof KnowledgeCancelled) throw err;
      if (err instanceof KnowledgeProfileMismatch) throw err;
      failed += 1;
      deps.logger.warn({ err, documentId: document.id }, 'reindex document failed');
      if (isRetryableKnowledgeError(err)) throw err;
    }
  }
  if (failed > 0) throw new Error(`${failed} 个文档重建失败，旧版本保留`);
}

async function hasManualEdits(
  deps: KnowledgeDeps,
  document: KnowledgeDocumentRow,
): Promise<boolean> {
  if (!document.currentVersionId) return false;
  return (await repo.knowledge.countEditedChunks(deps.db, document.currentVersionId)) > 0;
}

async function upsertSourceItem(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  snapshot: repo.knowledge.SourceReadSnapshot,
  jobId: string,
  syncRunId: string,
  item: SourceItem,
  rangeIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<boolean> {
  const data = Buffer.isBuffer(item.content)
    ? item.content
    : Buffer.from(item.content.markdown, 'utf8');
  const contentHash = sha256Hex(data);
  const existing = await repo.knowledge.findSourceDocument(
    deps.db,
    source.baseId,
    source.type,
    item.sourceId,
  );
  const keepFull =
    item.completeness === 'summary' && existing?.metadata.contentCompleteness === 'full';
  const metadata = {
    ...(existing?.metadata ?? {}),
    originalFilename: item.title,
    ...(item.completeness && !keepFull ? { contentCompleteness: item.completeness } : {}),
  };
  const patch: repo.knowledge.SourceDocumentPatch = {
    title: item.title,
    sourceUrl: item.sourceUrl,
    sourcePath: item.sourcePath,
    mimeType: item.mimeType,
    sizeBytes: data.length,
    metadata,
  };
  const creating = existing === null;
  if (creating) await repo.governance.assertKnowledgeDocumentQuota(deps.db, source.baseId);
  const document =
    existing ??
    (await repo.knowledge.createDocument(deps.db, {
      baseId: source.baseId,
      folderId: null,
      title: item.title,
      sourceType: source.type,
      sourceId: item.sourceId,
      sourceConnectionId: source.id,
      sourceUrl: item.sourceUrl,
      sourcePath: item.sourcePath,
      mimeType: item.mimeType,
      sizeBytes: data.length,
      metadata,
    }));
  if (creating) await repo.governance.notifyKnowledgeDocumentQuota(deps.db, source.baseId);
  const authorized = await repo.knowledge.setDocumentSourceRanges(
    deps.db,
    document.id,
    [...rangeIds],
    snapshot,
    patch,
  );
  if (!authorized) throw new SourceSnapshotStale('来源配置已变化，本轮同步中止');

  if (existing?.contentHash === contentHash) return false;
  if (existing && keepFull) {
    deps.logger.warn(
      { sourceId: source.id, itemId: item.sourceId, documentId: existing.id },
      'feed summary skipped: existing full text kept',
    );
    await settleDocumentStatus(deps, authorized, authorized.currentVersionId ? 'ready' : 'failed');
    return false;
  }
  if (existing && authorized.disabledReason === 'manual') {
    deps.logger.warn(
      { sourceId: source.id, itemId: item.sourceId, documentId: existing.id },
      'manual_disabled: external update skipped, disabled state kept',
    );
    await repo.knowledge.recordSyncItem(deps.db, {
      syncRunId,
      sourceId: source.id,
      rangeId: item.rangeId ?? null,
      externalId: item.sourceId,
      documentId: existing.id,
      status: 'skipped',
      code: 'manual_disabled',
      message: '文档已人工停用，已忽略外部内容更新',
      retryable: false,
    });
    return false;
  }
  if (existing && (await hasManualEdits(deps, authorized))) {
    deps.logger.warn(
      { sourceId: source.id, itemId: item.sourceId, documentId: existing.id },
      'manual_edit_conflict: external update skipped, old version kept',
    );
    await repo.knowledge.recordSyncItem(deps.db, {
      syncRunId,
      sourceId: source.id,
      rangeId: item.rangeId ?? null,
      externalId: item.sourceId,
      documentId: existing.id,
      status: 'skipped',
      code: 'manual_edit_conflict',
      message: '外部内容更新与人工编辑冲突，已保留人工版本',
      retryable: false,
    });
    return false;
  }
  try {
    await ingestContent(deps, authorized, {
      filename: item.title,
      mimeType: item.mimeType,
      data,
      markdown: Buffer.isBuffer(item.content) ? undefined : item.content.markdown,
      sourceRevision: item.revision,
      origin: 'source',
      versionMetadata: item.completeness ? { contentCompleteness: item.completeness } : {},
      expectedCurrentVersionId: authorized.currentVersionId,
      sourceSnapshot: snapshot,
      signal,
      jobId,
    });
  } catch (err) {
    await settleDocumentStatus(deps, authorized, authorized.currentVersionId ? 'ready' : 'failed');
    throw err;
  }
  return existing === null || existing.status === 'disabled';
}

async function disableStaleDocuments(
  deps: KnowledgeDeps,
  source: KnowledgeSourceRow,
  seen: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<number> {
  const documents = await listAllPages((cursor) =>
    repo.knowledge.listDocuments(deps.db, {
      baseId: source.baseId,
      sourceConnectionId: source.id,
      status: 'ready',
      limit: LIST_PAGE_SIZE,
      cursor,
    }),
  );
  let disabled = 0;
  for (const document of documents) {
    checkAborted(signal);
    if (document.sourceId !== null && seen.has(document.sourceId)) continue;
    await repo.knowledge.updateDocument(deps.db, document.id, {
      status: 'disabled',
      disabledReason: 'source',
    });
    await repo.knowledge.markWikiStaleByDocument(deps.db, document.id);
    disabled += 1;
  }
  return disabled;
}

const SYNCABLE = new Set(['active']);

export interface SyncRunResult {
  cursorAfter: Record<string, unknown>;
  stats: {
    listed: number;
    created: number;
    updated: number;
    disabled: number;
    failed: number;
  };
}

export async function runSync(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<SyncRunResult> {
  const payload = requirePayload(job);
  if (payload.type !== 'sync') throw new Error('job 类型不是 sync');
  const read = await repo.knowledge.getSourceReadSnapshot(deps.db, payload.sourceId);
  if (!read) throw new Error(KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE);
  const { source, snapshot } = read;
  if (!SYNCABLE.has(source.status)) {
    throw new KnowledgeCancelled();
  }
  const connector = deps.connectors[source.type];
  if (!connector) throw new Error(`不支持的来源类型 ${source.type}`);
  const ranges = snapshot.ranges.filter((range) => range.enabled);
  if (ranges.length === 0) throw new Error('来源没有启用的范围');

  const secrets = snapshot.secretsEncrypted ? await deps.decrypt(snapshot.secretsEncrypted) : {};
  const network: ConnectorNetwork | undefined =
    deps.trustedHosts?.length || deps.allowLoopback === true
      ? sourceNetworkOptions(deps)
      : undefined;
  const stats = { listed: 0, created: 0, updated: 0, disabled: 0, failed: 0 };
  const seen = new Set<string>();
  const rangeIdsByItem = new Map<string, Set<string>>();
  let complete = false;
  let hadItemIssues = false;
  let cursorAfter: Record<string, unknown> = source.cursor;
  let lastCheckpoint = Date.now();
  const checkpoint = async (
    cursor: Record<string, unknown>,
    status: SourceCheckpoint,
  ): Promise<void> => {
    cursorAfter = cursor;
    complete = status.complete && stats.failed === 0 && !hadItemIssues;
    await deps.db
      .update(schema.knowledgeSyncRuns)
      .set({ cursorAfter: cursor })
      .where(eq(schema.knowledgeSyncRuns.id, payload.syncRunId));
    lastCheckpoint = Date.now();
  };

  try {
    for await (const item of connector.sync({
      connectionId: source.id,
      config: snapshot.config,
      secrets,
      ranges: ranges.map((range) => ({
        id: range.id,
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
        if (item.failure) {
          hadItemIssues = true;
          if (item.failure.retryable) stats.failed += 1;
          deps.logger.warn(
            { sourceId: source.id, itemId: item.sourceId, code: item.failure.code },
            'sync item failed',
          );
          await repo.knowledge.recordSyncItem(deps.db, {
            syncRunId: payload.syncRunId,
            sourceId: source.id,
            rangeId: item.rangeId ?? null,
            externalId: item.sourceId,
            documentId: null,
            status: item.failure.retryable ? 'failed' : 'skipped',
            code: item.failure.code,
            message: item.failure.message,
            retryable: item.failure.retryable,
          });
          continue;
        }
        if (item.deleted === true) {
          const existing = await repo.knowledge.findSourceDocument(
            deps.db,
            source.baseId,
            source.type,
            item.sourceId,
          );
          if (existing && existing.status !== 'disabled') {
            await repo.knowledge.updateDocument(deps.db, existing.id, {
              status: 'disabled',
              disabledReason: 'source',
            });
            await repo.knowledge.markWikiStaleByDocument(deps.db, existing.id);
            stats.disabled += 1;
          }
          continue;
        }
        seen.add(item.sourceId);
        const rangeIds = rangeIdsByItem.get(item.sourceId) ?? new Set<string>();
        const fallbackRange = ranges.length === 1 ? ranges[0] : undefined;
        const rangeId = item.rangeId ?? fallbackRange?.id;
        if (rangeId) rangeIds.add(rangeId);
        rangeIdsByItem.set(item.sourceId, rangeIds);
        const created = await upsertSourceItem(
          deps,
          source,
          snapshot,
          job.id,
          payload.syncRunId,
          item,
          rangeIds,
          signal,
        );
        if (created) stats.created += 1;
        else stats.updated += 1;
      } catch (err) {
        if (
          err instanceof KnowledgeCancelled ||
          err instanceof SourceAuthError ||
          err instanceof SourceSnapshotStale
        ) {
          throw err;
        }
        stats.failed += 1;
        hadItemIssues = true;
        deps.logger.warn({ err, sourceId: source.id, itemId: item.sourceId }, 'sync item failed');
        await repo.knowledge.recordSyncItem(deps.db, {
          syncRunId: payload.syncRunId,
          sourceId: source.id,
          rangeId: item.rangeId ?? null,
          externalId: item.sourceId,
          documentId: null,
          status: 'failed',
          code: 'ingest_failed',
          message: describeKnowledgeError(err),
          retryable: isRetryableKnowledgeError(err),
        });
        if (isRetryableKnowledgeError(err)) throw err;
      }
      if (
        stats.listed % SYNC_CHECKPOINT_ITEMS === 0 ||
        Date.now() - lastCheckpoint > SYNC_CHECKPOINT_MS
      ) {
        await checkpoint(cursorAfter, { complete: false });
      }
    }
  } catch (err) {
    if (err instanceof KnowledgeCancelled) throw err;
    const authError = err instanceof SourceAuthError;
    if (authError || (err instanceof KnowledgeModelError && err.kind === 'auth')) {
      try {
        await repo.knowledge.updateSource(deps.db, source.id, { status: 'auth_error' });
      } finally {
        if (authError) {
          await repo.knowledge.disableDocumentsBySource(deps.db, source.id);
        }
      }
    }
    throw err;
  }

  if (stats.failed > 0) {
    throw new Error(`${stats.failed} 个条目同步失败，游标未推进`);
  }

  if (snapshot.config.syncDeletions === true && complete) {
    stats.disabled += await disableStaleDocuments(deps, source, seen, signal);
  }

  return { cursorAfter, stats };
}

export async function runSourceProbe(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<KnowledgeSourceProbeResult> {
  const payload = requirePayload(job);
  if (payload.type !== 'source_probe') throw new Error('job 类型不是 source_probe');
  const read = await repo.knowledge.getSourceReadSnapshot(deps.db, payload.sourceId);
  if (!read) throw new Error(KNOWLEDGE_SOURCE_NOT_FOUND_MESSAGE);
  const { source, snapshot } = read;
  const connector = deps.connectors[source.type];
  if (!connector?.probe) throw new Error(`不支持的来源类型 ${source.type}`);
  const ranges = snapshot.ranges.filter((range) => range.enabled);
  if (ranges.length === 0) throw new Error('来源没有启用的范围，无法探测');
  const secrets = snapshot.secretsEncrypted ? await deps.decrypt(snapshot.secretsEncrypted) : {};
  const network: ConnectorNetwork | undefined =
    deps.trustedHosts?.length || deps.allowLoopback === true
      ? sourceNetworkOptions(deps)
      : undefined;

  const checks: KnowledgeSourceProbeResult['checks'] = [];
  for (const range of ranges) {
    checkAborted(signal);
    try {
      await connector.probe({
        config: snapshot.config,
        secrets,
        range: {
          kind: range.kind,
          externalId: range.externalId,
          ref: range.ref,
          paths: range.paths,
        },
        signal,
        ...(network ? { network } : {}),
      });
      checks.push({ rangeId: range.id, ok: true });
    } catch (err) {
      if (err instanceof KnowledgeCancelled || signal.aborted) throw err;
      checks.push({
        rangeId: range.id,
        ok: false,
        code: err instanceof SourceAuthError ? 'auth_failed' : 'probe_failed',
        message: describeKnowledgeError(err),
      });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

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
  const pendingOriginals = await deps.db
    .selectDistinct({ blob: schema.knowledgeDocuments.contentHash })
    .from(schema.knowledgeDocuments);
  for (const row of pendingOriginals) {
    if (row.blob) referencedBlobs.add(row.blob);
  }
  const pendingJobBlobs = await deps.db
    .select({ payload: schema.knowledgeJobs.payload })
    .from(schema.knowledgeJobs)
    .where(inArray(schema.knowledgeJobs.status, ['queued', 'running']));
  for (const { payload } of pendingJobBlobs) {
    const input = payload.input;
    if (input && typeof input === 'object') {
      const blob = (input as Record<string, unknown>).blobSha256;
      if (typeof blob === 'string') referencedBlobs.add(blob);
    }
  }
  const liveVersionIds = new Set(versions.map((row) => row.id));
  const cutoff = Date.now() - BLOB_RETENTION_MS;

  const blobsRoot = knowledgeBlobsRoot(deps.knowledgeDir);
  for (const shard of await readdir(blobsRoot).catch(() => [])) {
    checkAborted(signal);
    for (const name of await readdir(join(blobsRoot, shard)).catch(() => [])) {
      if (referencedBlobs.has(name)) continue;
      const file = join(blobsRoot, shard, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(file, { force: true });
    }
  }

  const docsRoot = knowledgeDocsRoot(deps.knowledgeDir);
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

export type KnowledgeJobResult = Pick<repo.knowledge.FinishJobInput, 'result' | 'probeResult'>;

export async function runKnowledgeJob(
  deps: KnowledgeDeps,
  job: KnowledgeJobRow,
  signal: AbortSignal,
): Promise<KnowledgeJobResult | undefined> {
  switch (job.type) {
    case 'ingest':
      await runIngest(deps, job, signal);
      return;
    case 'reindex':
      await runReindex(deps, job, signal);
      return;
    case 'sync':
      return { result: await runSync(deps, job, signal) };
    case 'source_probe':
      return { probeResult: await runSourceProbe(deps, job, signal) };
    case 'cleanup':
      await runCleanup(deps, job, signal);
      return;
  }
}
