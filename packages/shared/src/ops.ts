import { z } from 'zod';
import { runErrorKindSchema, runStatusSchema } from './run-state.js';

export const MAINTENANCE_QUEUE = 'maintenance';

export const auditActorKindSchema = z.enum(['user', 'service', 'anonymous', 'agent']);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

export const auditStatusSchema = z.enum(['ok', 'error', 'denied']);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

export const scheduleMissedPolicySchema = z.enum(['skip', 'run_once']);
export type ScheduleMissedPolicy = z.infer<typeof scheduleMissedPolicySchema>;

export const runTriggerSchema = z.enum(['chat', 'mcp', 'schedule', 'event', 'review', 'channel']);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

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
  missedPolicy: scheduleMissedPolicySchema.default('skip'),
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
  missedPolicy: scheduleMissedPolicySchema,
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
export const schedulePatchSchema = scheduleInputSchema.omit({ agentId: true }).partial().extend({
  enabled: z.boolean().optional(),
  timezone: scheduleTimezoneSchema.optional(),
  missedPolicy: scheduleMissedPolicySchema.optional(),
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

export const memoryFileSchema = z.object({
  name: z.string(),
  size: z.number(),
  updatedAt: z.string().nullable(),
});

export type MemoryFile = z.infer<typeof memoryFileSchema>;

export const memoryFileListSchema = z.object({
  files: z.array(memoryFileSchema),
  initialized: z.boolean(),
});

export type MemoryFileList = z.infer<typeof memoryFileListSchema>;

export const memoryFileContentSchema = z.object({
  name: z.string(),
  content: z.string(),
  updatedAt: z.string().nullable(),
});

export type MemoryFileContent = z.infer<typeof memoryFileContentSchema>;

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

export function utcWindowStart(days: number, now = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

export function utcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
  daily: z.array(z.object({ day: z.string(), runs: z.number(), cost: z.number() })),
});
