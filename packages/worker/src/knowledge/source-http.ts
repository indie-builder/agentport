import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { z } from 'zod';

/**
 * 所有外部来源共用的 HTTP 信任边界：SSRF/DNS 检查、跨域去凭证、响应大小与超时。
 * 叶来源模块只调用这里，不复制第二套实现。
 */
export type SourceUrlOptions = {
  allowedOrigins?: string[];
  allowLoopback?: boolean;
  /** Exactly-matched `host` / `host:port` entries that may resolve to private addresses. */
  trustedHosts?: readonly string[];
};

function hostKey(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** An error body only classifies the failure; never let a stalled one hold the request. */
const ERROR_BODY_TIMEOUT_MS = 2_000;

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['192.0.0.0', 24],
  ['192.88.99.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];
const PRIVATE_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
];

const privateV4 = new BlockList();
for (const [network, prefix] of PRIVATE_V4) privateV4.addSubnet(network, prefix, 'ipv4');
const privateV6 = new BlockList();
for (const [network, prefix] of PRIVATE_V6) privateV6.addSubnet(network, prefix, 'ipv6');

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

function isLoopbackAddress(ip: string): boolean {
  const bare = stripBrackets(ip).toLowerCase();
  const embedded = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
  if (embedded) return embedded.startsWith('127.');
  if (isIP(bare) === 4) return bare.startsWith('127.');
  if (isIP(bare) === 6) return bare === '::1';
  return bare === 'localhost';
}

function isPrivateAddress(ip: string): boolean {
  const bare = stripBrackets(ip);
  const embedded = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1];
  if (embedded) return privateV4.check(embedded, 'ipv4');
  if (isIP(bare) === 4) return privateV4.check(bare, 'ipv4');
  if (isIP(bare) === 6) return privateV6.check(bare, 'ipv6');
  return true;
}

/**
 * http(s) only, no URL credentials, and (unless allowLoopback) never a private address.
 * allowedOrigins must be exact origins; `https://host/path` is rejected instead of
 * silently allowing a whole host. trustedHosts is deployment config (env), never user
 * config: an exact `host`/`host:port` match lets a private host through. DNS rebinding
 * between check and fetch needs a network-level egress allowlist; this is the
 * app-level guard.
 */
export async function validateSourceUrl(raw: string, options: SourceUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid source URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`source URL must use http or https: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error('source URL must not contain credentials; put them in credentials');
  }

  if (options.allowedOrigins) {
    const origins = options.allowedOrigins.map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`allowedOrigins entry is not a URL: ${origin}`);
      }
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username) {
        throw new Error(`allowedOrigins entries must be exact origins: ${origin}`);
      }
      return parsed.origin;
    });
    if (!origins.includes(url.origin)) {
      throw new Error(`source URL origin is not allowed: ${url.origin}`);
    }
  }

  const host = stripBrackets(url.hostname);
  // Explicit opt-in for local fixtures; production never accepts loopback.
  if (options.allowLoopback && process.env.NODE_ENV !== 'production' && isLoopbackAddress(host)) {
    return url;
  }
  if (options.trustedHosts?.includes(hostKey(url))) return url;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new Error(`cannot resolve source host: ${host}`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`source host resolves to a private address: ${host}`);
  }
  return url;
}

/**
 * Credentials or permissions were revoked (HTTP 401/403, documented Feishu tenant-token codes).
 * Distinct from network/timeout/rate-limit failures, which must never disable a source.
 */
export class SourceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAuthError';
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
}

export type FetchOptions = {
  method?: 'GET' | 'POST' | 'PROPFIND';
  body?: string;
  headers?: Record<string, string>;
  /** Headers are only sent to this origin, never across a redirect to another host. */
  authOrigin?: string;
  /**
   * `source` (default) treats 401/403 as revoked credentials; `item` keeps them as a
   * per-item failure because signed download URLs expire and file ACLs differ.
   */
  authFailure?: 'source' | 'item';
  allowLoopback?: boolean;
  trustedHosts?: readonly string[];
  signal?: AbortSignal;
};

/** 路由/hop-by-hop 头会改变请求目标或长度，供应商下载头只允许普通业务头。 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
]);

function checkedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new Error(`request header ${name} is not allowed`);
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('request headers must not contain CR/LF');
    }
  }
  return headers;
}

export async function fetchChecked(raw: string, options: FetchOptions): Promise<Response> {
  const requestHeaders = checkedHeaders(options.headers);
  let current = new URL(raw);
  // 错误信息只带 origin + pathname：签名 URL 的 query 不能进日志。
  const sourceLabel = `${current.origin}${current.pathname}`;
  // Once a redirect leaves the bound origin, credentials never come back even if a
  // later hop returns to that origin (A -> B -> A).
  let authTainted = false;
  const timeout = requestSignal(options.signal);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await validateSourceUrl(current.href, {
      ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }),
      ...(options.trustedHosts?.length ? { trustedHosts: options.trustedHosts } : {}),
    });
    if (options.authOrigin !== undefined && current.origin !== options.authOrigin) {
      authTainted = true;
    }
    const sendAuth =
      options.authOrigin !== undefined && !authTainted && current.origin === options.authOrigin;
    // A redirected POST/PROPFIND drops its body along with the credentials it carries.
    const method = sendAuth ? (options.method ?? 'GET') : 'GET';
    // 403 的 error body 需要单独读取，给它一条可提前取消的通道。
    const bodyAbort = new AbortController();
    const signal = AbortSignal.any([timeout, bodyAbort.signal]);
    const response = await fetch(current.href, {
      method,
      redirect: 'manual',
      signal,
      ...(sendAuth && method !== 'GET' ? { body: options.body ?? '' } : {}),
      headers: {
        'user-agent': 'agentport-source/1.0',
        ...(sendAuth ? requestHeaders : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`redirect without location from ${sourceLabel}`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      let body = '';
      // 403 的 body 读不完就不能判定为撤权：既可能藏着次级限流说明，也可能是网络问题。
      let bodyUnavailable = false;
      if (response.status === 403) {
        const stop = setTimeout(() => bodyAbort.abort(), ERROR_BODY_TIMEOUT_MS);
        try {
          body = await readCapped(response, 'error response');
        } catch (error) {
          // 调用方取消必须保留取消语义，不能被当成来源失败。
          if (options.signal?.aborted) throw options.signal.reason ?? error;
          bodyUnavailable = true;
        } finally {
          clearTimeout(stop);
        }
      } else {
        await response.body?.cancel();
      }
      const retryAfter = response.headers.get('retry-after');
      // GitHub 限流与权限不足同为 403：只有限流信号存在时才算可重试的普通错误。
      // 次级限流不带 retry-after、配额也没耗尽，只能在 body 里识别。
      const rateLimited =
        response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          retryAfter !== null ||
          /secondary rate limit|abuse detection/i.test(body));
      const retry = rateLimited && retryAfter ? ` (retry after ${retryAfter}s)` : '';
      const message = `HTTP ${response.status} from ${current.origin}${current.pathname}${retry}`;
      if (
        (response.status === 401 ||
          (response.status === 403 && !rateLimited && !bodyUnavailable)) &&
        options.authFailure !== 'item'
      ) {
        throw new SourceAuthError(message);
      }
      throw new Error(message);
    }
    return response;
  }
  throw new Error(`too many redirects from ${sourceLabel}`);
}

export async function readCapped(response: Response, label: string): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(response, label));
}

export async function readBytesCapped(response: Response, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Break first: cancelling a stream that for-await still holds throws.
      response.body.cancel().catch(() => undefined);
      throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchText(url: string, options: FetchOptions, label: string): Promise<string> {
  return readCapped(await fetchChecked(url, options), label);
}

export async function fetchBytes(
  url: string,
  options: FetchOptions,
  label: string,
): Promise<Buffer> {
  return readBytesCapped(await fetchChecked(url, options), label);
}

export async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  options: FetchOptions,
  label: string,
): Promise<T> {
  const text = await fetchText(url, options, label);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} response does not match the expected schema`);
  }
  return parsed.data;
}
