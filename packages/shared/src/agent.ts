import { z } from 'zod';
import { slugSchema } from './params.js';

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

export const AGENT_ROLES = [
  '通用助手',
  '前端工程师',
  '后端工程师',
  '测试工程师',
  '产品经理',
  '数据分析师',
  'UI 设计师',
  '内容运营专员',
  'DevOps 工程师',
  '项目管理员',
  '群聊答疑专员',
  '运维工程师',
  '数字分身',
] as const;

export const agentRoleSchema = z
  .string()
  .trim()
  .transform((role) => role || AGENT_ROLES[0])
  .pipe(z.enum(AGENT_ROLES, { error: `请选择支持的角色：${AGENT_ROLES.join('、')}` }))
  .transform((role): string => role)
  .default(AGENT_ROLES[0]);

/** 推理强度；不填则用 SDK 默认。DB 存 text，写入运行配置前用它收窄。 */
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;

export const agentInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(128),
  /** 角色/岗位的展示名（如「前端工程师」），仅用于展示与头像匹配。 */
  role: agentRoleSchema,
  description: z.string().max(300).default(''),
  model: z.string().default('claude-sonnet-5-5'),
  systemPrompt: z.string().default(''),
  serverIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  /**
   * 绑定的插件。插件是会话级能力（SDK `plugins` 无法按子智能体隔离），仅顶层智能体可绑定。
   * hooks / MCP 默认关闭，需要逐个显式授权。
   */
  pluginBindings: z
    .array(
      z.object({
        pluginId: z.string(),
        allowHooks: z.boolean().default(false),
        allowMcp: z.boolean().default(false),
      }),
    )
    .default([]),
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
  effort: effortSchema.optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentPatch = Omit<Partial<AgentInput>, 'effort' | 'maxThinkingTokens'> & {
  effort?: AgentInput['effort'] | null;
  maxThinkingTokens?: number | null;
};

export const agentSchema = agentInputSchema.extend({ role: z.string().default('通用助手') }).and(
  z.object({
    id: z.string(),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Agent = z.infer<typeof agentSchema>;

export const agentDuplicateInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(128),
});
export type AgentDuplicateInput = z.infer<typeof agentDuplicateInputSchema>;

/** 技能：可复用的操作流程，渲染为 .claude/skills/<slug>/SKILL.md。 */
export const skillInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(500),
  body: z.string().default(''),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

export const skillSchema = skillInputSchema.and(
  z.object({
    id: z.string(),
    /** skills.sh 来源 `owner/repo/skill`；内部自建为 null。 */
    sourceId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Skill = z.infer<typeof skillSchema>;

/** 技能支持资源文件：相对技能目录的安全路径 + 文本内容。 */
export const skillFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/,
      '路径必须是相对路径，且不能包含 .. 或绝对路径',
    ),
  content: z.string().max(200_000).default(''),
});

export type SkillFileInput = z.infer<typeof skillFileInputSchema>;

export const skillFileSchema = skillFileInputSchema.and(
  z.object({ id: z.string(), createdAt: z.string() }),
);

export type SkillFile = z.infer<typeof skillFileSchema>;

/** 项目规则：渲染为 `.claude/rules/<slug>.md`；globs 为空表示对全部文件生效。 */
export const ruleInputSchema = z.object({
  slug: slugSchema,
  content: z.string().max(100_000).default(''),
  globs: z.string().max(1000).default(''),
});

export type RuleInput = z.infer<typeof ruleInputSchema>;

export const ruleSchema = ruleInputSchema.and(
  z.object({
    id: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Rule = z.infer<typeof ruleSchema>;

/** 自定义输出风格：`.claude/output-styles/<slug>.md`，选中者经 settings.outputStyle 激活。 */
export const outputStyleInputSchema = z.object({
  slug: slugSchema,
  description: z.string().max(500).default(''),
  keepCodingInstructions: z.boolean().default(false),
  body: z.string().max(50_000).default(''),
});

export type OutputStyleInput = z.infer<typeof outputStyleInputSchema>;

export const outputStyleSchema = outputStyleInputSchema.and(
  z.object({
    id: z.string(),
    agentId: z.string(),
    isSelected: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type OutputStyle = z.infer<typeof outputStyleSchema>;

/** 技能列表项：附带引用它的智能体数量，用于「被 N 个智能体使用」。 */
export const skillWithAgentCountSchema = skillSchema.and(
  z.object({ agentCount: z.number().int().nonnegative() }),
);

export type SkillWithAgentCount = z.infer<typeof skillWithAgentCountSchema>;

/** skills.sh 市场榜单视图。 */
export const marketViewSchema = z.enum(['all-time', 'trending', 'hot']);
export type MarketView = z.infer<typeof marketViewSchema>;

/** skills.sh 市场条目；id 为 `owner/repo/skill`，name 是 CLI `--skill` 匹配用的显示名。 */
export const marketSkillSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  installs: z.number().int().nonnegative(),
});

export type MarketSkill = z.infer<typeof marketSkillSchema>;

export const marketInstallInputSchema = z.object({
  id: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
      '市场技能 id 必须是 owner/repo/skill',
    ),
});

export type MarketInstallInput = z.infer<typeof marketInstallInputSchema>;

/** 工作区文件预览：前端「完整文件」视图用；字段与 renderWorkspace 输出一致。 */
export const workspaceFilesSchema = z.object({
  mcpJson: z.string(),
  claudeMd: z.string(),
  agentMd: z.string(),
  skills: z
    .array(
      z.object({
        slug: z.string(),
        content: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
      }),
    )
    .default([]),
  subAgents: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  rules: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  outputStyles: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  selectedOutputStyle: z.string().nullable().default(null),
  /** 渲染到 `.claude/plugins/<slug>/` 的插件目录树；与运行时同一份裁剪结果。 */
  plugins: z
    .array(
      z.object({
        slug: z.string(),
        files: z
          .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() }))
          .default([]),
      }),
    )
    .default([]),
  settingsJson: z.string().nullable().default(null),
});

export type WorkspaceFiles = z.infer<typeof workspaceFilesSchema>;
