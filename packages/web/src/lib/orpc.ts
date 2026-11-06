import { agentsContract } from '@agentport/contract/agents';
import { auditContract } from '@agentport/contract/audit';
import { authContract, authNativeContract } from '@agentport/contract/auth';
import { channelsContract } from '@agentport/contract/channels';
import { chatContract } from '@agentport/contract/chat';
import { evalContract } from '@agentport/contract/eval';
import { knowledgeContract } from '@agentport/contract/knowledge';
import { marketContract } from '@agentport/contract/market';
import { memoryContract } from '@agentport/contract/memory';
import { memoryReviewsContract } from '@agentport/contract/memory-reviews';
import { opsContract } from '@agentport/contract/ops';
import { outputSharesContract } from '@agentport/contract/output-shares';
import { overviewContract } from '@agentport/contract/overview';
import { personalContract } from '@agentport/contract/personal';
import { pluginsContract } from '@agentport/contract/plugins';
import { runsContract } from '@agentport/contract/runs';
import { runtimeEnvironmentsContract } from '@agentport/contract/runtime-environments';
import { serversContract } from '@agentport/contract/servers';
import { skillsContract } from '@agentport/contract/skills';
import { problemSchema } from '@agentport/shared';
import { createORPCClient, ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { loginPath } from './auth-redirect.js';

export const contract = {
  agents: agentsContract,
  audit: auditContract,
  auth: { ...authContract, ...authNativeContract },
  channels: channelsContract,
  chat: chatContract,
  eval: evalContract,
  knowledge: knowledgeContract,
  market: marketContract,
  memory: memoryContract,
  memoryReviews: memoryReviewsContract,
  ops: opsContract,
  outputShares: outputSharesContract,
  overview: overviewContract,
  personal: personalContract,
  plugins: pluginsContract,
  runs: runsContract,
  runtimeEnvironments: runtimeEnvironmentsContract,
  servers: serversContract,
  skills: skillsContract,
} as const;

export interface ApiContext {
  idempotencyKey?: string;
}

export type ApiClient = ContractRouterClient<typeof contract, ApiContext>;

interface ApiErrorOptions {
  code?: string;
  retryable?: boolean;
  requestId?: string;
}

function codeForStatus(status: number): string {
  switch (status) {
    case 0:
      return 'NETWORK_ERROR';
    case 400:
      return 'INVALID_INPUT';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'UPSTREAM_FAILED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN';
  }
}

export class ApiError extends ORPCError<string, { requestId?: string; retryable: boolean }> {
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(status: number, message: string, options?: ApiErrorOptions) {
    const retryable = options?.retryable ?? status >= 500;
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
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }
}

export function errorMessage(error: unknown): string {
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

function problemError(body: unknown): ApiError | null {
  const parsed = problemSchema.safeParse(body);
  if (!parsed.success) return null;
  return new ApiError(parsed.data.status, parsed.data.message, {
    code: parsed.data.code,
    retryable: parsed.data.retryable,
    requestId: parsed.data.requestId,
  });
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

const link = new OpenAPILink(contract, {
  url: `${globalThis.location.origin}/api`,
  headers: (options, path) =>
    path.join('.') === 'memoryReviews.create' && options.context.idempotencyKey !== undefined
      ? { 'idempotency-key': options.context.idempotencyKey }
      : {},
  fetch: async (request, init) => {
    let response: Response;
    try {
      response = await fetch(request, { ...init, credentials: 'include' });
    } catch (error) {
      if (request.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError') {
        throw error;
      }
      throw new ApiError(0, '连不上 API 服务，请确认它已启动并检查网络后重试。');
    }
    if (
      response.status === 401 &&
      !new URL(request.url).pathname.startsWith('/api/auth/') &&
      globalThis.location.pathname !== '/login'
    ) {
      const returnTo = `${globalThis.location.pathname}${globalThis.location.search ?? ''}${globalThis.location.hash ?? ''}`;
      globalThis.location.assign(loginPath(returnTo, 'expired'));
      throw new ApiError(401, '登录已失效，请重新登录后再试。');
    }
    return response;
  },
  customErrorResponseBodyDecoder: (body) => problemError(body),
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
