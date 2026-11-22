import { z } from 'zod';
import {
  agentInputSchema,
  agentRoleSchema,
  displayNameSchema,
  outputStyleInputSchema,
  permissionModeSchema,
  ruleInputSchema,
} from './agent.js';
import { apiToolInputSchema, httpUrlSchema } from './mcp.js';
import { slugSchema } from './params.js';

export const AGENT_PACKAGE_SIDECAR = 'agentport.json';
export const AGENT_PACKAGE_SIDECAR_VERSION = 1;
export const AGENT_PACKAGE_MAX_BYTES = 1_048_576;
export const AGENT_PACKAGE_MAX_UNCOMPRESSED_BYTES = 4_194_304;
export const AGENT_PACKAGE_MAX_ENTRIES = 6_000;

export const AGENT_PACKAGE_PATHS = {
  claudeMd: 'CLAUDE.md',
  mcpJson: '.mcp.json',
  settings: '.claude/settings.json',
  agentsDir: '.claude/agents/',
  skillsDir: '.claude/skills/',
  workflowsDir: '.claude/workflows/',
  rulesDir: '.claude/rules/',
  outputStylesDir: '.claude/output-styles/',
  hooksDir: '.claude/hooks/',
  sidecar: AGENT_PACKAGE_SIDECAR,
} as const;

export const AGENT_PACKAGE_LIMITS = {
  subAgents: 20,
  resources: 100,
  rules: 50,
  outputStyles: 20,
  skillFiles: 50,
  workflows: 50,
  hookFiles: 50,
  servers: 100,
  tools: 2_000,
} as const;

export const packageRuleSchema = ruleInputSchema.strict();

export const packageOutputStyleSchema = outputStyleInputSchema
  .extend({ isSelected: z.boolean().default(false) })
  .strict();

export const packageToolSchema = apiToolInputSchema
  .extend({ enabled: z.boolean().default(true) })
  .strict();

const serverBase = {
  name: slugSchema,
  description: z.string().max(500).default(''),
  secretKeys: z.array(z.string()).default([]),
};

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

const {
  uiFormat,
  maxTurns,
  maxBudgetUsd,
  monthlyBudgetUsd,
  budgetAlertRatio,
  timeoutMs,
  effort,
  enabled,
  allowedTools,
  disallowedTools,
} = agentInputSchema.shape;

const platformFields = {
  permissionMode: permissionModeSchema.default('default'),
  uiFormat,
  maxTurns,
  maxBudgetUsd,
  monthlyBudgetUsd,
  budgetAlertRatio,
  timeoutMs,
  effort,
  enabled,
  allowedTools,
  disallowedTools,
};

export const packageSubAgentSchema = z
  .object({
    slug: slugSchema,
    permissionMode: permissionModeSchema.default('default'),
    maxBudgetUsd: z.number().positive().default(2),
    timeoutMs: z.number().int().positive().default(600_000),
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

export const agentPackageSidecarSchema = z
  .object({
    version: z.literal(AGENT_PACKAGE_SIDECAR_VERSION),
    agent: z
      .object({
        slug: slugSchema,
        name: displayNameSchema,
        role: agentRoleSchema,
        description: z.string().max(300).default(''),
        model: z.string().min(1).default('claude-sonnet-5-5'),
        ...platformFields,
        serverNames: z.array(slugSchema).default([]),
        skillSlugs: z.array(slugSchema).default([]),
        runtimeEnvironmentName: z.string().trim().min(1).max(64).optional(),
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
