import { createHash } from 'node:crypto';
import { parseFeed, parseJsonFeed } from 'feedsmith';
import TurndownService from 'turndown';
import { z } from 'zod';
import { probeConfluence, readConfluence } from './source-confluence.js';
import { probeDingtalk, readDingtalk } from './source-dingtalk.js';
import { probeFeishu, readFeishu } from './source-feishu.js';
import {
  BINARY_MIME_BY_EXTENSION,
  extensionWithDot,
  MIME_BY_EXTENSION,
  textContentType,
} from './source-formats.js';
import {
  type FetchOptions,
  fetchBytes,
  fetchChecked,
  fetchJson,
  fetchText,
  readCapped,
  rethrowAuth,
  sourceNetworkOptions,
  validateSourceUrl,
} from './source-http.js';
import { probeIma, readIma } from './source-ima.js';
import { probeNextcloud, readNextcloud } from './source-nextcloud.js';
import { probeNotion, readNotion } from './source-notion.js';
import { sanitizeSegment, uniquePath } from './source-paths.js';
import { probeSeafile, readSeafile } from './source-seafile.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './source-types.js';
import {
  encodePathSegments,
  failureOf,
  parseCursor,
  signalOption,
  snapshotOf,
  sourceCursorSchema,
} from './source-utils.js';
import { probeYuque, readYuque } from './source-yuque.js';

export { SourceAuthError, validateSourceUrl } from './source-http.js';

function contentHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

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

async function readRss(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  signal?.throwIfAborted();
  const previous = parseCursor('rss', rssCursorSchema, cursor);
  const origins = sourceNetworkOptions(config);
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
    signal?.throwIfAborted();
    const title = entry.title.trim() || 'untitled';
    const externalId = `${feedUrl.href}:${entry.id}`;

    let body = '';
    let completeness: 'full' | 'summary' = 'summary';
    if (entry.link) {
      try {
        const page = await fetchChecked(entry.link, { ...origins, ...(signal ? { signal } : {}) });
        const pageType = page.headers.get('content-type');
        if (pageType === null || textContentType(pageType)) {
          body = articleBody(await readCapped(page, 'article'));
          completeness = 'full';
        } else {
          await page.body?.cancel();
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
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

function inScope(file: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => file === root || file.startsWith(`${root.replace(/\/+$/, '')}/`));
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

  const origins = sourceNetworkOptions(config);
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
    const extension = extensionWithDot(entry.path);
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
      rethrowAuth(err);
      failures.push(failureOf(externalId, title, err, true));
    }
  }

  return snapshotOf(items, failures, previous);
}

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

  const origins = sourceNetworkOptions(config);
  const base = new URL(
    await validateSourceUrl(config.url.trim() || GITHUB_DEFAULT_API_BASE, origins),
  );
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
    const extension = extensionWithDot(entry.path);
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
      rethrowAuth(err);
      failures.push(failureOf(externalId, title, err, true));
    }
  }

  return snapshotOf(items, failures, previous);
}

async function probeRss(config: SourceConfig, signal: AbortSignal | undefined): Promise<void> {
  const signalOptions = signalOption(signal);
  const origins = sourceNetworkOptions(config);
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
}

async function probeGitlab(config: SourceConfig, signal: AbortSignal | undefined): Promise<void> {
  const signalOptions = signalOption(signal);
  const settings = gitlabConfigSchema.parse(config.settings);
  const token = config.credentials.token?.trim();
  if (!token) throw new Error('gitlab credentials.token is required');
  const origins = sourceNetworkOptions(config);
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
}

async function probeGithub(config: SourceConfig, signal: AbortSignal | undefined): Promise<void> {
  const signalOptions = signalOption(signal);
  const settings = githubConfigSchema.parse(config.settings);
  const token = config.credentials.token?.trim();
  if (!token) throw new Error('github credentials.token is required');
  const project = parseGithubProject(settings.project);
  const origins = sourceNetworkOptions(config);
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
}

type SourceHandler = {
  read: (
    config: SourceConfig,
    cursor: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<SourceSnapshot>;
  probe: (config: SourceConfig, signal: AbortSignal | undefined) => Promise<void>;
};

const SOURCE_HANDLERS: Record<string, SourceHandler | undefined> = {
  rss: { read: readRss, probe: probeRss },
  gitlab: { read: readGitlab, probe: probeGitlab },
  github: { read: readGithub, probe: probeGithub },
  feishu: { read: readFeishu, probe: probeFeishu },
  notion: { read: readNotion, probe: probeNotion },
  confluence: { read: readConfluence, probe: probeConfluence },
  yuque: { read: readYuque, probe: probeYuque },
  dingtalk: { read: readDingtalk, probe: probeDingtalk },
  ima: { read: readIma, probe: probeIma },
  seafile: { read: readSeafile, probe: probeSeafile },
  nextcloud: { read: readNextcloud, probe: probeNextcloud },
} satisfies Record<SourceConfig['type'], SourceHandler>;

export async function probeSource(config: SourceConfig, signal?: AbortSignal): Promise<void> {
  const handler = SOURCE_HANDLERS[config.type];
  if (handler === undefined) throw new Error(`unsupported source type: ${String(config.type)}`);
  return handler.probe(config, signal);
}

export async function readSource(
  config: SourceConfig,
  cursor?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SourceSnapshot> {
  const handler = SOURCE_HANDLERS[config.type];
  if (handler === undefined) throw new Error(`unsupported source type: ${String(config.type)}`);
  return handler.read(config, cursor, signal);
}
