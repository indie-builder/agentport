import { z } from 'zod';

/** 智能体可配置的权限模式，与 Agent SDK 的 PermissionMode 对齐。 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** 内置工具列表，前端用来渲染「允许/禁止」开关。 */
export const BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'TaskStop',
] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

export const agentInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _'),
  name: z.string().min(1).max(128),
  description: z.string().max(300).default(''),
  model: z.string().default('claude-sonnet-5-5'),
  systemPrompt: z.string().default(''),
  serverIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  /** 可委派的子智能体（最多一层，子智能体不能再委派）。 */
  subAgentIds: z.array(z.string()).default([]),
  /** 允许的 MCP 工具模式；留空表示「所有已绑定 server 的全部工具」。 */
  allowedTools: z.array(z.string()).default([]),
  /** 额外禁用的工具；内置工具默认全部禁用，这里是补充项。 */
  disallowedTools: z.array(z.string()).default([]),
  permissionMode: permissionModeSchema.default('dontAsk'),
  maxTurns: z.number().int().positive().default(20),
  maxBudgetUsd: z.number().positive().default(2),
  timeoutMs: z.number().int().positive().default(600_000),
  /** 推理强度；不填则用 SDK 默认。 */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

export type AgentInput = z.infer<typeof agentInputSchema>;

export const agentSchema = agentInputSchema.and(
  z.object({
    id: z.string(),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Agent = z.infer<typeof agentSchema>;

/** 技能：可复用的操作流程，渲染为 .claude/skills/<slug>/SKILL.md。 */
export const skillInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _'),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(500),
  body: z.string().default(''),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

export const skillSchema = skillInputSchema.and(
  z.object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Skill = z.infer<typeof skillSchema>;

/** 技能列表项：附带引用它的智能体数量，用于「被 N 个智能体使用」。 */
export const skillWithAgentCountSchema = skillSchema.and(
  z.object({ agentCount: z.number().int().nonnegative() }),
);

export type SkillWithAgentCount = z.infer<typeof skillWithAgentCountSchema>;

/** 工作区文件预览：前端「文件」tab 用。 */
export const workspaceFilesSchema = z.object({
  mcpJson: z.string(),
  claudeMd: z.string(),
  agentMd: z.string(),
  skills: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  subAgents: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
});

export type WorkspaceFiles = z.infer<typeof workspaceFilesSchema>;
