import { createHash } from 'node:crypto';
import { parseFeed, parseJsonFeed } from 'feedsmith';
import TurndownService from 'turndown';
import { z } from 'zod';
import { probeConfluence, readConfluence } from './source-confluence.js';
import { probeDingtalk, readDingtalk } from './source-dingtalk.js';
import {
  type FetchOptions,
  fetchBytes,
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  type SourceUrlOptions,
  validateSourceUrl,
} from './source-http.js';
import { probeIma, readIma } from './source-ima.js';
import { probeNextcloud, readNextcloud } from './source-nextcloud.js';
import { probeNotion, readNotion } from './source-notion.js';
import { probeSeafile, readSeafile } from './source-seafile.js';
import { probeYuque, readYuque } from './source-yuque.js';

export { SourceAuthError, validateSourceUrl } from './source-http.js';
export type { FetchOptions, SourceUrlOptions };

/**
 * External knowledge sources for the worker. This leaf has no DB/shared imports so
 * the ingestion jobs can adopt it without a schema change.
 */
export type SourceConfig = {
  type:
    | 'rss'
    | 'gitlab'
    | 'github'
    | 'feishu'
    | 'notion'
    | 'confluence'
    | 'yuque'
    | 'dingtalk'
    | 'ima'
    | 'seafile'
    | 'nextcloud';
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
  /** 二进制原件；解析器按字节与 MIME 处理，文本来源不使用。 */
  bytes?: Uint8Array;
  mimeType: string;
  /** provider 的真实版本标识（如 last_edited_time）；没有可靠版本时留空，由字节哈希判断变化。 */
  revision?: string;
  deleted?: boolean;
  /** feed 是滚动窗口：全文抓取失败时只剩摘要，摄取层据此不许把已有全文降级。 */
  completeness?: 'full' | 'summary';
};

/** 单个外部条目的持久失败：不阻断其它条目，但本轮不能据此推导删除。 */
export type SourceFailure = {
  externalId: string;
  title: string;
  code: string;
  message: string;
  retryable: boolean;
};

/** 分页上限/空页仍未证明终页：单项失败，不能把截断内容当完整文档发布。 */
class SourceTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceTruncatedError';
  }
}

/** Documented Feishu credential/token failures; extend only with codes Feishu documents as auth. */
const FEISHU_AUTH_CODES = new Set([99991661, 99991663, 99991668]);

export type SourceSnapshot = {
  items: SourceItem[];
  /** 单项失败/不支持：继续读其它条目，但整轮不能算完整枚举。 */
  failures?: SourceFailure[];
  cursor: Record<string, unknown>;
  /** False when the source cannot prove it listed everything (feeds roll items off). */
  complete: boolean;
};

/** SourceConfig carries the deployment allowlist; each reader forwards it to every hop. */
function urlOptions(config: SourceConfig): SourceUrlOptions {
  return {
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
  };
}

const MAX_FEISHU_BLOCKS = 50_000;

async function readCapped(response: Response, label: string): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(response, label));
}

async function fetchText(url: string, options: FetchOptions, label: string): Promise<string> {
  return readCapped(await fetchChecked(url, options), label);
}

function failureOf(
  externalId: string,
  title: string,
  err: unknown,
  retryable: boolean,
): SourceFailure {
  const truncated = err instanceof SourceTruncatedError;
  return {
    externalId,
    title,
    code: truncated ? 'truncated' : retryable ? 'fetch_failed' : 'unsupported_type',
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    retryable: truncated ? false : retryable,
  };
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
    let completeness: 'full' | 'summary' = 'summary';
    if (entry.link) {
      try {
        // fetchChecked re-validates, including every redirect hop.
        const page = await fetchChecked(entry.link, origins);
        const pageType = page.headers.get('content-type');
        // Binary pages are skipped before decoding: UTF-8 would corrupt them.
        if (pageType === null || textContentType(pageType)) {
          body = articleBody(await readCapped(page, 'article'));
          completeness = 'full';
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
      completeness,
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

/** 解析器（Docling/图片）支持的原字节格式；仓库与网盘按 MIME 交给 parser，不在 source 层解码。 */
const BINARY_MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 响应 Content-Type 反查后缀；只认上面两张表里的格式，octet-stream 不是格式证据。 */
const EXTENSION_BY_MIME: Record<string, string> = {};
for (const [extension, mime] of Object.entries({
  ...MIME_BY_EXTENSION,
  ...BINARY_MIME_BY_EXTENSION,
})) {
  EXTENSION_BY_MIME[mime] ??= extension.slice(1);
}

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

/**
 * 下载响应头可能缺失或误报文本；扩展名指向的格式优先，未知原件保持字节交给 parser。
 */
function driveFileMime(fileName: string, contentType: string | null): string {
  const extension = extensionOf(fileName);
  const byExtension = BINARY_MIME_BY_EXTENSION[extension] ?? MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return 'application/octet-stream';
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
  const failures: SourceFailure[] = [];
  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    const extension = extensionOf(entry.path);
    const textMime = MIME_BY_EXTENSION[extension];
    const binaryMime = BINARY_MIME_BY_EXTENSION[extension];
    if (!inScope(entry.path, paths)) continue;
    const externalId = `gitlab:${base.href.replace(/\/$/, '')}:${projectId}:${ref}:${entry.path}`;
    const title = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (!textMime && !binaryMime) {
      failures.push(
        failureOf(
          externalId,
          title,
          new Error(`unsupported file type ${extension || '(none)'}`),
          false,
        ),
      );
      continue;
    }
    const fileUrl = `${apiBase}/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(ref)}`;
    try {
      let content = '';
      let bytes: Uint8Array | undefined;
      if (textMime) {
        content = await fetchText(fileUrl, fetchOptions(), 'gitlab file');
        // An emptied file must replace the stored body instead of silently keeping it.
        if (content === '') content = `# ${entry.path}\n`;
      } else {
        bytes = await fetchBytes(fileUrl, fetchOptions(), 'gitlab file');
      }
      items.push({
        externalId,
        title,
        path: uniquePath(entry.path, usedPaths, entry.path),
        sourceUrl: `${webUrl}/-/blob/${ref}/${entry.path}`,
        content,
        ...(bytes ? { bytes } : {}),
        mimeType: textMime ?? (binaryMime as string),
      });
    } catch (err) {
      if (err instanceof SourceAuthError) throw err;
      failures.push(failureOf(externalId, title, err, true));
    }
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    // The tree was read completely above; any HTTP/pagination failure threw.
    complete: failures.length === 0,
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

function parseGithubProject(value: string): string {
  // project 直接拼进 API 路径：只接受 GitHub 合法的 owner/repo 字符，避免 `..`、`?`、`#` 改写路径。
  const project = value.trim();
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
  return project;
}

async function readGithub(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('github', sourceCursorSchema, cursor);
  const settings = githubConfigSchema.parse(config.settings);
  const token = config.credentials.token?.trim();
  if (!token) throw new Error('github credentials.token is required');
  const project = parseGithubProject(settings.project);
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
  const failures: SourceFailure[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || entry.mode === '120000') continue;
    const extension = extensionOf(entry.path);
    const textMime = MIME_BY_EXTENSION[extension];
    const binaryMime = BINARY_MIME_BY_EXTENSION[extension];
    const externalId = `github:${apiBase}:${repoId}:${ref}:${entry.path}`;
    const title = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (!inScope(entry.path, paths)) continue;
    if (!textMime && !binaryMime) {
      failures.push(
        failureOf(
          externalId,
          title,
          new Error(`unsupported file type ${extension || '(none)'}`),
          false,
        ),
      );
      continue;
    }
    try {
      let content = '';
      let bytes: Uint8Array | undefined;
      if (textMime) {
        content = await fetchText(
          `${apiBase}/repos/${project}/git/blobs/${encodeURIComponent(entry.sha)}`,
          fetchOptions('application/vnd.github.raw+json'),
          'github file',
        );
        // An emptied file must replace the stored body instead of silently keeping it.
        if (content === '') content = `# ${entry.path}\n`;
      } else {
        bytes = await fetchBytes(
          `${apiBase}/repos/${project}/git/blobs/${encodeURIComponent(entry.sha)}`,
          fetchOptions('application/vnd.github.raw+json'),
          'github file',
        );
      }
      items.push({
        externalId,
        title,
        path: uniquePath(entry.path, usedPaths, entry.path),
        sourceUrl: `${htmlUrl}/blob/${encodePathSegments(ref)}/${encodePathSegments(entry.path)}`,
        content,
        ...(bytes ? { bytes } : {}),
        mimeType: textMime ?? (binaryMime as string),
      });
    } catch (err) {
      if (err instanceof SourceAuthError) throw err;
      failures.push(failureOf(externalId, title, err, true));
    }
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    // truncated 已在上面明确抛错；能走到这里说明树是完整的。
    complete: failures.length === 0,
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
    // 缺少终页证据不能当最后一页；字段缺失直接判响应不合契约。
    has_more: z.boolean(),
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
    // 与 wiki 一致：has_more 必须在响应里明确给出。
    has_more: z.boolean(),
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
  /** 由 bridge 固定：Lark 应用与飞书应用互相独立，不能换域名混用 token。 */
  region: z.enum(['feishu', 'lark']).optional(),
  /** Lark 默认把在线文档导出为 docx/xlsx 原件；飞书保持既有 blocks 渲染。 */
  exportFiles: z.boolean().optional(),
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

const feishuEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});

/**
 * 先按公共 code/msg 判错，再校验 data：凭证错误不能因为 data 形状不符被降级成可重试的单项失败。
 */
async function fetchFeishuData<T>(
  url: string,
  dataSchema: z.ZodType<T>,
  options: FetchOptions,
  label: string,
): Promise<T> {
  const envelope = await fetchJson(url, feishuEnvelopeSchema, options, label);
  assertFeishuCode(envelope, label);
  const parsed = dataSchema.safeParse(envelope.data);
  if (!parsed.success) throw new Error(`${label} response does not match the expected schema`);
  return parsed.data;
}

const EXPORT_POLL_INTERVAL_MS = 1_000;
const EXPORT_MAX_POLLS = 60;

/** 在线文档的导出格式；其它类型本契约没有读取链，明确 unsupported。 */
const EXPORT_KINDS: Record<string, { extension: 'docx' | 'xlsx'; mimeType: string }> = {
  doc: {
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  docx: {
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  sheet: {
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  bitable: {
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
};

const exportTaskCreatedDataSchema = z.object({ ticket: z.string().min(1) });

const exportTaskStatusDataSchema = z.object({
  result: z.object({
    job_status: z.number(),
    job_error_msg: z.string().optional(),
    file_token: z.string().optional(),
  }),
});

/** 固定有界轮询；导出任务是异步的，但取消必须能立刻打断等待。 */
function waitForExportPoll(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, EXPORT_POLL_INTERVAL_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withExtension(title: string, extension: string): string {
  return title.toLowerCase().endsWith(`.${extension}`) ? title : `${title}.${extension}`;
}

/** 下载响应里的真实文件名；`filename*=`（RFC 5987）优先于普通 `filename=`。 */
function dispositionFilename(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const extended = /filename\*\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  const encoded = extended?.[1] ?? extended?.[2]?.trim();
  if (encoded) {
    const value = encoded.split("''").at(-1) ?? encoded;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

type DownloadFormat = { mimeType: string; extension: string };

function downloadFormat(extension: string): DownloadFormat | null {
  const mimeType = BINARY_MIME_BY_EXTENSION[extension] ?? MIME_BY_EXTENSION[extension];
  return mimeType ? { extension: extension.slice(1), mimeType } : null;
}

/** 真实下载名优先，其次可信响应类型；同类格式选下载名，非文本与文本冲突时取能确认的一方。 */
function wikiDownloadFormat(
  downloadedName: string | undefined,
  contentType: string | null,
): DownloadFormat | 'conflict' | null {
  const named = downloadedName ? downloadFormat(extensionOf(downloadedName)) : null;
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const declaredExtension = EXTENSION_BY_MIME[mime];
  const declared = declaredExtension ? { extension: declaredExtension, mimeType: mime } : null;
  if (!named) return declared;
  if (!declared || named.mimeType === declared.mimeType) return named;
  const namedText = textContentType(named.mimeType);
  const declaredText = textContentType(declared.mimeType);
  if (namedText === declaredText) return namedText ? named : 'conflict';
  // 文本响应头常是误报，非文本响应才更接近真实原件。
  return declaredText ? named : declared;
}

/** 标题只提供展示名；没有任何下载元数据时，明确的二进制后缀才可作为格式线索。 */
function titleBinaryFormat(title: string): DownloadFormat | null {
  const extension = extensionOf(title);
  return BINARY_MIME_BY_EXTENSION[extension] ? downloadFormat(extension) : null;
}

function withFormatExtension(title: string, extension: string): string {
  const current = extensionOf(title);
  return `${current ? title.slice(0, -current.length) : title}.${extension}`;
}

/**
 * Lark 在线文档导出：POST 建任务拿 ticket，轮询 ticket 拿 file_token，再按 file_token 下载。
 * ticket 与 file_token 是不同标识，不能拿其中一个当另一个。
 */
async function exportFeishuFile(
  auth: FeishuAuth,
  objToken: string,
  objType: string,
  signal: AbortSignal | undefined,
  label: string,
): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
  const kind = EXPORT_KINDS[objType];
  if (!kind) throw new Error(`unsupported export type ${objType}`);

  const created = await fetchFeishuData(
    `${auth.base}/open-apis/drive/v1/export_tasks`,
    exportTaskCreatedDataSchema,
    {
      ...feishuFetchOptions(auth),
      method: 'POST',
      body: JSON.stringify({
        token: objToken,
        type: objType,
        file_extension: kind.extension,
      }),
      headers: {
        ...auth.headers,
        'content-type': 'application/json; charset=utf-8',
      },
    },
    `${label} export task`,
  );
  const ticket = created.ticket;

  for (let poll = 0; poll < EXPORT_MAX_POLLS; poll += 1) {
    const status = await fetchFeishuData(
      `${auth.base}/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}?token=${encodeURIComponent(objToken)}`,
      exportTaskStatusDataSchema,
      feishuFetchOptions(auth),
      `${label} export status`,
    );
    const result = status.result;
    // 0 成功；1 新建、2 处理中；其它状态都是失败。
    if (result.job_status !== 0) {
      if (result.job_status === 1 || result.job_status === 2) {
        await waitForExportPoll(signal);
        continue;
      }
      throw new Error(
        `${label} export failed: ${result.job_error_msg ?? `job_status=${result.job_status}`}`,
      );
    }
    if (!result.file_token) throw new Error(`${label} export finished without a file_token`);
    const bytes = await fetchBytes(
      `${auth.base}/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(result.file_token)}/download`,
      { ...feishuFetchOptions(auth), authFailure: 'item' },
      `${label} export download`,
    );
    return { bytes, mimeType: kind.mimeType, extension: kind.extension };
  }
  throw new Error(`${label} export did not finish after ${EXPORT_MAX_POLLS} polls`);
}

async function listWikiNodes(
  auth: FeishuAuth,
  spaceId: string,
  parentToken: string | undefined,
  maxPages = 1000,
  firstPageOnly = false,
): Promise<WikiNode[]> {
  const nodes: WikiNode[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < maxPages; page += 1) {
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
    const pageItems = response.data.items;
    // 空页仍声称有下一页：没有终页证据，也不能把这份列表当完整枚举。
    if (pageItems.length === 0 && response.data.has_more) {
      throw new Error('feishu wiki pagination returned an empty page with has_more');
    }
    nodes.push(...pageItems);
    // 探测只验证首屏；正常同步仍要求枚举到终页。
    if (firstPageOnly) return nodes;
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
    if (response.data.items.length === 0) {
      // 空页仍声称有下一页：没有终页证据，不能把已读内容当完整文档。
      if (response.data.has_more) {
        throw new SourceTruncatedError('feishu docx blocks returned an empty page with has_more');
      }
      return blocks;
    }
    blocks.push(...response.data.items);
    if (!response.data.has_more) return blocks;
    if (blocks.length >= MAX_FEISHU_BLOCKS) {
      throw new SourceTruncatedError(
        `feishu docx blocks truncated at the ${MAX_FEISHU_BLOCKS} block limit`,
      );
    }
    const next = response.data.page_token ?? '';
    if (!next) throw new Error('feishu docx pagination set has_more without a page_token');
    if (seen.has(next)) throw new Error(`feishu docx pagination repeated page token ${next}`);
    seen.add(next);
    pageToken = next;
  }
  throw new SourceTruncatedError('feishu docx pagination exceeded 1000 pages');
}

async function listDriveFiles(
  auth: FeishuAuth,
  folderToken: string,
  maxPages = 1000,
  firstPageOnly = false,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  let pageToken = '';
  for (let page = 0; page < maxPages; page += 1) {
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
    const pageFiles = response.data.files;
    // 与 wiki 一致：空页 + has_more 没有终页证据，立即失败而不是当完整列表。
    if (pageFiles.length === 0 && response.data.has_more) {
      throw new Error('feishu drive pagination returned an empty page with has_more');
    }
    files.push(...pageFiles);
    // 探测只验证首屏；正常同步仍要求枚举到终页。
    if (firstPageOnly) return files;
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

const FEISHU_API_BASE = 'https://open.feishu.cn';
const LARK_API_BASE = 'https://open.larksuite.com';

/** Lark 应用与飞书应用互相独立：region 只由 bridge 固定，配置不能改接口域名。 */
function feishuApiBase(config: SourceConfig, settings: FeishuSettings): string {
  const base = settings.region === 'lark' ? LARK_API_BASE : config.url || FEISHU_API_BASE;
  return base.replace(/\/$/, '');
}

async function feishuAuthFor(
  config: SourceConfig,
  settings: FeishuSettings,
  signal: AbortSignal | undefined,
): Promise<{ auth: FeishuAuth; base: string }> {
  const origins = urlOptions(config);
  const base = feishuApiBase(config, settings);
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

  return {
    base,
    auth: {
      base,
      headers: { authorization: `Bearer ${token}` },
      origins,
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

async function readFeishu(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('feishu', sourceCursorSchema, cursor);
  const settings: FeishuSettings = feishuSettingsSchema.parse(config.settings);
  const { auth, base } = await feishuAuthFor(config, settings, signal);
  // Lark 与飞书的条目身份必须隔离：同名 token 不能跨云互认。
  const namespace = settings.region === 'lark' ? 'lark' : 'feishu';
  const exportFiles = settings.exportFiles === true;
  const usedPaths = new Set<string>();
  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];

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
          await walk(file.token, [...prefix, sanitizeSegment(file.name, file.token)]);
          continue;
        }
        if (file.type === 'shortcut') {
          const target = file.shortcut_info?.target_token;
          const targetType = file.shortcut_info?.target_type;
          if (!target || !targetType) {
            failures.push(
              failureOf(
                `${namespace}:drive:${file.token}`,
                sanitizeSegment(file.name, file.token),
                new Error(`shortcut ${file.token} has no readable target`),
                false,
              ),
            );
            continue;
          }
          // 目录快捷方式按真实目标递归；visited 负责断开环。
          if (targetType === 'folder') {
            await walk(target, prefix);
            continue;
          }
          await emitDriveItem({ ...file, token: target, type: targetType }, prefix);
          continue;
        }
        await emitDriveItem(file, prefix);
      }
    };

    const emitDriveItem = async (file: DriveFile, prefix: string[]): Promise<void> => {
      const baseTitle = sanitizeSegment(file.name, file.token);
      const externalId = `${namespace}:drive:${file.token}`;
      const sourceUrl = file.url ?? `${wikiWebBase(base).docx}/${file.token}`;
      const exportKind = EXPORT_KINDS[file.type];
      if (exportFiles && exportKind) {
        try {
          const exported = await exportFeishuFile(
            auth,
            file.token,
            file.type,
            signal,
            `feishu drive ${file.token}`,
          );
          const title = withExtension(baseTitle, exported.extension);
          items.push({
            externalId,
            title,
            path: uniquePath([...prefix, title].join('/'), usedPaths, file.token),
            sourceUrl,
            content: '',
            bytes: exported.bytes,
            mimeType: exported.mimeType,
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
        return;
      }
      if (file.type === 'docx') {
        // 既有飞书默认：docx blocks → markdown；Lark 走 exportFiles 分支。
        try {
          const blocks = await readDocxBlocks(auth, file.token);
          items.push({
            externalId,
            title: baseTitle,
            path: uniquePath([...prefix, `${baseTitle}.md`].join('/'), usedPaths, file.token),
            sourceUrl,
            content: docxToMarkdown(blocks),
            mimeType: 'text/markdown',
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
        return;
      }
      if (file.type === 'file') {
        try {
          const response = await fetchChecked(
            `${base}/open-apis/drive/v1/files/${encodeURIComponent(file.token)}/download`,
            { ...feishuFetchOptions(auth), authFailure: 'item' },
          );
          // 原件必须按字节保留：缺 MIME 或误报文本时也不能 UTF-8 解码。
          const contentType = response.headers.get('content-type');
          items.push({
            externalId,
            title: baseTitle,
            path: uniquePath([...prefix, baseTitle].join('/'), usedPaths, file.token),
            sourceUrl,
            content: '',
            bytes: await readBytesCapped(response, `feishu drive file ${file.name}`),
            mimeType: driveFileMime(file.name, contentType),
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
        return;
      }
      failures.push(
        failureOf(externalId, baseTitle, new Error(`unsupported drive type ${file.type}`), false),
      );
    };

    await walk(settings.folderToken, []);
  } else if (settings.spaceId || settings.nodeToken) {
    const nodeLinks = (node: WikiNode): string =>
      `${wikiWebBase(base).wiki}/${encodeURIComponent(node.node_token)}`;
    const walk = async (node: WikiNode, prefix: string[], spaceId: string): Promise<void> => {
      const baseTitle = sanitizeSegment(node.title ?? '', node.node_token);
      const externalId = `${namespace}:wiki:${node.node_token}`;
      const exportKind = EXPORT_KINDS[node.obj_type];
      if (exportFiles && exportKind) {
        try {
          const exported = await exportFeishuFile(
            auth,
            node.obj_token,
            node.obj_type,
            signal,
            `feishu wiki ${node.node_token}`,
          );
          const title = withExtension(baseTitle, exported.extension);
          items.push({
            externalId,
            title,
            path: uniquePath([...prefix, title].join('/'), usedPaths, node.node_token),
            sourceUrl: nodeLinks(node),
            content: '',
            bytes: exported.bytes,
            mimeType: exported.mimeType,
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
      } else if (exportFiles && node.obj_type === 'file') {
        try {
          const response = await fetchChecked(
            `${base}/open-apis/drive/v1/files/${encodeURIComponent(node.obj_token)}/download`,
            { ...feishuFetchOptions(auth), authFailure: 'item' },
          );
          const downloadedName = dispositionFilename(response.headers.get('content-disposition'));
          const metadata = wikiDownloadFormat(downloadedName, response.headers.get('content-type'));
          if (metadata === 'conflict') {
            failures.push(
              failureOf(
                externalId,
                baseTitle,
                new Error(`feishu wiki file ${node.node_token} download name and type disagree`),
                false,
              ),
            );
            return;
          }
          const format = metadata ?? titleBinaryFormat(baseTitle);
          if (!format) {
            failures.push(
              failureOf(
                externalId,
                baseTitle,
                new Error(`feishu wiki file ${node.node_token} has no trustworthy download format`),
                false,
              ),
            );
            return;
          }
          const title = withFormatExtension(baseTitle, format.extension);
          items.push({
            externalId,
            title,
            path: uniquePath([...prefix, title].join('/'), usedPaths, node.node_token),
            sourceUrl: nodeLinks(node),
            content: '',
            bytes: await readBytesCapped(response, `feishu wiki file ${node.node_token}`),
            mimeType: format.mimeType,
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
      } else if (!exportFiles && node.obj_type === 'docx') {
        try {
          const blocks = await readDocxBlocks(auth, node.obj_token);
          items.push({
            externalId,
            title: baseTitle,
            path: uniquePath([...prefix, `${baseTitle}.md`].join('/'), usedPaths, node.node_token),
            sourceUrl: nodeLinks(node),
            content: docxToMarkdown(blocks),
            mimeType: 'text/markdown',
          });
        } catch (err) {
          if (err instanceof SourceAuthError || signal?.aborted) throw err;
          failures.push(failureOf(externalId, baseTitle, err, true));
        }
      } else {
        failures.push(
          failureOf(
            externalId,
            baseTitle,
            new Error(`unsupported obj_type ${node.obj_type}`),
            false,
          ),
        );
      }
      if (node.has_child) {
        for (const childNode of await listWikiNodes(auth, spaceId, node.node_token)) {
          await walk(childNode, [...prefix, baseTitle], spaceId);
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
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    // 任何单项失败都不能证明完整枚举，删除推导据此关闭。
    complete: failures.length === 0,
  };
}

// ---------------------------------------------------------------------------

/**
 * 远程连通性探测：只核凭证与范围首项，不导入条目、不推进游标。
 * 任何一步失败都抛错，由调用方记入该 range 的检查结果。
 */
export async function probeSource(config: SourceConfig, signal?: AbortSignal): Promise<void> {
  const signalOptions = signal === undefined ? {} : { signal };
  switch (config.type) {
    case 'rss': {
      const origins = urlOptions(config);
      const feedUrl = await validateSourceUrl(config.url, origins);
      const headers = Object.fromEntries(
        Object.entries(config.credentials).filter(([name]) => name.trim() !== ''),
      );
      const response = await fetchChecked(feedUrl.href, {
        headers,
        authOrigin: feedUrl.origin,
        ...origins,
        ...signalOptions,
      });
      feedEntries(await readCapped(response, 'feed'));
      return;
    }
    case 'gitlab': {
      const settings = gitlabConfigSchema.parse(config.settings);
      const token = config.credentials.token?.trim();
      if (!token) throw new Error('gitlab credentials.token is required');
      const origins = urlOptions(config);
      const base = new URL(await validateSourceUrl(config.url, origins));
      const apiBase = /\/api\/v4\/?$/.test(base.pathname)
        ? base.href.replace(/\/$/, '')
        : `${base.href.replace(/\/$/, '')}/api/v4`;
      const options: FetchOptions = {
        headers: { 'private-token': token },
        authOrigin: base.origin,
        ...origins,
        ...signalOptions,
      };
      const project = await fetchJson(
        `${apiBase}/projects/${encodeURIComponent(settings.project)}`,
        gitlabProjectSchema,
        options,
        'gitlab project',
      );
      const ref = settings.ref?.trim() || project.default_branch;
      if (!ref) throw new Error('gitlab project has no default branch; set settings.ref');
      await fetchChecked(
        `${apiBase}/projects/${encodeURIComponent(String(project.id))}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=1&page=1`,
        options,
      );
      return;
    }
    case 'github': {
      const settings = githubConfigSchema.parse(config.settings);
      const token = config.credentials.token?.trim();
      if (!token) throw new Error('github credentials.token is required');
      const project = parseGithubProject(settings.project);
      const origins = urlOptions(config);
      const base = new URL(
        await validateSourceUrl(config.url.trim() || GITHUB_DEFAULT_API_BASE, origins),
      );
      const apiBase = base.href.replace(/\/$/, '');
      const options: FetchOptions = {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        authOrigin: base.origin,
        ...origins,
        ...signalOptions,
      };
      const repo = await fetchJson(
        `${apiBase}/repos/${project}`,
        githubRepoSchema,
        options,
        'github repository',
      );
      const ref = settings.ref?.trim() || repo.default_branch;
      if (!ref) throw new Error('github repository has no default branch; set settings.ref');
      const tree = await fetchJson(
        `${apiBase}/repos/${project}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        githubTreeSchema,
        options,
        'github tree',
      );
      if (tree.truncated === true) throw new Error('仓库树超过 100,000 条，无法完整枚举');
      return;
    }
    case 'feishu': {
      const settings: FeishuSettings = feishuSettingsSchema.parse(config.settings);
      const { auth } = await feishuAuthFor(config, settings, signal);
      if (settings.folderToken) {
        if (settings.spaceId || settings.nodeToken) {
          throw new Error('feishu settings must select either a wiki space/node or a drive folder');
        }
        await listDriveFiles(auth, settings.folderToken, 1, true);
        return;
      }
      if (settings.nodeToken) {
        await getWikiNode(auth, settings.nodeToken);
        return;
      }
      if (settings.spaceId) {
        await listWikiNodes(auth, settings.spaceId, undefined, 1, true);
        return;
      }
      throw new Error('feishu settings need spaceId or folderToken');
    }
    case 'notion':
      return probeNotion(config, signal);
    case 'confluence':
      return probeConfluence(config, signal);
    case 'yuque':
      return probeYuque(config, signal);
    case 'dingtalk':
      return probeDingtalk(config, signal);
    case 'ima':
      return probeIma(config, signal);
    case 'seafile':
      return probeSeafile(config, signal);
    case 'nextcloud':
      return probeNextcloud(config, signal);
    default:
      throw new Error(`unsupported source type: ${String((config as { type: unknown }).type)}`);
  }
}

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
    case 'notion':
      return readNotion(config, cursor, signal);
    case 'confluence':
      return readConfluence(config, cursor, signal);
    case 'yuque':
      return readYuque(config, cursor, signal);
    case 'dingtalk':
      return readDingtalk(config, cursor, signal);
    case 'ima':
      return readIma(config, cursor, signal);
    case 'seafile':
      return readSeafile(config, cursor, signal);
    case 'nextcloud':
      return readNextcloud(config, cursor, signal);
    default:
      throw new Error(`unsupported source type: ${String((config as { type: unknown }).type)}`);
  }
}
