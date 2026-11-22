import { z } from 'zod';
import { slugSchema } from './params.js';
import { utf8Bytes } from './utf8.js';

/** 平台支持的权限模式；SDK 的 auto 依赖模型分类器，平台不开放。 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk']);

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

export const DEFAULT_DISALLOWED_TOOLS: readonly string[] = [
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
  'ListAgents',
  'SendMessage',
  'EndConversation',
  'Monitor',
  'SendUserMessage',
];

export const SUB_AGENT_DUPLICATE_MESSAGE = '同一个智能体被重复选为子智能体，请去掉重复项';
export const SUB_AGENT_SELF_MESSAGE = '智能体不能把自己设为子智能体';
export const SUB_AGENT_MISSING_MESSAGE = '选中的子智能体已被删除，请刷新后重新选择';
export const SUB_AGENT_PLUGIN_BINDING_MESSAGE = '子智能体不能绑定插件；插件在会话级加载';

export const CONFIGURABLE_DISALLOWED_TOOLS: readonly string[] = [
  'Agent',
  'TaskStop',
  'ListAgents',
  'SendMessage',
];

export function disallowedToolsFor(input: {
  allowedTools: readonly string[];
  allowSubAgents: boolean;
  keepFileTools: boolean;
}): string[] {
  const configurable = new Set(CONFIGURABLE_DISALLOWED_TOOLS);
  const allowed = new Set(input.allowedTools);
  return DEFAULT_DISALLOWED_TOOLS.filter((tool) => {
    if (tool === 'Read' || tool === 'Write' || tool === 'Edit') return !input.keepFileTools;
    if (!configurable.has(tool)) return true;
    if (tool === 'Agent' || tool === 'TaskStop') return !input.allowSubAgents;
    return !allowed.has(tool);
  });
}

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

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const uiFormatSchema = z.enum(['markdown', 'openui']);

export const agentVisibilitySchema = z.enum(['private', 'organization']);

export const agentLifecycleStatusSchema = z.enum(['active', 'archived', 'deleted']);

export type AgentLifecycleStatus = z.infer<typeof agentLifecycleStatusSchema>;

export const displayNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\r\n]/.test(value), '显示名不能包含换行');

export const agentInputSchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
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
  subAgentIds: z.array(z.string()).default([]),
  runtimeEnvironmentId: z.string().nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  permissionMode: permissionModeSchema.default('default'),
  uiFormat: uiFormatSchema.default('markdown'),
  maxTurns: z.number().int().positive().default(20),
  maxBudgetUsd: z.number().positive().default(2),
  monthlyBudgetUsd: z.number().min(0.01).nullable().default(null),
  budgetAlertRatio: z.number().min(0.001).lte(1).default(0.8),
  timeoutMs: z.number().int().positive().default(600_000),
  effort: effortSchema.optional(),
  enabled: z.boolean().default(true),
  visibility: agentVisibilitySchema.default('private'),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).default([]),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentPatch = Omit<Partial<AgentInput>, 'effort'> & {
  effort?: AgentInput['effort'] | null;
};

export const agentSchema = agentInputSchema.extend({ role: z.string().default('通用助手') }).and(
  z.object({
    id: z.string(),
    createdBy: z.string(),
    ownerBusinessId: z.string(),
    parentId: z.string().nullable(),
    isDefault: z.boolean(),
    publishedVersion: z.number().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    hasDraft: z.boolean().optional(),
    archivedAt: z.string().nullable().optional(),
    deletedAt: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Agent = z.infer<typeof agentSchema>;

export const agentBudgetStateSchema = z.enum(['unlimited', 'ok', 'alert', 'exceeded']);

export const agentBudgetStatusSchema = z.object({
  monthlyBudgetUsd: z.number().nullable(),
  budgetAlertRatio: z.number(),
  periodStart: z.string(),
  spentUsd: z.number(),
  ratio: z.number().nullable(),
  state: agentBudgetStateSchema,
});

export type AgentBudgetStatus = z.infer<typeof agentBudgetStatusSchema>;

export const agentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  ownerBusinessId: z.string(),
  role: z.string().optional(),
  slug: z.string().optional(),
  parentId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  uiFormat: uiFormatSchema.optional(),
  serverIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxBudgetUsd: z.number().optional(),
  timeoutMs: z.number().int().optional(),
  visibility: agentVisibilitySchema.default('private'),
  tags: z.array(z.string()).default([]),
  archivedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  isFavorite: z.boolean().default(false),
  lastUsedAt: z.string().nullable().optional(),
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentOptionsSchema = z.object({
  servers: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  skills: z.array(
    z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string() }),
  ),
  plugins: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
  runtimeEnvironments: z.array(
    z.object({ id: z.string(), name: z.string(), hasOnlineVersion: z.boolean() }),
  ),
});

export type AgentOptions = z.infer<typeof agentOptionsSchema>;

export const agentDuplicateInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().pipe(displayNameSchema),
});
export type AgentDuplicateInput = z.infer<typeof agentDuplicateInputSchema>;

export const skillInputSchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
  description: z.string().min(1).max(500),
  body: z.string().default(''),
  license: z.string().max(200).optional(),
  compatibility: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

export const skillStatusSchema = z.enum(['draft', 'pending', 'published', 'rejected']);

export const skillSchema = skillInputSchema.and(
  z.object({
    id: z.string(),
    sourceId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: skillStatusSchema.default('published'),
    submittedAt: z.string().nullable().default(null),
    reviewedAt: z.string().nullable().default(null),
    reviewedBy: z.string().nullable().default(null),
    reviewNote: z.string().nullable().default(null),
  }),
);

export type Skill = z.infer<typeof skillSchema>;

export const AGENT_WORKFLOW_CONTENT_MAX = 131_072;
const AGENT_WORKFLOW_NAME_MAX = 200;
export const AGENT_WORKFLOW_DESCRIPTION_MAX = 2_000;

export const agentWorkflowInputSchema = z.object({
  slug: slugSchema,
  name: z
    .string()
    .min(1)
    .max(AGENT_WORKFLOW_NAME_MAX)
    .refine((value) => !/[\r\n]/.test(value), '显示名不能包含换行'),
  description: z.string().max(AGENT_WORKFLOW_DESCRIPTION_MAX).default(''),
  content: z.string().min(1).max(AGENT_WORKFLOW_CONTENT_MAX),
});

export const agentWorkflowSchema = agentWorkflowInputSchema.and(
  z.object({
    id: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type AgentWorkflow = z.infer<typeof agentWorkflowSchema>;

export const AGENT_HOOK_CONTENT_MAX = 200_000;
export const AGENT_HOOKS_CONFIG_MAX = 65_536;
export const AGENT_HOOK_FILE_LIMIT = 50;

export const agentHookFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
    '路径必须是相对路径，且不能包含 .、.. 或空路径段',
  );

export const agentHooksConfigSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .nullable()
  .default(null)
  .refine(
    (config) => config === null || utf8Bytes(JSON.stringify(config)) <= AGENT_HOOKS_CONFIG_MAX,
    `hooks 配置不能超过 ${AGENT_HOOKS_CONFIG_MAX} 字节`,
  );

export const agentHookFileInputSchema = z
  .object({
    path: agentHookFilePathSchema,
    content: z.string().max(AGENT_HOOK_CONTENT_MAX).default(''),
    executable: z.boolean().default(false),
  })
  .strict();

export const agentHookFileSchema = agentHookFileInputSchema.and(
  z.object({
    id: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type AgentHookFile = z.infer<typeof agentHookFileSchema>;

export const agentHooksSettingsInputSchema = z
  .object({ enabled: z.boolean(), config: agentHooksConfigSchema })
  .strict();

export const agentHooksSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).nullable(),
  files: z.array(agentHookFileSchema),
});

export type AgentHooks = z.infer<typeof agentHooksSchema>;

export interface SkillResourcePathConflict {
  path: string;
  conflictingPath: string;
}

export function findSkillResourcePathConflict(
  paths: readonly string[],
): SkillResourcePathConflict | undefined {
  const seen = new Map<string, string>([['skill.md', 'SKILL.md']]);
  for (const path of paths) {
    const folded = path.toLowerCase();
    for (const [existing, original] of seen) {
      if (
        folded === existing ||
        folded.startsWith(`${existing}/`) ||
        existing.startsWith(`${folded}/`)
      ) {
        return { path, conflictingPath: original };
      }
    }
    seen.set(folded, path);
  }
  return undefined;
}

export const skillFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
      '路径必须是相对路径，且不能包含 .、.. 或空路径段',
    )
    .refine(
      (path) => findSkillResourcePathConflict([path]) === undefined,
      '资源路径不能占用 SKILL.md',
    ),
  content: z.string().max(200_000).default(''),
});

export const skillFileSchema = skillFileInputSchema.and(
  z.object({ id: z.string(), createdAt: z.string() }),
);

export type SkillFile = z.infer<typeof skillFileSchema>;

export const ruleInputSchema = z.object({
  slug: slugSchema,
  content: z.string().max(100_000).default(''),
  globs: z.string().max(1000).default(''),
});

export const ruleSchema = ruleInputSchema.and(
  z.object({
    id: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Rule = z.infer<typeof ruleSchema>;

export const outputStyleInputSchema = z.object({
  slug: slugSchema,
  description: z.string().max(500).default(''),
  keepCodingInstructions: z.boolean().default(false),
  body: z.string().max(50_000).default(''),
});

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

export const skillWithAgentCountSchema = skillSchema.and(
  z.object({ agentCount: z.number().int().nonnegative() }),
);

export type SkillWithAgentCount = z.infer<typeof skillWithAgentCountSchema>;

export const marketViewSchema = z.enum(['all-time', 'trending', 'hot']);
export type MarketView = z.infer<typeof marketViewSchema>;

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
  workflows: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  rules: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  outputStyles: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  hookFiles: z
    .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() }))
    .default([]),
  selectedOutputStyle: z.string().nullable().default(null),
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
  settingsJson: z.string(),
});

export type WorkspaceFiles = z.infer<typeof workspaceFilesSchema>;
