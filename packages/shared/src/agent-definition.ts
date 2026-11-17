import { z } from 'zod';
import {
  agentHooksSchema,
  agentSchema,
  agentWorkflowSchema,
  outputStyleSchema,
  ruleSchema,
  skillSchema,
} from './agent.js';
import { apiToolSchema } from './mcp.js';
import { memoryPolicySchema } from './memory.js';
import { pluginSchema } from './plugin.js';

export const agentResourceVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
});

export const agentResourceVersionsSchema = z.object({
  servers: z.array(agentResourceVersionSchema),
  skills: z.array(agentResourceVersionSchema),
  plugins: z.array(agentResourceVersionSchema),
  subAgents: z.array(agentResourceVersionSchema),
  runtimeEnvironment: z
    .object({ id: z.string(), name: z.string(), versionId: z.string().nullable() })
    .nullable(),
});

const agentDefinitionServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  secretsEncrypted: z.string().nullable().optional(),
  tools: z.array(apiToolSchema).optional(),
  updatedAt: z.string(),
});

const agentDefinitionSkillSchema = skillSchema.and(
  z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })) }),
);

const agentDefinitionPluginSchema = pluginSchema;

const agentDefinitionSubAgentSchema = agentResourceVersionSchema.extend({
  publishedVersion: z.number().nullable(),
});

export const agentDefinitionSchema = z.object({
  agent: agentSchema,
  rules: z.array(ruleSchema),
  outputStyles: z.array(outputStyleSchema),
  workflows: z.array(agentWorkflowSchema),
  hooks: agentHooksSchema,
  memoryPolicy: memoryPolicySchema,
  resources: z.object({
    servers: z.array(agentDefinitionServerSchema),
    skills: z.array(agentDefinitionSkillSchema),
    plugins: z.array(agentDefinitionPluginSchema),
    subAgents: z.array(agentDefinitionSubAgentSchema),
    runtimeEnvironment: agentResourceVersionsSchema.shape.runtimeEnvironment,
  }),
});

export type AgentDefinitionServer = z.infer<typeof agentDefinitionServerSchema>;
export type AgentDefinitionSkill = z.infer<typeof agentDefinitionSkillSchema>;
export type AgentDefinitionPlugin = z.infer<typeof agentDefinitionPluginSchema>;
export type AgentDefinitionSubAgent = z.infer<typeof agentDefinitionSubAgentSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentResourceVersions = z.infer<typeof agentResourceVersionsSchema>;
