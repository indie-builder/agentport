import { ERROR_META, type ErrorCode } from '@agentport/shared';
import { NOT_FOUND_MESSAGES, type NotFoundResource } from './domain-messages.js';

export interface AppErrorOptions {
  path?: string | undefined;
  resource?: string | undefined;
  resourceId?: string | undefined;
  hint?: string | undefined;
  cause?: unknown;
  retryable?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly path?: string;
  readonly resource?: string;
  readonly resourceId?: string;
  readonly hint?: string;
  readonly cause?: unknown;
  readonly extra?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: AppErrorOptions) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_META[code].status;
    this.retryable = options?.retryable ?? ERROR_META[code].retryable;
    if (options?.path !== undefined) this.path = options.path;
    if (options?.resource !== undefined) this.resource = options.resource;
    if (options?.resourceId !== undefined) this.resourceId = options.resourceId;
    if (options?.hint !== undefined) this.hint = options.hint;
    if (options?.cause !== undefined) this.cause = options.cause;
    if (options?.extra !== undefined) this.extra = options.extra;
  }
}

export function fail(code: ErrorCode, message: string, options?: AppErrorOptions): never {
  throw new AppError(code, message, options);
}

export function invalidInput(message: string, path: string): never {
  return fail('INVALID_INPUT', message, { path });
}

export function notFound(resource: NotFoundResource, message?: string, resourceId?: string): never {
  throw new AppError('NOT_FOUND', message ?? NOT_FOUND_MESSAGES[resource], {
    resource,
    ...(resourceId === undefined ? {} : { resourceId }),
  });
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
