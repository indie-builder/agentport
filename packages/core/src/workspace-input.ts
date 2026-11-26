import {
  type AgentInput,
  type McpJsonArtifactEntry,
  type MemoryPolicy,
  type OpenUiToolDescriptor,
  type PreviewMcpJsonArtifactEntry,
  resolveMemoryPolicy,
} from '@agentport/shared';
import type {
  WorkspaceAgent,
  WorkspaceInput,
  WorkspacePlugin,
  WorkspaceSkill,
} from './workspace.js';

export const WORKSPACE_FILE_MODE = 0o600;
export const WORKSPACE_DIR_MODE = 0o700;

export interface WorkspaceAgentRow {
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPromptMd: string;
  maxTurns: number;
  permissionMode: AgentInput['permissionMode'];
  uiFormat: AgentInput['uiFormat'];
  effort: NonNullable<AgentInput['effort']> | null;
  allowedTools: string[];
  disallowedTools: string[];
  enabled: boolean;
  skills?: WorkspaceSkill[];
  serverNames?: string[];
}

export function toWorkspaceAgent(row: WorkspaceAgentRow): WorkspaceAgent {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    model: row.model,
    systemPrompt: row.systemPromptMd,
    maxTurns: row.maxTurns,
    permissionMode: row.permissionMode,
    uiFormat: row.uiFormat,
    effort: row.effort,
    allowedTools: row.allowedTools,
    disallowedTools: row.disallowedTools,
    ...(row.serverNames ? { serverNames: row.serverNames } : {}),
    ...(row.skills ? { skills: row.skills } : {}),
  };
}

export function resolveWorkspaceMemoryPolicy(
  value: unknown,
  context: { mode: 'preview' } | { mode: 'run'; channelId: string | null },
): MemoryPolicy {
  const policy = resolveMemoryPolicy(value);
  return context.mode === 'run' && context.channelId !== null
    ? { ...policy, writeMode: 'proposal_only' }
    : policy;
}

export function toWorkspaceInput<
  TEntry extends McpJsonArtifactEntry | PreviewMcpJsonArtifactEntry = McpJsonArtifactEntry,
>(params: {
  agent: WorkspaceAgentRow;
  servers: Array<{ name: string; entry: TEntry }>;
  skills: WorkspaceSkill[];
  subAgents: WorkspaceAgentRow[];
  workflows?: Array<{ slug: string; content: string }>;
  rules?: Array<{ slug: string; content: string; globs: string }>;
  outputStyles?: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  }>;
  selectedOutputStyle?: string | null;
  hooks?: Record<string, unknown> | null;
  hookFiles?: Array<{ path: string; content: string; executable: boolean }>;
  openuiTools?: OpenUiToolDescriptor[];
  plugins?: WorkspacePlugin[];
  memoryPolicy?: MemoryPolicy;
}): WorkspaceInput<TEntry> {
  const { agent, memoryPolicy } = params;
  return {
    agent: toWorkspaceAgent(agent),
    servers: params.servers,
    skills: params.skills,
    subAgents: params.subAgents.filter((row) => row.enabled).map(toWorkspaceAgent),
    ...(params.workflows && params.workflows.length > 0 ? { workflows: params.workflows } : {}),
    ...(memoryPolicy?.injectRules !== false && params.rules && params.rules.length > 0
      ? { rules: params.rules }
      : {}),
    ...(params.outputStyles && params.outputStyles.length > 0
      ? { outputStyles: params.outputStyles }
      : {}),
    ...(params.selectedOutputStyle ? { selectedOutputStyle: params.selectedOutputStyle } : {}),
    ...(params.hooks && Object.keys(params.hooks).length > 0 ? { hooks: params.hooks } : {}),
    ...(params.hookFiles && params.hookFiles.length > 0 ? { hookFiles: params.hookFiles } : {}),
    ...(params.plugins && params.plugins.length > 0 ? { plugins: params.plugins } : {}),
    ...(agent.allowedTools.length > 0 ? { toolsAllow: agent.allowedTools } : {}),
    ...(agent.disallowedTools.length > 0 ? { toolsDeny: agent.disallowedTools } : {}),
    ...(params.openuiTools && params.openuiTools.length > 0
      ? { openuiTools: params.openuiTools }
      : {}),
    ...(memoryPolicy ? { memoryPolicy } : {}),
  };
}

export function toOutputStyleSelection(
  rows: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
    isSelected: boolean;
  }>,
): {
  outputStyles: Array<{
    slug: string;
    description: string;
    keepCodingInstructions: boolean;
    body: string;
  }>;
  selectedOutputStyle: string | null;
} {
  return {
    outputStyles: rows.map((r) => ({
      slug: r.slug,
      description: r.description,
      keepCodingInstructions: r.keepCodingInstructions,
      body: r.body,
    })),
    selectedOutputStyle: rows.find((r) => r.isSelected)?.slug ?? null,
  };
}
