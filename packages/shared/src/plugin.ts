import { z } from 'zod';
import { slugSchema } from './params.js';

export const PLUGIN_ZIP_MAX_BYTES = 4_194_304;

export const PLUGIN_FILE_MAX_CODE_POINTS = 200_000;

export const PLUGIN_FILE_MAX_CODE_UNITS = 200_000;

export const pluginFilePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/,
    '路径必须是相对路径，且不能包含 .. 或绝对路径',
  )
  .refine(
    (path) =>
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    '插件路径不能包含空段、. 或 ..',
  );

export const pluginFileInputSchema = z.object({
  path: pluginFilePathSchema,
  content: z.string().max(PLUGIN_FILE_MAX_CODE_POINTS).default(''),
  executable: z.boolean().default(false),
});

export type PluginFileInput = z.infer<typeof pluginFileInputSchema>;

export const pluginCapabilitiesSchema = z.object({
  skills: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  hasHooks: z.boolean().default(false),
  mcpServers: z.array(z.string()).default([]),
});

export const pluginInputSchema = z.object({
  slug: slugSchema,
  runtimeName: slugSchema.optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(500).default(''),
  version: z.string().max(64).default(''),
  capabilities: pluginCapabilitiesSchema.default({
    skills: [],
    agents: [],
    hasHooks: false,
    mcpServers: [],
  }),
  files: z.array(pluginFileInputSchema).default([]),
});

export type PluginInput = z.infer<typeof pluginInputSchema>;

export const pluginSchema = pluginInputSchema.and(
  z.object({
    id: z.string(),
    runtimeName: z.string(),
    sourceId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export type Plugin = z.infer<typeof pluginSchema>;

export const pluginWithAgentCountSchema = pluginSchema.and(
  z.object({ agentCount: z.number().int().nonnegative() }),
);

export type PluginWithAgentCount = z.infer<typeof pluginWithAgentCountSchema>;
