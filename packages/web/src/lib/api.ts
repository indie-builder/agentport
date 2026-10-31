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
  ConnectorCatalogItem,
  ConversationSearchResponse,
  ConversationSummary,
  CreateMemoryReviewInput,
  EvalDataset,
  EvalDatasetImportResult,
  EvalRunExport,
  KnowledgeBase,
  KnowledgeBaseSettings,
  KnowledgeDocument,
  KnowledgeJob,
  KnowledgeSearchHit,
  KnowledgeSourceInput,
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
  OverviewTimeseriesPoint,
  PermissionDefinition,
  PermissionGrant,
  PersonalMemory,
  Plugin,
  PluginInput,
  PluginWithAgentCount,
  Problem,
  PublicOutputShare,
  PublicQuestionResponse,
  PublicRunQuestion,
  ResolvedRuntimeEnvironment,
  Role,
  RoleMatrix,
  RoleMatrixInput,
  Rule,
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
import { loginPath } from './auth-redirect.js';

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
    kind: 'stdio' | 'http';
    secretKeys: string[];
  }>;
  warnings: string[];
}

export type Me = AuthMe;

/** 列表只拿业务摘要；role/slug 仅在服务端摘要附带时展示，不作为授权依据。 */
/** 绑定选择器只拿摘要；不含资源配置、密钥或正文。 */
export type AgentOptions = {
  servers: Array<{ id: string; name: string; kind: string }>;
  skills: Array<{ id: string; slug: string; name: string; description: string }>;
  plugins: Array<{ id: string; slug: string; name: string }>;
  runtimeEnvironments: Array<{ id: string; name: string; hasOnlineVersion: boolean }>;
};

export type AgentSummary = Pick<Agent, 'id' | 'name' | 'description' | 'enabled'> & {
  createdBy: string;
  ownerBusinessId: string;
  role?: string;
  slug?: string;
  parentId?: string | null;
  createdAt?: string;
  /** 以下字段仅在服务端摘要附带时可用；不作为授权或正文读取的依据。 */
  uiFormat?: 'markdown' | 'openui';
  serverIds?: string[];
  skillIds?: string[];
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
};

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
  PermissionDefinition,
  PermissionGrant,
  Role,
  RoleMatrix,
  RoleMatrixInput,
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
  attachments?: MessageAttachment[];
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

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export interface RecentRun {
  id: string;
  agentId: string;
  agentName: string | null;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: string | null;
  turns: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface RunListItem extends RecentRun {
  inputTokens: number | null;
  outputTokens: number | null;
  /** 入队时锁定的智能体配置版本号；未知/旧数据为 null。 */
  agentVersion?: number | null;
}

export type RunStep =
  | { kind: 'user'; at: string; text: string }
  | { kind: 'assistant'; at: string; text: string }
  | {
      kind: 'tool';
      at: string;
      name: string | null;
      toolUseId: string | null;
      content: unknown;
      /** 调用结果；与 content（参数）分开。 */
      result?: unknown;
      parentToolUseId: string | null;
      /** 原生提问的最终展示快照；只有提问工具行才带。 */
      question?: PublicRunQuestion;
    };

export interface RunDetail {
  run: RunListItem & {
    conversationId: string;
    sessionId: string | null;
    sandboxId: string | null;
    /** 容器实际使用的身份；尚未创建容器时为 null。 */
    runtimeEnvironment: ResolvedRuntimeEnvironment | null;
  };
  steps: RunStep[];
  conversation: { id: string; agentId: string; title: string };
}

/** 结构化审批请求；approvedAt 非空表示已批准，waiting 由服务端计算。 */
export interface ApprovalRequest {
  id: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  waiting: boolean;
}

export interface ApprovalRequestList {
  items: ApprovalRequest[];
}

export interface RunList {
  items: RunListItem[];
}

export interface RunQuery {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface OverviewAgentRow {
  agentId: string;
  name: string;
  slug: string;
  createdAt: string;
  enabled: boolean;
  lastRunStartTime: string | null;
  runCount: number;
  totalCost: number;
  errorRate: number;
  latencyP50: number | null;
  latencyP99: number | null;
  totalTokens: number;
}

export interface Overview {
  window: { days: number; since: string };
  counts: {
    servers: number;
    agents: number;
    runs: number;
    running: number;
    failed: number;
    tokens: number;
    costUsd: number;
    avgLatencyMs: number | null;
  };
  agents: OverviewAgentRow[];
  recent: RecentRun[];
}

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  status: AuditStatus;
  durationMs: number | null;
  requestId: string | null;
  /** 输入内容的 sha256 前缀，用于比对；服务端不返回原文。 */
  inputDigest: string | null;
  createdAt: string;
}

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

/** 知识库：wire 形状与后端 features/knowledge/routes.ts 一一对应。 */
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
export interface KnowledgeChunk {
  id: string;
  documentId: string;
  versionId: string;
  ordinal: number;
  kind: 'text' | 'table' | 'image';
  heading: string | null;
  content: string;
  enabled: boolean;
  editedByUser: boolean;
  pageFrom: number | null;
  pageTo: number | null;
  /** 图片 chunk 的定位/角色；普通 chunk 为空对象。 */
  metadata: Record<string, unknown>;
}

export interface KnowledgeTag {
  id: string;
  baseId: string;
  name: string;
  createdAt: string;
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeSearchHit[];
  /** 向量不可用、只能走关键词时 true。 */
  degraded: boolean;
}

export interface KnowledgeSourceRange {
  id: string;
  kind: 'wiki_space' | 'wiki_node' | 'drive_folder' | 'gitlab_project' | 'github_repo' | 'feed';
  externalId: string;
  ref: string | null;
  paths: string[];
  enabled: boolean;
}

export interface KnowledgeSource {
  id: string;
  baseId: string;
  type: 'feishu_wiki' | 'feishu_drive' | 'gitlab' | 'github' | 'feed';
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
  model: string;
  generatedBy: 'sdk' | 'manual';
  createdAt: string;
}

export interface KnowledgeVersionImage {
  name: string;
  sha256: string;
  mimeType: string;
  page: number;
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
  pageMap: Array<{ page: number; startOffset: number; endOffset: number }>;
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
  createdAt: string;
  updatedAt: string;
  versions: KnowledgeWikiVersion[];
  nextCursor: string | null;
}

export interface KnowledgeModelProfile {
  id: string;
  kind: 'embedding' | 'rerank';
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
  process: { uptimeSeconds: number; memoryRssBytes: number; nodeVersion: string };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  } | null;
  db: { total: number; idle: number; waiting: number };
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

export class ApiError extends Error {
  status: number;
  /** 服务端稳定错误码；网络层错误没有。 */
  code?: string;
  retryable: boolean;
  requestId?: string;

  constructor(
    status: number,
    message: string,
    options?: { code?: string; retryable?: boolean; requestId?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (options?.code !== undefined) this.code = options.code;
    this.retryable = options?.retryable ?? status >= 500;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }
}

/**
 * 面向用户的错误文案：说明发生了什么，并给出下一步。
 *
 * 优先级：服务端 message（业务异常已经写好了人话）→ 按 code 的固定文案 →
 * 按状态码的通用建议。按 code 而不是状态码分支：同样是 409，
 * CONFLICT（已存在）和 CONFLICT_STALE（被别人改过）下一步完全不同。
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return '请求没有完成，请检查网络后重试。';
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return '连不上 API 服务，请确认它已启动并检查网络后重试。';
    if (error.status === 401) return '登录已失效，请重新登录后再试。';
    if (error.status === 403) return '当前账号没有这个操作的权限，请联系管理员开通。';
    if (error.code === 'CONFLICT_STALE') return '数据已被其他操作修改，请刷新后重试。';
    if (error.code === 'RATE_LIMITED') return '操作太频繁了，请稍等片刻再试。';
    // 4xx 的 message 是给用户看的；5xx 服务端已替换成固定文案，这里给可执行建议。
    if (error.status < 500 && error.message) return error.message;
    if (error.status >= 500) return '服务端暂时无法完成请求，请稍后重试；持续出现时查看服务日志。';
  }
  if (/^HTTP \d{3}$/.test(error.message)) {
    return '请求没有完成，请稍后重试。';
  }
  return error.message;
}

async function request<T>(
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
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      ...(signal === undefined ? {} : { signal }),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
    });
  } catch (error) {
    // 取消不是连不上：保持 AbortError 原样，让 TanStack Query 静默丢弃这次请求。
    if (signal?.aborted || (error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new ApiError(0, '连不上 API 服务，请确认它已启动并检查网络后重试。');
  }

  // EventSource 无法自定义 header，前端统一靠 cookie 会话；失效时带着原目标回到登录页。
  if (res.status === 401 && !path.startsWith('/auth/') && location.pathname !== '/login') {
    const returnTo = `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
    location.assign(loginPath(returnTo, 'expired'));
    throw new ApiError(401, '登录已失效，请重新登录后再试。');
  }

  if (!res.ok) {
    // 错误响应始终是 Problem JSON，即使成功响应是二进制。
    const data = (await res.json().catch(() => null)) as Partial<Problem> | null;
    // 服务端返回 Problem；非 Problem（代理页面、旧版本）时退回状态码文案。
    throw new ApiError(res.status, data?.message ?? (res.statusText || `HTTP ${res.status}`), {
      ...(data?.code === undefined ? {} : { code: data.code }),
      ...(data?.retryable === undefined ? {} : { retryable: data.retryable }),
      ...(data?.requestId === undefined ? {} : { requestId: data.requestId }),
    });
  }

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
    res = await fetch(`/api/public/output-shares/${encodeURIComponent(id)}${suffix}`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, '连不上分享服务，请检查网络后重试。');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as Partial<Problem> | null;
    throw new ApiError(res.status, data?.message ?? (res.statusText || `HTTP ${res.status}`), {
      ...(data?.code === undefined ? {} : { code: data.code }),
      ...(data?.retryable === undefined ? {} : { retryable: data.retryable }),
      ...(data?.requestId === undefined ? {} : { requestId: data.requestId }),
    });
  }
  return (responseType === 'blob' ? await res.blob() : await res.json()) as T;
}

export const api = {
  me: (): Promise<AuthMe> => request<AuthMe>('/auth/me'),
  /** 改密成功后服务端撤销全部会话，调用方必须重新登录。 */
  changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
    request('/auth/change-password', 'POST', { currentPassword, newPassword }),
  /** 指标端点不在 /api 下；不可用时返回 null，页面显示「不可用」。 */
  healthMetrics: async (): Promise<HealthMetrics | null> => {
    const probe = await probeHealth<HealthMetrics>('/health/metrics');
    return probe.reachable && probe.httpStatus === 200 ? probe.body : null;
  },
  healthLive: (): Promise<HealthProbe<HealthLive>> => probeHealth('/health/live'),
  healthReady: (): Promise<HealthProbe<HealthReady>> => probeHealth('/health/ready'),
  login: (username: string, password: string): Promise<{ ok: boolean }> =>
    request('/auth/login', 'POST', { username, password }),
  logout: (): Promise<{ ok: boolean }> => request('/auth/logout', 'POST'),

  accounts: (
    query: { q?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<AccountPage> => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/accounts${search}`, 'GET', undefined, signal);
  },
  createAccount: (input: CreateAccountInput): Promise<Account> =>
    request('/accounts', 'POST', input),
  updateAccount: (
    businessId: string,
    input: { username?: string; name?: string },
  ): Promise<Account> => request(`/accounts/${encodeURIComponent(businessId)}`, 'PATCH', input),
  setAccountStatus: (businessId: string, status: Account['status']): Promise<Account> =>
    request(`/accounts/${encodeURIComponent(businessId)}/status`, 'PATCH', { status }),
  resetAccountPassword: (businessId: string, password: string): Promise<{ ok: true }> =>
    request(`/accounts/${encodeURIComponent(businessId)}/password`, 'POST', {
      password,
    }),
  deleteAccount: (businessId: string): Promise<{ ok: true }> =>
    request(`/accounts/${encodeURIComponent(businessId)}`, 'DELETE'),
  setAccountRoles: (businessId: string, roleIds: string[]): Promise<{ ok: true }> =>
    request(`/accounts/${encodeURIComponent(businessId)}/roles`, 'PUT', { roleIds }),

  roles: (signal?: AbortSignal): Promise<RoleMatrix> => request('/roles', 'GET', undefined, signal),
  permissions: (signal?: AbortSignal): Promise<PermissionCatalog> =>
    request('/permissions', 'GET', undefined, signal),
  saveRoles: (input: RoleMatrixInput): Promise<RoleMatrix> => request('/roles', 'PUT', input),

  identities: (
    query: { q?: string; limit?: number; offset?: number; agentId: string },
    signal?: AbortSignal,
  ): Promise<IdentityPage> => {
    const params = new URLSearchParams({ agentId: query.agentId });
    if (query.q) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    return request(`/identities?${params.toString()}`, 'GET', undefined, signal);
  },

  overview: (): Promise<Overview> => request('/overview'),
  overviewTimeseries: (days = 14): Promise<OverviewTimeseriesPoint[]> =>
    request(`/overview/timeseries?days=${days}`),

  servers: (): Promise<Server[]> => request('/servers'),
  connectorCatalog: (): Promise<ConnectorCatalogItem[]> => request('/connector-catalog'),
  createServer: (input: ServerInput): Promise<Server> => request('/servers', 'POST', input),
  updateServer: (
    id: string,
    input: Partial<ServerInput>,
    expectedUpdatedAt?: string,
  ): Promise<Server> =>
    request(`/servers/${id}`, 'PATCH', {
      ...input,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    }),
  deleteServer: (id: string): Promise<void> => request(`/servers/${id}`, 'DELETE'),
  testServer: (id: string, runtimeEnvironmentId?: string | null): Promise<ServerTestResult> =>
    request(
      `/servers/${id}/test`,
      'POST',
      runtimeEnvironmentId === undefined || runtimeEnvironmentId === null
        ? undefined
        : { runtimeEnvironmentId },
    ),

  runtimeEnvironments: (): Promise<RuntimeEnvironment[]> => request('/runtime-environments'),
  runtimeEnvironment: (id: string): Promise<RuntimeEnvironment> =>
    request(`/runtime-environments/${id}`),
  createRuntimeEnvironment: (input: RuntimeEnvironmentInput): Promise<RuntimeEnvironment> =>
    request('/runtime-environments', 'POST', input),
  updateRuntimeEnvironment: (
    id: string,
    patch: RuntimeEnvironmentPatch,
  ): Promise<RuntimeEnvironment> => request(`/runtime-environments/${id}`, 'PATCH', patch),
  deleteRuntimeEnvironment: (id: string): Promise<void> =>
    request(`/runtime-environments/${id}`, 'DELETE'),
  runtimeEnvironmentVersions: (id: string): Promise<RuntimeEnvironmentVersionSummary[]> =>
    request(`/runtime-environments/${id}/versions`),
  runtimeEnvironmentVersion: (id: string, versionId: string): Promise<RuntimeEnvironmentVersion> =>
    request(`/runtime-environments/${id}/versions/${versionId}`),
  buildRuntimeEnvironment: (id: string): Promise<RuntimeEnvironmentVersion> =>
    request(`/runtime-environments/${id}/versions`, 'POST', {}),
  publishRuntimeEnvironment: (id: string, versionId: string): Promise<RuntimeEnvironment> =>
    request(`/runtime-environments/${id}/online-version`, 'PUT', { versionId }),
  importMcpFile: (content: string): Promise<McpImportResult> =>
    request('/servers/import-file', 'POST', { mcpJson: content }),
  /**
   * wire 上掩码字段叫 maskedToken（rotate 的 token 是明文，两者不能同名）。
   * 这里映射回 `token`，页面把「掩码」和「刚轮换的明文」放进同一处渲染。
   */
  serverToken: async (id: string): Promise<{ token: string; endpoint: string }> => {
    const { maskedToken, endpoint } = await request<{ maskedToken: string; endpoint: string }>(
      `/servers/${id}/token`,
    );
    return { token: maskedToken, endpoint };
  },
  rotateServerToken: (id: string): Promise<{ token: string; endpoint: string }> =>
    request(`/servers/${id}/rotate-token`, 'POST'),
  tools: (serverId: string): Promise<ApiTool[]> => request(`/servers/${serverId}/tools`),
  createTool: (serverId: string, input: ApiToolInput): Promise<ApiTool> =>
    request(`/servers/${serverId}/tools`, 'POST', input),
  deleteTool: (serverId: string, toolId: string): Promise<void> =>
    request(`/servers/${serverId}/tools/${toolId}`, 'DELETE'),
  /** 与 createTool 同字段，全部可选：编辑只提交改动的字段。 */
  updateTool: (
    serverId: string,
    toolId: string,
    patch: Partial<ApiToolInput> & { enabled?: boolean },
  ): Promise<ApiTool> => request(`/servers/${serverId}/tools/${toolId}`, 'PATCH', patch),
  runApprovals: (runId: string): Promise<ApprovalRequestList> =>
    request(`/runs/${runId}/approvals`),
  approveRun: (
    runId: string,
    serverId: string,
    toolName: string,
  ): Promise<{ serverId: string; toolName: string; approvedAt: string; waiting: boolean }> =>
    request(`/runs/${runId}/approve`, 'POST', { serverId, toolName }),

  agents: (): Promise<AgentSummary[]> => request('/agents'),
  agent: (id: string, signal?: AbortSignal): Promise<Agent> =>
    request(`/agents/${id}`, 'GET', undefined, signal),
  createAgent: (input: AgentInput): Promise<Agent> => request('/agents', 'POST', input),
  agentAccess: (id: string): Promise<AgentAccess> => request(`/agents/${id}/access`),
  agentOptions: (): Promise<AgentOptions> => request('/agents/options'),
  agentMembers: (id: string): Promise<AgentMemberList> => request(`/agents/${id}/members`),
  setAgentMember: (
    id: string,
    businessId: string,
    input: { canUse: boolean; canMaintain: boolean },
  ): Promise<AgentMember> =>
    request(`/agents/${id}/members/${encodeURIComponent(businessId)}`, 'PUT', input),
  deleteAgentMember: (id: string, businessId: string): Promise<{ ok: true }> =>
    request(`/agents/${id}/members/${encodeURIComponent(businessId)}`, 'DELETE'),
  transferAgent: (id: string, ownerBusinessId: string): Promise<Agent> =>
    request(`/agents/${id}/transfer`, 'POST', { ownerBusinessId }),
  updateAgent: (id: string, input: AgentPatch, expectedUpdatedAt?: string): Promise<Agent> =>
    request(`/agents/${id}`, 'PATCH', {
      ...input,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    }),
  duplicateAgent: (id: string, input: { slug: string; name: string }): Promise<Agent> =>
    request(`/agents/${id}/duplicate`, 'POST', input),
  deleteAgent: (id: string): Promise<void> => request(`/agents/${id}`, 'DELETE'),
  agentFiles: (id: string): Promise<AgentFiles> => request(`/agents/${id}/files`),
  agentVersions: (id: string): Promise<AgentVersionSummary[]> => request(`/agents/${id}/versions`),
  agentMemory: (id: string): Promise<MemoryFileList> => request(`/agents/${id}/memory`),
  /** 原生记忆目录 ZIP；只含 MEMORY.md 与主题 Markdown。 */
  agentMemoryDownloadUrl: (id: string): string => `/api/agents/${id}/memory/download`,
  agentMemoryVersions: (
    id: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> =>
    request(`/agents/${id}/memory/${encodeURIComponent(name)}/versions`, 'GET', undefined, signal),
  agentRuleVersions: (id: string, slug: string, signal?: AbortSignal): Promise<MemoryChangeList> =>
    request(`/agents/${id}/rules/${encodeURIComponent(slug)}/versions`, 'GET', undefined, signal),
  agentRules: (id: string): Promise<Rule[]> => request(`/agents/${id}/rules`),
  writeAgentRule: (
    id: string,
    slug: string,
    input: { content: string; globs: string },
  ): Promise<Rule> => request(`/agents/${id}/rules/${encodeURIComponent(slug)}`, 'PUT', input),
  deleteAgentRule: (id: string, slug: string): Promise<void> =>
    request(`/agents/${id}/rules/${encodeURIComponent(slug)}`, 'DELETE'),
  agentOutputStyles: (id: string): Promise<OutputStyle[]> => request(`/agents/${id}/output-styles`),
  writeAgentOutputStyle: (
    id: string,
    slug: string,
    input: { description: string; keepCodingInstructions: boolean; body: string },
  ): Promise<OutputStyle> =>
    request(`/agents/${id}/output-styles/${encodeURIComponent(slug)}`, 'PUT', input),
  unselectAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    request(`/agents/${id}/output-styles/${encodeURIComponent(slug)}/unselect`, 'POST'),
  deleteAgentOutputStyle: (id: string, slug: string): Promise<void> =>
    request(`/agents/${id}/output-styles/${encodeURIComponent(slug)}`, 'DELETE'),
  agentMemoryFile: (id: string, name: string): Promise<MemoryFileContent> =>
    request(`/agents/${id}/memory/${encodeURIComponent(name)}`),
  writeAgentMemoryFile: (id: string, name: string, content: string): Promise<MemoryFileContent> =>
    request(`/agents/${id}/memory/${encodeURIComponent(name)}`, 'PUT', { content }),
  deleteAgentMemoryFile: (id: string, name: string): Promise<void> =>
    request(`/agents/${id}/memory/${encodeURIComponent(name)}`, 'DELETE'),
  agentVersion: (id: string, version: number): Promise<AgentVersionDetail> =>
    request(`/agents/${id}/versions/${version}`),
  rollbackAgent: (id: string, version: number): Promise<Agent> =>
    request(`/agents/${id}/rollback`, 'POST', { version }),
  /** 官方目录包的 ZIP；错误仍是 Problem JSON。 */
  exportAgent: (
    id: string,
    signal?: AbortSignal,
    onWarnings?: (warnings: string[]) => void,
  ): Promise<Blob> =>
    request(`/export/agents/${id}`, 'GET', undefined, signal, 'blob', (response) => {
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
    request(
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
    request('/agents/import-file', 'POST', { agentMd }),

  skills: (): Promise<SkillWithAgentCount[]> => request('/skills'),
  createSkill: (input: SkillInput): Promise<Skill> => request('/skills', 'POST', input),
  importSkillFile: (content: string): Promise<SkillImportResult> =>
    request('/skills/import', 'POST', { skillMd: content }),
  updateSkill: (
    id: string,
    input: Partial<SkillInput>,
    expectedUpdatedAt?: string,
  ): Promise<Skill> =>
    request(`/skills/${id}`, 'PATCH', {
      ...input,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    }),
  deleteSkill: (id: string): Promise<void> => request(`/skills/${id}`, 'DELETE'),

  plugins: (): Promise<PluginWithAgentCount[]> => request('/plugins'),
  plugin: (id: string): Promise<Plugin> => request(`/plugins/${id}`),
  updatePlugin: (
    id: string,
    input: Partial<PluginInput>,
    expectedUpdatedAt?: string,
  ): Promise<Plugin> =>
    request(`/plugins/${id}`, 'PATCH', {
      ...input,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    }),
  deletePlugin: (id: string): Promise<void> => request(`/plugins/${id}`, 'DELETE'),
  importPlugin: (file: Blob, slug: string, signal?: AbortSignal): Promise<PluginImportResult> =>
    request(`/plugins/import?slug=${encodeURIComponent(slug)}`, 'POST', file, signal),
  nativePlugins: (): Promise<NativePlugins> => request('/plugins/native'),
  installNativePlugin: (input: NativePluginInstallInput): Promise<NativePluginImportResult> =>
    request('/plugins/install', 'POST', input),
  importNativePlugin: (input: NativePluginImportInput): Promise<NativePluginImportResult> =>
    request('/plugins/native/import', 'POST', input),
  skillFiles: (id: string): Promise<SkillFile[]> => request(`/skills/${id}/files`),
  writeSkillFile: (id: string, path: string, content: string): Promise<SkillFile> =>
    request(`/skills/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}`, 'PUT', {
      content,
    }),
  deleteSkillFile: (id: string, path: string): Promise<void> =>
    request(`/skills/${id}/files/${path.split('/').map(encodeURIComponent).join('/')}`, 'DELETE'),

  marketSkills: (
    query: { view?: MarketView; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<MarketSkill[]> => {
    const params = new URLSearchParams();
    if (query.view) params.set('view', query.view);
    if (query.q) params.set('q', query.q);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/market/skills${search}`, 'GET', undefined, signal);
  },
  installMarketSkill: (input: MarketInstallInput): Promise<SkillImportResult> =>
    request('/market/skills/install', 'POST', input),

  renameConversation: (id: string, title: string): Promise<ConversationDetail['conversation']> =>
    request(`/conversations/${id}`, 'PATCH', { title }),
  deleteConversation: (id: string): Promise<void> => request(`/conversations/${id}`, 'DELETE'),

  conversations: (agentId?: string, signal?: AbortSignal): Promise<Conversation[]> => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return request(`/conversations${query}`, 'GET', undefined, signal);
  },
  searchConversations: (
    options: ConversationSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationSearchResponse> => {
    const params = new URLSearchParams();
    if (options.q !== undefined) params.set('q', options.q);
    if (options.agentId !== undefined) params.set('agentId', options.agentId);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.before !== undefined) params.set('before', options.before);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/conversations/search${query}`, 'GET', undefined, signal);
  },
  conversation: (
    id: string,
    options: ConversationPageOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationDetail> => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.before !== undefined) params.set('before', options.before);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/conversations/${id}${query}`, 'GET', undefined, signal);
  },
  /** 会话成果按版本倒序分页；同一路径的多版由调用方分组，后端不做合并。 */
  outputs: (
    conversationId: string,
    options: { limit?: number; before?: string } = {},
    signal?: AbortSignal,
  ): Promise<OutputList> => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.before !== undefined) params.set('before', options.before);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/conversations/${conversationId}/outputs${query}`, 'GET', undefined, signal);
  },
  /** 文本预览只读已发布快照；超过后端上限时返回明确错误，由页面改为下载。 */
  outputContent: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<OutputContent> =>
    request(
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
    request(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      signal,
    ),
  /** 图片与 PDF 预览复用下载端点，保留统一 cookie 会话、401 跳转与 Problem 错误。 */
  outputBlob: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> =>
    request(
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
  ): Promise<OutputShareList> => {
    const params = new URLSearchParams({ runId: input.runId, path: input.path });
    return request(
      `/conversations/${conversationId}/output-shares?${params.toString()}`,
      'GET',
      undefined,
      signal,
    );
  },
  createOutputShare: (
    conversationId: string,
    input: { runId: string; path: string },
  ): Promise<OutputShare> =>
    request(`/conversations/${conversationId}/output-shares`, 'POST', input),
  revokeOutputShare: (id: string): Promise<void> => request(`/output-shares/${id}`, 'DELETE'),
  publicOutputShare: (id: string, token: string): Promise<PublicOutputShare> =>
    publicShareRequest(id, token, '', 'json'),
  publicOutputShareContent: (id: string, token: string): Promise<PublicOutputShareContent> =>
    publicShareRequest(id, token, '/content', 'json'),
  publicOutputShareDownload: (id: string, token: string): Promise<Blob> =>
    publicShareRequest(id, token, '/download', 'blob'),
  branchConversation: (id: string, fromMessageId?: string): Promise<{ id: string }> =>
    request(`/conversations/${id}/branch`, 'POST', {
      ...(fromMessageId === undefined ? {} : { fromMessageId }),
    }),

  /** 生成式 UI 的 Query/Mutation：工具目录由服务端授权，未授权会 403。 */
  callOpenUiTool: (
    conversationId: string,
    toolName: string,
    input: { args: Record<string, unknown>; messageId: string; blockKey: string },
  ): Promise<OpenUiToolResult> =>
    request(`/chat/${conversationId}/openui/tools/${encodeURIComponent(toolName)}`, 'POST', input),

  /** 会话级审批：202 返回的 approvalId 在这里批准；同一工具调用重试即执行。 */
  approveOpenUiTool: (
    conversationId: string,
    approvalId: string,
  ): Promise<{ approvalId: string; approvedAt: string | null }> =>
    request(
      `/chat/${conversationId}/openui/approvals/${encodeURIComponent(approvalId)}/approve`,
      'POST',
    ),

  sendChat: (input: ChatRequest): Promise<ChatAccepted> => request('/chat', 'POST', input),
  /** 生成式 UI 的表单/绑定快照；按 block 合并，不覆盖同消息其他段。 */
  saveOpenUiState: (
    conversationId: string,
    messageId: string,
    input: { blockKey: string; state: Record<string, unknown> },
  ): Promise<{ version: number; blockKey: string }> =>
    request(`/conversations/${conversationId}/messages/${messageId}/openui-state`, 'PUT', input),
  cancelRun: (runId: string): Promise<void> => request(`/chat/${runId}/cancel`, 'POST'),

  runs: (query: RunQuery = {}): Promise<RunList> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request<RunList>(`/runs${search}`);
  },
  exportRuns: (query: {
    agentId?: string;
    status?: RunStatus;
  }): Promise<{ format: string; exportedAt: string; items: RunListItem[] }> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/runs/export${search}`);
  },
  run: (id: string, signal?: AbortSignal): Promise<RunDetail> =>
    request(`/runs/${id}`, 'GET', undefined, signal),
  runQuestions: (id: string): Promise<{ items: PublicRunQuestion[] }> =>
    request(`/runs/${id}/questions`),
  respondToQuestion: (
    runId: string,
    requestId: string,
    response: PublicQuestionResponse,
  ): Promise<PublicRunQuestion> =>
    request(`/runs/${runId}/questions/${encodeURIComponent(requestId)}/response`, 'POST', response),
  skillDraftFromRun: (runId: string): Promise<Skill> =>
    request(`/runs/${runId}/skill-draft`, 'POST'),
  attention: (): Promise<Attention> => request('/attention'),
  schedules: (): Promise<Schedule[]> => request('/schedules'),
  createSchedule: (input: ScheduleInput): Promise<Schedule> => request('/schedules', 'POST', input),
  updateSchedule: (id: string, input: SchedulePatch): Promise<Schedule> =>
    request(`/schedules/${id}`, 'PATCH', input),
  deleteSchedule: (id: string): Promise<void> => request(`/schedules/${id}`, 'DELETE'),

  personalMemory: (): Promise<PersonalMemory> => request('/me/memory'),
  writePersonalMemory: (input: WritePersonalMemoryInput): Promise<PersonalMemoryWriteResult> =>
    request('/me/memory', 'PUT', input),
  personalMemoryDownloadUrl: '/api/me/memory/download',
  personalMemoryVersions: (
    query: { before?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> => {
    const params = new URLSearchParams();
    if (query.before !== undefined) params.set('before', query.before);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/me/memory/versions${search}`, 'GET', undefined, signal);
  },
  rollbackMemoryChange: (id: string): Promise<MemoryChange> =>
    request(`/memory/changes/${encodeURIComponent(id)}/rollback`, 'POST'),
  memoryReviews: (
    query: MemoryReviewQuery = {},
    signal?: AbortSignal,
  ): Promise<MemoryReviewList> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.conversationId) params.set('conversationId', query.conversationId);
    if (query.before) params.set('before', query.before);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/memory-reviews${search}`, 'GET', undefined, signal);
  },
  memoryReview: (runId: string, signal?: AbortSignal): Promise<MemoryReview> =>
    request(`/memory-reviews/${encodeURIComponent(runId)}`, 'GET', undefined, signal),
  /** 幂等键随请求头提交；同一键重复提交返回同一个 runId。 */
  createMemoryReview: (
    input: CreateMemoryReviewInput,
    idempotencyKey: string,
  ): Promise<{ runId: string }> =>
    request('/memory-reviews', 'POST', input, undefined, 'json', undefined, {
      'idempotency-key': idempotencyKey,
    }),
  applyMemoryReview: (runId: string): Promise<MemoryChange> =>
    request(`/memory-reviews/${encodeURIComponent(runId)}/apply`, 'POST'),
  rejectMemoryReview: (runId: string): Promise<MemoryReview> =>
    request(`/memory-reviews/${encodeURIComponent(runId)}`, 'PATCH', { decision: 'rejected' }),

  audit: (query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditList> => {
    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.status) params.set('status', query.status);
    if (query.target) params.set('target', query.target);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    if (query.beforeId) params.set('beforeId', query.beforeId);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request<AuditList>(`/audit${search}`, 'GET', undefined, signal);
  },
  exportAudit: (
    query: AuditQuery = {},
  ): Promise<{ format: string; exportedAt: string; items: AuditEntry[] }> => {
    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.status) params.set('status', query.status);
    if (query.target) params.set('target', query.target);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/audit/export${search}`);
  },

  evalCases: (agentId?: string): Promise<EvalCase[]> => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return request<EvalCase[]>(`/eval/cases${query}`);
  },
  createEvalCase: (input: EvalCaseInput): Promise<EvalCase> =>
    request('/eval/cases', 'POST', input),
  updateEvalCase: (id: string, input: Partial<Omit<EvalCaseInput, 'agentId'>>): Promise<EvalCase> =>
    request(`/eval/cases/${id}`, 'PATCH', input),
  deleteEvalCase: (id: string): Promise<void> => request(`/eval/cases/${id}`, 'DELETE'),
  exportEvalDataset: (agentId: string): Promise<EvalDataset> =>
    request(`/eval/cases/export?agentId=${encodeURIComponent(agentId)}`),
  importEvalDataset: (agentId: string, dataset: EvalDataset): Promise<EvalDatasetImportResult> =>
    request('/eval/cases/import', 'POST', { agentId, dataset }),

  evalRuns: (
    query: { agentId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EvalRunPage> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/eval/runs${search}`, 'GET', undefined, signal);
  },
  startEvalRun: (agentId: string): Promise<{ evalRunId: string }> =>
    request('/eval/runs', 'POST', { agentId }),
  cancelEvalRun: (id: string): Promise<{ ok: true }> => request(`/eval/runs/${id}/cancel`, 'POST'),
  evalRun: (id: string): Promise<EvalRunDetail> => request(`/eval/runs/${id}`),
  exportEvalRun: (id: string): Promise<EvalRunExport> =>
    request(`/eval/runs/${encodeURIComponent(id)}/export`),
  compareEvalRuns: (baseId: string, headId: string): Promise<EvalComparison> =>
    request(`/eval/runs/${baseId}/compare?head=${encodeURIComponent(headId)}`),

  // ---- 知识库 -------------------------------------------------------------
  knowledgeBases: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeBase>> => {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/knowledge/bases${search}`, 'GET', undefined, signal);
  },
  knowledgeBase: (id: string): Promise<KnowledgeBase> => request(`/knowledge/bases/${id}`),
  createKnowledgeBase: (input: KnowledgeBaseInput): Promise<KnowledgeBase> =>
    request('/knowledge/bases', 'POST', input),
  updateKnowledgeBase: (id: string, patch: KnowledgeBasePatch): Promise<KnowledgeBase> =>
    request(`/knowledge/bases/${id}`, 'PATCH', patch),
  deleteKnowledgeBase: (id: string): Promise<void> => request(`/knowledge/bases/${id}`, 'DELETE'),

  knowledgeFolders: (baseId: string): Promise<KnowledgeFolder[]> =>
    request(`/knowledge/bases/${baseId}/folders`),
  createKnowledgeFolder: (
    baseId: string,
    input: { parentId: string | null; name: string },
  ): Promise<KnowledgeFolder> => request(`/knowledge/bases/${baseId}/folders`, 'POST', input),
  updateKnowledgeFolder: (
    folderId: string,
    patch: { name?: string; parentId?: string | null },
  ): Promise<KnowledgeFolder> => request(`/knowledge/folders/${folderId}`, 'PATCH', patch),
  deleteKnowledgeFolder: (folderId: string): Promise<void> =>
    request(`/knowledge/folders/${folderId}`, 'DELETE'),
  knowledgeTags: (baseId: string): Promise<KnowledgeTag[]> =>
    request(`/knowledge/bases/${baseId}/tags`),
  createKnowledgeTag: (baseId: string, name: string): Promise<KnowledgeTag> =>
    request(`/knowledge/bases/${baseId}/tags`, 'POST', { name }),
  deleteKnowledgeTag: (tagId: string): Promise<void> =>
    request(`/knowledge/tags/${tagId}`, 'DELETE'),

  knowledgeDocuments: (
    baseId: string,
    query: { folderId?: string; tag?: string; status?: string; q?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<KnowledgePage<KnowledgeDocument>> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/knowledge/bases/${baseId}/documents${search}`, 'GET', undefined, signal);
  },
  uploadKnowledgeDocument: (
    baseId: string,
    input: {
      filename: string;
      mimeType: string;
      dataBase64: string;
      folderId: string | null;
      /** 目录上传时把相对路径放进标题，列表里能看出原目录。 */
      title?: string;
    },
  ): Promise<{ documentId: string; jobId: string }> =>
    request(`/knowledge/bases/${baseId}/documents/upload`, 'PUT', input),
  createKnowledgeManualDocument: (
    baseId: string,
    input: { title: string; content: string; folderId: string | null; tags: string[] },
  ): Promise<{ documentId: string; jobId: string }> =>
    request(`/knowledge/bases/${baseId}/documents/manual`, 'POST', input),
  importKnowledgeUrl: (
    baseId: string,
    input: { url: string; folderId: string | null },
  ): Promise<{ documentId: string; jobId: string }> =>
    request(`/knowledge/bases/${baseId}/documents/url`, 'POST', input),
  updateKnowledgeDocument: (
    documentId: string,
    patch: {
      title?: string;
      folderId?: string | null;
      status?: 'ready' | 'disabled';
      tags?: string[];
    },
  ): Promise<KnowledgeDocument> => request(`/knowledge/documents/${documentId}`, 'PATCH', patch),
  deleteKnowledgeDocument: (documentId: string): Promise<void> =>
    request(`/knowledge/documents/${documentId}`, 'DELETE'),
  reprocessKnowledgeDocument: (
    documentId: string,
    confirmOverwriteManualChunks = false,
  ): Promise<{ jobId: string }> =>
    request(`/knowledge/documents/${documentId}/reprocess`, 'POST', {
      confirmOverwriteManualChunks,
    }),

  knowledgeChunks: (
    documentId: string,
    versionId: string | undefined,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<KnowledgePage<KnowledgeChunk>> => {
    const params = new URLSearchParams();
    if (versionId) params.set('versionId', versionId);
    if (cursor) params.set('cursor', cursor);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request(`/knowledge/documents/${documentId}/chunks${search}`, 'GET', undefined, signal);
  },
  updateKnowledgeChunk: (
    chunkId: string,
    patch: { content?: string; heading?: string | null; enabled?: boolean },
  ): Promise<KnowledgeChunk> => request(`/knowledge/chunks/${chunkId}`, 'PATCH', patch),
  deleteKnowledgeChunk: (chunkId: string): Promise<void> =>
    request(`/knowledge/chunks/${chunkId}`, 'DELETE'),
  /** 解析正文是 text/markdown，不是 JSON；原件走 content 端点直接下载。 */
  knowledgeMarkdown: (versionId: string, signal?: AbortSignal): Promise<string> =>
    request(`/knowledge/versions/${versionId}/markdown`, 'GET', undefined, signal, 'text'),
  knowledgeOriginalUrl: (versionId: string): string =>
    `/api/knowledge/versions/${versionId}/content`,
  knowledgeVersionDetails: (
    versionId: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeVersionDetails> =>
    request(`/knowledge/versions/${versionId}/details`, 'GET', undefined, signal),
  /** 图片按版本元数据白名单读取，直接走鉴权端点，不代理也不抓远程。 */
  knowledgeVersionImageUrl: (versionId: string, name: string): string =>
    `/api/knowledge/versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(name)}`,

  knowledgeSearch: (
    baseId: string,
    q: string,
    limit = 10,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResponse> => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return request(
      `/knowledge/bases/${baseId}/search?${params.toString()}`,
      'GET',
      undefined,
      signal,
    );
  },

  knowledgeJobs: (baseId: string): Promise<KnowledgePage<KnowledgeJob>> =>
    request(`/knowledge/jobs?baseId=${encodeURIComponent(baseId)}`),
  knowledgeJob: (jobId: string): Promise<KnowledgeJob> => request(`/knowledge/jobs/${jobId}`),
  retryKnowledgeJob: (jobId: string): Promise<{ jobId: string }> =>
    request(`/knowledge/jobs/${jobId}/retry`, 'POST'),
  cancelKnowledgeJob: (jobId: string): Promise<KnowledgeJob> =>
    request(`/knowledge/jobs/${jobId}/cancel`, 'POST'),

  knowledgeSources: (baseId: string, cursor?: string): Promise<KnowledgePage<KnowledgeSource>> => {
    const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request(`/knowledge/bases/${baseId}/sources${search}`);
  },
  createKnowledgeSource: (baseId: string, input: KnowledgeSourceInput): Promise<KnowledgeSource> =>
    request(`/knowledge/bases/${baseId}/sources`, 'POST', input),
  updateKnowledgeSource: (
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
  ): Promise<KnowledgeSource> => request(`/knowledge/sources/${sourceId}`, 'PATCH', patch),
  deleteKnowledgeSource: (sourceId: string, documents: 'keep' | 'delete' = 'keep'): Promise<void> =>
    request(`/knowledge/sources/${sourceId}?documents=${documents}`, 'DELETE'),
  testKnowledgeSource: (sourceId: string): Promise<{ ok: boolean; issues: string[] }> =>
    request(`/knowledge/sources/${sourceId}/test`, 'POST'),
  syncKnowledgeSource: (sourceId: string): Promise<{ jobId: string; syncRunId: string }> =>
    request(`/knowledge/sources/${sourceId}/sync`, 'POST'),
  knowledgeSourceRuns: (sourceId: string): Promise<KnowledgePage<KnowledgeSyncRun>> =>
    request(`/knowledge/sources/${sourceId}/runs`),

  knowledgeWikiPages: (
    baseId: string,
    cursor?: string,
  ): Promise<KnowledgePage<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>>> => {
    const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request(`/knowledge/bases/${baseId}/wiki-pages${search}`);
  },
  knowledgeWikiPage: (pageId: string): Promise<KnowledgeWikiPageDetail> =>
    request(`/knowledge/wiki-pages/${pageId}`),
  knowledgeWikiVersions: (
    pageId: string,
    cursor?: string,
  ): Promise<KnowledgePage<KnowledgeWikiVersion>> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    return request(
      `/knowledge/wiki-pages/${pageId}/versions${params.size > 0 ? `?${params.toString()}` : ''}`,
    );
  },
  createKnowledgeWikiPage: (
    baseId: string,
    input: { slug: string; title: string },
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    request(`/knowledge/bases/${baseId}/wiki-pages`, 'POST', input),
  updateKnowledgeWikiPage: (
    pageId: string,
    patch: { title?: string; markdown?: string; expectedVersion?: string | null },
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    request(`/knowledge/wiki-pages/${pageId}`, 'PATCH', patch),
  generateKnowledgeWikiPage: (
    pageId: string,
    input: { instruction?: string } = {},
  ): Promise<{ jobId: string }> =>
    request(`/knowledge/wiki-pages/${pageId}/generate`, 'POST', input),
  rollbackKnowledgeWikiPage: (pageId: string, versionId: string): Promise<KnowledgeWikiVersion> =>
    request(`/knowledge/wiki-pages/${pageId}/rollback`, 'POST', { versionId }),
  publishKnowledgeWikiVersion: (
    pageId: string,
    versionId: string,
  ): Promise<Omit<KnowledgeWikiPageDetail, 'versions' | 'nextCursor'>> =>
    request(`/knowledge/wiki-pages/${pageId}/publish`, 'POST', { versionId }),

  /** 导出是二进制 ZIP；走统一的 request 保留错误 Problem，并保证带 cookie 会话。 */
  exportKnowledgeBase: (baseId: string): Promise<Blob> =>
    request(`/knowledge/bases/${baseId}/export`, 'GET', undefined, undefined, 'blob'),
  importKnowledgeBase: (archive: Blob): Promise<KnowledgePackageImportResult> =>
    request('/knowledge/bases/import', 'POST', archive),

  knowledgeModelProfiles: (): Promise<KnowledgeModelProfile[]> =>
    request('/knowledge/model-profiles'),
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
  ): Promise<KnowledgeModelProfile> => request(`/knowledge/model-profiles/${id}`, 'PATCH', patch),
  deleteKnowledgeModelProfile: (id: string): Promise<void> =>
    request(`/knowledge/model-profiles/${id}`, 'DELETE'),
  testKnowledgeModelProfile: (id: string): Promise<{ ok: boolean; kind?: string }> =>
    request(`/knowledge/model-profiles/${id}/test`, 'POST'),
  rebuildKnowledgeBase: (
    id: string,
    input: { documentIds?: string[]; chunksOnly?: boolean } = {},
  ): Promise<{ jobId: string }> => request(`/knowledge/bases/${id}/rebuild`, 'POST', input),
  createKnowledgeModelProfile: (input: {
    kind: 'embedding' | 'rerank';
    name: string;
    endpointUrl: string;
    model: string;
    apiKey?: string;
    embeddingProtocol?: 'openai' | 'cohere_v2';
    imageInputEnabled?: boolean;
  }): Promise<KnowledgeModelProfile> => request('/knowledge/model-profiles', 'POST', input),
};
