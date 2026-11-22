import { z } from 'zod';
import { accountNameSchema, permissionGrantSchema, roleSummarySchema } from './access.js';
import { runTriggerSchema } from './ops.js';
import { outputShareSchema } from './outputs.js';
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from './pagination.js';
import { runStatusSchema } from './run-state.js';
import { runListItemSchema } from './schemas.js';

export const updatePersonalProfileInputSchema = z
  .object({ name: accountNameSchema })
  .strict()
  .refine((input) => input.name.trim().length > 0, {
    message: '姓名不能只包含空白字符',
    path: ['name'],
  });

export const personalProfileSchema = z.object({
  businessId: z.string(),
  username: z.string(),
  name: z.string(),
});

export type PersonalProfile = z.infer<typeof personalProfileSchema>;

export const authMeSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: personalProfileSchema,
    roles: z.array(roleSummarySchema),
    grants: z.array(permissionGrantSchema),
  }),
]);
export type AuthMe = z.infer<typeof authMeSchema>;

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

const personalPageFields = {
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
};

export const personalShareListQuerySchema = z
  .object({
    ...personalPageFields,
  })
  .strict();

export const personalUsageQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  })
  .strict();

export const personalRunListQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
    agentId: z.string().min(1).optional(),
    status: runStatusSchema.optional(),
    trigger: runTriggerSchema.optional(),
    ...personalPageFields,
  })
  .strict();

export type PersonalRunListQuery = z.infer<typeof personalRunListQuerySchema>;

export const personalRunExportQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(30),
    agentId: z.string().min(1).optional(),
    status: runStatusSchema.optional(),
    trigger: runTriggerSchema.optional(),
  })
  .strict();

export type PersonalRunExportQuery = z.infer<typeof personalRunExportQuerySchema>;

export const personalRunExportSchema = z.object({
  format: z.literal('agentport/personal-usage@1'),
  exportedAt: z.iso.datetime(),
  items: z.array(personalRunSchema),
  truncated: z.boolean(),
});

export type PersonalRunExport = z.infer<typeof personalRunExportSchema>;

export const personalOutputListQuerySchema = z
  .object({
    q: z.string().trim().max(128).optional(),
    limit: personalPageFields.limit,
  })
  .strict();

export const personalOutputItemSchema = z.object({
  conversationId: z.string(),
  conversationTitle: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  runId: z.string(),
  path: z.string(),
  size: z.number(),
  mimeType: z.string(),
  createdAt: z.string(),
});

export type PersonalOutputItem = z.infer<typeof personalOutputItemSchema>;

export const personalOutputListSchema = z.object({
  items: z.array(personalOutputItemSchema),
  truncated: z.boolean(),
});

export type PersonalOutputList = z.infer<typeof personalOutputListSchema>;
