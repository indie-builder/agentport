import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type Browser, test } from '@e2e-dev/web';
import { type App, expect, type Screen } from 'e2e';
import { api, DATASET_ID, datasetPath } from '../support/business-dataset.js';

/**
 * 青禾数据集的知识域：真实 UI 创建知识库、手写文档、上传文件、编辑并发布 Wiki；
 * 其余重复项与轮询走同一浏览器、同源的业务 API。不直连数据库、不伪造摄取或检索结果。
 *
 * 固定对象（名称不随机）：
 * - 知识库「【青禾演示】」，slug 即数据集命名空间；
 * - 4 篇正常文档（2 手写 + 2 上传，实际摄取 3 ready + 1 disabled）；
 * - 1 篇真实摄取失败样本（损坏 PNG，由 worker 真实解析失败，不是入口拒绝）；
 * - 2 个 Wiki 页面（人工发布 1、真实生成草稿 1 且必须带引用）；
 * - 1 个 feed 来源 + 1 个范围，syncCron 为空，同步一次后最终暂停。
 *
 * 重跑语义：按固定名称精确查找，已有对象只复用不重建；manifest 记录了任务 ID 后不再重发，
 * 失败不自动重试；固定名称被不同内容占用时报冲突，不覆盖开发者修改。
 * E2E_DEV_DATA_VERIFY=1 时只做 GET 读取，不触发 embedding/模型/profile 测试/同步。
 */

const BUILD_FLAG_REASON = '专用数据构建用例：仅 E2E_DEV_DATA=1 时运行，普通回归不执行';
const VERIFY_FLAG_REASON =
  '专用数据只读验收：仅 E2E_DEV_DATA_VERIFY=1 时运行；不触发 embedding/模型/同步';

const BASE_NAME = '【青禾演示】';
const SUBJECT = '青禾商贸｜采购与售后协作';
const BASE_DESCRIPTION = `DEV-DATA ${DATASET_ID} · ${SUBJECT} v1；由 tests/dev-data/knowledge.e2e.ts 生成，请勿手工改名`;
const PO_NUMBER = 'QH-PO-2026-001';
const SUPPLIER = '云杉包装';
const PRODUCT = '竹纤维随行杯';
const FEED_URL = 'https://hnrss.org/newest?count=3';
const BUILD_COMMAND = 'pnpm dev:data';

const DOC_POLL_TIMEOUT_MS = 12 * 60_000;
const JOB_POLL_TIMEOUT_MS = 15 * 60_000;
const STATE_POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;
const VERIFY_TIMEOUT_MS = 5 * 60_000;

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/dev-data/knowledge/', import.meta.url));

type DocKey = 'manualPo' | 'manualAfterSales' | 'uploadAcceptance' | 'uploadBamboo' | 'failedImage';
type FolderKey = 'purchase' | 'afterSales';
type ExpectedDocStatus = 'ready' | 'disabled' | 'failed';
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const FOLDER_NAMES: Record<FolderKey, string> = {
  purchase: `${BASE_NAME}采购资料`,
  afterSales: `${BASE_NAME}售后资料`,
};
const TAGS = [PO_NUMBER, SUPPLIER, PRODUCT] as const;

interface DocSpec {
  key: DocKey;
  scenario: string;
  title: string;
  folder: FolderKey | null;
  tags: string[];
  expectedStatus: ExpectedDocStatus;
  fixture: string;
  uploadName: string | null;
  requiredText: string[];
}

const DOC_SPECS: DocSpec[] = [
  {
    key: 'manualPo',
    scenario: '手写采购单审批说明（实际摄取 ready）',
    title: `${BASE_NAME}采购单 ${PO_NUMBER} 审批说明`,
    folder: 'purchase',
    tags: [PO_NUMBER, SUPPLIER],
    expectedStatus: 'ready',
    fixture: 'manual-po-2026-001.md',
    uploadName: null,
    requiredText: [PO_NUMBER, SUPPLIER, PRODUCT],
  },
  {
    key: 'manualAfterSales',
    scenario: '手写售后规则（摄取 ready 后停用）',
    title: `${BASE_NAME}售后退换货规则`,
    folder: 'afterSales',
    tags: [PO_NUMBER],
    expectedStatus: 'disabled',
    fixture: 'manual-after-sales.md',
    uploadName: null,
    requiredText: [PO_NUMBER, SUPPLIER, PRODUCT],
  },
  {
    key: 'uploadAcceptance',
    scenario: '上传 Markdown 验收记录（实际摄取 ready）',
    title: `${BASE_NAME}${SUPPLIER}验收记录`,
    folder: 'purchase',
    tags: [SUPPLIER, PO_NUMBER],
    expectedStatus: 'ready',
    fixture: 'upload-yunshan-acceptance.md',
    uploadName: `${BASE_NAME}${SUPPLIER}验收记录.md`,
    requiredText: [PO_NUMBER, SUPPLIER, '缓冲材料厚度'],
  },
  {
    key: 'uploadBamboo',
    scenario: '上传 CSV 采购明细（实际摄取 ready，表格分块）',
    title: `${BASE_NAME}${PRODUCT}采购明细`,
    folder: 'purchase',
    tags: [PRODUCT, PO_NUMBER],
    expectedStatus: 'ready',
    fixture: 'upload-bamboo-cup.csv',
    uploadName: `${BASE_NAME}${PRODUCT}采购明细.csv`,
    requiredText: [PO_NUMBER, PRODUCT, SUPPLIER, '---'],
  },
  {
    key: 'failedImage',
    scenario: '上传损坏 PNG（入口接受，worker 真实摄取失败）',
    title: `${BASE_NAME}破损图片摄取失败样例`,
    folder: null,
    tags: [],
    expectedStatus: 'failed',
    fixture: 'broken-image.base64',
    uploadName: `${BASE_NAME}破损图片摄取失败样例.png`,
    requiredText: [],
  },
];

const WIKI_MANUAL = {
  slug: 'qinghe-po-2026-001-guide',
  title: `${BASE_NAME}采购单 ${PO_NUMBER} 协作说明`,
  fixture: 'wiki-manual.md',
};
const WIKI_GENERATED = {
  slug: 'qinghe-po-2026-001-draft',
  title: `${BASE_NAME}${PO_NUMBER} 采购知识草稿`,
  instruction: `请依据${SUPPLIER}验收记录与${PRODUCT}采购明细，为采购单 ${PO_NUMBER} 生成一份带引用的协作说明。`,
};
const SOURCE_NAME = `${BASE_NAME}行业动态 RSS`;

interface KnowledgeBase {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  embeddingProfileId: string;
  rerankProfileId: string | null;
  settings: { chunkTokens: number; chunkOverlap: number; wikiAutoUpdate: boolean };
}

interface Folder {
  id: string;
  baseId: string;
  parentId: string | null;
  name: string;
  path: string;
}

interface Tag {
  id: string;
  baseId: string;
  name: string;
}

interface KnowledgeDocument {
  id: string;
  baseId: string;
  folderId: string | null;
  title: string;
  sourceType: string;
  mimeType: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'disabled';
  currentVersionId: string | null;
  tags: string[];
}

interface Chunk {
  id: string;
  documentId: string;
  versionId: string;
  ordinal: number;
  kind: 'text' | 'table' | 'image';
  content: string;
  enabled: boolean;
}

interface WikiPage {
  id: string;
  baseId: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'stale' | 'failed';
  currentVersionId: string | null;
}

interface WikiVersion {
  id: string;
  pageId: string;
  version: number;
  markdown: string;
  sourceChunkIds: string[];
  model: string;
  generatedBy: 'manual' | 'sdk';
}

interface WikiPageDetail extends WikiPage {
  versions: WikiVersion[];
}

interface SourceRange {
  id: string;
  kind: string;
  externalId: string;
  enabled: boolean;
}

interface KnowledgeSource {
  id: string;
  baseId: string;
  type: string;
  name: string;
  status: 'active' | 'paused' | 'disabled' | 'auth_error';
  syncCron: string | null;
  ranges: SourceRange[];
}

interface Job {
  id: string;
  type: 'ingest' | 'reindex' | 'sync' | 'wiki_generate';
  status: JobStatus;
  step: string | null;
  attempts: number;
  error: string | null;
  documentId: string | null;
  sourceId: string | null;
}

interface SyncStats {
  listed: number;
  created: number;
  updated: number;
  disabled: number;
  failed: number;
}

interface SyncRun {
  id: string;
  sourceId: string;
  status: JobStatus;
  stats: SyncStats;
  error: string | null;
}

interface ModelProfile {
  id: string;
  name: string;
  kind: 'embedding' | 'rerank';
  enabled: boolean;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface DocumentRecord {
  id: string;
  title: string;
  scenario: string;
  expectedStatus: ExpectedDocStatus;
  status: KnowledgeDocument['status'];
  currentVersionId: string | null;
  folderId: string | null;
  tags: string[];
  sourceType: string;
  mimeType: string;
}

interface FolderRecord {
  key: FolderKey;
  id: string;
  name: string;
  path: string;
}

interface TagRecord {
  name: string;
  id: string;
}

interface ManualWikiRecord {
  pageId: string;
  slug: string;
  title: string;
  status: WikiPage['status'];
  currentVersionId: string | null;
  versionId: string | null;
  generatedBy: string | null;
}

interface GeneratedWikiRecord {
  pageId: string;
  slug: string;
  title: string;
  status: WikiPage['status'];
  versionId: string | null;
  sourceChunkIds: string[];
  model: string | null;
  jobId: string | null;
  jobStatus: WikiGenerateTask['status'] | null;
}

interface WikiGenerateTask {
  pageId: string;
  pageTitle: string;
  instruction: string;
  status: 'requested' | JobStatus | 'unknown';
  jobId: string | null;
  requestedAt: string;
  finishedAt: string | null;
  versionId: string | null;
  sourceChunkIds: string[];
  error: string | null;
}

interface FeedSyncTask {
  sourceId: string;
  status: 'requested' | JobStatus | 'unknown';
  jobId: string | null;
  syncRunId: string | null;
  requestedAt: string;
  finishedAt: string | null;
  error: string | null;
  runStatus: JobStatus | null;
  stats: SyncStats | null;
  importedDocumentIds: string[];
  importedDocuments: Array<{ id: string; title: string; status: string }>;
}

interface SourceRecord {
  id: string;
  name: string;
  type: 'feed';
  status: KnowledgeSource['status'];
  syncCron: string | null;
  rangeIds: string[];
  ranges: Array<{ id: string; kind: string; externalId: string; enabled: boolean }>;
  sync: FeedSyncTask | null;
}

interface GapRecord {
  key: string;
  reason: string;
  evidence: string[];
  recordedAt: string;
}

interface KnowledgeManifest {
  schemaVersion: 1;
  dataset: string;
  section: 'knowledge';
  namespace: string;
  displayName: string;
  subject: string;
  descriptionMarker: string;
  source: {
    origin: string;
    via: 'e2e-ui+api';
    buildCommand: string;
    updatedAt: string;
  };
  plan: {
    folders: Array<{ key: FolderKey; name: string }>;
    tags: string[];
    documents: Array<{ key: DocKey; title: string; expectedStatus: ExpectedDocStatus }>;
    wiki: {
      manualSlug: string;
      manualTitle: string;
      generatedSlug: string;
      generatedTitle: string;
    };
    feedUrl: string;
  };
  base: null | {
    id: string;
    slug: string;
    name: string;
    description: string;
    status: KnowledgeBase['status'];
    embeddingProfileId: string;
    rerankProfileId: string | null;
    settings: KnowledgeBase['settings'];
  };
  folders: FolderRecord[];
  tags: TagRecord[];
  documents: Partial<Record<DocKey, DocumentRecord>>;
  failedIngestion: null | {
    documentId: string;
    title: string;
    jobId: string;
    jobStatus: JobStatus;
    attempts: number;
    error: string;
  };
  wiki: {
    manual: ManualWikiRecord | null;
    generated: GeneratedWikiRecord | null;
  };
  feedSource: SourceRecord | null;
  costTasks: {
    wikiGenerate: WikiGenerateTask | null;
    feedSync: FeedSyncTask | null;
  };
  relations: {
    baseId: string | null;
    folderIds: string[];
    documentFolderIds: Record<string, string | null>;
    documentTags: Record<string, string[]>;
    wiki: { manualPageId: string | null; generatedPageId: string | null };
    sourceRangeIds: string[];
  };
  gaps: GapRecord[];
  status: 'in_progress' | 'ready' | 'partial' | 'blocked';
}

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);
const TERMINAL_DOC_STATUSES = new Set<KnowledgeDocument['status']>(['ready', 'failed', 'disabled']);

function nowIso(): string {
  return new Date().toISOString();
}

function conflict(message: string): never {
  throw new Error(
    `[${DATASET_ID}] 知识数据集冲突：${message}。构建不会覆盖已有对象或改用随机名称。`,
  );
}

function gapFailure(message: string): never {
  throw new Error(`[${DATASET_ID}] 知识数据集缺口：${message}。未伪造摄取、生成或同步结果。`);
}

function verification(message: string): never {
  throw new Error(`[${DATASET_ID}] 知识数据集验收失败：${message}`);
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) verification(message);
  return value;
}

function exactlyOne<T>(items: T[], label: string): T {
  if (items.length === 0) verification(`缺少${label}`);
  if (items.length > 1) verification(`${label}存在 ${items.length} 个，无法唯一确定`);
  const [only] = items;
  if (only === undefined) verification(`缺少${label}`);
  return only;
}

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

async function readFixture(name: string): Promise<string> {
  return readFile(fixturePath(name), 'utf8');
}

function newManifest(origin: string): KnowledgeManifest {
  return {
    schemaVersion: 1,
    dataset: DATASET_ID,
    section: 'knowledge',
    namespace: DATASET_ID,
    displayName: BASE_NAME,
    subject: SUBJECT,
    descriptionMarker: BASE_DESCRIPTION,
    source: {
      origin,
      via: 'e2e-ui+api',
      buildCommand: BUILD_COMMAND,
      updatedAt: nowIso(),
    },
    plan: {
      folders: [
        { key: 'purchase', name: FOLDER_NAMES.purchase },
        { key: 'afterSales', name: FOLDER_NAMES.afterSales },
      ],
      tags: [...TAGS],
      documents: DOC_SPECS.map((spec) => ({
        key: spec.key,
        title: spec.title,
        expectedStatus: spec.expectedStatus,
      })),
      wiki: {
        manualSlug: WIKI_MANUAL.slug,
        manualTitle: WIKI_MANUAL.title,
        generatedSlug: WIKI_GENERATED.slug,
        generatedTitle: WIKI_GENERATED.title,
      },
      feedUrl: FEED_URL,
    },
    base: null,
    folders: [],
    tags: [],
    documents: {},
    failedIngestion: null,
    wiki: { manual: null, generated: null },
    feedSource: null,
    costTasks: { wikiGenerate: null, feedSync: null },
    relations: {
      baseId: null,
      folderIds: [],
      documentFolderIds: {},
      documentTags: {},
      wiki: { manualPageId: null, generatedPageId: null },
      sourceRangeIds: [],
    },
    gaps: [],
    status: 'in_progress',
  };
}

async function loadManifest(): Promise<KnowledgeManifest | null> {
  try {
    return JSON.parse(await readFile(datasetPath('knowledge'), 'utf8')) as KnowledgeManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function syncRelations(manifest: KnowledgeManifest): void {
  const documentFolderIds: Record<string, string | null> = {};
  const documentTags: Record<string, string[]> = {};
  for (const spec of DOC_SPECS) {
    const record = manifest.documents[spec.key];
    documentFolderIds[spec.key] = record?.folderId ?? null;
    documentTags[spec.key] = record?.tags ?? [];
  }
  manifest.costTasks.feedSync = manifest.feedSource?.sync ?? null;
  manifest.relations = {
    baseId: manifest.base?.id ?? null,
    folderIds: manifest.folders.map((folder) => folder.id),
    documentFolderIds,
    documentTags,
    wiki: {
      manualPageId: manifest.wiki.manual?.pageId ?? null,
      generatedPageId: manifest.wiki.generated?.pageId ?? null,
    },
    sourceRangeIds: manifest.feedSource?.rangeIds ?? [],
  };
}

async function saveManifest(manifest: KnowledgeManifest): Promise<void> {
  manifest.source.updatedAt = nowIso();
  syncRelations(manifest);
  const file = datasetPath('knowledge');
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

function assertManifestIdentity(manifest: KnowledgeManifest): void {
  if (manifest.schemaVersion !== 1)
    verification(`manifest schemaVersion 为 ${manifest.schemaVersion}`);
  if (manifest.dataset !== DATASET_ID) verification(`manifest dataset 为 ${manifest.dataset}`);
  if (manifest.section !== 'knowledge') verification(`manifest section 为 ${manifest.section}`);
  if (manifest.namespace !== DATASET_ID)
    verification(`manifest namespace 为 ${manifest.namespace}`);
  if (manifest.displayName !== BASE_NAME)
    verification(`manifest displayName 为 ${manifest.displayName}`);
  if (manifest.subject !== SUBJECT) verification(`manifest subject 为 ${manifest.subject}`);
  if (manifest.descriptionMarker !== BASE_DESCRIPTION) {
    verification('manifest descriptionMarker 与固定数据集标记不一致');
  }
  if (manifest.plan.feedUrl !== FEED_URL) verification('manifest feedUrl 与固定来源地址不一致');
}

function recordGap(
  manifest: KnowledgeManifest,
  key: string,
  reason: string,
  evidence: string[],
): void {
  const next: GapRecord = { key, reason, evidence, recordedAt: nowIso() };
  const index = manifest.gaps.findIndex((entry) => entry.key === key);
  if (index >= 0) manifest.gaps[index] = next;
  else manifest.gaps.push(next);
}

function clearGap(manifest: KnowledgeManifest, key: string): void {
  manifest.gaps = manifest.gaps.filter((entry) => entry.key !== key);
}

function findGap(manifest: KnowledgeManifest, key: string): GapRecord | undefined {
  return manifest.gaps.find((entry) => entry.key === key);
}

async function poll<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`[${DATASET_ID}] 等待超时：${label}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function listAll<T>(
  browser: Browser,
  path: string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const search = new URLSearchParams({ ...params, limit: '200' });
    if (cursor !== null) search.set('cursor', cursor);
    const page = await api<Page<T>>(browser, `${path}?${search.toString()}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

async function findBase(browser: Browser): Promise<KnowledgeBase | null> {
  const bases = await listAll<KnowledgeBase>(browser, '/api/knowledge/bases');
  const matches = bases.filter((base) => base.slug === DATASET_ID);
  if (matches.length > 1) conflict(`slug ${DATASET_ID} 对应 ${matches.length} 个知识库`);
  return matches[0] ?? null;
}

async function fetchDocument(browser: Browser, documentId: string): Promise<KnowledgeDocument> {
  return api<KnowledgeDocument>(browser, `/api/knowledge/documents/${enc(documentId)}`);
}

async function findDocumentByTitle(
  browser: Browser,
  baseId: string,
  title: string,
): Promise<KnowledgeDocument | null> {
  const documents = await listAll<KnowledgeDocument>(
    browser,
    `/api/knowledge/bases/${enc(baseId)}/documents`,
  );
  const matches = documents.filter((document) => document.title === title);
  if (matches.length > 1) conflict(`文档标题「${title}」对应 ${matches.length} 个文档`);
  return matches[0] ?? null;
}

async function fetchChunks(browser: Browser, documentId: string): Promise<Chunk[]> {
  return listAll<Chunk>(browser, `/api/knowledge/documents/${enc(documentId)}/chunks`);
}

async function findWikiPage(
  browser: Browser,
  baseId: string,
  slug: string,
): Promise<WikiPage | null> {
  const pages = await listAll<WikiPage>(browser, `/api/knowledge/bases/${enc(baseId)}/wiki-pages`);
  const matches = pages.filter((page) => page.slug === slug);
  if (matches.length > 1) conflict(`Wiki slug ${slug} 对应 ${matches.length} 个页面`);
  return matches[0] ?? null;
}

async function fetchWikiPage(browser: Browser, pageId: string): Promise<WikiPageDetail> {
  return api<WikiPageDetail>(browser, `/api/knowledge/wiki-pages/${enc(pageId)}?limit=200`);
}

async function fetchJob(browser: Browser, jobId: string): Promise<Job> {
  return api<Job>(browser, `/api/knowledge/jobs/${enc(jobId)}`);
}

async function waitJob(browser: Browser, jobId: string): Promise<Job> {
  return poll(
    `知识任务 ${jobId}`,
    () => fetchJob(browser, jobId),
    (job) => TERMINAL_JOB_STATUSES.has(job.status),
    JOB_POLL_TIMEOUT_MS,
  );
}

async function fetchSyncRun(
  browser: Browser,
  sourceId: string,
  syncRunId: string,
): Promise<SyncRun> {
  const response = await api<Page<SyncRun>>(
    browser,
    `/api/knowledge/sources/${enc(sourceId)}/runs?limit=200`,
  );
  return required(
    response.items.find((run) => run.id === syncRunId),
    `来源 ${sourceId} 找不到同步运行 ${syncRunId}`,
  );
}

async function pickEmbeddingProfile(browser: Browser): Promise<ModelProfile | null> {
  const profiles = await api<ModelProfile[]>(browser, '/api/knowledge/model-profiles');
  return profiles.find((profile) => profile.kind === 'embedding' && profile.enabled) ?? null;
}

function documentRecord(spec: DocSpec, document: KnowledgeDocument): DocumentRecord {
  return {
    id: document.id,
    title: document.title,
    scenario: spec.scenario,
    expectedStatus: spec.expectedStatus,
    status: document.status,
    currentVersionId: document.currentVersionId,
    folderId: document.folderId,
    tags: document.tags,
    sourceType: document.sourceType,
    mimeType: document.mimeType,
  };
}

function sourceRecord(source: KnowledgeSource, sync: FeedSyncTask | null): SourceRecord {
  return {
    id: source.id,
    name: source.name,
    type: 'feed',
    status: source.status,
    syncCron: source.syncCron,
    rangeIds: source.ranges.map((range) => range.id),
    ranges: source.ranges.map((range) => ({
      id: range.id,
      kind: range.kind,
      externalId: range.externalId,
      enabled: range.enabled,
    })),
    sync,
  };
}

async function createBaseViaUi(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  profile: ModelProfile;
}): Promise<void> {
  const { app, screen, browser, profile } = input;
  await app.open('/knowledge');
  await screen.getByRole('button', { name: '新建知识库' }).first().tap();
  await browser.locator('#knowledge-name').fill(BASE_NAME);
  await browser.locator('#knowledge-description').fill(BASE_DESCRIPTION);

  const slug = browser.locator('#knowledge-slug');
  if (!(await slug.isVisible())) {
    await screen.getByRole('button', { name: '高级设置', exact: true }).tap();
  }
  await slug.fill(DATASET_ID);

  if ((await browser.locator('#knowledge-embedding').count()) > 0) {
    await screen.getByRole('combobox', { name: /^Embedding/ }).tap();
    await screen.getByRole('option', profile.name, { exact: true }).tap();
  }

  await screen.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).tap();
  await expect(browser).toHaveURL(/\/knowledge\/kb_/);
}

async function createManualDocumentViaUi(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  baseId: string;
  spec: DocSpec;
  content: string;
}): Promise<void> {
  const { app, screen, browser, baseId, spec, content } = input;
  await app.open(`/knowledge/${baseId}`);
  await screen.getByRole('button', { name: '导入', exact: true }).tap();
  await screen.getByRole('menuitem', '手写文档').tap();
  await browser.locator('#knowledge-manual-title').fill(spec.title);
  if (spec.tags.length > 0) {
    await browser.locator('#knowledge-manual-tags').fill(spec.tags.join(', '));
  }
  await browser.locator('[contenteditable="true"][aria-label="正文（Markdown）"]').fill(content);
  await screen.getByRole('dialog').getByRole('button', { name: '导入', exact: true }).tap();
}

async function uploadDocumentsViaUi(input: {
  app: App;
  browser: Browser;
  baseId: string;
  specs: DocSpec[];
}): Promise<string> {
  const { app, browser, baseId, specs } = input;
  await app.open(`/knowledge/${baseId}`);
  const inputElement = browser.locator('input[aria-label="选择要上传的文件"]');
  await inputElement.waitFor();
  const temp = await mkdtemp(join(tmpdir(), `${DATASET_ID}-knowledge-upload-`));
  try {
    const paths: string[] = [];
    for (const spec of specs) {
      const uploadName = spec.uploadName;
      if (uploadName === null) throw new Error(`文档 ${spec.key} 缺少上传文件名`);
      const target = join(temp, uploadName);
      if (spec.fixture.endsWith('.base64')) {
        const encoded = (await readFixture(spec.fixture)).trim();
        await writeFile(target, Buffer.from(encoded, 'base64'));
      } else {
        await copyFile(fixturePath(spec.fixture), target);
      }
      paths.push(target);
    }
    await inputElement.setInputFiles(paths);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return temp;
}

async function createWikiPageViaUi(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  baseId: string;
  page: { slug: string; title: string };
}): Promise<void> {
  const { app, screen, browser, baseId, page } = input;
  await app.open(`/knowledge/${baseId}?panel=wiki`);
  await screen.getByRole('button', { name: '新建 Wiki 页面' }).tap();
  await browser.locator('#wiki-title').fill(page.title);
  await browser.locator('#wiki-slug').fill(page.slug);
  await screen.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).tap();
}

async function publishWikiViaUi(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  baseId: string;
  pageId: string;
  markdown: string;
}): Promise<void> {
  const { app, screen, browser, baseId, pageId, markdown } = input;
  await app.open(`/knowledge/${baseId}?panel=wiki&page=${enc(pageId)}`);
  await screen.getByRole('button', { name: '编辑正文', exact: true }).waitFor();
  await screen.getByRole('button', { name: '编辑正文', exact: true }).tap();
  await browser.locator('#knowledge-wiki-markdown').fill(markdown);
  await screen.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).tap();
}

async function ensureFolders(
  manifest: KnowledgeManifest,
  browser: Browser,
  baseId: string,
): Promise<Record<FolderKey, string>> {
  const folders = await api<Folder[]>(
    browser,
    `/api/knowledge/bases/${enc(baseId)}/folders?limit=200`,
  );
  const ids = {} as Record<FolderKey, string>;
  const records: FolderRecord[] = [];
  for (const [key, name] of Object.entries(FOLDER_NAMES) as Array<[FolderKey, string]>) {
    const matches = folders.filter((folder) => folder.name === name);
    if (matches.length > 1) conflict(`文件夹名称「${name}」对应 ${matches.length} 个文件夹`);
    const recorded = manifest.folders.find((entry) => entry.key === key);
    let folder = matches[0];
    if (folder === undefined && recorded !== undefined) {
      conflict(`manifest 记录的文件夹 ${recorded.id}（${name}）已不存在`);
    }
    if (folder === undefined) {
      folder = await api<Folder>(browser, `/api/knowledge/bases/${enc(baseId)}/folders`, {
        method: 'POST',
        body: { parentId: null, name },
      });
    } else if (folder.parentId !== null || folder.path !== `/${name}`) {
      conflict(`文件夹「${name}」已存在但位置为 ${folder.path}，不是数据集固定根目录`);
    } else if (recorded !== undefined && recorded.id !== folder.id) {
      conflict(`文件夹「${name}」的 ID ${folder.id} 与 manifest ${recorded.id} 不一致`);
    }
    ids[key] = folder.id;
    records.push({ key, id: folder.id, name: folder.name, path: folder.path });
  }
  manifest.folders = records;
  return ids;
}

async function ensureTags(
  manifest: KnowledgeManifest,
  browser: Browser,
  baseId: string,
): Promise<Record<string, string>> {
  const tags = await api<Tag[]>(browser, `/api/knowledge/bases/${enc(baseId)}/tags`);
  const ids: Record<string, string> = {};
  const records: TagRecord[] = [];
  for (const name of TAGS) {
    const matches = tags.filter((tag) => tag.name === name);
    if (matches.length > 1) conflict(`标签「${name}」对应 ${matches.length} 个标签`);
    const recorded = manifest.tags.find((entry) => entry.name === name);
    let tag = matches[0];
    if (tag === undefined && recorded !== undefined) {
      conflict(`manifest 记录的标签 ${recorded.id}（${name}）已不存在`);
    }
    if (tag === undefined) {
      tag = await api<Tag>(browser, `/api/knowledge/bases/${enc(baseId)}/tags`, {
        method: 'POST',
        body: { name },
      });
    } else if (recorded !== undefined && recorded.id !== tag.id) {
      conflict(`标签「${name}」的 ID ${tag.id} 与 manifest ${recorded.id} 不一致`);
    }
    ids[name] = tag.id;
    records.push({ name, id: tag.id });
  }
  manifest.tags = records;
  return ids;
}

async function ensureDocumentMetadata(input: {
  browser: Browser;
  spec: DocSpec;
  document: KnowledgeDocument;
  folderIds: Record<FolderKey, string>;
}): Promise<KnowledgeDocument> {
  const { browser, spec, document, folderIds } = input;
  const patch: { folderId?: string; tags?: string[] } = {};
  if (spec.folder !== null) {
    const expectedFolderId = folderIds[spec.folder];
    if (document.folderId === null) patch.folderId = expectedFolderId;
    else if (document.folderId !== expectedFolderId) {
      conflict(`文档「${spec.title}」已被移动到其他文件夹（${document.folderId}）`);
    }
  }
  if (spec.tags.length > 0) {
    const missing = spec.tags.filter((tag) => !document.tags.includes(tag));
    if (missing.length > 0) {
      if (document.tags.length === 0) patch.tags = spec.tags;
      else {
        conflict(`文档「${spec.title}」的标签已被修改，缺少 ${missing.join('、')}`);
      }
    }
  }
  if (Object.keys(patch).length === 0) return document;
  return api<KnowledgeDocument>(browser, `/api/knowledge/documents/${enc(document.id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

async function latestIngestJob(
  browser: Browser,
  baseId: string,
  documentId: string,
): Promise<Job | null> {
  const jobs = await listAll<Job>(browser, '/api/knowledge/jobs', {
    baseId,
    documentId,
  });
  return jobs.find((job) => job.type === 'ingest') ?? null;
}

/**
 * 文档状态会在首次失败时先写 failed，队列仍可能按退避重试；必须等 ingest 任务到终态，
 * 否则会把「还在重试」误判成最终失败。
 */
async function waitIngestOutcome(
  browser: Browser,
  baseId: string,
  documentId: string,
): Promise<{ job: Job; document: KnowledgeDocument }> {
  const job = await poll<Job | null>(
    `文档 ${documentId} 摄取任务`,
    () => latestIngestJob(browser, baseId, documentId),
    (value) => value !== null && TERMINAL_JOB_STATUSES.has(value.status),
    DOC_POLL_TIMEOUT_MS,
  );
  if (job === null) throw new Error(`[${DATASET_ID}] 文档 ${documentId} 没有摄取任务`);
  const document = await poll(
    `文档 ${documentId} 摄取状态`,
    () => fetchDocument(browser, documentId),
    (value) => TERMINAL_DOC_STATUSES.has(value.status),
    STATE_POLL_TIMEOUT_MS,
  );
  return { job, document };
}

async function ensureDocuments(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  manifest: KnowledgeManifest;
  baseId: string;
  folderIds: Record<FolderKey, string>;
}): Promise<void> {
  const { app, screen, browser, manifest, baseId, folderIds } = input;
  const existing = await listAll<KnowledgeDocument>(
    browser,
    `/api/knowledge/bases/${enc(baseId)}/documents`,
  );

  for (const spec of DOC_SPECS) {
    const matches = existing.filter((document) => document.title === spec.title);
    if (matches.length > 1) conflict(`文档标题「${spec.title}」对应 ${matches.length} 个文档`);
    const found = matches[0];
    const recorded = manifest.documents[spec.key];
    if (found === undefined && recorded !== undefined) {
      conflict(`manifest 记录的文档「${spec.title}」(${recorded.id}) 已不存在`);
    }
    if (found !== undefined && recorded !== undefined && recorded.id !== found.id) {
      conflict(`文档「${spec.title}」的 ID ${found.id} 与 manifest ${recorded.id} 不一致`);
    }
    if (found !== undefined) {
      manifest.documents[spec.key] = documentRecord(spec, found);
      await saveManifest(manifest);
      continue;
    }
    if (spec.uploadName === null) {
      await createManualDocumentViaUi({
        app,
        screen,
        browser,
        baseId,
        spec,
        content: await readFixture(spec.fixture),
      });
    }
  }

  const missingUploads = DOC_SPECS.filter(
    (spec) =>
      spec.uploadName !== null && !existing.some((document) => document.title === spec.title),
  );
  let uploadTemp: string | null = null;
  try {
    if (missingUploads.length > 0) {
      uploadTemp = await uploadDocumentsViaUi({
        app,
        browser,
        baseId,
        specs: missingUploads,
      });
    }

    for (const spec of DOC_SPECS) {
      const document = await poll(
        `文档「${spec.title}」出现`,
        () => findDocumentByTitle(browser, baseId, spec.title),
        (value) => value !== null,
        DOC_POLL_TIMEOUT_MS,
      );
      if (document === null) conflict(`文档「${spec.title}」没有创建成功`);
      const outcome = await waitIngestOutcome(browser, baseId, document.id);
      let terminal = outcome.document;

      if (spec.expectedStatus === 'failed') {
        if (outcome.job.status !== 'failed') {
          gapFailure(
            `文档「${spec.title}」的摄取任务状态为 ${outcome.job.status}，预期 failed；任务错误：${outcome.job.error ?? '(无)'}`,
          );
        }
        if (terminal.status !== 'failed') {
          gapFailure(`文档「${spec.title}」状态为 ${terminal.status}，预期 failed`);
        }
      } else {
        if (outcome.job.status !== 'succeeded') {
          gapFailure(
            `文档「${spec.title}」的摄取任务状态为 ${outcome.job.status}，预期 succeeded；任务错误：${outcome.job.error ?? '(无)'}`,
          );
        }
        if (spec.expectedStatus === 'disabled') {
          if (terminal.status === 'ready') {
            const previous = manifest.documents[spec.key]?.status;
            if (previous === 'disabled') {
              conflict(`文档「${spec.title}」被重新启用，构建不会再次停用`);
            }
            terminal = await api<KnowledgeDocument>(
              browser,
              `/api/knowledge/documents/${enc(terminal.id)}`,
              { method: 'PATCH', body: { status: 'disabled' } },
            );
          } else if (terminal.status !== 'disabled') {
            gapFailure(`文档「${spec.title}」状态为 ${terminal.status}，预期 disabled`);
          }
        } else if (terminal.status !== 'ready') {
          gapFailure(`文档「${spec.title}」状态为 ${terminal.status}，预期 ready`);
        }
      }

      terminal = await ensureDocumentMetadata({
        browser,
        spec,
        document: terminal,
        folderIds,
      });
      manifest.documents[spec.key] = documentRecord(spec, terminal);
      await saveManifest(manifest);
    }
  } finally {
    if (uploadTemp !== null) await rm(uploadTemp, { recursive: true, force: true });
  }
}

async function ensureFailedIngestion(
  manifest: KnowledgeManifest,
  browser: Browser,
  baseId: string,
): Promise<void> {
  const spec = DOC_SPECS.find((entry) => entry.key === 'failedImage');
  if (spec === undefined) throw new Error('缺少 failedImage 规格');
  const document = required(
    await findDocumentByTitle(browser, baseId, spec.title),
    `缺少失败样本「${spec.title}」`,
  );
  if (document.status !== 'failed') {
    verification(`失败样本文档「${spec.title}」状态为 ${document.status}`);
  }
  if (document.currentVersionId !== null) {
    verification(`失败样本文档「${spec.title}」不应有当前版本`);
  }
  const jobs = await listAll<Job>(browser, '/api/knowledge/jobs', {
    baseId,
    documentId: document.id,
  });
  const ingestJobs = jobs.filter((job) => job.type === 'ingest');
  if (ingestJobs.some((job) => job.status === 'succeeded')) {
    verification(`失败样本文档「${spec.title}」存在成功的摄取任务`);
  }
  const failed = required(
    ingestJobs.find((job) => job.status === 'failed'),
    `失败样本文档「${spec.title}」没有真实 failed ingest 任务（入口拒绝不算摄取失败）`,
  );
  if (failed.error === null || failed.error.trim() === '') {
    verification(`失败样本文档「${spec.title}」的 failed 任务缺少错误信息`);
  }
  manifest.failedIngestion = {
    documentId: document.id,
    title: document.title,
    jobId: failed.id,
    jobStatus: failed.status,
    attempts: failed.attempts,
    error: failed.error,
  };
  await saveManifest(manifest);
}

async function ensureManualWiki(input: {
  app: App;
  screen: Screen;
  browser: Browser;
  manifest: KnowledgeManifest;
  baseId: string;
}): Promise<void> {
  const { app, screen, browser, manifest, baseId } = input;
  const markdown = await readFixture(WIKI_MANUAL.fixture);
  let page = await findWikiPage(browser, baseId, WIKI_MANUAL.slug);
  const recorded = manifest.wiki.manual;
  if (page === null && recorded !== null) {
    conflict(`manifest 记录的人工 Wiki 页面 ${recorded.pageId} 已不存在`);
  }
  if (page !== null && recorded !== null && recorded.pageId !== page.id) {
    conflict(`人工 Wiki 页面 ID ${page.id} 与 manifest ${recorded.pageId} 不一致`);
  }
  if (page === null) {
    await createWikiPageViaUi({ app, screen, browser, baseId, page: WIKI_MANUAL });
    page = required(
      await poll(
        `Wiki 页面 ${WIKI_MANUAL.slug} 出现`,
        () => findWikiPage(browser, baseId, WIKI_MANUAL.slug),
        (value) => value !== null,
        STATE_POLL_TIMEOUT_MS,
      ),
      `Wiki 页面 ${WIKI_MANUAL.slug} 没有创建成功`,
    );
  }
  if (page.title !== WIKI_MANUAL.title) {
    conflict(`Wiki 页面 ${WIKI_MANUAL.slug} 标题为「${page.title}」`);
  }
  manifest.wiki.manual = {
    pageId: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    currentVersionId: page.currentVersionId,
    versionId: page.currentVersionId,
    generatedBy: null,
  };
  await saveManifest(manifest);

  let detail = await fetchWikiPage(browser, page.id);
  let current = detail.versions.find((version) => version.id === detail.currentVersionId);
  if (current === undefined) {
    await publishWikiViaUi({
      app,
      screen,
      browser,
      baseId,
      pageId: page.id,
      markdown,
    });
    detail = await poll(
      `Wiki 页面 ${page.id} 人工发布`,
      () => fetchWikiPage(browser, page.id),
      (value) => {
        const version = value.versions.find((entry) => entry.id === value.currentVersionId);
        return version?.generatedBy === 'manual' && version.markdown.includes(PO_NUMBER);
      },
      STATE_POLL_TIMEOUT_MS,
    );
    current = detail.versions.find((version) => version.id === detail.currentVersionId);
  }
  if (current === undefined || current.generatedBy !== 'manual') {
    conflict(`Wiki 页面 ${page.id} 的当前版本不是人工发布`);
  }
  if (!current.markdown.includes(PO_NUMBER) || !current.markdown.includes(SUPPLIER)) {
    conflict(`Wiki 页面 ${page.id} 的人工正文已被修改，不是数据集固定内容`);
  }
  manifest.wiki.manual = {
    pageId: detail.id,
    slug: detail.slug,
    title: detail.title,
    status: detail.status,
    currentVersionId: detail.currentVersionId,
    versionId: current.id,
    generatedBy: current.generatedBy,
  };
  await saveManifest(manifest);
}

async function ensureGeneratedWiki(input: {
  browser: Browser;
  manifest: KnowledgeManifest;
  baseId: string;
}): Promise<void> {
  const { browser, manifest, baseId } = input;
  let page = await findWikiPage(browser, baseId, WIKI_GENERATED.slug);
  const recorded = manifest.wiki.generated;
  if (page === null && recorded !== null) {
    conflict(`manifest 记录的生成 Wiki 页面 ${recorded.pageId} 已不存在`);
  }
  if (page !== null && recorded !== null && recorded.pageId !== page.id) {
    conflict(`生成 Wiki 页面 ID ${page.id} 与 manifest ${recorded.pageId} 不一致`);
  }
  if (page === null) {
    page = await api<WikiPage>(browser, `/api/knowledge/bases/${enc(baseId)}/wiki-pages`, {
      method: 'POST',
      body: { slug: WIKI_GENERATED.slug, title: WIKI_GENERATED.title },
    });
    manifest.wiki.generated = {
      pageId: page.id,
      slug: page.slug,
      title: page.title,
      status: page.status,
      versionId: null,
      sourceChunkIds: [],
      model: null,
      jobId: null,
      jobStatus: null,
    };
    await saveManifest(manifest);
  }
  if (page.title !== WIKI_GENERATED.title) {
    conflict(`Wiki 页面 ${WIKI_GENERATED.slug} 标题为「${page.title}」`);
  }

  const detail = await fetchWikiPage(browser, page.id);
  const generated = detail.versions.find(
    (version) => version.generatedBy === 'sdk' && version.sourceChunkIds.length > 0,
  );
  if (generated !== undefined) {
    manifest.wiki.generated = {
      pageId: detail.id,
      slug: detail.slug,
      title: detail.title,
      status: detail.status,
      versionId: generated.id,
      sourceChunkIds: generated.sourceChunkIds,
      model: generated.model,
      jobId: manifest.costTasks.wikiGenerate?.jobId ?? null,
      jobStatus: manifest.costTasks.wikiGenerate?.status ?? null,
    };
    clearGap(manifest, 'wiki-generate');
    await saveManifest(manifest);
    return;
  }

  const emptyDraft = detail.versions.find((version) => version.generatedBy === 'sdk');
  if (emptyDraft !== undefined) {
    recordGap(
      manifest,
      'wiki-generate',
      '已存在真实生成版本但没有引用 chunk，无法证明带引用；不自动重试',
      [page.id, emptyDraft.id],
    );
    await saveManifest(manifest);
    return;
  }

  const task = manifest.costTasks.wikiGenerate;
  if (task !== null) {
    if (task.jobId === null) {
      recordGap(manifest, 'wiki-generate', '上次已记录生成请求但未拿到任务 ID，按不自动重试处理', [
        task.pageId,
      ]);
      await saveManifest(manifest);
      return;
    }
    const job = await waitJob(browser, task.jobId);
    const after = await fetchWikiPage(browser, page.id);
    const version = after.versions.find(
      (entry) => entry.generatedBy === 'sdk' && entry.sourceChunkIds.length > 0,
    );
    task.status = job.status;
    task.finishedAt = nowIso();
    task.error = job.error;
    task.versionId = version?.id ?? null;
    task.sourceChunkIds = version?.sourceChunkIds ?? [];
    if (version === undefined) {
      recordGap(
        manifest,
        'wiki-generate',
        `生成任务 ${job.id} 状态为 ${job.status}，没有产生带引用的草稿；不自动重试`,
        [page.id, job.id],
      );
    } else {
      manifest.wiki.generated = {
        pageId: after.id,
        slug: after.slug,
        title: after.title,
        status: after.status,
        versionId: version.id,
        sourceChunkIds: version.sourceChunkIds,
        model: version.model,
        jobId: job.id,
        jobStatus: job.status,
      };
      clearGap(manifest, 'wiki-generate');
    }
    await saveManifest(manifest);
    return;
  }

  // 成本任务先记录场景身份，再触发；拿到 jobId 立刻落 manifest，重跑不重发。
  const requested: WikiGenerateTask = {
    pageId: page.id,
    pageTitle: page.title,
    instruction: WIKI_GENERATED.instruction,
    status: 'requested',
    jobId: null,
    requestedAt: nowIso(),
    finishedAt: null,
    versionId: null,
    sourceChunkIds: [],
    error: null,
  };
  manifest.costTasks.wikiGenerate = requested;
  await saveManifest(manifest);

  const started = await api<{ jobId: string }>(
    browser,
    `/api/knowledge/wiki-pages/${enc(page.id)}/generate`,
    { method: 'POST', body: { instruction: WIKI_GENERATED.instruction } },
  );
  requested.jobId = started.jobId;
  requested.status = 'queued';
  await saveManifest(manifest);

  const job = await waitJob(browser, started.jobId);
  const after = await fetchWikiPage(browser, page.id);
  const version = after.versions.find(
    (entry) => entry.generatedBy === 'sdk' && entry.sourceChunkIds.length > 0,
  );
  requested.status = job.status;
  requested.finishedAt = nowIso();
  requested.error = job.error;
  requested.versionId = version?.id ?? null;
  requested.sourceChunkIds = version?.sourceChunkIds ?? [];
  if (version === undefined) {
    recordGap(
      manifest,
      'wiki-generate',
      `生成任务 ${job.id} 状态为 ${job.status}，没有产生带引用的草稿；不自动重试`,
      [page.id, job.id],
    );
  } else {
    manifest.wiki.generated = {
      pageId: after.id,
      slug: after.slug,
      title: after.title,
      status: after.status,
      versionId: version.id,
      sourceChunkIds: version.sourceChunkIds,
      model: version.model,
      jobId: job.id,
      jobStatus: job.status,
    };
    clearGap(manifest, 'wiki-generate');
  }
  await saveManifest(manifest);
}

async function ensureFeedSource(input: {
  browser: Browser;
  manifest: KnowledgeManifest;
  baseId: string;
}): Promise<void> {
  const { browser, manifest, baseId } = input;
  const sources = await listAll<KnowledgeSource>(
    browser,
    `/api/knowledge/bases/${enc(baseId)}/sources`,
  );
  const matches = sources.filter((source) => source.name === SOURCE_NAME);
  if (matches.length > 1) conflict(`来源名称「${SOURCE_NAME}」对应 ${matches.length} 个来源`);
  const existingTask = manifest.costTasks.feedSync;
  const recordedStatus = manifest.feedSource?.status;
  let source = matches[0];
  if (source === undefined && manifest.feedSource !== null) {
    conflict(`manifest 记录的来源 ${manifest.feedSource.id} 已不存在`);
  }
  if (recordedStatus === 'paused' && source?.status === 'active') {
    conflict(`来源「${SOURCE_NAME}」在构建暂停后被重新启用，构建不会再次暂停`);
  }
  if (
    source !== undefined &&
    manifest.feedSource !== null &&
    manifest.feedSource.id !== source.id
  ) {
    conflict(`同名来源 ${source.id} 与 manifest 记录的 ${manifest.feedSource.id} 不一致`);
  }
  if (source !== undefined && existingTask !== null && existingTask.sourceId !== source.id) {
    conflict(`同步任务属于来源 ${existingTask.sourceId}，不是当前来源 ${source.id}`);
  }
  if (source === undefined) {
    source = await api<KnowledgeSource>(browser, `/api/knowledge/bases/${enc(baseId)}/sources`, {
      method: 'POST',
      body: {
        type: 'feed',
        name: SOURCE_NAME,
        config: {},
        secrets: {},
        syncCron: null,
        ranges: [{ kind: 'feed', externalId: FEED_URL, ref: null, paths: [], enabled: true }],
      },
    });
  }
  if (source.type !== 'feed') conflict(`来源「${SOURCE_NAME}」类型为 ${source.type}`);
  if (source.ranges.length !== 1) {
    conflict(`来源「${SOURCE_NAME}」范围数量为 ${source.ranges.length}，预期 1`);
  }
  const range = source.ranges[0];
  if (
    range === undefined ||
    range.kind !== 'feed' ||
    range.externalId !== FEED_URL ||
    !range.enabled
  ) {
    conflict(`来源「${SOURCE_NAME}」的范围不是启用中的 ${FEED_URL}`);
  }
  if (source.syncCron !== null) {
    conflict(`来源「${SOURCE_NAME}」syncCron 为 ${source.syncCron}，预期空`);
  }
  if (source.status !== 'active' && source.status !== 'paused') {
    conflict(`来源「${SOURCE_NAME}」状态为 ${source.status}，不能安全复用`);
  }

  manifest.feedSource = sourceRecord(source, existingTask);
  await saveManifest(manifest);

  let task = existingTask;
  if (task === null) {
    if (source.status !== 'active') {
      recordGap(manifest, 'feed-sync', '来源已处于 paused，构建不会重新启用，因此没有同步记录', [
        source.id,
      ]);
      await saveManifest(manifest);
    } else {
      task = {
        sourceId: source.id,
        status: 'requested',
        jobId: null,
        syncRunId: null,
        requestedAt: nowIso(),
        finishedAt: null,
        error: null,
        runStatus: null,
        stats: null,
        importedDocumentIds: [],
        importedDocuments: [],
      };
      manifest.costTasks.feedSync = task;
      manifest.feedSource = sourceRecord(source, task);
      await saveManifest(manifest);

      const started = await api<{ jobId: string; syncRunId: string }>(
        browser,
        `/api/knowledge/sources/${enc(source.id)}/sync`,
        { method: 'POST' },
      );
      task.jobId = started.jobId;
      task.syncRunId = started.syncRunId;
      task.status = 'queued';
      manifest.feedSource = sourceRecord(source, task);
      await saveManifest(manifest);
    }
  }

  if (task !== null && task.jobId !== null) {
    const job = await waitJob(browser, task.jobId);
    task.status = job.status;
    task.error = job.error;
    task.finishedAt = nowIso();
    if (task.syncRunId !== null) {
      const run = await fetchSyncRun(browser, source.id, task.syncRunId);
      task.runStatus = run.status;
      task.stats = run.stats;
      task.error = task.error ?? run.error;
    }
    if (job.status === 'succeeded') {
      const documents = await listAll<KnowledgeDocument>(
        browser,
        `/api/knowledge/bases/${enc(baseId)}/documents`,
      );
      const imported = documents.filter(
        (document) =>
          document.sourceType === 'feed' &&
          !DOC_SPECS.some((spec) => spec.title === document.title),
      );
      task.importedDocumentIds = imported.map((document) => document.id);
      task.importedDocuments = imported.map((document) => ({
        id: document.id,
        title: document.title,
        status: document.status,
      }));
      clearGap(manifest, 'feed-sync');
    } else {
      recordGap(manifest, 'feed-sync', `同步任务 ${job.id} 状态为 ${job.status}；不自动重试`, [
        source.id,
        job.id,
        task.syncRunId ?? '',
      ]);
    }
    manifest.feedSource = sourceRecord(source, task);
    await saveManifest(manifest);
  }

  if (source.status === 'active') {
    source = await api<KnowledgeSource>(browser, `/api/knowledge/sources/${enc(source.id)}`, {
      method: 'PATCH',
      body: { status: 'paused' },
    });
    manifest.feedSource = sourceRecord(source, task);
    await saveManifest(manifest);
  }
  if (source.status !== 'paused') {
    conflict(`来源「${SOURCE_NAME}」最终状态为 ${source.status}，预期 paused`);
  }
}

async function assertDataset(
  manifest: KnowledgeManifest,
  browser: Browser,
  origin: string,
): Promise<void> {
  assertManifestIdentity(manifest);
  let manifestOrigin: string;
  try {
    manifestOrigin = new URL(manifest.source.origin).origin;
  } catch {
    verification(`manifest origin 不是合法 URL：${manifest.source.origin}`);
  }
  if (manifestOrigin !== origin) {
    verification(
      `manifest 来源 ${manifestOrigin} 与当前应用 ${origin} 不一致；请在当前环境重新构建`,
    );
  }

  const bases = await listAll<KnowledgeBase>(browser, '/api/knowledge/bases');
  const base = exactlyOne(
    bases.filter((entry) => entry.slug === DATASET_ID),
    `知识库 slug ${DATASET_ID}`,
  );
  if (manifest.base === null) verification('manifest 缺少知识库 ID');
  if (manifest.base.id !== base.id) verification('manifest 知识库 ID 与 API 不一致');
  if (base.name !== BASE_NAME) verification(`知识库名称为「${base.name}」`);
  if (base.description !== BASE_DESCRIPTION) verification('知识库描述标记与固定值不一致');
  if (base.status !== 'active') verification(`知识库状态为 ${base.status}`);
  if (base.settings.wikiAutoUpdate) verification('知识库 wikiAutoUpdate 不是关闭状态');
  if (base.embeddingProfileId.trim() === '') verification('知识库没有绑定 embedding profile');
  if (base.rerankProfileId !== null && base.rerankProfileId.trim() === '') {
    verification('知识库 rerank profile 为空字符串');
  }
  // 只读列出配置，不调用 profile 测试或 embedding；证明绑定仍指向启用的 embedding。
  const profiles = await api<ModelProfile[]>(browser, '/api/knowledge/model-profiles');
  const embedding = profiles.find((profile) => profile.id === base.embeddingProfileId);
  if (embedding === undefined || embedding.kind !== 'embedding' || !embedding.enabled) {
    verification(`知识库绑定的 embedding profile ${base.embeddingProfileId} 不可用`);
  }

  const folders = await api<Folder[]>(
    browser,
    `/api/knowledge/bases/${enc(base.id)}/folders?limit=200`,
  );
  const folderIds: Record<FolderKey, string> = {} as Record<FolderKey, string>;
  for (const [key, name] of Object.entries(FOLDER_NAMES) as Array<[FolderKey, string]>) {
    const folder = exactlyOne(
      folders.filter((entry) => entry.name === name),
      `文件夹「${name}」`,
    );
    if (folder.parentId !== null || folder.path !== `/${name}`) {
      verification(`文件夹「${name}」位置为 ${folder.path}`);
    }
    const recorded = manifest.folders.find((entry) => entry.name === name);
    if (recorded?.id !== folder.id) verification(`manifest 文件夹「${name}」ID 与 API 不一致`);
    folderIds[key] = folder.id;
  }

  const tags = await api<Tag[]>(browser, `/api/knowledge/bases/${enc(base.id)}/tags`);
  for (const name of TAGS) {
    const tag = exactlyOne(
      tags.filter((entry) => entry.name === name),
      `标签「${name}」`,
    );
    const recorded = manifest.tags.find((entry) => entry.name === name);
    if (recorded?.id !== tag.id) verification(`manifest 标签「${name}」ID 与 API 不一致`);
  }

  const documents = await listAll<KnowledgeDocument>(
    browser,
    `/api/knowledge/bases/${enc(base.id)}/documents`,
  );
  const readyChunks = new Map<string, Chunk>();
  for (const spec of DOC_SPECS) {
    const document = exactlyOne(
      documents.filter((entry) => entry.title === spec.title),
      `文档「${spec.title}」`,
    );
    if (document.status !== spec.expectedStatus) {
      verification(`文档「${spec.title}」状态为 ${document.status}，预期 ${spec.expectedStatus}`);
    }
    const recorded = manifest.documents[spec.key];
    if (recorded === undefined) verification(`manifest 缺少文档「${spec.title}」`);
    if (recorded.id !== document.id) {
      verification(`manifest 文档「${spec.title}」ID 与 API 不一致`);
    }
    if (spec.folder !== null) {
      if (document.folderId !== folderIds[spec.folder]) {
        verification(`文档「${spec.title}」不在固定文件夹`);
      }
    }
    for (const tag of spec.tags) {
      if (!document.tags.includes(tag)) {
        verification(`文档「${spec.title}」缺少标签「${tag}」`);
      }
    }
    if (spec.expectedStatus === 'failed') continue;

    if (document.currentVersionId === null) {
      verification(`文档「${spec.title}」没有当前版本`);
    }
    const chunks = await fetchChunks(browser, document.id);
    if (chunks.length === 0) verification(`文档「${spec.title}」没有分块`);
    const text = chunks.map((chunk) => chunk.content).join('\n');
    for (const token of spec.requiredText) {
      if (!text.includes(token)) {
        verification(`文档「${spec.title}」分块缺少固定内容「${token}」`);
      }
    }
    if (spec.key === 'uploadBamboo' && !chunks.some((chunk) => chunk.kind === 'table')) {
      verification(`文档「${spec.title}」没有表格分块`);
    }
  }

  // 生成草稿的引用必须落在任意 ready 文档的当前、启用分块上（包含 feed 导入的文档）。
  for (const document of documents) {
    if (document.status !== 'ready') continue;
    for (const chunk of await fetchChunks(browser, document.id)) {
      if (chunk.enabled) readyChunks.set(chunk.id, chunk);
    }
  }

  const failedSpec = DOC_SPECS.find((spec) => spec.key === 'failedImage');
  if (failedSpec === undefined) throw new Error('缺少 failedImage 规格');
  const failedDocument = exactlyOne(
    documents.filter((entry) => entry.title === failedSpec.title),
    `失败样本「${failedSpec.title}」`,
  );
  if (failedDocument.status !== 'failed') {
    verification(`失败样本「${failedSpec.title}」状态为 ${failedDocument.status}`);
  }
  if (failedDocument.currentVersionId !== null) {
    verification(`失败样本「${failedSpec.title}」不应有当前版本`);
  }
  const failedJobs = await listAll<Job>(browser, '/api/knowledge/jobs', {
    baseId: base.id,
    documentId: failedDocument.id,
  });
  const failedIngest = failedJobs.filter((job) => job.type === 'ingest');
  if (failedIngest.some((job) => job.status === 'succeeded')) {
    verification(`失败样本「${failedSpec.title}」存在成功摄取任务`);
  }
  const failedJob = exactlyOne(
    failedIngest.filter((job) => job.status === 'failed'),
    `失败样本「${failedSpec.title}」的 failed ingest 任务`,
  );
  if (failedJob.error === null || failedJob.error.trim() === '') {
    verification(`失败样本「${failedSpec.title}」的 failed 任务缺少错误信息`);
  }
  if (manifest.failedIngestion === null) verification('manifest 缺少失败摄取样本记录');
  if (manifest.failedIngestion.documentId !== failedDocument.id) {
    verification('manifest 失败样本 ID 与 API 不一致');
  }
  if (manifest.failedIngestion.jobId !== failedJob.id) {
    verification('manifest 失败样本任务 ID 与 API 不一致');
  }

  const manualPage = exactlyOne(
    (await listAll<WikiPage>(browser, `/api/knowledge/bases/${enc(base.id)}/wiki-pages`)).filter(
      (page) => page.slug === WIKI_MANUAL.slug,
    ),
    `Wiki 页面 ${WIKI_MANUAL.slug}`,
  );
  if (manualPage.title !== WIKI_MANUAL.title) {
    verification(`Wiki 页面 ${WIKI_MANUAL.slug} 标题为「${manualPage.title}」`);
  }
  if (manualPage.status !== 'published') {
    verification(`Wiki 页面 ${WIKI_MANUAL.slug} 状态为 ${manualPage.status}`);
  }
  const manualDetail = await fetchWikiPage(browser, manualPage.id);
  if (manualDetail.currentVersionId === null) {
    verification(`Wiki 页面 ${WIKI_MANUAL.slug} 没有当前发布版本`);
  }
  const manualVersion = required(
    manualDetail.versions.find((version) => version.id === manualDetail.currentVersionId),
    `Wiki 页面 ${WIKI_MANUAL.slug} 的当前版本不可读`,
  );
  if (manualVersion.generatedBy !== 'manual') {
    verification(`Wiki 页面 ${WIKI_MANUAL.slug} 当前版本不是人工发布`);
  }
  if (!manualVersion.markdown.includes(PO_NUMBER) || !manualVersion.markdown.includes(SUPPLIER)) {
    verification(`Wiki 页面 ${WIKI_MANUAL.slug} 的正文缺少固定业务内容`);
  }
  if (manifest.wiki.manual === null) verification('manifest 缺少人工 Wiki 页面记录');
  if (manifest.wiki.manual.pageId !== manualPage.id) {
    verification('manifest 人工 Wiki 页面 ID 与 API 不一致');
  }
  if (manifest.wiki.manual.versionId !== manualVersion.id) {
    verification('manifest 人工 Wiki 版本 ID 与 API 不一致');
  }

  const generatedPage = exactlyOne(
    (await listAll<WikiPage>(browser, `/api/knowledge/bases/${enc(base.id)}/wiki-pages`)).filter(
      (page) => page.slug === WIKI_GENERATED.slug,
    ),
    `Wiki 页面 ${WIKI_GENERATED.slug}`,
  );
  if (generatedPage.title !== WIKI_GENERATED.title) {
    verification(`Wiki 页面 ${WIKI_GENERATED.slug} 标题为「${generatedPage.title}」`);
  }
  const generatedDetail = await fetchWikiPage(browser, generatedPage.id);
  const generatedVersion = generatedDetail.versions.find(
    (version) => version.generatedBy === 'sdk' && version.sourceChunkIds.length > 0,
  );
  if (generatedVersion === undefined) {
    const recordedGap = findGap(manifest, 'wiki-generate');
    verification(
      `缺少真实生成且带引用的 Wiki 草稿${
        recordedGap === undefined ? '' : `（已记录 gap：${recordedGap.reason}）`
      }`,
    );
  }
  if (generatedVersion.markdown.trim() === '') {
    verification('生成 Wiki 草稿正文为空');
  }
  for (const chunkId of generatedVersion.sourceChunkIds) {
    if (!readyChunks.has(chunkId)) {
      verification(`生成 Wiki 引用 ${chunkId} 不属于任何 ready 文档的当前分块`);
    }
  }
  if (manifest.wiki.generated === null) verification('manifest 缺少生成 Wiki 记录');
  if (manifest.wiki.generated.pageId !== generatedPage.id) {
    verification('manifest 生成 Wiki 页面 ID 与 API 不一致');
  }
  if (manifest.wiki.generated.versionId !== generatedVersion.id) {
    verification('manifest 生成 Wiki 版本 ID 与 API 不一致');
  }

  const sources = await listAll<KnowledgeSource>(
    browser,
    `/api/knowledge/bases/${enc(base.id)}/sources`,
  );
  const source = exactlyOne(
    sources.filter((entry) => entry.name === SOURCE_NAME),
    `来源「${SOURCE_NAME}」`,
  );
  if (source.type !== 'feed') verification(`来源「${SOURCE_NAME}」类型为 ${source.type}`);
  if (source.status !== 'paused') verification(`来源「${SOURCE_NAME}」状态为 ${source.status}`);
  if (source.syncCron !== null) verification(`来源「${SOURCE_NAME}」syncCron 不是空`);
  if (source.ranges.length !== 1) {
    verification(`来源「${SOURCE_NAME}」范围数量为 ${source.ranges.length}`);
  }
  const range = source.ranges[0];
  if (range === undefined) verification(`来源「${SOURCE_NAME}」没有范围`);
  if (range.kind !== 'feed' || range.externalId !== FEED_URL || !range.enabled) {
    verification(`来源「${SOURCE_NAME}」范围不是启用中的 ${FEED_URL}`);
  }
  if (manifest.feedSource === null) verification('manifest 缺少来源记录');
  if (manifest.feedSource.id !== source.id) verification('manifest 来源 ID 与 API 不一致');
  if (manifest.feedSource.rangeIds.length !== 1 || manifest.feedSource.rangeIds[0] !== range.id) {
    verification('manifest 来源范围 ID 与 API 不一致');
  }

  const sync = manifest.feedSource.sync;
  if (sync === null || sync.jobId === null) {
    if (findGap(manifest, 'feed-sync') === undefined) {
      verification('来源没有同步记录，也没有声明 feed-sync gap');
    }
  } else {
    const job = await fetchJob(browser, sync.jobId);
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      verification(`来源同步任务 ${job.id} 仍未到终态（${job.status}）`);
    }
    if (sync.syncRunId !== null) {
      const run = await fetchSyncRun(browser, source.id, sync.syncRunId);
      if (!TERMINAL_JOB_STATUSES.has(run.status)) {
        verification(`来源同步运行 ${run.id} 仍未到终态（${run.status}）`);
      }
    }
    if (job.status !== 'succeeded' && findGap(manifest, 'feed-sync') === undefined) {
      verification(`来源同步任务 ${job.id} 状态为 ${job.status}，但没有声明 feed-sync gap`);
    }
  }

  for (const gap of manifest.gaps) {
    if (gap.reason.trim() === '') verification(`gap「${gap.key}」缺少原因`);
  }
}

test('dev data: 青禾知识库（摄取、失败样本、Wiki 发布/生成、RSS 来源）', {
  session: 'admin',
  timeout: BUILD_TIMEOUT_MS,
}, async ({ app, screen, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', BUILD_FLAG_REASON);

  // api() 通过 browser.evaluate 同源请求，必须先打开页面。
  await app.open('/knowledge');
  const origin = new URL(app.baseUrl ?? (await browser.url())).origin;
  let manifest = await loadManifest();
  if (manifest !== null) {
    let recordedOrigin: string;
    try {
      recordedOrigin = new URL(manifest.source.origin).origin;
    } catch {
      conflict(`manifest origin 不是合法 URL：${manifest.source.origin}`);
    }
    if (recordedOrigin !== origin) {
      conflict(`manifest 属于 ${recordedOrigin}，当前应用是 ${origin}`);
    }
  }
  if (manifest === null) manifest = newManifest(origin);
  assertManifestIdentity(manifest);
  manifest.source.origin = origin;
  manifest.status = 'in_progress';
  await saveManifest(manifest);

  const profile = await pickEmbeddingProfile(browser);
  let base = await findBase(browser);

  if (profile === null && base === null) {
    recordGap(
      manifest,
      'embedding-profile',
      '没有启用的 embedding profile，无法创建知识库；未伪造 ready',
      [],
    );
    manifest.status = 'blocked';
    await saveManifest(manifest);
    gapFailure('没有启用的 embedding profile');
  }

  if (manifest.base !== null && base === null) {
    conflict(`manifest 记录的知识库 ${manifest.base.id} 已不存在`);
  }
  if (base === null) {
    if (profile === null) gapFailure('没有启用的 embedding profile');
    await createBaseViaUi({ app, screen, browser, profile });
    base = required(
      await poll(
        `知识库 ${DATASET_ID} 出现`,
        () => findBase(browser),
        (value) => value !== null,
        STATE_POLL_TIMEOUT_MS,
      ),
      `知识库 ${DATASET_ID} 没有创建成功`,
    );
  } else if (manifest.base !== null && manifest.base.id !== base.id) {
    conflict(`manifest 知识库 ${manifest.base.id} 与同名知识库 ${base.id} 不一致`);
  }
  if (base.name !== BASE_NAME) conflict(`知识库名称为「${base.name}」`);
  if (base.description !== BASE_DESCRIPTION) conflict('知识库描述标记已被修改');
  if (base.status !== 'active') conflict(`知识库状态为 ${base.status}`);
  if (base.settings.wikiAutoUpdate) conflict('知识库 wikiAutoUpdate 已被开启');
  manifest.base = {
    id: base.id,
    slug: base.slug,
    name: base.name,
    description: base.description,
    status: base.status,
    embeddingProfileId: base.embeddingProfileId,
    rerankProfileId: base.rerankProfileId,
    settings: base.settings,
  };
  clearGap(manifest, 'embedding-profile');
  await saveManifest(manifest);

  const folderIds = await ensureFolders(manifest, browser, base.id);
  await saveManifest(manifest);
  await ensureTags(manifest, browser, base.id);
  await saveManifest(manifest);

  await ensureDocuments({ app, screen, browser, manifest, baseId: base.id, folderIds });
  await ensureFailedIngestion(manifest, browser, base.id);
  await ensureManualWiki({ app, screen, browser, manifest, baseId: base.id });
  await ensureGeneratedWiki({ browser, manifest, baseId: base.id });
  await ensureFeedSource({ browser, manifest, baseId: base.id });

  manifest.status = manifest.gaps.length === 0 ? 'ready' : 'partial';
  await saveManifest(manifest);
  await assertDataset(manifest, browser, origin);
});

test('dev data verify: 青禾知识库只读验收', {
  session: 'admin',
  timeout: VERIFY_TIMEOUT_MS,
  tags: ['verify'],
}, async ({ app, browser }) => {
  test.skip(process.env.E2E_DEV_DATA_VERIFY !== '1', VERIFY_FLAG_REASON);

  const manifest = await loadManifest();
  if (manifest === null) {
    verification(`缺少 knowledge manifest ${datasetPath('knowledge')}；请先执行 ${BUILD_COMMAND}`);
  }
  await app.open('/knowledge');
  const origin = new URL(app.baseUrl ?? (await browser.url())).origin;
  await assertDataset(manifest, browser, origin);
});
