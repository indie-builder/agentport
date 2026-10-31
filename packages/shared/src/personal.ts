import { z } from 'zod';
import { accountNameSchema } from './access.js';
import { runTriggerSchema } from './ops.js';
import { outputShareSchema } from './outputs.js';
import { runListItemSchema, runStatusSchema } from './schemas.js';

/** 个人资料：只允许改显示姓名；身份字段只读。 */
export const updatePersonalProfileInputSchema = z
  .object({ name: accountNameSchema })
  .strict()
  .refine((input) => input.name.trim().length > 0, {
    message: '姓名不能只包含空白字符',
    path: ['name'],
  });

export type UpdatePersonalProfileInput = z.infer<typeof updatePersonalProfileInputSchema>;

export const personalProfileSchema = z.object({
  businessId: z.string(),
  username: z.string(),
  name: z.string(),
});

export type PersonalProfile = z.infer<typeof personalProfileSchema>;

/** 只暴露可展示的会话元数据；token、userId 等认证载体不上 wire。 */
export const personalSessionSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});

export type PersonalSession = z.infer<typeof personalSessionSchema>;

export const personalSessionListSchema = z.object({ items: z.array(personalSessionSchema) });

export type PersonalSessionList = z.infer<typeof personalSessionListSchema>;

/** 我的会话分享：归属来自来源会话本人，列表里 revokedAt 恒为 null。 */
export const personalOutputShareSchema = outputShareSchema.extend({
  conversationId: z.string(),
  conversationTitle: z.string(),
  agentId: z.string(),
});

export type PersonalOutputShare = z.infer<typeof personalOutputShareSchema>;

export const personalOutputShareListSchema = z.object({
  items: z.array(personalOutputShareSchema),
  nextCursor: z.string().nullable(),
});

export type PersonalOutputShareList = z.infer<typeof personalOutputShareListSchema>;

export const personalUsageSummarySchema = z.object({
  days: z.number().int().min(1).max(90),
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  runCount: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  timeout: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.string().nullable(),
  costRecordedRuns: z.number().int().nonnegative(),
  costMissingRuns: z.number().int().nonnegative(),
});

export type PersonalUsageSummary = z.infer<typeof personalUsageSummarySchema>;

export const personalRunSchema = runListItemSchema.extend({
  trigger: runTriggerSchema,
  createdAt: z.iso.datetime(),
  conversationId: z.string().nullable(),
});

export type PersonalRun = z.infer<typeof personalRunSchema>;

export const personalRunListSchema = z.object({
  items: z.array(personalRunSchema),
  nextCursor: z.string().nullable(),
});

export type PersonalRunList = z.infer<typeof personalRunListSchema>;

export const personalShareListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type PersonalShareListQuery = z.infer<typeof personalShareListQuerySchema>;

export const personalUsageQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  })
  .strict();

export type PersonalUsageQuery = z.infer<typeof personalUsageQuerySchema>;

export const personalRunListQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
    agentId: z.string().min(1).optional(),
    status: runStatusSchema.optional(),
    trigger: runTriggerSchema.optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type PersonalRunListQuery = z.infer<typeof personalRunListQuerySchema>;
