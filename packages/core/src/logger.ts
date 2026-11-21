import type { ErrorCode } from '@agentport/shared';
import pino, { type Logger } from 'pino';

export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'token',
  'apiKey',
  'secret',
  'accessToken',
  'refreshToken',
  'idToken',
  'runToken',
  'password',
  'authorization',
  'cookie',
  '*.apiKey',
  '*.token',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.runToken',
  '*.password',
  '*.authorization',
  '*.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

export type ServiceLoggerInput = {
  service: 'api' | 'worker';
  env: string;
  version: string;
  level: string;
  pretty?: boolean | undefined;
};

export function createServiceLogger(input: ServiceLoggerInput): Logger {
  return pino({
    level: input.level,
    base: { service: input.service, env: input.env, version: input.version },
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
    ...(input.pretty === true
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  });
}

export type LogEventMap = {
  'request completed': { route: string; statusCode: number; responseTime: number };
  'slow request': { route: string; statusCode: number; responseTime: number };
  'request failed': { route: string; statusCode: number; responseTime: number; code: ErrorCode };
  'unhandled error': { code: ErrorCode };
  'run enqueued': { runId: string; queue: string };
  'run failed': { runId: string; attemptsMade: number; code?: ErrorCode };
  'queue error': { queue: string };
  'worker started': Record<string, never>;
  'worker stopped': Record<string, never>;
};

export function logEvent<K extends keyof LogEventMap>(
  log: Logger,
  event: K,
  fields: LogEventMap[K],
  level: 'info' | 'warn' | 'error' = 'info',
  extraFields?: Record<string, unknown>,
): void {
  const merged: Record<string, unknown> =
    extraFields === undefined ? fields : { ...extraFields, ...fields };
  const message = event as string;
  if (level === 'error') log.error(merged, message);
  else if (level === 'warn') log.warn(merged, message);
  else log.info(merged, message);
}

export type RunLogFields = {
  runId: string;
  requestId?: string | undefined;
  agentId?: string | undefined;
  conversationId?: string | undefined;
};

export function runScopedLogger(base: Logger, fields: RunLogFields): Logger {
  const bindings: Record<string, string> = { runId: fields.runId };
  if (fields.requestId !== undefined) bindings.requestId = fields.requestId;
  if (fields.agentId !== undefined) bindings.agentId = fields.agentId;
  if (fields.conversationId !== undefined) bindings.conversationId = fields.conversationId;
  return base.child(bindings);
}

export function requestScopedLogger(base: Logger, requestId: string): Logger {
  return base.child({ requestId });
}
