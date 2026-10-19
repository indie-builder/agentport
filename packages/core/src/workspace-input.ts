import type { McpJsonEntry } from './tools.js';
import type { WorkspaceAgent, WorkspaceInput, WorkspaceSkill } from './workspace.js';

/** 渲染工作区所需的最小 agent 行；API 预览与 worker 落盘共用这一份映射。 */
export interface WorkspaceAgentRow {
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPromptMd: string;
  maxTurns: number;
  permissionMode: string;
  effort: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  enabled: boolean;
}

function toAgent(row: WorkspaceAgentRow): WorkspaceAgent {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    maxTurns: row.maxTurns,
    permissionMode: row.permissionMode,
    effort: row.effort,
    allowedTools: row.allowedTools,
    disallowedTools: row.disallowedTools,
  };
}

/**
 * agent + 绑定 → renderWorkspace 输入。servers 的 entry 由调用方构造：
 * 预览用密钥占位，运行时用解密后的真实值；这里只负责组装与过滤已停用的子智能体。
 */
export function toWorkspaceInput(params: {
  agent: WorkspaceAgentRow;
  servers: Array<{ name: string; entry: McpJsonEntry }>;
  skills: WorkspaceSkill[];
  subAgents: WorkspaceAgentRow[];
}): WorkspaceInput {
  const { agent } = params;
  return {
    agent: toAgent(agent),
    servers: params.servers,
    skills: params.skills,
    subAgents: params.subAgents.filter((row) => row.enabled).map(toAgent),
    ...(agent.allowedTools.length > 0 ? { toolsAllow: agent.allowedTools } : {}),
    ...(agent.disallowedTools.length > 0 ? { toolsDeny: agent.disallowedTools } : {}),
  };
}
