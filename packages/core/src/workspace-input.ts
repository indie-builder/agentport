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
  /** 子智能体自带技能；可选，由 DB 调用方补充子行时提供。 */
  skills?: WorkspaceSkill[];
  /** 父智能体派生子智能体时等它多久；子智能体 md 里要写明，否则等待规则是空话。 */
  timeoutMs: number;
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
    timeoutMs: row.timeoutMs,
    ...(row.skills ? { skills: row.skills } : {}),
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
  rules?: Array<{ slug: string; content: string; globs: string }>;
}): WorkspaceInput {
  const { agent } = params;
  return {
    agent: toAgent(agent),
    servers: params.servers,
    skills: params.skills,
    subAgents: params.subAgents.filter((row) => row.enabled).map(toAgent),
    ...(params.rules && params.rules.length > 0 ? { rules: params.rules } : {}),
    ...(agent.allowedTools.length > 0 ? { toolsAllow: agent.allowedTools } : {}),
    ...(agent.disallowedTools.length > 0 ? { toolsDeny: agent.disallowedTools } : {}),
  };
}
