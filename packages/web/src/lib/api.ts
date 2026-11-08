import type { KnowledgeBaseActivityItem } from '@agentport/contract/knowledge';
import type {
  AccessScope,
  Account,
  Agent,
  AgentAccess,
  AgentInput,
  AgentMember,
  AgentPatch,
  ApiTool,
  ApiToolInput,
  Attention,
  AuthMe,
  Channel,
  ChannelAgentBinding,
  ChannelDetail,
  ChannelListItem,
  ChannelMessage,
  ConnectorCatalogItem,
  ConversationBranch,
  ConversationSearchResponse,
  ConversationSummary,
  CreateMemoryReviewInput,
  EvalDataset,
  EvalDatasetImportResult,
  EvalRunExport,
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
  KnowledgeLocator,
  KnowledgeModelProfileSelection,
  KnowledgeSearchDiagnostics,
  KnowledgeSearchDirectAnswer,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
  KnowledgeSearchScores,
  KnowledgeSearchWarning,
  KnowledgeSourceInput,
  KnowledgeSyncItem,
  KnowledgeTarget,
  KnowledgeWikiLinksResult,
  KnowledgeWikiVersionDiff,
  MarketInstallInput,
  MarketSkill,
  MarketView,
  MemoryChange,
  MemoryFileContent,
  MemoryFileList,
  MemoryReview,
  MessageAttachment,
  NativePluginImportInput,
  NativePluginInstallInput,
  OpenUiToolResult,
  OutputContent,
  OutputFile,
  OutputList,
  OutputShare,
  OutputStyle,
  Overview,
  OverviewAgentRow,
  OverviewTimeseriesPoint,
  PermissionDefinition,
  PermissionGrant,
  PersonalMemory,
  PersonalOutputShareList,
  PersonalProfile,
  PersonalRunList,
  PersonalRunListQuery,
  PersonalSessionList,
  PersonalUsageSummary,
  Plugin,
  PluginInput,
  PluginWithAgentCount,
  PublicOutputShare,
  PublicQuestionResponse,
  PublicRunQuestion,
  RecentRun,
  Role,
  RoleMatrix,
  RoleMatrixInput,
  Rule,
  RunDetail,
  RunList,
  RunListItem,
  RunStatus,
  RunStep,
  RuntimeEnvironment,
  RuntimeEnvironmentInput,
  RuntimeEnvironmentPatch,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
  Schedule,
  ScheduleInput,
  SchedulePatch,
  Server,
  ServerInput,
  ServerTestResult,
  ChatRequest as SharedChatRequest,
  ConversationDetail as SharedConversationDetail,
  EvalComparison as SharedEvalComparison,
  EvalRunPage as SharedEvalRunPage,
  NativeInstalledPlugin as SharedNativeInstalledPlugin,
  Skill,
  SkillFile,
  SkillInput,
  SkillWithAgentCount,
  WorkspaceFiles,
  WritePersonalMemoryInput,
} from '@agentport/shared';
import type { ApiClient } from './orpc.js';
import { ApiError, authenticatedFetch, fetchResponse, responseApiError, rpc } from './orpc.js';

export { ApiError, errorMessage } from './orpc.js';

export type AgentFiles = WorkspaceFiles;

/** 插件 ZIP 导入结果：warnings 提示被忽略的官方组件，不阻断导入。 */
export interface PluginImportResult {
  plugin: Plugin;
  warnings: string[];
}

/** 官方 CLI 缓存里的插件；imported 表示同一来源已经加入平台插件库。 */
export interface NativeInstalledPlugin extends SharedNativeInstalledPlugin {
  imported: boolean;
}

export interface NativePlugins {
  installed: NativeInstalledPlugin[];
}

/** 原生安装/纳入结果；reused 表示库里已有同一来源，未覆盖原对象。 */
export type NativePluginImportResult = PluginImportResult & { reused: boolean };

export type { OverviewTimeseriesPoint };

/** 导入官方目录包后新建/复用的资源；正文在文件里，这里只回名称供提示。 */
export interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  createdSubAgents: string[];
  warnings: string[];
}

export interface SkillImportResult {
  skill: Skill;
  warnings: string[];
}

/** `.mcp.json` 导入结果；secretKeys 只有键名，值不会回显。 */
export interface McpImportResult {
  servers: Array<{
    id: string;
    name: string;
    kind: 'stdio' | 'http' | 'generated';
    secretKeys: string[];
  }>;
  warnings: string[];
}

export type Me = AuthMe;

type ApiOutput<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

export type AgentOptions = ApiOutput<ApiClient['agents']['options']>;
export type AgentSummary = ApiOutput<ApiClient['agents']['list']>[number];

export interface AccountPage {
  items: Account[];
  total: number;
}

export interface IdentityCandidate {
  businessId: string;
  name: string;
  accountActive: boolean;
}

export interface IdentityPage {
  items: IdentityCandidate[];
  total: number;
}

export interface PermissionCatalog {
  permissions: PermissionDefinition[];
  scopes: { id: AccessScope; label: string }[];
}

export interface AgentMemberList {
  ownerBusinessId: string;
  members: AgentMember[];
}

export interface CreateAccountInput {
  businessId: string;
  username: string;
  name: string;
  password: string;
  /** 历史业务 ID 必须显式恢复；普通新账户传 false。 */
  restore: boolean;
  roleIds?: string[];
}

export type {
  AccessScope,
  Account,
  AgentAccess,
  AgentMember,
  ConversationBranch,
  Overview,
  OverviewAgentRow,
  PermissionDefinition,
  PermissionGrant,
  RecentRun,
  Role,
  RoleMatrix,
  RoleMatrixInput,
  RunDetail,
  RunList,
  RunListItem,
  RunStatus,
  RunStep,
};

/** 个人偏好保存结果：多返回本次写入的变更 id，供页面提示。 */
export interface PersonalMemoryWriteResult extends PersonalMemory {
  changeId: string;
}

export interface MemoryChangeList {
  items: MemoryChange[];
}

export interface MemoryReviewQuery {
  agentId?: string;
  conversationId?: string;
  before?: string;
  limit?: number;
}

export interface MemoryReviewList {
  items: MemoryReview[];
}

export interface ChatAccepted {
  runId: string;
  conversationId: string;
  /** 仅本次带附件发送时返回元数据；字节只上行，响应里没有 base64 与宿主路径。 */
  attachments?: MessageAttachment[] | undefined;
}

/** 附件随消息一次性提交；字节只在这里出现，落库与回放只保留元数据。 */
export type ChatAttachmentInput = NonNullable<SharedChatRequest['attachments']>[number];

/** 发送契约来自 shared；本地别名让 Web 调用方只依赖 api 模块。 */
export type ChatRequest = SharedChatRequest;

export interface AgentVersionSummary {
  id: string;
  version: number;
  note: string | null;
  createdAt: string;
}

export interface AgentVersionDetail {
  version: number;
  snapshot: Agent;
  createdAt: string;
}

export type ApprovalRequestList = ApiOutput<ApiClient['runs']['approvals']>;
export type ApprovalRequest = ApprovalRequestList['items'][number];

/** 频道活动 run：只有 queued/running；状态来自 DB，不是 SSE 快照。 */
export interface ChannelActiveRun {
  runId: string;
  agentId: string;
  status: RunStatus;
  startedAt: string | null;
}

export type ChannelApproval = ApiOutput<ApiClient['channels']['approve']>;

interface ChannelMessageInput {
  body: string;
  clientMessageId?: string;
  mentions?: string[];
  mentionAll?: boolean;
}

export interface RunQuery {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
}

export type AuditEntry = ApiOutput<ApiClient['audit']['list']>['items'][number];
export type AuditStatus = AuditEntry['status'];

export interface AuditQuery {
  action?: string;
  status?: AuditStatus;
  target?: string;
  limit?: number;
  /** ISO 时间戳；与 beforeId 相互独立，由调用方自行选择。 */
  before?: string;
  /** 上一页最后一条的 id；同毫秒并列时用 id 继续翻页。 */
  beforeId?: string;
}

export interface AuditList {
  items: AuditEntry[];
}

export type Conversation = ConversationSummary;

export type ConversationDetail = SharedConversationDetail;

/** 会话消息分页：默认 50 条、上限 100；before 为上一页最早消息的 id。 */
export interface ConversationPageOptions {
  limit?: number;
  before?: string;
}

/** 全局历史搜索：空 q 按最近活动返回；before 是服务端下发的下一页游标。 */
export interface ConversationSearchOptions {
  q?: string;
  agentId?: string;
  limit?: number;
  before?: string;
}

export type EvalRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface EvalCase {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
  createdAt: string;
}

export interface EvalCaseInput {
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
}

export interface EvalRun {
  id: string;
  agentId: string;
  status: EvalRunStatus;
  total: number;
  passed: number;
  /** worker 崩溃时的原因；正常完成为 null。 */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type EvalRunPage = SharedEvalRunPage;

export interface EvalResult {
  /** 用例或运行被清理后置空，历史结果仍然保留。 */
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string | null;
}

export interface EvalRunDetail {
  evalRun: EvalRun;
  results: EvalResult[];
}

export type EvalComparison = SharedEvalComparison;

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

/** 后端只回 content/heading/enabled 可写；正文改动会清空向量并标记人工编辑。 */
export type { KnowledgeChunk };

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
export type {
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
};

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

export interface HealthMetrics {
  process: { uptimeSeconds: number; memoryRssBytes: number; bunVersion: string };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  } | null;
  db: { connected: boolean; pingMs: number | null; maxConnections: number | null };
  redis: { pingMs: number } | null;
}

export interface HealthLive {
  status: string;
}

export interface HealthReady {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  redis: 'ok' | 'error';
}

/** 健康端点在 /api 之外，且 503 也是有效结果；reachable 表示拿到了可解析的响应。 */
export interface HealthProbe<T> {
  reachable: boolean;
  httpStatus: number | null;
  body: T | null;
  error: string | null;
}

export async function probeHealth<T>(path: string): Promise<HealthProbe<T>> {
  try {
    const res = await fetch(path, { credentials: 'include' });
    const body = (await res.json().catch(() => null)) as T | null;
    return { reachable: true, httpStatus: res.status, body, error: null };
  } catch {
    return {
      reachable: false,
      httpStatus: null,
      body: null,
      error: '连不上 API 服务：进程未启动、端口未发布，或被反向代理拦截。',
    };
  }
}

function boolParam(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function clientOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function isFaqBatchBody(
  value: Record<string, unknown> | { results: KnowledgeFaqBatchResult['results'] },
): value is { results: KnowledgeFaqBatchResult['results'] } {
  return Array.isArray((value as { results?: unknown }).results);
}

async function nativeRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  responseType: 'json' | 'blob' | 'text' = 'json',
  onResponse?: (response: Response) => void,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) {
    headers['content-type'] =
      body instanceof Blob ? body.type || 'application/zip' : 'application/json';
  }
  const res = await authenticatedFetch(`/api${path}`, {
    method,
    ...(signal === undefined ? {} : { signal }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
  });
  if (!res.ok) throw await responseApiError(res);

  if (res.status === 204) return undefined as T;
  onResponse?.(res);
  if (responseType === 'text') return (await res.text()) as T;
  return (responseType === 'blob' ? await res.blob() : await res.json()) as T;
}

export interface OutputShareList {
  items: OutputShare[];
}

export interface PublicOutputShareContent {
  file: PublicOutputShare['file'];
  content: string;
}

/**
 * 公开分享只认 URL 片段里的 Bearer token，不带管理会话 cookie，也不触发登录跳转。
 * 无效、撤销与源文件删除都由服务端统一 404，这里原样交给页面显示单一无效状态。
 */
async function publicShareRequest<T>(
  id: string,
  token: string,
  suffix: string,
  responseType: 'json' | 'blob',
): Promise<T> {
  let res: Response;
  try {
    res = await fetchResponse(`/api/public/output-shares/${encodeURIComponent(id)}${suffix}`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new ApiError(0, '连不上分享服务，请检查网络后重试。');
  }
  if (!res.ok) throw await responseApiError(res);
  return (responseType === 'blob' ? await res.blob() : await res.json()) as T;
}

export const api = {
  me: (): Promise<AuthMe> => rpc.auth.me(),
  /** 改密成功后服务端撤销全部会话，调用方必须重新登录。 */
  changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
    rpc.auth.changePassword({ body: { currentPassword, newPassword } }),
  /** 指标端点不在 /api 下；不可用时返回 null，页面显示「不可用」。 */
  healthMetrics: async (): Promise<HealthMetrics | null> => {
    const probe = await probeHealth<HealthMetrics>('/health/metrics');
    return probe.reachable && probe.httpStatus === 200 ? probe.body : null;
  },
  healthLive: (): Promise<HealthProbe<HealthLive>> => probeHealth('/health/live'),
  healthReady: (): Promise<HealthProbe<HealthReady>> => probeHealth('/health/ready'),
  login: (username: string, password: string): Promise<{ ok: boolean }> =>
    rpc.auth.login({ body: { username, password } }),
  logout: (): Promise<{ ok: boolean }> => rpc.auth.logout(),

  accounts: (
    query: { q?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<AccountPage> => rpc.auth.accounts.list({ query }, clientOptions(signal)),
  createAccount: (input: CreateAccountInput): Promise<Account> =>
    rpc.auth.accounts.create({ body: input }),
  updateAccount: (
    businessId: string,
    input: { username?: string; name?: string },
  ): Promise<Account> => rpc.auth.accounts.update({ params: { businessId }, body: input }),
  setAccountStatus: (businessId: string, status: Account['status']): Promise<Account> =>
    rpc.auth.accounts.status({ params: { businessId }, body: { status } }),
  resetAccountPassword: (businessId: string, password: string): Promise<{ ok: true }> =>
    rpc.auth.accounts.password({ params: { businessId }, body: { password } }),
  deleteAccount: (businessId: string): Promise<{ ok: true }> =>
    rpc.auth.accounts.delete({ params: { businessId } }),
  setAccountRoles: (businessId: string, roleIds: string[]): Promise<{ ok: true }> =>
    rpc.auth.accounts.roles({ params: { businessId }, body: { roleIds } }),

  roles: (signal?: AbortSignal): Promise<RoleMatrix> =>
    rpc.auth.roles.list(undefined, clientOptions(signal)),
  permissions: (signal?: AbortSignal): Promise<PermissionCatalog> =>
    rpc.auth.permissions(undefined, clientOptions(signal)),
  saveRoles: (input: RoleMatrixInput): Promise<RoleMatrix> =>
    rpc.auth.roles.replace({ body: input }),

  identities: (
    query: { q?: string; limit?: number; offset?: number; agentId: string },
    signal?: AbortSignal,
  ): Promise<IdentityPage> => rpc.agents.identities({ query }, clientOptions(signal)),

  overview: (): Promise<Overview> => rpc.overview.snapshot({ query: {} }),
  overviewTimeseries: (days = 14): Promise<OverviewTimeseriesPoint[]> =>
    rpc.overview.timeseries({ query: { days } }),

  servers: (): Promise<Server[]> => rpc.servers.list(),
  connectorCatalog: (): Promise<ConnectorCatalogItem[]> => rpc.servers.catalog(),
  createServer: (input: ServerInput): Promise<Server> => rpc.servers.create({ body: input }),
  updateServer: (
    id: string,
    input: Partial<ServerInput>,
    expectedUpdatedAt?: string,
  ): Promise<Server> =>
    rpc.servers.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deleteServer: (id: string): Promise<void> => rpc.servers.delete({ params: { id } }),
  testServer: (id: string, runtimeEnvironmentId?: string | null): Promise<ServerTestResult> =>
    rpc.servers.test({
      params: { id },
      ...(runtimeEnvironmentId === undefined || runtimeEnvironmentId === null
        ? {}
        : { body: { runtimeEnvironmentId } }),
    }),

  runtimeEnvironments: (): Promise<RuntimeEnvironment[]> => rpc.runtimeEnvironments.list(),
  runtimeEnvironment: (id: string): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.detail({ params: { id } }),
  createRuntimeEnvironment: (input: RuntimeEnvironmentInput): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.create({ body: input }),
  updateRuntimeEnvironment: (
    id: string,
    patch: RuntimeEnvironmentPatch,
  ): Promise<RuntimeEnvironment> => rpc.runtimeEnvironments.update({ params: { id }, body: patch }),
  deleteRuntimeEnvironment: (id: string): Promise<void> =>
    rpc.runtimeEnvironments.remove({ params: { id } }),
  runtimeEnvironmentVersions: (id: string): Promise<RuntimeEnvironmentVersionSummary[]> =>
    rpc.runtimeEnvironments.versions({ params: { id } }),
  runtimeEnvironmentVersion: (id: string, versionId: string): Promise<RuntimeEnvironmentVersion> =>
    rpc.runtimeEnvironments.versionDetail({ params: { id, versionId } }),
  buildRuntimeEnvironment: (id: string): Promise<RuntimeEnvironmentVersion> =>
    rpc.runtimeEnvironments.build({ params: { id } }),
  publishRuntimeEnvironment: (id: string, versionId: string): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.publish({ params: { id }, body: { versionId } }),
  importMcpFile: (content: string): Promise<McpImportResult> =>
    rpc.servers.importFile({ body: { mcpJson: content } }),
  /**
   * wire 上掩码字段叫 maskedToken（rotate 的 token 是明文，两者不能同名）。
   * 这里映射回 `token`，页面把「掩码」和「刚轮换的明文」放进同一处渲染。
   */
  serverToken: async (id: string): Promise<{ token: string; endpoint: string }> => {
    const { maskedToken, endpoint } = await rpc.servers.token({ params: { id } });
    return { token: maskedToken, endpoint };
  },
  rotateServerToken: (id: string): Promise<{ token: string; endpoint: string }> =>
    rpc.servers.rotateToken({ params: { id } }),
  tools: (serverId: string): Promise<ApiTool[]> =>
    rpc.servers.tools.list({ params: { id: serverId } }),
  createTool: (serverId: string, input: ApiToolInput): Promise<ApiTool> =>
    rpc.servers.tools.create({ params: { id: serverId }, body: input }),
  deleteTool: (serverId: string, toolId: string): Promise<void> =>
    rpc.servers.tools.delete({ params: { id: serverId, toolId } }),
  /** 与 createTool 同字段，全部可选：编辑只提交改动的字段。 */
  updateTool: (
    serverId: string,
    toolId: string,
    patch: Partial<ApiToolInput> & { enabled?: boolean },
  ): Promise<ApiTool> =>
    rpc.servers.tools.update({ params: { id: serverId, toolId }, body: patch }),
  runApprovals: (runId: string): Promise<ApprovalRequestList> =>
    rpc.runs.approvals({ params: { id: runId } }),
  approveRun: (runId: string, serverId: string, toolName: string) =>
    rpc.runs.approve({ params: { id: runId }, body: { serverId, toolName } }),

  agents: (): Promise<AgentSummary[]> => rpc.agents.list({}),
  agent: (id: string, signal?: AbortSignal): Promise<Agent> =>
    rpc.agents.get({ params: { id } }, clientOptions(signal)),
  createAgent: (input: AgentInput): Promise<Agent> => rpc.agents.create({ body: input }),
  agentAccess: (id: string): Promise<AgentAccess> => rpc.agents.access({ params: { id } }),
  agentOptions: (): Promise<AgentOptions> => rpc.agents.options({}),
  agentMembers: (id: string): Promise<AgentMemberList> => rpc.agents.members({ params: { id } }),
  setAgentMember: (
    id: string,
    businessId: string,
    input: { canUse: boolean; canMaintain: boolean },
  ): Promise<AgentMember> => rpc.agents.setMember({ params: { id, businessId }, body: input }),
  deleteAgentMember: (id: string, businessId: string): Promise<{ ok: boolean }> =>
    rpc.agents.deleteMember({ params: { id, businessId } }),
  transferAgent: (id: string, ownerBusinessId: string): Promise<Agent> =>
    rpc.agents.transfer({ params: { id }, body: { ownerBusinessId } }),
  updateAgent: (
    id: string,
    input: AgentPatch,
    expectedUpdatedAt?: string,
  ): Promise<Agent | AgentSummary> =>
    rpc.agents.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  duplicateAgent: (id: string, input: { slug: string; name: string }): Promise<Agent> =>
    rpc.agents.duplicate({ params: { id }, body: input }),
  deleteAgent: (id: string): Promise<void> => rpc.agents.delete({ params: { id } }),
  agentFiles: (id: string): Promise<AgentFiles> => rpc.agents.files({ params: { id }, query: {} }),
  agentVersions: (id: string): Promise<AgentVersionSummary[]> =>
    rpc.agents.versions({ params: { id } }),
  agentMemory: (id: string): Promise<MemoryFileList> => rpc.agents.memory({ params: { id } }),
  /** 原生记忆目录 ZIP；只含 MEMORY.md 与主题 Markdown。 */
  agentMemoryDownloadUrl: (id: string): string => `/api/agents/${id}/memory/download`,
  agentMemoryVersions: (
    id: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> =>
    rpc.memory.agentFileVersions({ params: { id, name }, query: {} }, clientOptions(signal)),
  agentRuleVersions: (id: string, slug: string, signal?: AbortSignal): Promise<MemoryChangeList> =>
    rpc.memory.agentRuleVersions({ params: { id, slug }, query: {} }, clientOptions(signal)),
  agentRules: (id: string): Promise<Rule[]> => rpc.agents.rules({ params: { id } }),
  writeAgentRule: (
    id: string,
    slug: string,
    input: { content: string; globs: string },
  ): Promise<Rule> => rpc.agents.writeRule({ params: { id, slug }, body: input }),
  deleteAgentRule: (id: string, slug: string): Promise<void> =>
    rpc.agents.deleteRule({ params: { id, slug } }),
  agentOutputStyles: (id: string): Promise<OutputStyle[]> =>
    rpc.agents.outputStyles({ params: { id } }),
  writeAgentOutputStyle: (
    id: string,
    slug: string,
    input: { description: string; keepCodingInstructions: boolean; body: string },
  ): Promise<OutputStyle> => rpc.agents.writeOutputStyle({ params: { id, slug }, body: input }),
  unselectAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    rpc.agents.unselectOutputStyle({ params: { id, slug } }),
  deleteAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    rpc.agents.deleteOutputStyle({ params: { id, slug } }),
  agentMemoryFile: (id: string, name: string): Promise<MemoryFileContent> =>
    rpc.agents.memoryFile({ params: { id, name } }),
  writeAgentMemoryFile: (id: string, name: string, content: string): Promise<MemoryFileContent> =>
    rpc.agents.writeMemory({ params: { id, name }, body: { content } }),
  deleteAgentMemoryFile: (id: string, name: string): Promise<void> =>
    rpc.agents.deleteMemory({ params: { id, name } }),
  agentVersion: (id: string, version: number): Promise<AgentVersionDetail> =>
    rpc.agents.version({ params: { id, version } }),
  rollbackAgent: (id: string, version: number): Promise<Agent> =>
    rpc.agents.rollback({ params: { id }, body: { version } }),
  /** 官方目录包的 ZIP；错误仍是 Problem JSON。 */
  exportAgent: (
    id: string,
    signal?: AbortSignal,
    onWarnings?: (warnings: string[]) => void,
  ): Promise<Blob> =>
    nativeRequest(`/export/agents/${id}`, 'GET', undefined, signal, 'blob', (response) => {
      if (onWarnings === undefined) return;
      const raw = response.headers.get('x-package-warnings');
      if (raw === null) return;
      try {
        const parsed: unknown = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(parsed)) onWarnings(parsed.filter((item) => typeof item === 'string'));
      } catch {
        // 头部损坏不影响下载本身，忽略即可。
      }
    }),
  /** 显式传环境 id 时覆盖包内名称映射；省略则按包中名称匹配。 */
  importAgent: (
    file: Blob,
    signal?: AbortSignal,
    runtimeEnvironmentId?: string,
  ): Promise<AgentImportResult> =>
    nativeRequest(
      `/import/agents${
        runtimeEnvironmentId === undefined
          ? ''
          : `?runtimeEnvironmentId=${encodeURIComponent(runtimeEnvironmentId)}`
      }`,
      'POST',
      file,
      signal,
    ),
  importAgentFile: (agentMd: string): Promise<Pick<AgentImportResult, 'agent' | 'warnings'>> =>
    rpc.agents.importFile({ body: { agentMd } }),

  skills: (): Promise<SkillWithAgentCount[]> => rpc.skills.list({}),
  createSkill: (input: SkillInput): Promise<Skill> => rpc.skills.create({ body: input }),
  importSkillFile: (content: string): Promise<SkillImportResult> =>
    rpc.skills.importFile({ body: { skillMd: content } }),
  updateSkill: (
    id: string,
    input: Partial<SkillInput>,
    expectedUpdatedAt?: string,
  ): Promise<Skill> =>
    rpc.skills.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deleteSkill: (id: string): Promise<void> => rpc.skills.delete({ params: { id } }),

  plugins: (): Promise<PluginWithAgentCount[]> => rpc.plugins.list({}),
  plugin: (id: string): Promise<Plugin> => rpc.plugins.get({ params: { id } }),
  updatePlugin: (
    id: string,
    input: Partial<PluginInput>,
    expectedUpdatedAt?: string,
  ): Promise<Plugin> =>
    rpc.plugins.update({
      params: { id },
      body: {
        ...input,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      },
    }),
  deletePlugin: (id: string): Promise<void> => rpc.plugins.delete({ params: { id } }),
  importPlugin: (file: Blob, slug: string, signal?: AbortSignal): Promise<PluginImportResult> =>
    nativeRequest(`/plugins/import?slug=${encodeURIComponent(slug)}`, 'POST', file, signal),
  nativePlugins: (): Promise<NativePlugins> => rpc.plugins.native({}),
  installNativePlugin: async (input: NativePluginInstallInput): Promise<NativePluginImportResult> =>
    (await rpc.plugins.install({ body: input })).body,
  importNativePlugin: async (input: NativePluginImportInput): Promise<NativePluginImportResult> =>
    (await rpc.plugins.importNative({ body: input })).body,
  skillFiles: (id: string): Promise<SkillFile[]> => rpc.skills.files({ params: { id } }),
  writeSkillFile: (id: string, path: string, content: string): Promise<SkillFile> =>
    rpc.skills.writeFile({ params: { id, path }, body: { content } }),
  deleteSkillFile: (id: string, path: string): Promise<void> =>
    rpc.skills.deleteFile({ params: { id, path } }),

  marketSkills: (
    query: { view?: MarketView; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<MarketSkill[]> => rpc.market.list({ query }, clientOptions(signal)),
  installMarketSkill: (input: MarketInstallInput): Promise<SkillImportResult> =>
    rpc.market.install({ body: input }),

  renameConversation: (id: string, title: string): Promise<ConversationDetail['conversation']> =>
    rpc.chat.renameConversation({ params: { id }, body: { title } }),
  deleteConversation: (id: string): Promise<void> =>
    rpc.chat.deleteConversation({ params: { id } }),

  channels: (signal?: AbortSignal): Promise<ChannelListItem[]> =>
    rpc.channels.list({}, clientOptions(signal)),
  createChannel: (input: { name: string; description?: string | null }): Promise<Channel> =>
    rpc.channels.create({ body: input }),
  channel: (id: string, signal?: AbortSignal): Promise<ChannelDetail> =>
    rpc.channels.detail({ params: { id } }, clientOptions(signal)),
  channelMessages: (
    id: string,
    options: { after?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ChannelMessage[]> =>
    rpc.channels.messages({ params: { id }, query: options }, clientOptions(signal)),
  postChannelMessage: async (id: string, input: ChannelMessageInput): Promise<ChannelMessage> =>
    (await rpc.channels.postMessage({ params: { id }, body: input })).body,
  markChannelRead: (id: string, seq: number): Promise<{ lastReadSeq: number }> =>
    rpc.channels.markRead({ params: { id }, body: { seq } }),
  bindChannelAgent: (
    id: string,
    input: { agentId: string; autoWakeOnAll?: boolean },
  ): Promise<ChannelAgentBinding> => rpc.channels.addAgent({ params: { id }, body: input }),
  channelRuns: (id: string, signal?: AbortSignal): Promise<{ items: ChannelActiveRun[] }> =>
    rpc.channels.activeRuns({ params: { id }, query: { status: 'active' } }, clientOptions(signal)),
  channelApprovals: (id: string, signal?: AbortSignal): Promise<{ items: ChannelApproval[] }> =>
    rpc.channels.approvals({ params: { id } }, clientOptions(signal)),
  approveChannelApproval: (id: string, approvalId: string): Promise<ChannelApproval> =>
    rpc.channels.approve({ params: { id, approvalId } }),
  stopChannelRun: (id: string, runId: string): Promise<{ ok: boolean }> =>
    rpc.channels.stopRun({ params: { id, runId } }),

  conversations: (agentId?: string, signal?: AbortSignal): Promise<Conversation[]> =>
    rpc.chat.listConversations(
      { query: agentId === undefined ? {} : { agentId } },
      clientOptions(signal),
    ),
  searchConversations: (
    options: ConversationSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationSearchResponse> =>
    rpc.chat.searchConversations({ query: options }, clientOptions(signal)),
  conversation: (
    id: string,
    options: ConversationPageOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationDetail> =>
    rpc.chat.conversation({ params: { id }, query: options }, clientOptions(signal)),
  /** 会话成果按版本倒序分页；同一路径的多版由调用方分组，后端不做合并。 */
  outputs: (
    conversationId: string,
    options: { limit?: number; before?: string } = {},
    signal?: AbortSignal,
  ): Promise<OutputList> =>
    rpc.chat.listOutputs({ params: { id: conversationId }, query: options }, clientOptions(signal)),
  /** 文本预览只读已发布快照；超过后端上限时返回明确错误，由页面改为下载。 */
  outputContent: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<OutputContent> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/content?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      signal,
    ),
  /** 列表未覆盖的旧版先取真实元信息，再决定按文本还是图片预览，不猜类型。 */
  outputFile: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ file: OutputFile }> =>
    rpc.chat.output(
      { params: { id: conversationId, runId }, query: { path } },
      clientOptions(signal),
    ),
  /** 图片与 PDF 预览复用下载端点，保留统一 cookie 会话、401 跳转与 Problem 错误。 */
  outputBlob: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      signal,
      'blob',
    ),
  outputDownloadUrl: (conversationId: string, runId: string, path: string): string =>
    `/api/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
  /** 同一三元组的分享记录，含已撤销状态。 */
  outputShares: (
    conversationId: string,
    input: { runId: string; path: string },
    signal?: AbortSignal,
  ): Promise<OutputShareList> =>
    rpc.outputShares.list({ params: { id: conversationId }, query: input }, clientOptions(signal)),
  createOutputShare: (
    conversationId: string,
    input: { runId: string; path: string },
  ): Promise<OutputShare> =>
    rpc.outputShares.create({ params: { id: conversationId }, body: input }),
  revokeOutputShare: (id: string): Promise<void> => rpc.outputShares.revoke({ params: { id } }),
  publicOutputShare: (id: string, token: string): Promise<PublicOutputShare> =>
    publicShareRequest(id, token, '', 'json'),
  publicOutputShareContent: (id: string, token: string): Promise<PublicOutputShareContent> =>
    publicShareRequest(id, token, '/content', 'json'),
  publicOutputShareDownload: (id: string, token: string): Promise<Blob> =>
    publicShareRequest(id, token, '/download', 'blob'),
  branchConversation: (id: string, fromMessageId?: string): Promise<ConversationBranch> =>
    rpc.chat.branchConversation({
      params: { id },
      body: { ...(fromMessageId === undefined ? {} : { fromMessageId }) },
    }),

  /** 生成式 UI 的 Query/Mutation：工具目录由服务端授权，未授权会 403。 */
  callOpenUiTool: async (
    conversationId: string,
    toolName: string,
    input: { args: Record<string, unknown>; messageId: string; blockKey: string },
  ): Promise<OpenUiToolResult> =>
    (
      await rpc.chat.callOpenuiTool({
        params: { conversationId, toolName },
        body: input,
      })
    ).body,

  /** 会话级审批：202 返回的 approvalId 在这里批准；同一工具调用重试即执行。 */
  approveOpenUiTool: (
    conversationId: string,
    approvalId: string,
  ): Promise<{ approvalId: string; approvedAt: string | null }> =>
    rpc.chat.approveOpenuiTool({ params: { conversationId, approvalId } }),

  sendChat: async (input: ChatRequest): Promise<ChatAccepted> => {
    const result = await rpc.chat.startRun({ body: input });
    if (result.status === 202) return result.body;
    throw new ApiError(204, '该操作已在本地完成，不需要发起运行。');
  },
  /** 生成式 UI 的表单/绑定快照；按 block 合并，不覆盖同消息其他段。 */
  saveOpenUiState: (
    conversationId: string,
    messageId: string,
    input: { blockKey: string; state: Record<string, unknown> },
  ): Promise<{ version: number; blockKey: string }> =>
    rpc.chat.saveOpenuiState({ params: { conversationId, messageId }, body: input }),
  cancelRun: async (runId: string): Promise<void> => {
    await rpc.chat.cancelRun({ params: { runId } });
  },

  runs: (query: RunQuery = {}): Promise<RunList> => rpc.runs.list({ query }),
  exportRuns: (query: {
    agentId?: string;
    status?: RunStatus;
  }): Promise<{ format: string; exportedAt: string; items: RunListItem[] }> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return nativeRequest(`/runs/export${search}`);
  },
  run: (id: string, signal?: AbortSignal): Promise<RunDetail> =>
    rpc.runs.detail({ params: { id } }, clientOptions(signal)),
  runQuestions: (id: string): Promise<{ items: PublicRunQuestion[] }> =>
    rpc.runs.questions({ params: { id } }),
  respondToQuestion: (
    runId: string,
    requestId: string,
    response: PublicQuestionResponse,
  ): Promise<PublicRunQuestion> =>
    rpc.runs.respondToQuestion({ params: { id: runId, requestId }, body: response }),
  skillDraftFromRun: (runId: string): Promise<Skill> =>
    rpc.runs.skillDraft({ params: { id: runId } }),
  attention: (): Promise<Attention> => rpc.ops.attention(),
  schedules: (): Promise<Schedule[]> => rpc.ops.schedules.list(),
  createSchedule: (input: ScheduleInput): Promise<Schedule> =>
    rpc.ops.schedules.create({ body: input }),
  updateSchedule: (id: string, input: SchedulePatch): Promise<Schedule> =>
    rpc.ops.schedules.update({ params: { id }, body: input }),
  deleteSchedule: (id: string): Promise<void> => rpc.ops.schedules.remove({ params: { id } }),

  personalMemory: (): Promise<PersonalMemory> => rpc.memory.readPersonal(),
  updatePersonalProfile: (input: { name: string }): Promise<PersonalProfile> =>
    rpc.auth.profile({ body: input }),
  meSessions: (signal?: AbortSignal): Promise<PersonalSessionList> =>
    rpc.auth.sessions(undefined, clientOptions(signal)),
  revokeMeSession: (id: string): Promise<void> => rpc.auth.revokeSession({ params: { id } }),
  personalOutputShares: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<PersonalOutputShareList> =>
    rpc.personal.outputShares({ query }, clientOptions(signal)),
  revokePersonalOutputShare: (id: string): Promise<void> =>
    rpc.personal.revokeOutputShare({ params: { id } }),
  personalUsage: (days: number, signal?: AbortSignal): Promise<PersonalUsageSummary> =>
    rpc.personal.usage({ query: { days } }, clientOptions(signal)),
  personalRuns: (
    query: PersonalRunListQuery = { days: 30, limit: 50 },
    signal?: AbortSignal,
  ): Promise<PersonalRunList> => rpc.personal.runs({ query }, clientOptions(signal)),
  /** 回顾来源固定本人；只带专家筛选，不传全局会话列表。 */
  personalConversations: (
    query: { agentId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ConversationSummary[]> => rpc.personal.conversations({ query }, clientOptions(signal)),
  writePersonalMemory: (input: WritePersonalMemoryInput): Promise<PersonalMemoryWriteResult> =>
    rpc.memory.writePersonal({ body: input }),
  personalMemoryDownloadUrl: '/api/me/memory/download',
  personalMemoryVersions: (
    query: { before?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> => rpc.memory.personalVersions({ query }, clientOptions(signal)),
  rollbackMemoryChange: (id: string): Promise<MemoryChange> =>
    rpc.memory.rollback({ params: { id } }),
  memoryReviews: (query: MemoryReviewQuery = {}, signal?: AbortSignal): Promise<MemoryReviewList> =>
    rpc.memoryReviews.list({ query }, clientOptions(signal)),
  /** 幂等键随请求头提交；同一键重复提交返回同一个 runId。scope=own 约束来源会话必须是本人。 */
  createMemoryReview: (
    input: CreateMemoryReviewInput,
    idempotencyKey: string,
    scope?: 'own',
  ): Promise<{ runId: string }> =>
    rpc.memoryReviews.create(
      {
        query: { ...(scope === undefined ? {} : { scope }) },
        body: input,
      },
      { context: { idempotencyKey } },
    ),
  memoryReview: (runId: string, signal?: AbortSignal): Promise<MemoryReview> =>
    rpc.memoryReviews.detail({ params: { runId } }, clientOptions(signal)),
  applyMemoryReview: (runId: string): Promise<MemoryChange> =>
    rpc.memoryReviews.apply({ params: { runId } }),
  rejectMemoryReview: (runId: string): Promise<MemoryReview> =>
    rpc.memoryReviews.decide({ params: { runId }, body: { decision: 'rejected' } }),

  audit: (query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditList> =>
    rpc.audit.list({ query }, clientOptions(signal)),
  exportAudit: (
    query: AuditQuery = {},
  ): Promise<{ format: string; exportedAt: string; items: AuditEntry[] }> => {
    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.status) params.set('status', query.status);
    if (query.target) params.set('target', query.target);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return nativeRequest(`/audit/export${search}`);
  },

  evalCases: (agentId?: string): Promise<EvalCase[]> =>
    rpc.eval.cases.list({ query: agentId === undefined ? {} : { agentId } }),
  createEvalCase: (input: EvalCaseInput): Promise<EvalCase> =>
    rpc.eval.cases.create({ body: input }),
  updateEvalCase: (id: string, input: Partial<Omit<EvalCaseInput, 'agentId'>>): Promise<EvalCase> =>
    rpc.eval.cases.update({ params: { id }, body: input }),
  deleteEvalCase: (id: string): Promise<void> => rpc.eval.cases.remove({ params: { id } }),
  exportEvalDataset: (agentId: string): Promise<EvalDataset> =>
    nativeRequest(`/eval/cases/export?agentId=${encodeURIComponent(agentId)}`),
  importEvalDataset: (agentId: string, dataset: EvalDataset): Promise<EvalDatasetImportResult> =>
    rpc.eval.cases.import({ body: { agentId, dataset } }),

  evalRuns: (
    query: { agentId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EvalRunPage> => rpc.eval.runs.list({ query }, clientOptions(signal)),
  startEvalRun: (agentId: string): Promise<{ evalRunId: string }> =>
    rpc.eval.runs.create({ body: { agentId } }),
  cancelEvalRun: (id: string): Promise<{ ok: true }> => rpc.eval.runs.cancel({ params: { id } }),
  evalRun: (id: string): Promise<EvalRunDetail> => rpc.eval.runs.detail({ params: { id } }),
  exportEvalRun: (id: string): Promise<EvalRunExport> =>
    nativeRequest(`/eval/runs/${encodeURIComponent(id)}/export`),
  compareEvalRuns: (baseId: string, headId: string): Promise<EvalComparison> =>
    rpc.eval.runs.compare({ params: { id: baseId }, query: { head: headId } }),

  // ---- 知识库 -------------------------------------------------------------
  knowledgeBases: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeBase>> =>
    rpc.knowledge.bases.list({ query }, clientOptions(signal)),
  knowledgeBase: (id: string): Promise<KnowledgeBase> =>
    rpc.knowledge.bases.get({ params: { id } }),
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
