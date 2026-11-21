import { apiContract } from '@agentport/contract';
import { errorCodeForStatus } from '@agentport/contract/errors';
import { problemSchema } from '@agentport/shared';
import { createORPCClient, ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { loginPath } from './auth-redirect.js';

export interface ApiContext {
  idempotencyKey?: string;
}

export type ApiClient = ContractRouterClient<typeof apiContract, ApiContext>;

interface ApiErrorOptions {
  code?: string | undefined;
  retryable?: boolean | undefined;
  requestId?: string | undefined;
  hint?: string | undefined;
  path?: string | undefined;
  resource?: string | undefined;
  resourceId?: string | undefined;
  errors?: { path: string; message: string }[] | undefined;
}

function codeForStatus(status: number): string {
  if (status === 0) return 'NETWORK_ERROR';
  const code = errorCodeForStatus(status);
  return code === 'INTERNAL_ERROR' && status < 500 ? 'UNKNOWN' : code;
}

export class ApiError extends ORPCError<string, { requestId?: string; retryable: boolean }> {
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly hint: string | undefined;
  readonly path: string | undefined;
  readonly resource: string | undefined;
  readonly resourceId: string | undefined;
  readonly errors: { path: string; message: string }[] | undefined;

  constructor(status: number, message: string, options?: ApiErrorOptions) {
    const retryable = options?.retryable ?? false;
    super(options?.code ?? codeForStatus(status), {
      status,
      message,
      data: {
        retryable,
        ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
      },
    });
    this.name = 'ApiError';
    this.retryable = retryable;
    this.hint = options?.hint;
    this.path = options?.path;
    this.resource = options?.resource;
    this.resourceId = options?.resourceId;
    this.errors = options?.errors;
    this.requestId = options?.requestId;
  }
}

function errorCopy(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return '请求没有完成，请检查网络后重试。';
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return '连不上 API 服务，请确认它已启动并检查网络后重试。';
    if (error.status === 401) return '登录已失效，请重新登录后再试。';
    if (error.status === 403) return '当前账号没有这个操作的权限，请联系管理员开通。';
    if (error.code === 'CONFLICT_STALE') return '数据已被其他操作修改，请刷新后重试。';
    if (error.code === 'RATE_LIMITED') return '操作太频繁了，请稍等片刻再试。';
    if (error.status < 500 && error.message) return error.message;
    if (error.status >= 500) return '服务端暂时无法完成请求，请稍后重试；持续出现时查看服务日志。';
  }
  if (/^HTTP \d{3}$/.test(error.message)) {
    return '请求没有完成，请稍后重试。';
  }
  return error.message;
}

export function describeError(error: unknown): {
  message: string;
  requestId?: string;
  hint?: string;
} {
  const result: { message: string; requestId?: string; hint?: string } = {
    message: errorCopy(error),
  };
  if (error instanceof ApiError) {
    if (error.requestId !== undefined) result.requestId = error.requestId;
    if (error.hint !== undefined) result.hint = error.hint;
  }
  return result;
}

export function errorMessage(error: unknown): string {
  return describeError(error).message;
}

function problemToApiError(body: unknown, status?: number): ApiError | null {
  const parsed = problemSchema.safeParse(body);
  if (!parsed.success) return null;
  const { code, message, status: bodyStatus, ...rest } = parsed.data;
  return new ApiError(status ?? bodyStatus, message, { code, ...rest });
}

export async function fetchResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted || (error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new ApiError(0, '连不上 API 服务，请确认它已启动并检查网络后重试。');
  }
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetchResponse(input, { ...init, credentials: 'include' });
  const url = input instanceof Request ? input.url : String(input);
  if (
    response.status === 401 &&
    !new URL(url, globalThis.location.origin).pathname.startsWith('/api/auth/') &&
    globalThis.location.pathname !== '/login'
  ) {
    const returnTo = `${globalThis.location.pathname}${globalThis.location.search ?? ''}${globalThis.location.hash ?? ''}`;
    globalThis.location.assign(loginPath(returnTo, 'expired'));
    throw new ApiError(401, '登录已失效，请重新登录后再试。');
  }
  return response;
}

export async function responseApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch((error: unknown) => {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    return null;
  });
  return (
    problemToApiError(body, response.status) ??
    new ApiError(
      response.status,
      typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string'
        ? body.message
        : response.statusText || `HTTP ${response.status}`,
    )
  );
}

function toApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof ORPCError) {
    const data: unknown = error.data;
    const requestId =
      typeof data === 'object' &&
      data !== null &&
      'requestId' in data &&
      typeof data.requestId === 'string'
        ? data.requestId
        : undefined;
    const retryable =
      typeof data === 'object' &&
      data !== null &&
      'retryable' in data &&
      typeof data.retryable === 'boolean'
        ? data.retryable
        : undefined;
    return new ApiError(error.status, error.message, {
      code: error.code,
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryable === undefined ? {} : { retryable }),
    });
  }
  return error;
}

const link = new OpenAPILink(apiContract, {
  url: `${globalThis.location.origin}/api`,
  headers: (options) =>
    options.context.idempotencyKey !== undefined
      ? { 'idempotency-key': options.context.idempotencyKey }
      : {},
  fetch: authenticatedFetch,
  customErrorResponseBodyDecoder: (body) => problemToApiError(body),
  interceptors: [
    async ({ next, ...options }) => {
      try {
        return await next(options);
      } catch (error) {
        throw toApiError(error);
      }
    },
  ],
});

export const rpc: ApiClient = createORPCClient<ApiClient>(link);
