import type {
  Agent,
  AgentInput,
  ApiTool,
  ApiToolInput,
  ChatRequest,
  ConversationSummary,
  Server,
  ServerInput,
  ServerTestResult,
  ConversationDetail as SharedConversationDetail,
  Skill,
  SkillInput,
  WorkspaceFiles,
} from '@agentport/shared';

export type AgentFiles = WorkspaceFiles;

/** 导出文件的前端视图；页面只取 agent.slug 生成文件名，其余原样写盘。 */
export interface AgentExport {
  format: string;
  exportedAt: string;
  agent: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>;
  servers: Array<Record<string, unknown>>;
  skills: Skill[];
  workspace: AgentFiles;
}

export interface AgentImportResult {
  agent: Agent;
  createdServers: string[];
  reusedServers: string[];
  createdSkills: string[];
  warnings: string[];
}

export interface Me {
  authenticated: boolean;
  username?: string;
}

export interface ChatAccepted {
  runId: string;
  conversationId: string;
}

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
    };

export interface RunDetail {
  run: RunListItem & {
    conversationId: string;
    sessionId: string | null;
    sandboxId: string | null;
  };
  steps: RunStep[];
  conversation: { id: string; agentId: string; title: string };
}

/** 结构化审批请求；approvedAt 非空表示已批准。 */
export interface ApprovalRequest {
  id: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  createdAt: string;
  approvedAt: string | null;
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
  window?: { days: number; since: string };
  counts: {
    servers: number;
    agents: number;
    runs: number | null;
    running: number | null;
    costUsd?: number;
    avgLatencyMs?: number | null;
  };
  agents?: OverviewAgentRow[];
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
  limit?: number;
  before?: string;
}

export interface AuditList {
  items: AuditEntry[];
}

export type Conversation = ConversationSummary;

export type ConversationDetail = SharedConversationDetail;

export interface ConversationList {
  items: Conversation[];
  /** 后端尚未实现列表接口时为 false，页面退回本地会话记录。 */
  supported: boolean;
}

export type EvalRunStatus = 'running' | 'succeeded' | 'failed';

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
  createdAt: string;
  finishedAt: string | null;
}

export interface EvalResult {
  caseId: string;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string;
}

export interface EvalRunDetail {
  evalRun: EvalRun;
  results: EvalResult[];
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

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 面向用户的错误文案：说明发生了什么，并给出下一步。
 * 服务端返回的 message 通常已经可读；纯状态码则换成可执行建议。
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return '请求没有完成，请检查网络后重试。';
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return '连不上 API 服务，请确认它已启动并检查网络后重试。';
    if (error.status === 401) return '登录已失效，请重新登录后再试。';
    if (error.status === 403) return '当前账号没有这个操作的权限，请联系管理员开通。';
    if (error.status === 404) return '这条内容可能已被删除，请刷新列表后重试。';
    if (error.status === 409) return '数据已被其他操作修改，请刷新后重试。';
    if (error.status >= 500) return '服务端暂时无法完成请求，请稍后重试；持续出现时查看服务日志。';
  }
  if (/^HTTP \d{3}$/.test(error.message)) {
    return '请求没有完成，请稍后重试。';
  }
  return error.message;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, '连不上 API 服务，请确认它已启动并检查网络后重试。');
  }

  // EventSource 无法自定义 header，前端统一靠 cookie 会话；失效时回到登录页。
  if (res.status === 401 && !path.startsWith('/auth/') && !location.pathname.startsWith('/login')) {
    location.assign('/login');
    throw new ApiError(401, '登录已失效，请重新登录后再试。');
  }

  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const message =
      typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : res.statusText;
    throw new ApiError(res.status, message || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: (): Promise<Me> => request<Me>('/auth/me'),
  /** 指标端点不在 /api 下；不可用时返回 null，页面显示「不可用」。 */
  healthMetrics: async (): Promise<HealthMetrics | null> => {
    try {
      const res = await fetch('/health/metrics', { credentials: 'include' });
      return res.ok ? ((await res.json()) as HealthMetrics) : null;
    } catch {
      return null;
    }
  },
  login: (username: string, password: string): Promise<{ ok: boolean }> =>
    request('/auth/login', 'POST', { username, password }),
  logout: (): Promise<{ ok: boolean }> => request('/auth/logout', 'POST'),

  overview: async (): Promise<Overview | null> => {
    try {
      return await request<Overview>('/overview');
    } catch (error) {
      // 旧后端没有该端点；统计退回 servers/agents 列表推断。
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  servers: (): Promise<Server[]> => request('/servers'),
  createServer: (input: ServerInput): Promise<Server> => request('/servers', 'POST', input),
  updateServer: (id: string, input: Partial<ServerInput>): Promise<Server> =>
    request(`/servers/${id}`, 'PATCH', input),
  deleteServer: (id: string): Promise<void> => request(`/servers/${id}`, 'DELETE'),
  testServer: (id: string): Promise<ServerTestResult> => request(`/servers/${id}/test`, 'POST'),
  tools: (serverId: string): Promise<ApiTool[]> => request(`/servers/${serverId}/tools`),
  createTool: (serverId: string, input: ApiToolInput): Promise<ApiTool> =>
    request(`/servers/${serverId}/tools`, 'POST', input),
  deleteTool: (serverId: string, toolId: string): Promise<void> =>
    request(`/servers/${serverId}/tools/${toolId}`, 'DELETE'),
  updateTool: (
    serverId: string,
    toolId: string,
    patch: { enabled?: boolean; requiresApproval?: boolean },
  ): Promise<ApiTool> => request(`/servers/${serverId}/tools/${toolId}`, 'PATCH', patch),
  runApprovals: (runId: string): Promise<ApprovalRequestList> =>
    request(`/runs/${runId}/approvals`),
  approveRun: (
    runId: string,
    serverId: string,
    toolName: string,
  ): Promise<{ serverId: string; toolName: string; approvedAt: string }> =>
    request(`/runs/${runId}/approve`, 'POST', { serverId, toolName }),

  agents: (): Promise<Agent[]> => request('/agents'),
  createAgent: (input: AgentInput): Promise<Agent> => request('/agents', 'POST', input),
  updateAgent: (id: string, input: Partial<AgentInput>): Promise<Agent> =>
    request(`/agents/${id}`, 'PATCH', input),
  deleteAgent: (id: string): Promise<void> => request(`/agents/${id}`, 'DELETE'),
  agentFiles: (id: string): Promise<AgentFiles> => request(`/agents/${id}/files`),
  agentVersions: (id: string): Promise<AgentVersionSummary[]> => request(`/agents/${id}/versions`),
  agentVersion: (id: string, version: number): Promise<AgentVersionDetail> =>
    request(`/agents/${id}/versions/${version}`),
  rollbackAgent: (id: string, version: number): Promise<Agent> =>
    request(`/agents/${id}/rollback`, 'POST', { version }),
  exportAgent: (id: string): Promise<AgentExport> => request(`/export/agents/${id}`),
  importAgent: (data: unknown): Promise<AgentImportResult> =>
    request('/import/agents', 'POST', data),

  skills: (): Promise<Skill[]> => request('/skills'),
  createSkill: (input: SkillInput): Promise<Skill> => request('/skills', 'POST', input),
  updateSkill: (id: string, input: Partial<SkillInput>): Promise<Skill> =>
    request(`/skills/${id}`, 'PATCH', input),
  deleteSkill: (id: string): Promise<void> => request(`/skills/${id}`, 'DELETE'),

  conversations: async (agentId?: string): Promise<ConversationList> => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    try {
      const items = await request<Conversation[]>(`/conversations${query}`);
      return { items, supported: true };
    } catch (error) {
      // 历史列表接口不在当前契约中；先支持本浏览器发起的会话，接口上线后自动切换。
      if (error instanceof ApiError && error.status === 404) return { items: [], supported: false };
      throw error;
    }
  },
  conversation: (id: string): Promise<ConversationDetail> => request(`/conversations/${id}`),
  branchConversation: (id: string, fromMessageId?: string): Promise<{ id: string }> =>
    request(`/conversations/${id}/branch`, 'POST', {
      ...(fromMessageId === undefined ? {} : { fromMessageId }),
    }),

  sendChat: (input: ChatRequest): Promise<ChatAccepted> => request('/chat', 'POST', input),
  cancelRun: (runId: string): Promise<void> => request(`/chat/${runId}/cancel`, 'POST'),

  runs: (query: RunQuery = {}): Promise<RunList> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request<RunList>(`/runs${search}`);
  },
  run: (id: string): Promise<RunDetail> => request(`/runs/${id}`),

  audit: (query: AuditQuery = {}): Promise<AuditList> => {
    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return request<AuditList>(`/audit${search}`);
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

  evalRuns: (agentId?: string): Promise<EvalRun[]> => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return request<EvalRun[]>(`/eval/runs${query}`);
  },
  startEvalRun: (agentId: string): Promise<{ evalRunId: string }> =>
    request('/eval/runs', 'POST', { agentId }),
  evalRun: (id: string): Promise<EvalRunDetail> => request(`/eval/runs/${id}`),
};
