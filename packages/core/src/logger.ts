import pino, { type Logger } from 'pino';

/** 服务日志的唯一脱敏清单；新增凭证类字段只在这里补一次。 */
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
