import { z } from 'zod';
import { runTriggerSchema } from './ops.js';
import { runStatusSchema } from './run-state.js';
import { utf8Bytes } from './utf8.js';

const MAX_MESSAGE_BYTES = 64 * 1024;

const messageSchema = z
  .string()
  .min(1, '请输入消息')
  .refine((value) => utf8Bytes(value) <= MAX_MESSAGE_BYTES, '消息不能超过 64KiB');

export const integrationScopeSchema = z.enum(['runs.create', 'runs.read']);
export type IntegrationScope = z.infer<typeof integrationScopeSchema>;

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(integrationScopeSchema),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const apiTokenCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(integrationScopeSchema)
      .min(1, '至少选择一个权限范围')
      .refine((scopes) => new Set(scopes).size === scopes.length, '权限范围不能重复'),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export type ApiTokenCreateInput = z.infer<typeof apiTokenCreateInputSchema>;

export const apiTokenCreateResultSchema = apiTokenSchema.extend({ token: z.string() });
export type ApiTokenCreateResult = z.infer<typeof apiTokenCreateResultSchema>;

export const webhookEventTypeSchema = z.enum([
  'run.completed',
  'run.failed',
  'approval.requested',
  'budget.alert',
]);
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;

export const webhookDirectionSchema = z.enum(['inbound', 'outbound']);
export type WebhookDirection = z.infer<typeof webhookDirectionSchema>;

export const webhookEndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  direction: webhookDirectionSchema,
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  url: z.string().nullable(),
  events: z.array(webhookEventTypeSchema),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

const httpUrlSchema = z
  .string()
  .url('请输入合法的 URL')
  .refine((value) => /^https?:\/\//.test(value), 'URL 必须使用 http 或 https');

export const webhookEndpointCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    direction: webhookDirectionSchema,
    agentId: z.string().min(1).optional(),
    url: httpUrlSchema.optional(),
    events: z.array(webhookEventTypeSchema).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.direction === 'inbound') {
      if (!input.agentId) {
        ctx.addIssue({ code: 'custom', path: ['agentId'], message: '入站端点必须选择专家' });
      }
      if (input.url !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: '入站端点不能配置 URL' });
      }
      if (input.events !== undefined && input.events.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['events'], message: '入站端点不订阅事件' });
      }
      return;
    }
    if (!input.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: '出站端点必须配置 URL' });
    }
    if (!input.events || input.events.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['events'], message: '至少订阅一个事件' });
    }
    if (input.agentId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['agentId'], message: '出站端点不能绑定专家' });
    }
  });
export type WebhookEndpointCreateInput = z.infer<typeof webhookEndpointCreateInputSchema>;

export const webhookEndpointCreateResultSchema = webhookEndpointSchema.extend({
  secret: z.string(),
});
export type WebhookEndpointCreateResult = z.infer<typeof webhookEndpointCreateResultSchema>;

export const externalRunInputSchema = z
  .object({
    agentId: z.string().min(1),
    message: messageSchema,
    conversationId: z.string().min(1).optional(),
  })
  .strict();
export type ExternalRunInput = z.infer<typeof externalRunInputSchema>;

export const externalRunAcceptedSchema = z.object({
  runId: z.string(),
  conversationId: z.string(),
  status: runStatusSchema,
  replayed: z.boolean().optional(),
});

export const externalRunStatusSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  agentId: z.string(),
  conversationId: z.string(),
  trigger: runTriggerSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  turns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type ExternalRunStatus = z.infer<typeof externalRunStatusSchema>;

export const inboundWebhookPayloadSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    message: messageSchema,
    conversationId: z.string().min(1).optional(),
  })
  .strict();
export type InboundWebhookPayload = z.infer<typeof inboundWebhookPayloadSchema>;
