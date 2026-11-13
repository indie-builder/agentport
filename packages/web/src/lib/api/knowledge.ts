import type { KnowledgeBaseActivityItem } from '@agentport/contract/knowledge';
import type {
  KnowledgeBase,
  KnowledgeBaseSettings,
  KnowledgeBaseSummary,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeFaq,
  KnowledgeFaqImportInput,
  KnowledgeFaqImportResponse,
  KnowledgeJob,
  KnowledgeModelProfileSelection,
  KnowledgeSearchResult,
  KnowledgeSearchWarning,
  KnowledgeSourceInput,
  KnowledgeSyncItem,
  KnowledgeTarget,
  KnowledgeWikiLinksResult,
  KnowledgeWikiVersionDiff,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { ApiError, rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

/** 后端只回 content/heading/enabled 可写；正文改动会清空向量并标记人工编辑。 */
export type {
  KnowledgeChunk,
  KnowledgeDocumentVersion,
  KnowledgeFaq,
  KnowledgeFaqImportInput,
  KnowledgeFaqImportResponse,
  KnowledgeJob,
  KnowledgeLocator,
  KnowledgeSearchDiagnostics,
  KnowledgeSearchDirectAnswer,
  KnowledgeSearchHit,
  KnowledgeSearchScores,
  KnowledgeSearchWarning,
  KnowledgeSyncItem,
} from '@agentport/shared';

function boolParam(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function isFaqBatchBody(
  value: Record<string, unknown> | { results: KnowledgeFaqBatchResult['results'] },
): value is { results: KnowledgeFaqBatchResult['results'] } {
  return Array.isArray((value as { results?: unknown }).results);
}

export interface KnowledgePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface KnowledgeBaseInput {
  slug: string;
  name: string;
  description: string;
  embeddingProfileId: string;
  rerankProfileId: string | null;
  /** 音频转录模型；null 表示不启用 ASR。 */
  asrProfileId: string | null;
  /** 建库时后端补默认值；设置弹层保存时以完整 settings 提交。 */
  settings: Omit<KnowledgeBaseSettings, 'imageProcessing'> & {
    imageProcessing?: KnowledgeBaseSettings['imageProcessing'];
  };
}

export interface KnowledgeBasePatch {
  name?: string;
  description?: string;
  status?: 'active' | 'disabled';
  embeddingProfileId?: string;
  rerankProfileId?: string | null;
  asrProfileId?: string | null;
  settings?: KnowledgeBaseInput['settings'];
}

export interface KnowledgeFolder {
  id: string;
  baseId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: string;
}

export interface KnowledgeChunkWriteResult {
  document: KnowledgeDocument;
  chunk: KnowledgeChunk | null;
  jobId: string | null;
}

export interface KnowledgeTag {
  id: string;
  baseId: string;
  name: string;
  createdAt: string;
}

export type KnowledgeContentKind = KnowledgeTarget['kind'];

export type KnowledgeVersionOrigin = KnowledgeDocumentVersion['origin'];

export interface KnowledgeSearchOptions {
  q: string;
  folders?: string[];
  tags?: string[];
  kinds?: KnowledgeContentKind[];
  limit?: number;
  rerank?: boolean;
  minVectorScore?: number;
  diagnostics?: boolean;
  /** 只筛 FAQ；文档与 Wiki 不受影响。 */
  onlyRecommended?: boolean;
  /** FAQ 组排到普通结果前。 */
  faqPriority?: boolean;
  /** directAnswer 的原始问题 cosine 门槛。 */
  faqDirectAnswerThreshold?: number;
}

/** FAQ wire 是文档投影：列表只回 title/status/tags，详情另带两个版本。 */
export type KnowledgeFaqDocument = Omit<
  Pick<
    KnowledgeDocument,
    | 'id'
    | 'baseId'
    | 'folderId'
    | 'title'
    | 'contentKind'
    | 'status'
    | 'disabledReason'
    | 'currentVersionId'
    | 'tags'
    | 'createdAt'
    | 'updatedAt'
  >,
  'contentKind' | 'disabledReason'
> & { contentKind: string; disabledReason: string | null };

export type KnowledgeFaqVersion = Pick<
  KnowledgeDocumentVersion,
  | 'id'
  | 'documentId'
  | 'version'
  | 'origin'
  | 'parentVersionId'
  | 'metadata'
  | 'faq'
  | 'isCurrent'
  | 'createdAt'
>;

export interface KnowledgeFaqDetail {
  document: KnowledgeFaqDocument;
  draftVersion: KnowledgeFaqVersion | null;
  publishedVersion: KnowledgeFaqVersion | null;
  faq: KnowledgeFaq | null;
}

export type KnowledgeFaqSummary = KnowledgeFaqDocument & { faq: KnowledgeFaq | null };

export interface KnowledgeBatchResult {
  documentId: string;
  status: 'succeeded' | 'failed';
  newDocumentId?: string | undefined;
  jobId?: string | undefined;
  code?: string | undefined;
  message?: string | undefined;
}

export interface KnowledgeFaqBatchResult {
  results: Array<{
    documentId: string;
    status: 'succeeded' | 'failed';
    code?: string | undefined;
    message?: string | undefined;
  }>;
}

export type KnowledgeFaqBatchInput =
  | {
      action: 'publish';
      importBatchId?: string;
      items: Array<{ documentId: string; versionId: string; expectedVersionId: string | null }>;
    }
  | {
      action: 'enable' | 'disable' | 'delete';
      importBatchId?: never;
      items: Array<{ documentId: string }>;
    };

export interface KnowledgeBatchInput {
  documentIds: string[];
  action: 'move' | 'copy' | 'tag' | 'delete' | 'reprocess';
  folderId?: string | null;
  tags?: string[];
  tagMode?: 'add' | 'remove' | 'replace';
  confirmOverwriteManualChunks?: boolean;
}

export interface KnowledgeRetrievalEvaluationInput {
  cases: Array<{ q: string; expectedTargets: KnowledgeTarget[]; expectedChunkIds?: string[] }>;
  limit?: number;
  rerank?: boolean;
  minVectorScore?: number;
}

export interface KnowledgeRetrievalEvaluationReport {
  recallAtK: number;
  mrr: number;
  chunkRecallAtK: number | null;
  results: Array<{
    q: string;
    hit: boolean;
    recallAtK: number;
    reciprocalRank: number;
    chunkRecallAtK: number | null;
    elapsedMs: number;
    degraded: boolean;
    warnings: KnowledgeSearchWarning[];
  }>;
}

export type KnowledgeManualDraft = ApiOutput<ApiClient['knowledge']['documents']['manual']>;

export type KnowledgeChunkPreview = ApiOutput<ApiClient['knowledge']['bases']['chunkPreview']>;

export type KnowledgeSearchResponse = KnowledgeSearchResult;

export type KnowledgeWikiLinks = KnowledgeWikiLinksResult;

export type KnowledgeWikiDiff = KnowledgeWikiVersionDiff;

/** 连接来源类型直接从 shared 输入契约派生，新增 provider 不再手改 wire 枚举。 */
export type KnowledgeSourceType = Exclude<
  KnowledgeSourceInput['type'],
  'upload' | 'url' | 'manual'
>;

export type KnowledgeSourceRangeKind = KnowledgeSourceInput['ranges'][number]['kind'];

export interface KnowledgeSourceRange {
  id: string;
  kind: KnowledgeSourceRangeKind;
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
}

export interface KnowledgeSource {
  id: string;
  baseId: string;
  type: KnowledgeSourceType;
  name: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  status: 'active' | 'paused' | 'auth_error' | 'disabled';
  syncCron: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  ranges: KnowledgeSourceRange[];
}

export interface KnowledgeSyncRun {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  cursorBefore: Record<string, unknown> | null;
  cursorAfter: Record<string, unknown> | null;
  stats: { listed: number; created: number; updated: number; disabled: number; failed: number };
  error: string | null;
  createdAt: string;
}

export interface KnowledgeWikiVersion {
  id: string;
  pageId: string;
  version: number;
  markdown: string;
  sourceChunkIds: string[];
  model: string | null;
  generatedBy: string;
  createdAt: string;
  title?: string;
}

export interface KnowledgeVersionImage {
  name: string;
  mimeType: string;
  page: number | null;
  warnings?: string[] | undefined;
}

/** 版本详情：只含 UI 展示所需元数据，不含 blob 地址与磁盘路径。 */
export interface KnowledgeVersionDetails {
  id: string;
  documentId: string;
  version: number;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sourceRevision: string | null;
  parseStatus: 'parsed' | 'parse_failed';
  pageMap: Array<Record<string, unknown>>;
  images: KnowledgeVersionImage[];
  createdAt: string;
}

export interface KnowledgeWikiPageDetail {
  id: string;
  baseId: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'stale' | 'failed';
  currentVersionId: string | null;
  parentId?: string | null;
  position?: number;
  createdAt: string;
  updatedAt: string;
  versions: KnowledgeWikiVersion[];
  nextCursor: string | null;
}

export interface KnowledgeModelProfile {
  id: string;
  kind: 'embedding' | 'rerank' | 'asr';
  name: string;
  endpointUrl: string;
  model: string;
  dimensions: number | null;
  enabled: boolean;
  hasSecret: boolean;
  /** 只有 Cohere v2 协议 + embed-v4.0 才能接收图片。 */
  embeddingProtocol: 'openai' | 'cohere_v2';
  imageInputEnabled: boolean;
  createdAt: string;
  updatedAt: string;
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

export default {
  // ---- 知识库 -------------------------------------------------------------
  knowledgeBases: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeBase>> =>
    rpc.knowledge.bases.list({ query }, clientOptions(signal)),
  knowledgeBase: (id: string): Promise<KnowledgeBase> =>
    rpc.knowledge.bases.get({ params: { id } }),
  /** 置顶是当前账号的个人偏好，只返回 ID，列表排序在客户端完成。 */
  knowledgeBasePins: (signal?: AbortSignal): Promise<{ baseIds: string[] }> =>
    rpc.knowledge.bases.pins({}, clientOptions(signal)),
  setKnowledgeBasePin: (baseId: string, pinned: boolean): Promise<{ pinned: boolean }> =>
    rpc.knowledge.bases.setPin({ params: { id: baseId }, body: { pinned } }),
  knowledgeBaseSummary: (id: string, signal?: AbortSignal): Promise<KnowledgeBaseSummary> =>
    rpc.knowledge.bases.summary({ params: { id } }, clientOptions(signal)),
  // 概览的活动流只读最近一页；20 条足够覆盖一次会话内产生的动作。
  knowledgeBaseActivity: (
    id: string,
    cursor?: string,
  ): Promise<KnowledgePage<KnowledgeBaseActivityItem>> =>
    rpc.knowledge.bases.activity({
      params: { id },
      query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) },
    }),
  previewKnowledgeChunks: (
    id: string,
    body: { sample: string; chunkTokens?: number; chunkOverlap?: number },
  ): Promise<KnowledgeChunkPreview> => rpc.knowledge.bases.chunkPreview({ params: { id }, body }),
  duplicateKnowledgeBase: (
    id: string,
    body: { name?: string; slug?: string; description?: string },
  ): Promise<KnowledgeBase> => rpc.knowledge.bases.duplicate({ params: { id }, body }),
  createKnowledgeBase: (input: KnowledgeBaseInput): Promise<KnowledgeBase> =>
    rpc.knowledge.bases.create({ body: input }),
  updateKnowledgeBase: (id: string, patch: KnowledgeBasePatch): Promise<KnowledgeBase> =>
    rpc.knowledge.bases.update({ params: { id }, body: patch }),
  deleteKnowledgeBase: async (id: string): Promise<void> => {
    await rpc.knowledge.bases.remove({ params: { id } });
  },
  knowledgeFolders: (baseId: string): Promise<KnowledgeFolder[]> =>
    rpc.knowledge.bases.folders({ params: { id: baseId }, query: {} }),
  createKnowledgeFolder: (
    baseId: string,
    input: { parentId: string | null; name: string },
  ): Promise<KnowledgeFolder> =>
    rpc.knowledge.bases.createFolder({ params: { id: baseId }, body: input }),
  updateKnowledgeFolder: (
    folderId: string,
    patch: { name?: string; parentId?: string | null },
  ): Promise<KnowledgeFolder> =>
    rpc.knowledge.folders.update({ params: { folderId }, body: patch }),
  deleteKnowledgeFolder: async (folderId: string): Promise<void> => {
    await rpc.knowledge.folders.remove({ params: { folderId } });
  },
  knowledgeTags: (baseId: string): Promise<KnowledgeTag[]> =>
    rpc.knowledge.bases.tags({ params: { id: baseId } }),
  createKnowledgeTag: (baseId: string, name: string): Promise<KnowledgeTag> =>
    rpc.knowledge.bases.createTag({ params: { id: baseId }, body: { name } }),
  renameKnowledgeTag: (tagId: string, name: string): Promise<KnowledgeTag> =>
    rpc.knowledge.tags.update({ params: { tagId }, body: { name } }),
  deleteKnowledgeTag: async (tagId: string): Promise<void> => {
    await rpc.knowledge.tags.remove({ params: { tagId } });
  },
  knowledgeDocuments: (
    baseId: string,
    query: Parameters<ApiClient['knowledge']['bases']['documents']>[0]['query'] = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeDocument>> =>
    rpc.knowledge.bases.documents({ params: { id: baseId }, query }, clientOptions(signal)),
  knowledgeDocument: (documentId: string, signal?: AbortSignal): Promise<KnowledgeDocument> =>
    rpc.knowledge.documents.get({ params: { documentId } }, clientOptions(signal)),
  uploadKnowledgeDocument: (
    baseId: string,
    input: {
      filename: string;
      mimeType: string;
      dataBase64: string;
      folderId: string | null;
      /** 目录上传时保留浏览器提供的相对路径；后端按真实目录建树。 */
      relativePath?: string;
    },
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.bases.upload({ params: { id: baseId }, body: input }),
  createKnowledgeManualDocument: (
    baseId: string,
    input: { title: string; content: string; folderId: string | null; tags: string[] },
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.bases.createManual({ params: { id: baseId }, body: input }),
  importKnowledgeUrl: (
    baseId: string,
    input: { url: string; folderId: string | null },
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.bases.createUrl({ params: { id: baseId }, body: input }),
  updateKnowledgeDocument: (
    documentId: string,
    patch: {
      title?: string;
      folderId?: string | null;
      status?: 'ready' | 'disabled';
      tags?: string[];
    },
  ): Promise<KnowledgeDocument> =>
    rpc.knowledge.documents.update({ params: { documentId }, body: patch }),
  deleteKnowledgeDocument: async (documentId: string): Promise<void> => {
    await rpc.knowledge.documents.remove({ params: { documentId } });
  },
  reprocessKnowledgeDocument: (
    documentId: string,
    confirmOverwriteManualChunks = false,
  ): Promise<{ jobId: string }> =>
    rpc.knowledge.documents.reprocess({
      params: { documentId },
      body: { confirmOverwriteManualChunks },
    }),
  batchKnowledgeDocuments: (
    baseId: string,
    input: KnowledgeBatchInput,
  ): Promise<{ results: KnowledgeBatchResult[] }> =>
    rpc.knowledge.bases.batch({ params: { id: baseId }, body: input }),
  knowledgeDocumentVersions: (
    documentId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeDocumentVersion>> =>
    rpc.knowledge.documents.versions(
      { params: { documentId }, query: cursor === undefined ? {} : { cursor } },
      clientOptions(signal),
    ),
  rollbackKnowledgeDocument: (
    documentId: string,
    input: { versionId: string; expectedVersionId: string | null },
  ): Promise<KnowledgeDocument> =>
    rpc.knowledge.documents.rollback({ params: { documentId }, body: input }),
  knowledgeDocumentManual: (
    documentId: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeManualDraft> =>
    rpc.knowledge.documents.manual({ params: { documentId } }, clientOptions(signal)),
  saveKnowledgeDocumentManual: (
    documentId: string,
    input: Parameters<ApiClient['knowledge']['documents']['saveManual']>[0]['body'],
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.documents.saveManual({ params: { documentId }, body: input }),
  publishKnowledgeDocumentVersion: (
    documentId: string,
    input: { versionId: string; expectedVersionId: string | null },
  ): Promise<KnowledgeDocument> =>
    rpc.knowledge.documents.publish({ params: { documentId }, body: input }),
  knowledgeChunks: (
    documentId: string,
    versionId: string | undefined,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<KnowledgePage<KnowledgeChunk>> =>
    rpc.knowledge.documents.chunks(
      {
        params: { documentId },
        query: {
          ...(versionId === undefined ? {} : { versionId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      clientOptions(signal),
    ),
  updateKnowledgeChunk: (
    chunkId: string,
    patch: {
      content?: string;
      heading?: string | null;
      enabled?: boolean;
      expectedVersionId: string;
    },
  ): Promise<KnowledgeChunkWriteResult> =>
    rpc.knowledge.chunks.update({ params: { chunkId }, body: patch }),
  createKnowledgeChunk: (
    documentId: string,
    input: { content: string; heading?: string | null; expectedVersionId: string },
  ): Promise<KnowledgeChunkWriteResult> =>
    rpc.knowledge.documents.createChunk({ params: { documentId }, body: input }),
  deleteKnowledgeChunk: (
    chunkId: string,
    expectedVersionId: string,
  ): Promise<KnowledgeChunkWriteResult> =>
    rpc.knowledge.chunks.remove({ params: { chunkId }, body: { expectedVersionId } }),
  /** 解析正文是 text/markdown，不是 JSON；原件走 content 端点直接下载。 */
  knowledgeMarkdown: (versionId: string, signal?: AbortSignal): Promise<string> =>
    nativeRequest(`/knowledge/versions/${versionId}/markdown`, 'GET', undefined, signal, 'text'),
  knowledgeOriginalUrl: (versionId: string): string =>
    `/api/knowledge/versions/${versionId}/content`,
  knowledgeOriginalBlob: (versionId: string, signal?: AbortSignal): Promise<Blob> =>
    nativeRequest(`/knowledge/versions/${versionId}/content`, 'GET', undefined, signal, 'blob'),
  knowledgeVersionDetails: (
    versionId: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeVersionDetails> =>
    rpc.knowledge.versions.details({ params: { versionId } }, clientOptions(signal)),
  /** 图片按版本元数据白名单读取，直接走鉴权端点，不代理也不抓远程。 */
  knowledgeVersionImageUrl: (versionId: string, name: string): string =>
    `/api/knowledge/versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(name)}`,
  knowledgeSearch: (
    baseId: string,
    options: KnowledgeSearchOptions,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResponse> =>
    rpc.knowledge.bases.search(
      {
        params: { id: baseId },
        query: {
          q: options.q,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          folders: options.folders,
          tags: options.tags,
          kinds: options.kinds,
          ...(options.rerank === undefined ? {} : { rerank: boolParam(options.rerank) }),
          ...(options.minVectorScore === undefined
            ? {}
            : { minVectorScore: options.minVectorScore }),
          ...(options.onlyRecommended === undefined
            ? {}
            : { onlyRecommended: boolParam(options.onlyRecommended) }),
          ...(options.faqPriority === undefined
            ? {}
            : { faqPriority: boolParam(options.faqPriority) }),
          ...(options.faqDirectAnswerThreshold === undefined
            ? {}
            : { faqDirectAnswerThreshold: options.faqDirectAnswerThreshold }),
          ...(options.diagnostics === undefined
            ? {}
            : { diagnostics: boolParam(options.diagnostics) }),
        },
      },
      clientOptions(signal),
    ),
  evaluateKnowledgeRetrieval: async (
    baseId: string,
    input: KnowledgeRetrievalEvaluationInput,
  ): Promise<KnowledgeRetrievalEvaluationReport> =>
    rpc.knowledge.bases.evaluate({
      params: { id: baseId },
      body: input,
    }),
  knowledgeJobs: (
    baseId: string,
    options: { documentId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeJob>> =>
    rpc.knowledge.jobs.list({ query: { baseId, ...options } }, clientOptions(signal)),
  knowledgeJob: (jobId: string): Promise<KnowledgeJob> =>
    rpc.knowledge.jobs.get({ params: { jobId } }),
  retryKnowledgeJob: (jobId: string): Promise<{ jobId: string }> =>
    rpc.knowledge.jobs.retry({ params: { jobId } }),
  cancelKnowledgeJob: (jobId: string): Promise<KnowledgeJob> =>
    rpc.knowledge.jobs.cancel({ params: { jobId } }),
  knowledgeSources: (baseId: string, cursor?: string): Promise<KnowledgePage<KnowledgeSource>> =>
    rpc.knowledge.bases.sources({
      params: { id: baseId },
      query: cursor === undefined ? {} : { cursor },
    }),
  createKnowledgeSource: (baseId: string, input: KnowledgeSourceInput): Promise<KnowledgeSource> =>
    rpc.knowledge.bases.createSource({ params: { id: baseId }, body: input }),
  updateKnowledgeSource: async (
    sourceId: string,
    patch: {
      name?: string;
      config?: Record<string, unknown>;
      /** 省略表示沿用已存凭证；绝不发空字符串，避免把密钥清空。 */
      secrets?: Record<string, string>;
      status?: 'active' | 'paused' | 'disabled';
      syncCron?: string | null;
      ranges?: Array<Omit<KnowledgeSourceRange, 'id'>>;
    },
  ): Promise<KnowledgeSource & { disabledDocumentIds?: string[] }> =>
    rpc.knowledge.sources.update({ params: { sourceId }, body: patch }),
  deleteKnowledgeSource: async (
    sourceId: string,
    documents: 'keep' | 'delete' = 'keep',
  ): Promise<void> => {
    await rpc.knowledge.sources.remove({ params: { sourceId }, query: { documents } });
  },
  /** 只读远程 probe：202 返回 jobId，结果从 GET jobs/:id 的 result 读取。 */
  testKnowledgeSource: (sourceId: string): Promise<{ jobId: string }> =>
    rpc.knowledge.sources.test({ params: { sourceId } }),
  syncKnowledgeSource: (sourceId: string): Promise<{ jobId: string; syncRunId: string }> =>
    rpc.knowledge.sources.sync({ params: { sourceId } }),
  knowledgeSourceRuns: (sourceId: string): Promise<KnowledgePage<KnowledgeSyncRun>> =>
    rpc.knowledge.sources.runs({ params: { sourceId }, query: {} }),
  knowledgeSyncItems: (
    sourceId: string,
    syncRunId: string,
    query: { cursor?: string; status?: 'failed' | 'skipped' } = {},
  ): Promise<KnowledgePage<KnowledgeSyncItem>> =>
    rpc.knowledge.sources.runItems({ params: { sourceId, syncRunId }, query }),
  // FAQ：与文档共用版本/发布/启停，不新增执行引擎。
  knowledgeFaqs: (
    baseId: string,
    query: Omit<
      Parameters<ApiClient['knowledge']['bases']['faqs']>[0]['query'],
      'isRecommended'
    > & {
      isRecommended?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeFaqSummary>> => {
    const { isRecommended, ...rest } = query;
    return rpc.knowledge.bases.faqs(
      {
        params: { id: baseId },
        query: {
          ...rest,
          ...(isRecommended === undefined ? {} : { isRecommended: boolParam(isRecommended) }),
        },
      },
      clientOptions(signal),
    );
  },
  knowledgeFaq: (documentId: string, signal?: AbortSignal): Promise<KnowledgeFaqDetail> =>
    rpc.knowledge.faqs.get({ params: { documentId } }, clientOptions(signal)),
  createKnowledgeFaq: (
    baseId: string,
    input: {
      title?: string;
      faq: KnowledgeFaq;
      folderId?: string | null;
      tags?: string[];
      expectedVersionId?: string | null;
    },
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.bases.createFaq({ params: { id: baseId }, body: input }),
  updateKnowledgeFaq: (
    documentId: string,
    input: Parameters<ApiClient['knowledge']['faqs']['update']>[0]['body'],
  ): Promise<{ documentId: string; jobId: string }> =>
    rpc.knowledge.faqs.update({ params: { documentId }, body: input }),
  publishKnowledgeFaq: (
    documentId: string,
    input: { versionId: string; expectedVersionId: string | null },
  ): Promise<KnowledgeFaqDocument> =>
    rpc.knowledge.faqs.publish({ params: { documentId }, body: input }),
  setKnowledgeFaqStatus: (documentId: string, enabled: boolean): Promise<KnowledgeFaqDocument> =>
    rpc.knowledge.faqs.status({ params: { documentId }, body: { enabled } }),
  deleteKnowledgeFaq: async (documentId: string): Promise<void> => {
    await rpc.knowledge.faqs.remove({ params: { documentId } });
  },
  importKnowledgeFaqs: async (
    baseId: string,
    input: KnowledgeFaqImportInput,
  ): Promise<KnowledgeFaqImportResponse> =>
    (await rpc.knowledge.bases.importFaqs({ params: { id: baseId }, body: input })).body,
  batchKnowledgeFaqs: async (
    baseId: string,
    input: KnowledgeFaqBatchInput,
  ): Promise<KnowledgeFaqBatchResult> => {
    const { body } = await rpc.knowledge.bases.faqBatch({ params: { id: baseId }, body: input });
    if (!isFaqBatchBody(body)) {
      throw new ApiError(500, '批量操作响应格式不正确，请稍后重试。');
    }
    return body;
  },
  exportKnowledgeFaqs: (
    baseId: string,
    format: 'json' | 'csv',
    version: 'published' | 'draft' = 'published',
  ): Promise<Blob> =>
    nativeRequest(
      `/knowledge/bases/${baseId}/faqs/export?format=${format}&version=${version}`,
      'GET',
      undefined,
      undefined,
      'blob',
    ),
  testKnowledgeFaqs: (
    baseId: string,
    input: {
      q: string;
      limit?: number;
      rerank?: boolean;
      minVectorScore?: number;
      onlyRecommended?: boolean;
      faqPriority?: boolean;
      faqDirectAnswerThreshold?: number;
    },
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResponse> =>
    rpc.knowledge.bases.testFaqs({ params: { id: baseId }, body: input }, clientOptions(signal)),
  knowledgeWikiPages: (
    baseId: string,
    cursor?: string,
  ): Promise<KnowledgePage<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>>> =>
    rpc.knowledge.bases.wikiPages({
      params: { id: baseId },
      query: cursor === undefined ? {} : { cursor },
    }),
  knowledgeWikiPage: (pageId: string): Promise<KnowledgeWikiPageDetail> =>
    rpc.knowledge.wiki.get({ params: { pageId }, query: {} }),
  knowledgeWikiVersions: (
    pageId: string,
    cursor?: string,
  ): Promise<KnowledgePage<KnowledgeWikiVersion>> =>
    rpc.knowledge.wiki.versions({
      params: { pageId },
      query: cursor === undefined ? {} : { cursor },
    }),
  createKnowledgeWikiPage: (
    baseId: string,
    input: { slug: string; title: string; parentId?: string | null; position?: number },
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    rpc.knowledge.bases.createWikiPage({ params: { id: baseId }, body: input }),
  updateKnowledgeWikiPage: (
    pageId: string,
    patch: {
      title?: string;
      markdown?: string;
      expectedVersion?: string | null;
      parentId?: string | null;
      position?: number;
    },
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    rpc.knowledge.wiki.update({ params: { pageId }, body: patch }),
  knowledgeWikiLinks: (pageId: string): Promise<KnowledgeWikiLinks> =>
    rpc.knowledge.wiki.links({ params: { pageId } }),
  knowledgeWikiDiff: (
    pageId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<KnowledgeWikiDiff> =>
    rpc.knowledge.wiki.diff({ params: { pageId }, query: { fromVersionId, toVersionId } }),
  generateKnowledgeWikiPage: (
    pageId: string,
    input: { instruction?: string } = {},
  ): Promise<{ jobId: string }> => rpc.knowledge.wiki.generate({ params: { pageId }, body: input }),
  rollbackKnowledgeWikiPage: (pageId: string, versionId: string): Promise<KnowledgeWikiVersion> =>
    rpc.knowledge.wiki.rollback({ params: { pageId }, body: { versionId } }),
  publishKnowledgeWikiVersion: (
    pageId: string,
    versionId: string,
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    rpc.knowledge.wiki.publish({ params: { pageId }, body: { versionId } }),
  exportKnowledgeBase: (baseId: string): Promise<Blob> =>
    nativeRequest(`/knowledge/bases/${baseId}/export`, 'GET', undefined, undefined, 'blob'),
  importKnowledgeBase: (archive: Blob): Promise<KnowledgePackageImportResult> =>
    nativeRequest('/knowledge/bases/import', 'POST', archive),
  knowledgeModelProfiles: async (): Promise<KnowledgeModelProfile[]> =>
    (await rpc.knowledge.modelProfiles.list({ query: {} })).flatMap((profile) =>
      'endpointUrl' in profile ? [profile] : [],
    ),
  knowledgeModelProfileSelections: async (): Promise<KnowledgeModelProfileSelection[]> =>
    (await rpc.knowledge.modelProfiles.list({ query: { view: 'selection' } })).flatMap((profile) =>
      'supportsImageVectors' in profile ? [profile] : [],
    ),
  updateKnowledgeModelProfile: (
    id: string,
    patch: {
      name?: string;
      endpointUrl?: string;
      model?: string;
      apiKey?: string | null;
      enabled?: boolean;
      embeddingProtocol?: 'openai' | 'cohere_v2';
      imageInputEnabled?: boolean;
    },
  ): Promise<KnowledgeModelProfile> =>
    rpc.knowledge.modelProfiles.update({ params: { profileId: id }, body: patch }),
  deleteKnowledgeModelProfile: async (id: string): Promise<void> => {
    await rpc.knowledge.modelProfiles.remove({ params: { profileId: id } });
  },
  testKnowledgeModelProfile: (id: string): Promise<{ ok: boolean; kind?: string }> =>
    rpc.knowledge.modelProfiles.test({ params: { profileId: id } }),
  rebuildKnowledgeBase: (
    id: string,
    input: { documentIds?: string[]; chunksOnly?: boolean } = {},
  ): Promise<{ jobId: string }> => rpc.knowledge.bases.rebuild({ params: { id }, body: input }),
  createKnowledgeModelProfile: (input: {
    kind: 'embedding' | 'rerank' | 'asr';
    name: string;
    endpointUrl: string;
    model: string;
    apiKey?: string;
    enabled?: boolean;
    embeddingProtocol?: 'openai' | 'cohere_v2';
    imageInputEnabled?: boolean;
  }): Promise<KnowledgeModelProfile> => rpc.knowledge.modelProfiles.create({ body: input }),
};
