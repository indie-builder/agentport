import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parseFeed, parseJsonFeed } from 'feedsmith';
import TurndownService from 'turndown';
import { z } from 'zod';

/**
 * External knowledge sources for the worker. This leaf has no DB/shared imports so
 * the ingestion jobs can adopt it without a schema change.
 */
export type SourceConfig = {
  type: 'rss' | 'gitlab' | 'github' | 'feishu';
  url: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  /** Deployment-trusted `host` or `host:port`; only these may resolve to private addresses. */
  trustedHosts?: readonly string[];
  /** Local fixtures only; validateSourceUrl still refuses loopback in production. */
  allowLoopback?: boolean;
};

export type SourceItem = {
  externalId: string;
  title: string;
  path: string;
  sourceUrl: string;
  content: string;
  mimeType: string;
  deleted?: boolean;
};

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

/** Documented Feishu credential/token failures; extend only with codes Feishu documents as auth. */
const FEISHU_AUTH_CODES = new Set([99991661, 99991663, 99991668]);

export type SourceSnapshot = {
  items: SourceItem[];
  cursor: Record<string, unknown>;
  /** False when the source cannot prove it listed everything (feeds roll items off). */
  complete: boolean;
};

export type SourceUrlOptions = {
  allowedOrigins?: string[];
  allowLoopback?: boolean;
  /** Exactly-matched `host` / `host:port` entries that may resolve to private addresses. */
  trustedHosts?: readonly string[];
};

function hostKey(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

/** SourceConfig carries the deployment allowlist; each reader forwards it to every hop. */
function urlOptions(config: SourceConfig): SourceUrlOptions {
  return {
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
  };
}

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_FEISHU_BLOCKS = 50_000;
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

function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
}

type FetchOptions = {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Headers are only sent to this origin, never across a redirect to another host. */
  authOrigin?: string;
  allowLoopback?: boolean;
  trustedHosts?: readonly string[];
  signal?: AbortSignal;
};

async function fetchChecked(raw: string, options: FetchOptions): Promise<Response> {
  let current = new URL(raw);
  const timeout = requestSignal(options.signal);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await validateSourceUrl(current.href, {
      ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }),
      ...(options.trustedHosts?.length ? { trustedHosts: options.trustedHosts } : {}),
    });
    const sendAuth = options.authOrigin !== undefined && current.origin === options.authOrigin;
    // A redirected POST drops its body along with the credentials it carries.
    const method = sendAuth ? (options.method ?? 'GET') : 'GET';
    // 403 的 error body 需要单独读取，给它一条可提前取消的通道。
    const bodyAbort = new AbortController();
    const signal = AbortSignal.any([timeout, bodyAbort.signal]);
    const response = await fetch(current.href, {
      method,
      redirect: 'manual',
      signal,
      ...(method === 'POST' ? { body: options.body ?? '' } : {}),
      headers: {
        'user-agent': 'agentport-source/1.0',
        ...(sendAuth ? options.headers : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error(`redirect without location from ${current.href}`);
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
      if (response.status === 401 || (response.status === 403 && !rateLimited && !bodyUnavailable)) {
        throw new SourceAuthError(message);
      }
      throw new Error(message);
    }
    return response;
  }
  throw new Error(`too many redirects from ${raw}`);
}

async function readCapped(response: Response, label: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return '';
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchText(url: string, options: FetchOptions, label: string): Promise<string> {
  return readCapped(await fetchChecked(url, options), label);
}

async function fetchJson<T>(
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

function textContentType(value: string | null): boolean {
  if (!value) return false;
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, '-')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must never carry control chars
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

function uniquePath(path: string, used: Set<string>, token: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const disambiguated =
    dot > 0 ? `${path.slice(0, dot)} [${token}]${path.slice(dot)}` : `${path} [${token}]`;
  used.add(disambiguated);
  return disambiguated;
}

function contentHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Feed parsing (feedsmith) and body HTML → markdown (turndown).
// Content feeds are always text; anything else in the body is left as text.
// ---------------------------------------------------------------------------

type FeedEntry = { id: string; title: string; link: string; html: string; summary: string };

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form']);

function htmlToMarkdown(input: string): string {
  return turndown
    .turndown(input)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function articleBody(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  const markdown = htmlToMarkdown(article ?? body ?? html);
  if (!markdown) throw new Error('article page had no readable text');
  return markdown;
}

function feedEntries(source: string): { feedTitle: string; entries: FeedEntry[] } {
  // parseFeed regex-scans for XML tags, so JSON bodies containing feed markup must bypass it.
  const parsed = source.trimStart().startsWith('{')
    ? { format: 'json' as const, feed: parseJsonFeed(source) }
    : parseFeed(source);
  if (parsed.format === 'json') {
    const { feed } = parsed;
    const entries = (feed.items ?? []).flatMap((item) => {
      const link = item.url ?? item.external_url ?? '';
      const id = String(item.id ?? '') || link || item.title || '';
      if (!id) return [];
      return [
        {
          id,
          title: item.title ?? '',
          link,
          html: item.content_html ?? item.content_text ?? '',
          summary: item.summary ?? '',
        },
      ];
    });
    return { feedTitle: feed.title ?? '', entries };
  }
  if (parsed.format === 'atom') {
    const { feed } = parsed;
    const entries = (feed.entries ?? []).flatMap((entry) => {
      const id = entry.id || entry.title?.value || '';
      if (!id) return [];
      return [
        {
          id,
          title: entry.title?.value ?? '',
          link:
            entry.links?.find((link) => link.rel === undefined || link.rel === 'alternate')?.href ??
            '',
          html: entry.content?.value ?? '',
          summary: entry.summary?.value ?? '',
        },
      ];
    });
    return { feedTitle: feed.title?.value ?? '', entries };
  }
  const { feed } = parsed;
  const entries = (feed.items ?? []).flatMap((item) => {
    const link = item.link ?? '';
    // RDF has no guid; its id falls back to the link, so an empty link still skips the item.
    const id = ('guid' in item ? item.guid?.value : undefined) ?? link;
    if (!id) return [];
    return [
      {
        id,
        title: item.title ?? '',
        link,
        html: item.content?.encoded || item.description || '',
        summary: item.description ?? '',
      },
    ];
  });
  return { feedTitle: feed.title ?? '', entries };
}

const rssCursorSchema = z.object({
  version: z.literal(1),
  initial: z.boolean(),
  itemHashes: z.record(z.string(), z.string()),
});

const sourceCursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

function parseCursor<T>(
  type: string,
  schema: z.ZodType<T>,
  cursor: Record<string, unknown> | undefined,
): T | undefined {
  // The DB column defaults to {}; that is "first sync", not a malformed cursor.
  if (cursor === undefined || Object.keys(cursor).length === 0) return undefined;
  const parsed = schema.safeParse(cursor);
  if (!parsed.success) {
    throw new Error(`invalid ${type} cursor; start from a cursor returned by readSource`);
  }
  return parsed.data;
}

async function readRss(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('rss', rssCursorSchema, cursor);
  const origins = urlOptions(config);
  const feedUrl = await validateSourceUrl(config.url, origins);
  const feedOrigin = feedUrl.origin;
  const headers = Object.fromEntries(
    Object.entries(config.credentials).filter(([name]) => name.trim() !== ''),
  );

  const request = await fetchChecked(feedUrl.href, {
    headers,
    authOrigin: feedOrigin,
    ...origins,
    ...(signal === undefined ? {} : { signal }),
  });
  const source = await readCapped(request, 'feed');
  const { feedTitle, entries } = feedEntries(source);
  const feedDir = sanitizeSegment(feedTitle, 'feed');

  const usedPaths = new Set<string>();
  const items: SourceItem[] = [];
  const itemHashes: Record<string, string> = {};

  for (const entry of entries) {
    const title = entry.title.trim() || 'untitled';
    const externalId = `${feedUrl.href}:${entry.id}`;

    let body = '';
    if (entry.link) {
      try {
        // fetchChecked re-validates, including every redirect hop.
        const page = await fetchChecked(entry.link, origins);
        const pageType = page.headers.get('content-type');
        // Binary pages are skipped before decoding: UTF-8 would corrupt them.
        if (pageType === null || textContentType(pageType)) {
          body = articleBody(await readCapped(page, 'article'));
        } else {
          await page.body?.cancel();
        }
      } catch {
        // Full-text extraction is best effort; the feed summary is the fallback.
      }
    }
    if (!body) body = htmlToMarkdown(entry.html) || htmlToMarkdown(entry.summary);
    if (!body) body = entry.summary;

    const path = uniquePath(
      `${feedDir}/${sanitizeSegment(title, 'untitled')}.md`,
      usedPaths,
      entry.id,
    );
    itemHashes[externalId] = contentHash(title, body);
    items.push({
      externalId,
      title,
      path,
      sourceUrl: entry.link || feedUrl.href,
      content: body,
      mimeType: 'text/markdown',
    });
  }

  return {
    items,
    cursor: {
      version: 1,
      initial: previous === undefined,
      itemHashes,
    },
    // A feed only exposes a recent window, so its absence never proves deletion.
    complete: false,
  };
}

// ---------------------------------------------------------------------------
// GitLab / GitHub repository files
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.rst',
  '.adoc',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.rst': 'text/plain',
  '.adoc': 'text/plain',
};

const gitlabProjectSchema = z.object({
  id: z.union([z.string(), z.number()]),
  default_branch: z.string().optional(),
  web_url: z.string().optional(),
});

const gitlabTreeEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
});

const gitlabConfigSchema = z.object({
  project: z.union([z.string(), z.number()]).transform(String),
  ref: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function inScope(file: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => file === root || file.startsWith(`${root.replace(/\/+$/, '')}/`));
}

/** Human-facing link: encode each segment (`#`, `?`, spaces) but keep `/` as hierarchy. */
function encodePathSegments(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function readGitlab(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('gitlab', sourceCursorSchema, cursor);
  const settings = gitlabConfigSchema.parse(config.settings);
  const token = config.credentials.token?.trim();
  if (!token) throw new Error('gitlab credentials.token is required');
  const paths = settings.paths ?? [];
  for (const selected of paths) {
    if (selected.startsWith('/') || selected.includes('..')) {
      throw new Error(`gitlab path is not a repository-relative path: ${selected}`);
    }
  }

  const origins = urlOptions(config);
  const base = new URL(await validateSourceUrl(config.url, origins));
  const apiBase = /\/api\/v4\/?$/.test(base.pathname)
    ? base.href.replace(/\/$/, '')
    : `${base.href.replace(/\/$/, '')}/api/v4`;
  const authOrigin = base.origin;
  const headers = { 'private-token': token };
  const fetchOptions = (): FetchOptions => ({
    headers,
    authOrigin,
    ...origins,
    ...(signal === undefined ? {} : { signal }),
  });

  const project = await fetchJson(
    `${apiBase}/projects/${encodeURIComponent(settings.project)}`,
    gitlabProjectSchema,
    fetchOptions(),
    'gitlab project',
  );
  const ref = settings.ref?.trim() || project.default_branch;
  if (!ref) throw new Error('gitlab project has no default branch; set settings.ref');
  const projectId = String(project.id);
  const webUrl = project.web_url ?? `${base.origin}/${settings.project}`;

  const treeEntries: Array<z.infer<typeof gitlabTreeEntrySchema>> = [];
  for (let page = 1; page <= 1000; page += 1) {
    const response = await fetchChecked(
      `${apiBase}/projects/${encodeURIComponent(projectId)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
      fetchOptions(),
    );
    const parsed = z
      .array(gitlabTreeEntrySchema)
      .safeParse(JSON.parse(await readCapped(response, 'gitlab tree')));
    if (!parsed.success) throw new Error('gitlab tree response does not match the expected schema');
    treeEntries.push(...parsed.data);
    const next = Number(response.headers.get('x-next-page') ?? '');
    if (!next) break;
    if (next <= page)
      throw new Error(`gitlab pagination did not advance (page ${page} -> ${next})`);
    if (page === 1000) throw new Error('gitlab tree exceeded 1000 pages');
  }

  const usedPaths = new Set<string>();
  const items: SourceItem[] = [];
  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    const extension = extensionOf(entry.path);
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    if (!inScope(entry.path, paths)) continue;
    const fileUrl = `${apiBase}/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(ref)}`;
    let content = await fetchText(fileUrl, fetchOptions(), 'gitlab file');
    // An emptied file must replace the stored body instead of silently keeping it.
    if (content === '') content = `# ${entry.path}\n`;
    const title = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    items.push({
      externalId: `gitlab:${base.href.replace(/\/$/, '')}:${projectId}:${ref}:${entry.path}`,
      title,
      path: uniquePath(entry.path, usedPaths, entry.path),
      sourceUrl: `${webUrl}/-/blob/${ref}/${entry.path}`,
      content,
      mimeType: MIME_BY_EXTENSION[extension] ?? 'text/plain',
    });
  }

  return {
    items,
    cursor: { version: 1, initial: previous === undefined },
    // The tree was read completely above; any HTTP/pagination failure threw.
    complete: true,
  };
}

// ---------------------------------------------------------------------------
// GitHub repository files
// ---------------------------------------------------------------------------

const GITHUB_DEFAULT_API_BASE = 'https://api.github.com';

const githubRepoSchema = z.object({
  id: z.union([z.string(), z.number()]),
  default_branch: z.string().optional(),
  html_url: z.string().optional(),
});

const githubTreeNodeSchema = z.object({
  path: z.string(),
  type: z.string(),
  sha: z.string(),
  /** `120000` marks a symlink; its blob body is a target path, not file content. */
  mode: z.string().optional(),
});

const githubTreeSchema = z.object({
  tree: z.array(githubTreeNodeSchema),
  truncated: z.boolean().optional(),
});

const githubConfigSchema = z.object({
  project: z.union([z.string(), z.number()]).transform(String),
  ref: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

async function readGithub(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('github', sourceCursorSchema, cursor);
  const settings = githubConfigSchema.parse(config.settings);
  const token = config.credentials.token?.trim();
  if (!token) throw new Error('github credentials.token is required');
  // project 直接拼进 API 路径：只接受 GitHub 合法的 owner/repo 字符，避免 `..`、`?`、`#` 改写路径。
  const project = settings.project.trim();
  const [owner, repoName, ...rest] = project.split('/');
  if (
    rest.length > 0 ||
    !/^[A-Za-z0-9-]+$/.test(owner ?? '') ||
    !/^[A-Za-z0-9._-]+$/.test(repoName ?? '') ||
    repoName === '.' ||
    repoName === '..'
  ) {
    throw new Error(`github project must be owner/repo: ${project}`);
  }
  const paths = settings.paths ?? [];
  for (const selected of paths) {
    if (selected.startsWith('/') || selected.includes('..')) {
      throw new Error(`github path is not a repository-relative path: ${selected}`);
    }
  }

  const origins = urlOptions(config);
  const base = new URL(
    await validateSourceUrl(config.url.trim() || GITHUB_DEFAULT_API_BASE, origins),
  );
  // baseUrl 已是 API 根（github.com 或 GHE 的 /api/v3），不再补路径。
  const apiBase = base.href.replace(/\/$/, '');
  const authOrigin = base.origin;
  const fetchOptions = (accept = 'application/vnd.github+json'): FetchOptions => ({
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
    authOrigin,
    ...origins,
    ...(signal === undefined ? {} : { signal }),
  });

  const repo = await fetchJson(
    `${apiBase}/repos/${project}`,
    githubRepoSchema,
    fetchOptions(),
    'github repository',
  );
  const ref = settings.ref?.trim() || repo.default_branch;
  if (!ref) throw new Error('github repository has no default branch; set settings.ref');
  const repoId = String(repo.id);
  const htmlUrl = (repo.html_url ?? `${base.origin}/${project}`).replace(/\/$/, '');

  const tree = await fetchJson(
    `${apiBase}/repos/${project}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    githubTreeSchema,
    fetchOptions(),
    'github tree',
  );
  // GitHub recursive tree 在 100,000 条处截断；截断时不能假装枚举完整。
  if (tree.truncated === true) {
    throw new Error('仓库树超过 100,000 条，无法完整枚举；请缩小仓库范围');
  }

  const usedPaths = new Set<string>();
  const items: SourceItem[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || entry.mode === '120000') continue;
    const extension = extensionOf(entry.path);
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    if (!inScope(entry.path, paths)) continue;
    let content = await fetchText(
      `${apiBase}/repos/${project}/git/blobs/${encodeURIComponent(entry.sha)}`,
      fetchOptions('application/vnd.github.raw+json'),
      'github file',
    );
    // An emptied file must replace the stored body instead of silently keeping it.
    if (content === '') content = `# ${entry.path}\n`;
    const title = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    items.push({
      externalId: `github:${apiBase}:${repoId}:${ref}:${entry.path}`,
      title,
      path: uniquePath(entry.path, usedPaths, entry.path),
      sourceUrl: `${htmlUrl}/blob/${encodePathSegments(ref)}/${encodePathSegments(entry.path)}`,
      content,
      mimeType: MIME_BY_EXTENSION[extension] ?? 'text/plain',
    });
  }

  return {
    items,
    cursor: { version: 1, initial: previous === undefined },
    // truncated 已在上面明确抛错；能走到这里说明树是完整的。
    complete: true,
  };
}

// ---------------------------------------------------------------------------
// Feishu wiki + Drive (docx blocks, text files)
// ---------------------------------------------------------------------------

const textElementSchema = z
  .object({
    text_run: z
      .object({
        content: z.string().optional(),
        text_element_style: z
          .object({
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
            strikethrough: z.boolean().optional(),
            inline_code: z.boolean().optional(),
            link: z.object({ url: z.string().optional() }).optional(),
          })
          .optional(),
      })
      .optional(),
    mention_user: z.object({}).optional(),
    mention_doc: z.object({ url: z.string().optional() }).optional(),
    equation: z.object({ content: z.string().optional() }).optional(),
  })
  .passthrough();

const blockTextSchema = z.object({ elements: z.array(textElementSchema).optional() }).passthrough();

const docxBlockSchema = z
  .object({
    block_id: z.string(),
    block_type: z.number(),
    parent_id: z.string().optional(),
    children: z.array(z.string()).optional(),
    text: blockTextSchema.optional(),
    heading1: blockTextSchema.optional(),
    heading2: blockTextSchema.optional(),
    heading3: blockTextSchema.optional(),
    heading4: blockTextSchema.optional(),
    heading5: blockTextSchema.optional(),
    heading6: blockTextSchema.optional(),
    heading7: blockTextSchema.optional(),
    heading8: blockTextSchema.optional(),
    heading9: blockTextSchema.optional(),
    bullet: blockTextSchema.optional(),
    ordered: blockTextSchema.optional(),
    code: blockTextSchema.optional(),
    quote: blockTextSchema.optional(),
    todo: blockTextSchema.optional(),
    callout: blockTextSchema.optional(),
    table: z
      .object({
        cells: z.array(z.string()),
        property: z.object({ column_size: z.number().optional() }).optional(),
      })
      .optional(),
    image: z.object({ token: z.string().optional() }).optional(),
    file: z.object({ token: z.string().optional() }).optional(),
    sheet: z.object({ token: z.string().optional() }).optional(),
    bitable: z.object({ token: z.string().optional() }).optional(),
    board: z.object({ token: z.string().optional() }).optional(),
  })
  .passthrough();

const wikiNodeSchema = z
  .object({
    node_token: z.string(),
    obj_token: z.string(),
    obj_type: z.string(),
    title: z.string().optional(),
    has_child: z.boolean().optional(),
    space_id: z.string().optional(),
  })
  .passthrough();

const wikiNodesSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({
    items: z.array(wikiNodeSchema),
    has_more: z.boolean().optional(),
    page_token: z.string().optional(),
  }),
});

const wikiNodeInfoSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ node: wikiNodeSchema }),
});

const docxBlocksSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({
    items: z.array(docxBlockSchema),
    has_more: z.boolean().optional(),
    page_token: z.string().optional(),
  }),
});

const driveFileSchema = z
  .object({
    token: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string().optional(),
    shortcut_info: z
      .object({ target_token: z.string().optional(), target_type: z.string().optional() })
      .optional(),
  })
  .passthrough();

const driveFilesSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({
    files: z.array(driveFileSchema),
    has_more: z.boolean().optional(),
    next_page_token: z.string().optional(),
  }),
});

const tenantTokenSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const feishuSettingsSchema = z.object({
  spaceId: z.string().optional(),
  nodeToken: z.string().optional(),
  folderToken: z.string().optional(),
});

type FeishuSettings = z.infer<typeof feishuSettingsSchema>;
type WikiNode = z.infer<typeof wikiNodeSchema>;
type DocxBlock = z.infer<typeof docxBlockSchema>;
type DriveFile = z.infer<typeof driveFileSchema>;

const CONTAINER_BLOCKS = new Set([19, 24, 25, 33, 34]);

function richText(value: z.infer<typeof blockTextSchema> | undefined): string {
  if (!value?.elements) return '';
  return value.elements
    .map((element) => {
      if (element.text_run) {
        let text = element.text_run.content ?? '';
        const style = element.text_run.text_element_style;
        if (style?.inline_code) text = `\`${text}\``;
        if (style?.bold) text = `**${text}**`;
        if (style?.italic) text = `*${text}*`;
        if (style?.strikethrough) text = `~~${text}~~`;
        if (style?.link?.url) text = `[${text}](${style.link.url})`;
        return text;
      }
      if (element.mention_user) return '@成员';
      if (element.mention_doc?.url) return `[文档](${element.mention_doc.url})`;
      if (element.equation?.content) return `$${element.equation.content}$`;
      return '';
    })
    .join('');
}

function blockText(block: DocxBlock, level: number): string {
  if (level >= 1) {
    const key = `heading${level}` as keyof DocxBlock;
    return richText(block[key] as z.infer<typeof blockTextSchema> | undefined);
  }
  return '';
}

type RenderContext = {
  byId: Map<string, DocxBlock>;
  ordered: Map<string, number>;
};

function renderTable(block: DocxBlock, ctx: RenderContext): string {
  if (!block.table) return '[表格内容缺失]';
  const columns = block.table.property?.column_size ?? 0;
  if (columns <= 0) return '[表格缺少列信息]';
  const cells = block.table.cells;
  const rows: string[][] = [];
  for (let index = 0; index < cells.length; index += columns) {
    const row: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      const cellId = cells[index + column];
      const cell = cellId ? ctx.byId.get(cellId) : undefined;
      const text = (cell?.children ?? [])
        .map((childId) => {
          const child = ctx.byId.get(childId);
          return child ? richText(child.text).trim() : '';
        })
        .filter((entry) => entry !== '')
        .join(' ');
      row.push(text);
    }
    rows.push(row);
  }
  if (rows.length === 0) return '';
  const first = rows[0] ?? [];
  const lines = [`| ${first.join(' | ')} |`, `| ${first.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function renderBlock(block: DocxBlock, ctx: RenderContext): string {
  const container = () =>
    (block.children ?? [])
      .map((childId) => {
        const child = ctx.byId.get(childId);
        return child ? renderBlock(child, ctx) : '';
      })
      .filter((line) => line.trim() !== '')
      .join('\n');

  switch (block.block_type) {
    case 1:
    case 32:
      return '';
    case 2:
      return richText(block.text);
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
      return `${'#'.repeat(block.block_type - 2)} ${blockText(block, block.block_type - 2)}`;
    case 12:
      return `- ${richText(block.bullet)}`;
    case 13: {
      const parent = block.parent_id ?? '';
      const next = (ctx.ordered.get(parent) ?? 0) + 1;
      ctx.ordered.set(parent, next);
      return `${next}. ${richText(block.ordered)}`;
    }
    case 14:
      return `\`\`\`\n${richText(block.code)}\n\`\`\``;
    case 15:
      return `> ${richText(block.quote)}`;
    case 17:
      return `- [ ] ${richText(block.text)}`;
    case 19:
      return [richText(block.callout), container()].filter(Boolean).join('\n');
    case 22:
      return '---';
    case 31:
      return renderTable(block, ctx);
    case 33:
    case 34:
    case 24:
    case 25:
      return container();
    case 27:
      return '[图片未同步]';
    case 23:
      return '[附件未同步]';
    case 30:
      return '[内嵌表格未同步（sheet）]';
    case 18:
      return '[内嵌表格未同步（bitable）]';
    case 43:
      return '[画板未同步]';
    default:
      return `[不支持的块类型 ${block.block_type}]`;
  }
}

function docxToMarkdown(blocks: DocxBlock[]): string {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const consumed = new Set<string>();
  const markConsumed = (id: string): void => {
    if (consumed.has(id)) return;
    consumed.add(id);
    for (const childId of byId.get(id)?.children ?? []) markConsumed(childId);
  };
  for (const block of blocks) {
    if (CONTAINER_BLOCKS.has(block.block_type)) {
      for (const childId of block.children ?? []) markConsumed(childId);
    }
    if (block.block_type === 31) {
      for (const cellId of block.table?.cells ?? []) markConsumed(cellId);
    }
  }

  const ctx: RenderContext = { byId, ordered: new Map() };
  return blocks
    .filter((block) => !consumed.has(block.block_id))
    .map((block) => renderBlock(block, ctx).trim())
    .filter((line) => line !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type FeishuAuth = {
  base: string;
  headers: Record<string, string>;
  origins: SourceUrlOptions;
  signal?: AbortSignal;
};

function feishuFetchOptions(auth: FeishuAuth): FetchOptions {
  return {
    headers: auth.headers,
    authOrigin: new URL(auth.base).origin,
    ...auth.origins,
    ...(auth.signal === undefined ? {} : { signal: auth.signal }),
  };
}

function assertFeishuCode(value: { code: number; msg?: string | undefined }, label: string): void {
  if (value.code === 0) return;
  const message = `feishu ${label} error: code=${value.code} msg=${value.msg ?? ''}`;
  throw FEISHU_AUTH_CODES.has(value.code) ? new SourceAuthError(message) : new Error(message);
}

async function listWikiNodes(
  auth: FeishuAuth,
  spaceId: string,
  parentToken: string | undefined,
): Promise<WikiNode[]> {
  const nodes: WikiNode[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({ page_size: '50' });
    if (parentToken) params.set('parent_node_token', parentToken);
    if (pageToken) params.set('page_token', pageToken);
    const response = await fetchJson(
      `${auth.base}/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${params.toString()}`,
      wikiNodesSchema,
      feishuFetchOptions(auth),
      'feishu wiki nodes',
    );
    assertFeishuCode(response, 'wiki nodes');
    nodes.push(...response.data.items);
    if (!response.data.has_more) return nodes;
    const next = response.data.page_token ?? '';
    if (!next) throw new Error('feishu wiki pagination set has_more without a page_token');
    if (seen.has(next)) throw new Error(`feishu wiki pagination repeated page token ${next}`);
    seen.add(next);
    pageToken = next;
  }
  throw new Error('feishu wiki pagination exceeded 1000 pages');
}

async function getWikiNode(auth: FeishuAuth, nodeToken: string): Promise<WikiNode> {
  const response = await fetchJson(
    `${auth.base}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`,
    wikiNodeInfoSchema,
    feishuFetchOptions(auth),
    'feishu wiki node',
  );
  assertFeishuCode(response, 'wiki node');
  return response.data.node;
}

async function readDocxBlocks(auth: FeishuAuth, documentId: string): Promise<DocxBlock[]> {
  const blocks: DocxBlock[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
    if (pageToken) params.set('page_token', pageToken);
    const response = await fetchJson(
      `${auth.base}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${params.toString()}`,
      docxBlocksSchema,
      feishuFetchOptions(auth),
      'feishu docx blocks',
    );
    assertFeishuCode(response, 'docx blocks');
    if (response.data.items.length === 0) break;
    blocks.push(...response.data.items);
    if (blocks.length >= MAX_FEISHU_BLOCKS) break;
    if (!response.data.has_more) return blocks;
    const next = response.data.page_token ?? '';
    if (!next) throw new Error('feishu docx pagination set has_more without a page_token');
    if (seen.has(next)) throw new Error(`feishu docx pagination repeated page token ${next}`);
    seen.add(next);
    pageToken = next;
  }
  return blocks;
}

async function listDriveFiles(auth: FeishuAuth, folderToken: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < 1000; page += 1) {
    const params = new URLSearchParams({
      folder_token: folderToken,
      page_size: '200',
      order_by: 'EditedTime',
      direction: 'DESC',
    });
    if (pageToken) params.set('page_token', pageToken);
    const response = await fetchJson(
      `${auth.base}/open-apis/drive/v1/files?${params.toString()}`,
      driveFilesSchema,
      feishuFetchOptions(auth),
      'feishu drive files',
    );
    assertFeishuCode(response, 'drive files');
    files.push(...response.data.files);
    if (!response.data.has_more) return files;
    const next = response.data.next_page_token ?? '';
    if (!next) throw new Error('feishu drive pagination set has_more without a next_page_token');
    if (seen.has(next)) throw new Error(`feishu drive pagination repeated page token ${next}`);
    seen.add(next);
    pageToken = next;
  }
  throw new Error('feishu drive pagination exceeded 1000 pages');
}

/** Human-facing Feishu/Lark web base for reference links (API base is a different host). */
function wikiWebBase(apiBase: string): { wiki: string; docx: string } {
  const lark = new URL(apiBase).hostname.endsWith('larksuite.com');
  return lark
    ? { wiki: 'https://larksuite.com/wiki', docx: 'https://larksuite.com/docx' }
    : { wiki: 'https://feishu.cn/wiki', docx: 'https://feishu.cn/docx' };
}

async function readFeishu(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('feishu', sourceCursorSchema, cursor);
  const settings: FeishuSettings = feishuSettingsSchema.parse(config.settings);
  const origins = urlOptions(config);
  const base = config.url.replace(/\/$/, '');
  await validateSourceUrl(base, origins);

  const accessToken = config.credentials.accessToken?.trim();
  let token = accessToken;
  if (!token) {
    // The API stores appId in config and only the secret in encrypted credentials.
    const appId = (config.credentials.appId ?? String(config.settings.appId ?? '')).trim();
    const appSecret = config.credentials.appSecret?.trim();
    if (!appId || !appSecret) {
      throw new Error('feishu credentials must provide accessToken or appId + appSecret');
    }
    const response = await fetchChecked(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      authOrigin: new URL(base).origin,
      ...origins,
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = tenantTokenSchema.safeParse(
      JSON.parse(await readCapped(response, 'feishu token')),
    );
    if (!parsed.success)
      throw new Error('feishu token response does not match the expected schema');
    assertFeishuCode(parsed.data, 'token');
    const exchanged = parsed.data.tenant_access_token;
    if (!exchanged) throw new Error('feishu token response had no tenant_access_token');
    token = exchanged;
  }

  const auth: FeishuAuth = {
    base,
    headers: { authorization: `Bearer ${token}` },
    origins,
    ...(signal === undefined ? {} : { signal }),
  };
  const usedPaths = new Set<string>();
  const items: SourceItem[] = [];

  if (settings.folderToken) {
    if (settings.spaceId || settings.nodeToken) {
      throw new Error('feishu settings must select either a wiki space/node or a drive folder');
    }
    const visited = new Set<string>();
    const walk = async (folderToken: string, prefix: string[]): Promise<void> => {
      if (visited.has(folderToken)) return;
      visited.add(folderToken);
      const files = await listDriveFiles(auth, folderToken);
      for (const file of files) {
        if (file.type === 'folder') {
          const name = sanitizeSegment(file.name, file.token);
          await walk(file.token, [...prefix, name]);
          continue;
        }
        if (file.type === 'shortcut') {
          const target = file.shortcut_info?.target_token;
          const targetType = file.shortcut_info?.target_type;
          if (!target || !targetType || targetType === 'folder') {
            throw new Error(`feishu drive shortcut ${file.token} has no readable target`);
          }
          await emitDriveItem({ ...file, token: target, type: targetType }, prefix);
          continue;
        }
        await emitDriveItem(file, prefix);
      }
    };

    const emitDriveItem = async (file: DriveFile, prefix: string[]): Promise<void> => {
      const title = sanitizeSegment(file.name, file.token);
      if (file.type === 'docx') {
        const blocks = await readDocxBlocks(auth, file.token);
        items.push({
          externalId: `feishu:drive:${file.token}`,
          title,
          path: uniquePath(
            [...prefix, `${sanitizeSegment(file.name, file.token)}.md`].join('/'),
            usedPaths,
            file.token,
          ),
          sourceUrl: file.url ?? `${wikiWebBase(base).docx}/${file.token}`,
          content: docxToMarkdown(blocks),
          mimeType: 'text/markdown',
        });
        return;
      }
      if (file.type === 'file') {
        const response = await fetchChecked(
          `${base}/open-apis/drive/v1/files/${encodeURIComponent(file.token)}/download`,
          feishuFetchOptions(auth),
        );
        const contentType = response.headers.get('content-type');
        if (!textContentType(contentType)) {
          await response.body?.cancel();
          throw new Error(
            `feishu drive file ${file.name} (${file.token}) has unsupported type ${contentType ?? 'unknown'}`,
          );
        }
        items.push({
          externalId: `feishu:drive:${file.token}`,
          title,
          path: uniquePath([...prefix, title].join('/'), usedPaths, file.token),
          sourceUrl: file.url ?? `${base}/open-apis/drive/v1/files/${file.token}`,
          content: await readCapped(response, `feishu drive file ${file.name}`),
          mimeType: contentType?.split(';')[0]?.trim() ?? 'text/plain',
        });
        return;
      }
      throw new Error(
        `feishu drive item ${file.name} (${file.token}) has unsupported type ${file.type}`,
      );
    };

    await walk(settings.folderToken, []);
  } else if (settings.spaceId || settings.nodeToken) {
    const nodeLinks = (node: WikiNode): string =>
      `${wikiWebBase(base).wiki}/${encodeURIComponent(node.node_token)}`;
    const walk = async (node: WikiNode, prefix: string[], spaceId: string): Promise<void> => {
      const title = sanitizeSegment(node.title ?? '', node.node_token);
      if (node.obj_type !== 'docx') {
        throw new Error(
          `feishu wiki node ${node.node_token} "${title}" has unsupported obj_type ${node.obj_type}`,
        );
      }
      const blocks = await readDocxBlocks(auth, node.obj_token);
      items.push({
        externalId: `feishu:wiki:${node.node_token}`,
        title,
        path: uniquePath([...prefix, `${title}.md`].join('/'), usedPaths, node.node_token),
        sourceUrl: nodeLinks(node),
        content: docxToMarkdown(blocks),
        mimeType: 'text/markdown',
      });
      if (node.has_child) {
        for (const childNode of await listWikiNodes(auth, spaceId, node.node_token)) {
          await walk(childNode, [...prefix, title], spaceId);
        }
      }
    };

    if (settings.nodeToken) {
      // A node token is resolvable without listing its space first.
      const root = await getWikiNode(auth, settings.nodeToken);
      const spaceId = settings.spaceId ?? root.space_id;
      if (!spaceId) throw new Error('feishu wiki node did not report a space_id');
      await walk(root, [], spaceId);
    } else if (settings.spaceId) {
      for (const node of await listWikiNodes(auth, settings.spaceId, undefined)) {
        await walk(node, [], settings.spaceId);
      }
    }
  } else {
    throw new Error('feishu settings need spaceId or folderToken');
  }

  return {
    items,
    cursor: { version: 1, initial: previous === undefined },
    // Wiki/Drive listings were walked completely; any failure threw above.
    complete: true,
  };
}

// ---------------------------------------------------------------------------

export async function readSource(
  config: SourceConfig,
  cursor?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SourceSnapshot> {
  switch (config.type) {
    case 'rss':
      return readRss(config, cursor, signal);
    case 'gitlab':
      return readGitlab(config, cursor, signal);
    case 'github':
      return readGithub(config, cursor, signal);
    case 'feishu':
      return readFeishu(config, cursor, signal);
    default:
      throw new Error(`unsupported source type: ${String((config as { type: unknown }).type)}`);
  }
}
