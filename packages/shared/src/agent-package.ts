import { z } from 'zod';
import { agentRoleSchema } from './agent.js';
import { apiToolInputSchema, httpUrlSchema } from './mcp.js';
import { slugSchema } from './params.js';

/**
 * 专家包 = 官方 `.claude/` 目录的 ZIP 快照。
 * 正文（提示词、规则、输出风格、技能及其资源）只存在于官方文件里；
 * 根 `agentport.json` 只放官方文件表达不了的平台元数据：显示名、slug、
 * 预算/超时、密钥键名、生成式连接器托管定义与子定义自有规则。
 */

export const AGENT_PACKAGE_SIDECAR = 'agentport.json';
export const AGENT_PACKAGE_SIDECAR_VERSION = 1;
/** ZIP 文件本身的上限，同时是导入路由的 bodyLimit。 */
export const AGENT_PACKAGE_MAX_BYTES = 1_048_576;
/** 解压后所有条目字节数之和的上限；先读中央目录再解压，避免 zip bomb。 */
export const AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES = 4_194_304;
export const AGENT_PACKAGE_MAX_ENTRIES = 6_000;

/** 官方文件在包内的固定路径；其余路径一律视为未知能力并拒绝。 */
export const AGENT_PACKAGE_PATHS = {
  claudeMd: 'CLAUDE.md',
  mcpJson: '.mcp.json',
  settings: '.claude/settings.json',
  agentsDir: '.claude/agents/',
  skillsDir: '.claude/skills/',
  rulesDir: '.claude/rules/',
  outputStylesDir: '.claude/output-styles/',
  sidecar: AGENT_PACKAGE_SIDECAR,
} as const;

/** 与导入端逐项限制共享，避免导出产出自己无法导入的包。 */
export const AGENT_PACKAGE_LIMITS = {
  subAgents: 20,
  resources: 100,
  rules: 50,
  outputStyles: 20,
  skillFiles: 50,
  servers: 100,
  tools: 2_000,
} as const;

/** 平台暂不开放 auto（依赖模型分类器），与手动创建保持一致。 */
const packagePermissionModeSchema = z.enum(['dontAsk', 'plan', 'default', 'acceptEdits']);

export const packageRuleSchema = z
  .object({
    slug: slugSchema,
    content: z.string().max(100_000).default(''),
    globs: z.string().max(1_000).default(''),
  })
  .strict();

export const packageOutputStyleSchema = z
  .object({
    slug: slugSchema,
    description: z.string().max(500).default(''),
    keepCodingInstructions: z.boolean().default(false),
    body: z.string().max(50_000).default(''),
    isSelected: z.boolean().default(false),
  })
  .strict();

export const packageToolSchema = apiToolInputSchema
  .extend({ enabled: z.boolean().default(true) })
  .strict();

const serverBase = {
  name: slugSchema,
  description: z.string().max(500).default(''),
  /** 只导出键名；导入时提示重新填写，绝不携带明文。 */
  secretKeys: z.array(z.string()).default([]),
};

/**
 * 连接器的非敏感定义。平台元数据与官方 `.mcp.json` 一一对应；
 * generated 的端点由目标实例按新 id 重建，所以这里只存上游 baseUrl 与工具定义。
 */
export const packageServerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...serverBase,
      kind: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
    })
    .strict(),
  z.object({ ...serverBase, kind: z.literal('http'), url: httpUrlSchema }).strict(),
  z
    .object({
      ...serverBase,
      kind: z.literal('generated'),
      baseUrl: httpUrlSchema,
      tools: z.array(packageToolSchema).max(AGENT_PACKAGE_LIMITS.tools).optional(),
    })
    .strict()
    .superRefine((entry, ctx) => {
      const seen = new Set<string>();
      for (const [index, tool] of (entry.tools ?? []).entries()) {
        if (seen.has(tool.name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tools', index, 'name'],
            message: `「${entry.name}」的工具名称「${tool.name}」重复`,
          });
        }
        seen.add(tool.name);
      }
    }),
]);

const platformFields = {
  permissionMode: packagePermissionModeSchema.default('dontAsk'),
  maxTurns: z.number().int().positive().default(20),
  maxBudgetUsd: z.number().positive().default(2),
  timeoutMs: z.number().int().positive().default(600_000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
};

/**
 * 子定义的平台字段。name/description/model/maxTurns/effort/skills/mcpServers 在
 * `.claude/agents/<slug>.md`（官方字段）；子自有规则与输出风格没有官方运行时存放位置，
 * 只能作为平台元数据随包携带，不会被 SDK 自动加载。
 */
export const packageSubAgentSchema = z
  .object({
    slug: slugSchema,
    permissionMode: packagePermissionModeSchema.default('dontAsk'),
    maxBudgetUsd: z.number().positive().default(2),
    timeoutMs: z.number().int().positive().default(600_000),
    maxThinkingTokens: z.number().int().positive().optional(),
    enabled: z.boolean().default(true),
    allowedTools: z.array(z.string()).default([]),
    disallowedTools: z.array(z.string()).default([]),
    rules: z.array(packageRuleSchema).max(AGENT_PACKAGE_LIMITS.rules).default([]),
    outputStyles: z
      .array(packageOutputStyleSchema)
      .max(AGENT_PACKAGE_LIMITS.outputStyles)
      .default([]),
  })
  .strict();

/**
 * 根 `agentport.json`。根提示词在 CLAUDE.md；根规则、输出风格与技能
 * 在 `.claude/` 下，这里只有绑定（名称引用）与平台运行参数。
 */
export const agentPackageSidecarSchema = z
  .object({
    version: z.literal(AGENT_PACKAGE_SIDECAR_VERSION),
    agent: z
      .object({
        slug: slugSchema,
        name: z.string().min(1).max(128),
        role: agentRoleSchema,
        description: z.string().max(300).default(''),
        model: z.string().min(1).default('claude-sonnet-5-5'),
        ...platformFields,
        serverNames: z.array(slugSchema).default([]),
        skillSlugs: z.array(slugSchema).default([]),
      })
      .strict(),
    servers: z.array(packageServerSchema).max(AGENT_PACKAGE_LIMITS.servers).default([]),
    subAgents: z.array(packageSubAgentSchema).max(AGENT_PACKAGE_LIMITS.subAgents).default([]),
  })
  .strict();

export type AgentPackageSidecar = z.infer<typeof agentPackageSidecarSchema>;
export type PackageServer = z.infer<typeof packageServerSchema>;
export type PackageSubAgent = z.infer<typeof packageSubAgentSchema>;
export type PackageRule = z.infer<typeof packageRuleSchema>;
export type PackageOutputStyle = z.infer<typeof packageOutputStyleSchema>;
