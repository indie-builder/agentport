import { z } from 'zod';

export const providerErrorKindSchema = z.enum([
  'network',
  'timeout',
  'rate_limit',
  'auth',
  'upstream',
  'content_blocked',
]);
export type ProviderErrorKind = z.infer<typeof providerErrorKindSchema>;

export function providerErrorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  return 'upstream';
}

export const modelProviderProtocolSchema = z.literal('anthropic');

const modelProviderCredentialSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7E]+$/, '凭证只能包含可见 ASCII 字符');

export const modelProviderHealthSchema = z.object({
  state: z.enum(['unknown', 'healthy', 'unhealthy']),
  checkedAt: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
});

export const modelProviderUsageSchema = z.object({
  providerId: z.string(),
  requests: z.number().int(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  budgetUsd: z.number().nullable(),
  budgetRatio: z.number().nullable(),
});
export type ModelProviderUsage = z.infer<typeof modelProviderUsageSchema>;

export const modelProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: modelProviderProtocolSchema,
  baseUrl: z.string(),
  models: z.array(z.string()),
  priority: z.number().int(),
  enabled: z.boolean(),
  monthlyBudgetUsd: z.number().nullable(),
  alertRatio: z.number(),
  hasCredential: z.boolean(),
  health: modelProviderHealthSchema,
  usage: modelProviderUsageSchema.omit({
    providerId: true,
    budgetUsd: true,
    budgetRatio: true,
  }),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export const modelProviderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  protocol: modelProviderProtocolSchema.default('anthropic'),
  baseUrl: z.string().url(),
  credential: modelProviderCredentialSchema,
  models: z.array(z.string().min(1)).min(1).max(50),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  monthlyBudgetUsd: z.number().min(0).nullable().default(null),
  alertRatio: z.number().min(0).max(1).default(0.8),
});
export type ModelProviderCreate = z.infer<typeof modelProviderCreateSchema>;

export const modelProviderUpdateSchema = modelProviderCreateSchema.partial().extend({
  protocol: modelProviderProtocolSchema.optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  alertRatio: z.number().min(0).max(1).optional(),
  credential: modelProviderCredentialSchema.optional(),
});
export type ModelProviderUpdate = z.infer<typeof modelProviderUpdateSchema>;

export const modelProviderTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().nullable(),
  message: z.string(),
  models: z.array(z.string()),
});
export type ModelProviderTestResult = z.infer<typeof modelProviderTestResultSchema>;
