import type {
  Agent,
  AgentInput,
  ApiTool,
  ApiToolInput,
  ChatRequest,
  Server,
  ServerInput,
  ServerTestResult,
} from '@agentport/shared';

export interface Me {
  authenticated: boolean;
  username?: string;
}

export interface AgentFiles {
  mcpJson: string;
  claudeMd: string;
  agentMd: string;
}

export interface ChatAccepted {
  runId: string;
  conversationId: string;
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
  return error instanceof Error ? error.message : '请求失败';
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    // EventSource 无法自定义 header，前端统一靠 cookie 会话；失效时回到登录页。
    window.location.assign('/login');
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

  sendChat: (input: ChatRequest): Promise<ChatAccepted> => request('/chat', 'POST', input),
  cancelRun: (runId: string): Promise<void> => request(`/chat/${runId}/cancel`, 'POST'),
};
