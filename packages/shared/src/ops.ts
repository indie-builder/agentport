import { z } from 'zod';
import { runErrorKindSchema, runStatusSchema } from './run-state.js';

export const MAINTENANCE_QUEUE = 'maintenance';

/** 运行来源：对话 / 外部 MCP / 定时 / 事件 / 记忆审核 / 频道。 */
export const runTriggerSchema = z.enum(['chat', 'mcp', 'schedule', 'event', 'review', 'channel']);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** 5 段 cron 结构校验（分 时 日 月 周，按任务时区解析）；实际可调度性由 API schema 用 BullMQ 解析。 */
export const cronSchema = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).length === 5, 'cron 需要 5 段：分 时 日 月 周');

const ianaTimeZones = new Set(Intl.supportedValuesOf('timeZone'));

export const scheduleTimezoneSchema = z
  .string()
  .trim()
  .min(1, '无效的时区')
  .refine((timeZone) => timeZone === 'UTC' || ianaTimeZones.has(timeZone), '无效的时区');

export const scheduleInputSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(120),
  cron: cronSchema,
  timezone: scheduleTimezoneSchema.default('Asia/Shanghai'),
  missedPolicy: z.enum(['skip', 'run_once']).default('skip'),
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
  timezone: z.string(),
  missedPolicy: z.enum(['skip', 'run_once']),
  description: z.string(),
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
export const schedulePatchSchema = scheduleInputSchema
  .omit({ agentId: true })
  .partial()
  .extend({
    enabled: z.boolean().optional(),
    timezone: scheduleTimezoneSchema.optional(),
    missedPolicy: z.enum(['skip', 'run_once']).optional(),
    expectedUpdatedAt: z.string().optional(),
  });

export type SchedulePatch = z.infer<typeof schedulePatchSchema>;

export const scheduleRunSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  errorKind: runErrorKindSchema.nullable(),
  costUsd: z.string().nullable(),
});

export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

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

export const attentionSchema = z.object({
  approvals: z.array(attentionItemSchema),
  failedRuns: z.array(attentionItemSchema),
  total: z.number(),
});

export type Attention = z.infer<typeof attentionSchema>;

const DAY_MS = 86_400_000;

/**
 * 统计窗口的唯一口径：最近 days 个 UTC 自然日，起点是 days-1 天前的 UTC 零点。
 * API 的 since、数据库分组和前端补天都从这里推导，避免滚动 24h 跨出 31 个日期。
 */
export function utcWindowStart(days: number, now = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

export function utcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 窗口内每个 UTC 自然日（YYYY-MM-DD），升序。 */
export function recentUtcDays(days: number, now = new Date()): string[] {
  const start = utcWindowStart(days, now).getTime();
  return Array.from({ length: days }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10),
  );
}

export const RETENTION_DEFAULTS = { runDays: 90, messageDays: 30, agentVersions: 50 } as const;

export const retentionSettingsSchema = z.object({
  runDays: z.number().int().positive(),
  messageDays: z.number().int().positive(),
  agentVersions: z.number().int().positive(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

export const retentionUpdateSchema = z.object({
  runDays: z.number().int().positive().max(3650).optional(),
  messageDays: z.number().int().positive().max(3650).optional(),
  agentVersions: z.number().int().positive().max(1000).optional(),
});

export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export type RetentionUpdate = z.infer<typeof retentionUpdateSchema>;

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
