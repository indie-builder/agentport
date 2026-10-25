import { z } from 'zod';
import { slugSchema } from './params.js';

/**
 * 插件 = 官方插件根目录（`.claude-plugin/plugin.json` + skills/、agents/、hooks/、.mcp.json）
 * 的完整快照。平台只保存文件并渲染成同名目录，加载交给 Claude Agent SDK 原生 `plugins`。
 */

/** 插件根内路径：相对、POSIX、不含 `..`，与技能资源文件同一套安全规则。 */
export const pluginFilePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/,
    '路径必须是相对路径，且不能包含 .. 或绝对路径',
  );

export const pluginFileInputSchema = z.object({
  path: pluginFilePathSchema,
  content: z.string().max(200_000).default(''),
  /** Unix 可执行位；插件 hooks 依赖 `scripts/*.sh` 可直接执行。 */
  executable: z.boolean().default(false),
});

export type PluginFileInput = z.infer<typeof pluginFileInputSchema>;

/** 插件内可执行组件的检测结果，决定绑定时的默认授权。 */
export const pluginCapabilitiesSchema = z.object({
  skills: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  hasHooks: z.boolean().default(false),
  mcpServers: z.array(z.string()).default([]),
});

export type PluginCapabilities = z.infer<typeof pluginCapabilitiesSchema>;

export const pluginInputSchema = z.object({
  slug: slugSchema,
  /** SDK 看到的插件名；缺省与原目录名一致。 */
  runtimeName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, '仅允许小写字母、数字、- 和 _')
    .optional(),
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
    /** 原生市场来源 `name@marketplace`；ZIP 导入为 null。只输出，客户端不能改写。 */
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
