import { z } from 'zod';
import { chatEventSchema, sandboxTaskSchema } from './chat.js';
import { sandboxInputCommandSchema } from './questions.js';

export const SUPERVISOR_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const SUPERVISOR_CANCEL_GRACE_MS = 5_000;
export const APPROVAL_RUN_ID_HEADER = 'x-agentport-run-id';

const runIdSchema = z.string().min(1);

export const supervisorInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    runId: runIdSchema,
    task: sandboxTaskSchema,
    env: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal('input'),
    runId: runIdSchema,
    command: sandboxInputCommandSchema,
  }),
  z.object({
    type: z.literal('cancel'),
    runId: runIdSchema,
  }),
]);

export type SupervisorInput = z.infer<typeof supervisorInputSchema>;
export type SupervisorInputFrame = z.input<typeof supervisorInputSchema>;

export const supervisorOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('started'), runId: runIdSchema }),
  z.object({ type: z.literal('event'), runId: runIdSchema, event: chatEventSchema }),
  z.object({ type: z.literal('stderr'), runId: runIdSchema, text: z.string() }),
  z.object({
    type: z.literal('settled'),
    runId: runIdSchema,
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    stopped: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('rejected'),
    runId: z.string(),
    code: z.enum(['BUSY', 'NOT_ACTIVE', 'INVALID_COMMAND', 'SPAWN_FAILED']),
    message: z.string(),
  }),
]);

export type SupervisorOutput = z.infer<typeof supervisorOutputSchema>;

export const SESSION_CLEANUP_REQUEST_CHANNEL = 'session-cleanup:requests';
const SESSION_CLEANUP_ACK_PREFIX = 'session-cleanup:ack:';
export const SESSION_CLEANUP_TIMEOUT_MS = 10_000;

export function sessionCleanupAckChannel(requestId: string): string {
  return `${SESSION_CLEANUP_ACK_PREFIX}${requestId}`;
}

export const sessionCleanupTargetSchema = z.object({
  conversationId: z.string().min(1),
  sandboxIds: z.array(z.string().min(1)),
});

export type SessionCleanupTarget = z.infer<typeof sessionCleanupTargetSchema>;

export const sessionCleanupRequestSchema = z.object({
  requestId: z.string().min(1),
  deadline: z.number().int().positive(),
  targets: z.array(sessionCleanupTargetSchema).min(1),
});

export type SessionCleanupRequest = z.infer<typeof sessionCleanupRequestSchema>;

export const sessionCleanupAckSchema = z.discriminatedUnion('ok', [
  z.object({ requestId: z.string().min(1), ok: z.literal(true) }),
  z.object({ requestId: z.string().min(1), ok: z.literal(false), error: z.string() }),
]);

export type SessionCleanupAck = z.infer<typeof sessionCleanupAckSchema>;

export type ExecutionSettlement =
  | { state: 'stopped'; code: number | null; signal: string | null }
  | { state: 'unconfirmed'; error: string };
