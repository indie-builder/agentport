import { z } from 'zod';

/** 运行来源：对话 / 外部 MCP / 定时 / 事件。 */
export const runTriggerSchema = z.enum(['chat', 'mcp', 'schedule', 'event']);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** 极简 5 段 cron 校验（分 时 日 月 周，UTC）。完整解析在 core/worker 侧。 */
export const cronSchema = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).length === 5, 'cron 需要 5 段：分 时 日 月 周');

export const scheduleInputSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(120),
  cron: cronSchema,
  prompt: z.string().min(1).max(8000),
  enabled: z.boolean().default(true),
});

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const scheduleSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  name: z.string(),
  cron: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextDueAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Schedule = z.infer<typeof scheduleSchema>;

// `.partial()` 只把字段设为可选，不会移除 `default()`；直接 partial 会在省略
// enabled 时仍注入 true，把停用的任务重新启用。这里显式覆盖成纯可选。
export const schedulePatchSchema = scheduleInputSchema.omit({ agentId: true }).partial().extend({
  enabled: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});

export type SchedulePatch = z.infer<typeof schedulePatchSchema>;

/**
 * 长期记忆用 Claude Code 原生 auto-memory：目录是 MEMORY.md + 主题文件。
 * 平台只做浏览/编辑，不定义新的记忆结构。
 */
export const memoryFileSchema = z.object({
  name: z.string(),
  size: z.number(),
  updatedAt: z.string().nullable(),
});

export type MemoryFile = z.infer<typeof memoryFileSchema>;

export const memoryFileListSchema = z.object({
  files: z.array(memoryFileSchema),
  /** 记忆目录是否已初始化（有 MEMORY.md）。 */
  initialized: z.boolean(),
});

export type MemoryFileList = z.infer<typeof memoryFileListSchema>;

export const memoryFileContentSchema = z.object({
  name: z.string(),
  content: z.string(),
  updatedAt: z.string().nullable(),
});

export type MemoryFileContent = z.infer<typeof memoryFileContentSchema>;

/** 需要人处理的一条：待批工具调用或失败的运行。 */
export const attentionItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    runId: z.string(),
    agentId: z.string(),
    agentName: z.string().nullable(),
    serverId: z.string(),
    toolName: z.string(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('failed_run'),
    runId: z.string(),
    agentId: z.string(),
    agentName: z.string().nullable(),
    error: z.string().nullable(),
    endedAt: z.string().nullable(),
  }),
]);

export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const attentionSchema = z.object({
  approvals: z.array(attentionItemSchema),
  failedRuns: z.array(attentionItemSchema),
  total: z.number(),
});

export type Attention = z.infer<typeof attentionSchema>;

/** 单个智能体的运行统计（/api/agents/:id/stats 与概览页共用形状）。 */
export const agentStatsSchema = z.object({
  agentId: z.string(),
  runCount: z.number(),
  running: z.number(),
  failed: z.number(),
  succeeded: z.number(),
  totalCost: z.number(),
  totalTokens: z.number(),
  errorRate: z.number(),
  latencyP50: z.number().nullable(),
  latencyP99: z.number().nullable(),
  lastRunStartTime: z.string().nullable(),
  /** 按天统计的运行量，供活跃度热力图使用。 */
  daily: z.array(z.object({ day: z.string(), runs: z.number(), cost: z.number() })),
});

export type AgentStats = z.infer<typeof agentStatsSchema>;
