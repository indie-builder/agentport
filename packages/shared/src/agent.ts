import { z } from 'zod';
import { slugSchema } from './params.js';

/** 平台支持的权限模式；SDK 的 auto 依赖模型分类器，平台不开放。 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk']);

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

export const CONFIGURABLE_DISALLOWED_TOOLS: readonly string[] = [
  'Agent',
  'TaskStop',
  'ListAgents',
  'SendMessage',
];

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

/** 助手回复的渲染格式：Markdown（默认）或生成式 UI（围栏内的 OpenUI Lang）。 */
export const uiFormatSchema = z.enum(['markdown', 'openui']);

export const displayNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\r\n]/.test(value), '显示名不能包含换行');

export const agentInputSchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
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
  /** 绑定的命名运行环境；null 表示平台默认环境。 */
  runtimeEnvironmentId: z.string().nullable().default(null),
  /** 允许的 MCP 工具模式；留空表示「所有已绑定 server 的全部工具」。 */
  allowedTools: z.array(z.string()).default([]),
  /** 额外禁用的工具；内置工具默认禁用，Bash 默认在沙箱容器内放行，这里是补充项。 */
  disallowedTools: z.array(z.string()).default([]),
  permissionMode: permissionModeSchema.default('default'),
  /** 助手回复格式；openui 时系统提示词追加 OpenUI Lang 约定，前端按生成式 UI 渲染。 */
  uiFormat: uiFormatSchema.default('markdown'),
  maxTurns: z.number().int().positive().default(20),
  maxBudgetUsd: z.number().positive().default(2),
  timeoutMs: z.number().int().positive().default(600_000),
  /** 推理强度；不填则用 SDK 默认。 */
  effort: effortSchema.optional(),
  enabled: z.boolean().default(true),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentPatch = Omit<Partial<AgentInput>, 'effort'> & {
  effort?: AgentInput['effort'] | null;
};

export const agentSchema = agentInputSchema.extend({ role: z.string().default('通用助手') }).and(
  z.object({
    id: z.string(),
    /** 创建时的业务身份；不随转交改变。 */
    createdBy: z.string(),
    /** 当前负责人；决定 W 范围与成员管理权。 */
    ownerBusinessId: z.string(),
    /** 单层委派：非空表示自己是某个主智能体的子智能体。 */
    parentId: z.string().nullable(),
    isDefault: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Agent = z.infer<typeof agentSchema>;

/** 列表摘要：只含成员可见的业务字段；其余为服务端附带的可选元数据，不作为授权依据。 */
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
});

export type AgentSummary = z.infer<typeof agentSummarySchema>;

/** 绑定选择器只拿摘要；不含资源配置、密钥或正文。 */
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

/** 技能：可复用的操作流程，渲染为 .claude/skills/<slug>/SKILL.md。 */
export const skillInputSchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
  description: z.string().min(1).max(500),
  body: z.string().default(''),
  /** SKILL.md frontmatter 的来源描述字段，导入/安装时原样保留。 */
  license: z.string().max(200).optional(),
  compatibility: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

/** 工作流脚本字符上限；API 保存与 core 解析器共用。 */
export const AGENT_WORKFLOW_CONTENT_MAX = 131_072;
export const AGENT_WORKFLOW_NAME_MAX = 200;
export const AGENT_WORKFLOW_DESCRIPTION_MAX = 2_000;

/** 工作流：官方 `.claude/workflows/<slug>.js`；name/description 来自脚本内 `meta`。 */
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const agentHooksConfigSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .nullable()
  .default(null)
  .refine(
    (config) => config === null || utf8ByteLength(JSON.stringify(config)) <= AGENT_HOOKS_CONFIG_MAX,
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

/** 不解析单路径；在入口校验后检查整组路径能否与生成的 SKILL.md 一起落盘。 */
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

/** 技能支持资源文件：相对技能目录的规范路径；根级 SKILL.md 留给生成的定义。 */
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

/** 项目规则：渲染为 `.claude/rules/<slug>.md`；globs 为空表示对全部文件生效。 */
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

/** 自定义输出风格：`.claude/output-styles/<slug>.md`，选中者经 settings.outputStyle 激活。 */
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
  workflows: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  rules: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  outputStyles: z.array(z.object({ slug: z.string(), content: z.string() })).default([]),
  hookFiles: z
    .array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() }))
    .default([]),
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
  settingsJson: z.string(),
});

export type WorkspaceFiles = z.infer<typeof workspaceFilesSchema>;
