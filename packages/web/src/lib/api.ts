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

export interface Me {
  authenticated: boolean;
  username?: string;
}

export interface ChatAccepted {
  runId: string;
  conversationId: string;
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

export type Conversation = ConversationSummary;

export type ConversationDetail = SharedConversationDetail;

export interface ConversationList {
  items: Conversation[];
  /** 后端尚未实现列表接口时为 false，页面退回本地会话记录。 */
  supported: boolean;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '请求失败';
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
    throw new ApiError(0, '网络连接失败，请确认 API 服务已启动');
  }

  // EventSource 无法自定义 header，前端统一靠 cookie 会话；失效时回到登录页。
  if (res.status === 401 && !path.startsWith('/auth/') && !location.pathname.startsWith('/login')) {
    location.assign('/login');
    throw new ApiError(401, '登录已失效');
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

  agents: (): Promise<Agent[]> => request('/agents'),
  createAgent: (input: AgentInput): Promise<Agent> => request('/agents', 'POST', input),
  updateAgent: (id: string, input: Partial<AgentInput>): Promise<Agent> =>
    request(`/agents/${id}`, 'PATCH', input),
  deleteAgent: (id: string): Promise<void> => request(`/agents/${id}`, 'DELETE'),
  agentFiles: (id: string): Promise<AgentFiles> => request(`/agents/${id}/files`),

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

  sendChat: (input: ChatRequest): Promise<ChatAccepted> => request('/chat', 'POST', input),
  cancelRun: (runId: string): Promise<void> => request(`/chat/${runId}/cancel`, 'POST'),
};
