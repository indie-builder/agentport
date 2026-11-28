import { z } from 'zod';
import { HTTP_URL_ONLY_MESSAGE } from '../errors.js';
import { parseUrl } from '../url.js';

export function isSafeOpenUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

const actionPayload = {
  params: z.record(z.string(), z.unknown()).default({}),
  message: z
    .string()
    .min(1)
    .max(64 * 1024),
  context: z.unknown().optional(),
  formState: z.record(z.string(), z.unknown()).optional(),
  formName: z.string().max(256).optional(),
  messageId: z.string().min(1).optional(),
  blockKey: z.string().min(1).max(256).optional(),
};

export const openUiActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue_conversation'), ...actionPayload }),
  z.object({
    type: z.literal('open_url'),
    ...actionPayload,
    params: z.object({ url: z.string().refine(isSafeOpenUrl, HTTP_URL_ONLY_MESSAGE) }),
  }),
]);
export type OpenUiAction = z.infer<typeof openUiActionSchema>;

export const openUiActionPartSchema = z.object({
  type: z.literal('openui_action'),
  context: z.unknown().optional(),
  formState: z.record(z.string(), z.unknown()).optional(),
  formName: z.string().optional(),
});

export const openUiStateEnvelopeSchema = z.object({
  version: z.literal(1),
  blocks: z.record(z.string(), z.unknown()),
});

export const OPENUI_STATE_MAX_BYTES = 64 * 1024;
export const OPENUI_STATE_TOTAL_MAX_BYTES = 256 * 1024;

export interface OpenUiPromptOptions {
  examples: readonly string[];
  additionalRules: readonly string[];
}

export interface OpenUiToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export const openUiToolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), data: z.unknown() }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({ status: z.literal('approval_required'), approvalId: z.string() }),
]);
export type OpenUiToolResult = z.infer<typeof openUiToolResultSchema>;
