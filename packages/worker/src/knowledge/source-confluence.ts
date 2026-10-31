import { z } from 'zod';
import {
  type FetchOptions,
  fetchBytes,
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import { uniquePath } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * Confluence Cloud (basic/scoped token) and Data Center (PAT) leaf reader.
 *
 * The rendered `body.view` HTML goes to the existing HTML parser as bytes, so
 * storage-format macros are not flattened by a second converter here. Ranges are
 * a space or a page subtree; page identity is the provider page ID and
 * attachments use the attachment ID (never the fileId).
 */

const PAGE_SIZE = 250;
const DC_PAGE_SIZE = 100;
const MAX_PAGES = 1000;

const settingsSchema = z.object({
  authMode: z.enum(['cloud_basic', 'cloud_scoped', 'dc_pat']),
  email: z.string().optional(),
  cloudId: z.string().optional(),
  rangeKind: z.enum(['confluence_space', 'confluence_page']),
  resourceId: z.string().trim().min(1),
  siteUrl: z.string().trim().optional(),
});

type Settings = z.infer<typeof settingsSchema>;

type Network = {
  allowLoopback?: boolean;
  trustedHosts?: readonly string[];
};

type Auth = {
  settings: Settings;
  site: URL;
  /** REST API root: `<site>/wiki`/`/rest/api`, or the scoped gateway. */
  apiRoot: URL;
  apiOrigin: string;
  authorization: string;
  network: Network;
};

const cursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

const spaceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  key: z.string().optional(),
  name: z.string().optional(),
});

const cloudPageSummarySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  // Folder entries are not pages and need not carry a title.
  title: z.string().optional(),
  status: z.string().optional(),
  spaceId: z.union([z.string(), z.number()]).transform(String).optional(),
  type: z.string().optional(),
  contentType: z.string().optional(),
});

const cloudPageDetailSchema = cloudPageSummarySchema.extend({
  title: z.string(),
  version: z.object({ number: z.number().optional() }).optional(),
  body: z.object({ view: z.object({ value: z.string() }).optional() }).optional(),
  _links: z.object({ webui: z.string().optional() }).optional(),
});

const cloudPageListSchema = z.object({
  results: z.array(cloudPageSummarySchema),
  _links: z.object({ next: z.string().optional() }).optional(),
});

const cloudFolderSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.string().optional(),
  status: z.string().optional(),
  spaceId: z.union([z.string(), z.number()]).transform(String).optional(),
});

const cloudAttachmentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().optional(),
  mediaType: z.string().optional(),
  fileId: z.string().optional(),
  fileSize: z.number().optional(),
  version: z.object({ number: z.number().optional() }).optional(),
  _links: z.object({ download: z.string().optional(), webui: z.string().optional() }).optional(),
});

const cloudAttachmentListSchema = z.object({
  results: z.array(cloudAttachmentSchema),
  _links: z.object({ next: z.string().optional() }).optional(),
});

const dcPageSummarySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  space: spaceSchema.optional(),
});

const dcPageDetailSchema = dcPageSummarySchema.extend({
  version: z.object({ number: z.number().optional() }).optional(),
  body: z.object({ view: z.object({ value: z.string() }).optional() }).optional(),
  _links: z.object({ webui: z.string().optional() }).optional(),
});

const dcPageListSchema = z.object({
  results: z.array(dcPageSummarySchema),
  _links: z.object({ next: z.string().optional() }).optional(),
});

const dcSpaceListSchema = z.object({
  results: z.array(spaceSchema),
  _links: z.object({ next: z.string().optional() }).optional(),
});

const dcAttachmentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().optional(),
  metadata: z.object({ mediaType: z.string().optional() }).optional(),
  version: z.object({ number: z.number().optional() }).optional(),
  _links: z.object({ download: z.string().optional() }).optional(),
});

const dcAttachmentListSchema = z.object({
  results: z.array(dcAttachmentSchema),
  _links: z.object({ next: z.string().optional() }).optional(),
});

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
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
};

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

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
};

class ItemError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ItemError';
  }
}

function networkOptions(config: SourceConfig): Network {
  return {
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireValue(value: string | undefined, message: string): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') throw new Error(message);
  return trimmed;
}

async function authenticate(config: SourceConfig): Promise<Auth> {
  const settings = settingsSchema.parse(config.settings);
  const network = networkOptions(config);
  const site = new URL(await validateSourceUrl(settings.siteUrl || config.url, network));
  if (site.search || site.hash) {
    throw new Error('confluence site URL must not contain a query or fragment');
  }
  const siteBase = `${site.origin}${trimSlash(site.pathname)}`;
  let apiRoot: URL;
  if (settings.authMode === 'cloud_scoped') {
    const cloudId = requireValue(
      settings.cloudId,
      'confluence cloudId is required for scoped tokens',
    );
    apiRoot = new URL(
      `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}/wiki/api/v2`,
    );
  } else if (settings.authMode === 'dc_pat') {
    apiRoot = new URL(`${siteBase}/rest/api`);
  } else {
    const restBase = site.pathname.replace(/\/+$/, '').endsWith('/wiki')
      ? siteBase
      : `${siteBase}/wiki`;
    apiRoot = new URL(`${restBase}/api/v2`);
  }

  let authorization: string;
  if (settings.authMode === 'dc_pat') {
    const pat = requireValue(config.credentials.pat, 'confluence credentials.pat is required');
    authorization = `Bearer ${pat}`;
  } else {
    const email = requireValue(settings.email, 'confluence email is required for Cloud tokens');
    const token = requireValue(
      config.credentials.apiToken,
      'confluence credentials.apiToken is required',
    );
    authorization = `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
  }

  return {
    settings,
    site: new URL(siteBase),
    apiRoot,
    apiOrigin: apiRoot.origin,
    authorization,
    network,
  };
}

function jsonOptions(auth: Auth, signal: AbortSignal | undefined): FetchOptions {
  return {
    headers: { authorization: auth.authorization, accept: 'application/json' },
    authOrigin: auth.apiOrigin,
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

function downloadOptions(auth: Auth, signal: AbortSignal | undefined): FetchOptions {
  return {
    headers: { authorization: auth.authorization },
    authOrigin: auth.apiOrigin,
    authFailure: 'item',
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

function pageApiUrl(auth: Auth, suffix: string): string {
  return `${auth.apiRoot.href}${suffix}`;
}

/**
 * Page links may only stay on the bound API origin and under its REST context;
 * a provider link must never become a request to another origin.
 */
function checkedNextUrl(link: string, auth: Auth, label: string): string {
  const url = new URL(link, auth.apiRoot);
  if (url.origin !== auth.apiOrigin) {
    throw new Error(`${label} pagination left the API origin`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} pagination URL contains credentials`);
  }
  const prefix = trimSlash(auth.apiRoot.pathname);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error(`${label} pagination left the API context path`);
  }
  return url.href;
}

/** Data Center `_links.next` is application-relative to the deployment context. */
function resolveProviderLink(link: string, auth: Auth): URL {
  if (auth.settings.authMode === 'dc_pat' && link.startsWith('/') && !link.startsWith('//')) {
    const context = trimSlash(auth.site.pathname);
    if (context !== '' && link.startsWith(`${context}/`)) {
      return new URL(link, auth.site.origin);
    }
    return new URL(`${auth.site.origin}${context}${link}`);
  }
  return new URL(link, auth.apiRoot);
}

function nextPageUrl(link: string, base: URL, auth: Auth, label: string): string {
  if (link.trim() === '') throw new Error(`${label} returned an empty next link`);
  const checked = checkedNextUrl(resolveProviderLink(link, auth).href, auth, label);
  const url = new URL(checked);
  // Only the endpoint being paginated may be continued: a provider link must
  // not switch the request to another API resource.
  if (url.pathname !== base.pathname) {
    throw new Error(`${label} pagination used an unexpected endpoint`);
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor === null) return url.href;
  // Rebuild the known endpoint from the cursor instead of fetching a
  // provider-supplied URL; the origin, context and endpoint are already checked.
  const rebuilt = new URL(base.href);
  rebuilt.searchParams.delete('cursor');
  rebuilt.searchParams.set('cursor', cursor);
  return rebuilt.href;
}

type Envelope<T> = { results: T[]; next?: string };

async function collect<T>(
  first: string,
  auth: Auth,
  label: string,
  read: (url: string) => Promise<Envelope<T>>,
): Promise<T[]> {
  const base = new URL(checkedNextUrl(first, auth, label));
  const out: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = base.href;
  for (let page = 0; next !== undefined; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`${label} exceeded ${MAX_PAGES} pages`);
    const url = next;
    if (seen.has(url)) throw new Error(`${label} pagination repeated a page`);
    seen.add(url);
    const envelope = await read(url);
    out.push(...envelope.results);
    next = envelope.next === undefined ? undefined : nextPageUrl(envelope.next, base, auth, label);
    if (next !== undefined && envelope.results.length === 0) {
      throw new Error(`${label} returned an empty page before the end`);
    }
  }
  return out;
}

function nextFromLinkHeader(headers: Headers): string | undefined {
  const value = headers.get('link');
  if (!value) return undefined;
  for (const part of value.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (!match) continue;
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i.exec(match[2] ?? '');
    const relations = (rel?.[1] ?? rel?.[2])?.split(/\s+/);
    if (relations?.includes('next')) return match[1];
  }
  return undefined;
}

/** Cloud list endpoints may paginate through the Link header instead of `_links.next`. */
async function fetchJsonWithNext<T>(
  url: string,
  schema: z.ZodType<T>,
  options: FetchOptions,
  label: string,
): Promise<{ data: T; next?: string }> {
  const response = await fetchChecked(url, options);
  const text = new TextDecoder().decode(await readBytesCapped(response, label));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} response does not match the expected schema`);
  const next = nextFromLinkHeader(response.headers);
  return { data: parsed.data, ...(next === undefined ? {} : { next }) };
}

function failureOf(externalId: string, title: string, err: unknown): SourceFailure {
  const itemError = err instanceof ItemError ? err : undefined;
  return {
    externalId,
    title,
    code: itemError?.code ?? 'fetch_failed',
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    retryable: itemError?.retryable ?? true,
  };
}

function rethrowAuth(err: unknown): void {
  if (err instanceof SourceAuthError) throw err;
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot).toLowerCase();
}

function mimeOfFile(name: string, declared: string | undefined): string | undefined {
  const extension = extensionOf(name);
  const byExtension = BINARY_MIME_BY_EXTENSION[extension] ?? TEXT_MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const mime = declared?.split(';')[0]?.trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && EXTENSION_BY_MIME[mime]) return mime;
  return undefined;
}

function filenameOf(title: string | undefined, id: string, mime: string | undefined): string {
  const clean = sanitizeSegment(title ?? '', `attachment-${id}`);
  if (extensionOf(clean)) return clean;
  const extension = mime ? EXTENSION_BY_MIME[mime] : undefined;
  return extension ? `${clean}.${extension}` : clean;
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

function humanUrl(webui: string | undefined, site: URL): string {
  if (!webui) return '';
  try {
    const url = new URL(webui, site);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function pageBodyHtml(
  page: z.infer<typeof cloudPageDetailSchema> | z.infer<typeof dcPageDetailSchema>,
): string {
  const html = page.body?.view?.value;
  if (html === undefined) {
    throw new ItemError(
      'confluence page did not return a rendered body.view',
      'fetch_failed',
      true,
    );
  }
  return html;
}

function revisionOf(
  page: z.infer<typeof cloudPageDetailSchema> | z.infer<typeof dcPageDetailSchema>,
): string | undefined {
  const number = page.version?.number;
  return number === undefined ? undefined : String(number);
}

async function fetchSpace(
  auth: Auth,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof spaceSchema>> {
  const resourceId = auth.settings.resourceId;
  if (auth.settings.authMode !== 'dc_pat') {
    return fetchJson(
      pageApiUrl(auth, `/spaces/${encodeURIComponent(resourceId)}`),
      spaceSchema,
      jsonOptions(auth, signal),
      'confluence space',
    );
  }
  // The DC space endpoint is keyed by space key, while external ranges carry the
  // numeric space ID: resolve the key through the official space list first.
  const first = pageApiUrl(auth, `/space?start=0&limit=${DC_PAGE_SIZE}`);
  const listed = await collect(first, auth, 'confluence spaces', async (url) => {
    const body = await fetchJson(
      url,
      dcSpaceListSchema,
      jsonOptions(auth, signal),
      'confluence spaces',
    );
    return {
      results: body.results,
      ...(body._links?.next === undefined ? {} : { next: body._links.next }),
    };
  });
  const key = listed.find((space) => space.id === resourceId)?.key?.trim();
  if (!key) throw new Error(`confluence space ${resourceId} was not found in the space list`);
  const metadata = await fetchJson(
    pageApiUrl(auth, `/space/${encodeURIComponent(key)}`),
    spaceSchema,
    jsonOptions(auth, signal),
    'confluence space',
  );
  if (metadata.id !== resourceId || metadata.key !== key) {
    throw new Error(`confluence space ${resourceId} did not match its space metadata`);
  }
  return metadata;
}

async function fetchCloudPage(
  auth: Auth,
  id: string,
  signal: AbortSignal | undefined,
  withBody: boolean,
): Promise<z.infer<typeof cloudPageDetailSchema>> {
  return fetchJson(
    pageApiUrl(auth, `/pages/${encodeURIComponent(id)}${withBody ? '?body-format=view' : ''}`),
    cloudPageDetailSchema,
    jsonOptions(auth, signal),
    'confluence page',
  );
}

async function fetchCloudFolder(
  auth: Auth,
  id: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof cloudFolderSchema>> {
  return fetchJson(
    pageApiUrl(auth, `/folders/${encodeURIComponent(id)}`),
    cloudFolderSchema,
    jsonOptions(auth, signal),
    'confluence folder',
  );
}

async function fetchDcPage(
  auth: Auth,
  id: string,
  signal: AbortSignal | undefined,
  withBody: boolean,
): Promise<z.infer<typeof dcPageDetailSchema>> {
  const expand = withBody ? 'body.view,version,space' : 'version,space';
  return fetchJson(
    pageApiUrl(auth, `/content/${encodeURIComponent(id)}?expand=${expand}`),
    dcPageDetailSchema,
    jsonOptions(auth, signal),
    'confluence page',
  );
}

async function listCloudPages(
  auth: Auth,
  id: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof cloudPageSummarySchema>[]> {
  const resourceId = encodeURIComponent(id);
  const first = pageApiUrl(
    auth,
    `/spaces/${resourceId}/pages?status=current&depth=all&limit=${PAGE_SIZE}`,
  );
  return collect(first, auth, 'confluence space pages', async (url) => {
    const { data, next } = await fetchJsonWithNext(
      url,
      cloudPageListSchema,
      jsonOptions(auth, signal),
      'confluence space pages',
    );
    const providerNext = data._links?.next ?? next;
    return {
      results: data.results,
      ...(providerNext === undefined ? {} : { next: providerNext }),
    };
  });
}

async function listDcPages(
  auth: Auth,
  spaceKey: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof dcPageSummarySchema>[]> {
  const first = pageApiUrl(
    auth,
    `/space/${encodeURIComponent(spaceKey)}/content/page?start=0&limit=${DC_PAGE_SIZE}&expand=space,version`,
  );
  return collect(first, auth, 'confluence space pages', async (url) => {
    const body = await fetchJson(
      url,
      dcPageListSchema,
      jsonOptions(auth, signal),
      'confluence space pages',
    );
    return {
      results: body.results,
      ...(body._links?.next === undefined ? {} : { next: body._links.next }),
    };
  });
}

async function listChildPages(
  auth: Auth,
  parentId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof cloudPageSummarySchema>[]> {
  const first = pageApiUrl(
    auth,
    `/pages/${encodeURIComponent(parentId)}/direct-children?limit=${PAGE_SIZE}`,
  );
  return collect(first, auth, 'confluence page children', async (url) => {
    const { data, next } = await fetchJsonWithNext(
      url,
      cloudPageListSchema,
      jsonOptions(auth, signal),
      'confluence page children',
    );
    const providerNext = data._links?.next ?? next;
    return {
      results: data.results,
      ...(providerNext === undefined ? {} : { next: providerNext }),
    };
  });
}

async function listChildFolders(
  auth: Auth,
  folderId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof cloudPageSummarySchema>[]> {
  const first = pageApiUrl(
    auth,
    `/folders/${encodeURIComponent(folderId)}/direct-children?limit=${PAGE_SIZE}`,
  );
  return collect(first, auth, 'confluence folder children', async (url) => {
    const { data, next } = await fetchJsonWithNext(
      url,
      cloudPageListSchema,
      jsonOptions(auth, signal),
      'confluence folder children',
    );
    const providerNext = data._links?.next ?? next;
    return {
      results: data.results,
      ...(providerNext === undefined ? {} : { next: providerNext }),
    };
  });
}

async function listDcChildPages(
  auth: Auth,
  parentId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof dcPageSummarySchema>[]> {
  const first = pageApiUrl(
    auth,
    `/content/${encodeURIComponent(parentId)}/child/page?start=0&limit=${DC_PAGE_SIZE}&expand=space,version`,
  );
  return collect(first, auth, 'confluence page children', async (url) => {
    const body = await fetchJson(
      url,
      dcPageListSchema,
      jsonOptions(auth, signal),
      'confluence page children',
    );
    return {
      results: body.results,
      ...(body._links?.next === undefined ? {} : { next: body._links.next }),
    };
  });
}

async function collectCloudTree(
  auth: Auth,
  root: z.infer<typeof cloudPageDetailSchema>,
  signal: AbortSignal | undefined,
  failures: SourceFailure[],
): Promise<z.infer<typeof cloudPageDetailSchema>[]> {
  if (!root.spaceId) throw new Error('confluence page range did not return its spaceId');
  const details = [root];
  const pendingPages = [root.id];
  const pendingFolders: string[] = [];
  const seenPages = new Set([root.id]);
  const seenFolders = new Set<string>();
  while (pendingPages.length > 0 || pendingFolders.length > 0) {
    const fromPage = pendingPages.length > 0;
    const id = fromPage ? (pendingPages.shift() as string) : (pendingFolders.shift() as string);
    let children: z.infer<typeof cloudPageSummarySchema>[];
    try {
      children = fromPage
        ? await listChildPages(auth, id, signal)
        : await listChildFolders(auth, id, signal);
    } catch (err) {
      rethrowAuth(err);
      failures.push(
        failureOf(fromPage ? `confluence:page:${id}` : `confluence:folder:${id}`, id, err),
      );
      continue;
    }
    for (const child of children) {
      if ((child.type ?? child.contentType) === 'folder') {
        if (seenFolders.has(child.id)) throw new Error('confluence folder tree repeated a folder');
        // A folder's space is checked before it enters the queue; the list
        // entry may omit spaceId, so the official folder metadata confirms it.
        const folderSpaceId =
          child.spaceId ?? (await fetchCloudFolder(auth, child.id, signal)).spaceId;
        if (folderSpaceId === undefined) {
          throw new Error('confluence folder did not return its spaceId');
        }
        if (folderSpaceId !== root.spaceId) {
          throw new Error('confluence page subtree crossed into another space');
        }
        seenFolders.add(child.id);
        pendingFolders.push(child.id);
        continue;
      }
      if (seenPages.has(child.id)) throw new Error('confluence page tree repeated a page');
      seenPages.add(child.id);
      let detail: z.infer<typeof cloudPageDetailSchema>;
      try {
        detail = await fetchCloudPage(auth, child.id, signal, true);
      } catch (err) {
        rethrowAuth(err);
        failures.push(failureOf(`confluence:page:${child.id}`, child.title ?? child.id, err));
        continue;
      }
      if (detail.spaceId !== root.spaceId) {
        throw new Error('confluence page subtree crossed into another space');
      }
      details.push(detail);
      pendingPages.push(detail.id);
    }
  }
  return details;
}

async function collectDcTree(
  auth: Auth,
  root: z.infer<typeof dcPageDetailSchema>,
  signal: AbortSignal | undefined,
  failures: SourceFailure[],
): Promise<z.infer<typeof dcPageDetailSchema>[]> {
  const spaceKey = root.space?.key?.trim();
  if (!spaceKey) throw new Error('confluence page range did not return its space key');
  const details = [root];
  const pending = [root.id];
  const seen = new Set([root.id]);
  while (pending.length > 0) {
    const id = pending.shift() as string;
    let children: z.infer<typeof dcPageSummarySchema>[];
    try {
      children = await listDcChildPages(auth, id, signal);
    } catch (err) {
      rethrowAuth(err);
      failures.push(failureOf(`confluence:page:${id}`, id, err));
      continue;
    }
    for (const child of children) {
      if (seen.has(child.id)) throw new Error('confluence page tree repeated a page');
      seen.add(child.id);
      let detail: z.infer<typeof dcPageDetailSchema>;
      try {
        detail = await fetchDcPage(auth, child.id, signal, true);
      } catch (err) {
        rethrowAuth(err);
        failures.push(failureOf(`confluence:page:${child.id}`, child.title, err));
        continue;
      }
      if (detail.space?.key !== spaceKey) {
        throw new Error('confluence page subtree crossed into another space');
      }
      details.push(detail);
      pending.push(detail.id);
    }
  }
  return details;
}

async function listCloudAttachments(
  auth: Auth,
  pageId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof cloudAttachmentSchema>[]> {
  const first = pageApiUrl(
    auth,
    `/pages/${encodeURIComponent(pageId)}/attachments?limit=${PAGE_SIZE}`,
  );
  return collect(first, auth, 'confluence attachments', async (url) => {
    const { data, next } = await fetchJsonWithNext(
      url,
      cloudAttachmentListSchema,
      jsonOptions(auth, signal),
      'confluence attachments',
    );
    const providerNext = data._links?.next ?? next;
    return {
      results: data.results,
      ...(providerNext === undefined ? {} : { next: providerNext }),
    };
  });
}

async function listDcAttachments(
  auth: Auth,
  pageId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof dcAttachmentSchema>[]> {
  const first = pageApiUrl(
    auth,
    `/content/${encodeURIComponent(pageId)}/child/attachment?start=0&limit=${DC_PAGE_SIZE}&expand=version,metadata,_links.download`,
  );
  return collect(first, auth, 'confluence attachments', async (url) => {
    const body = await fetchJson(
      url,
      dcAttachmentListSchema,
      jsonOptions(auth, signal),
      'confluence attachments',
    );
    return {
      results: body.results,
      ...(body._links?.next === undefined ? {} : { next: body._links.next }),
    };
  });
}

function cloudDownloadUrl(auth: Auth, pageId: string, attachmentId: string): string {
  const restBase = `${auth.apiRoot.origin}${trimSlash(auth.apiRoot.pathname).replace(/\/api\/v2$/, '')}`;
  return `${restBase}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(attachmentId)}/download`;
}

function dcDownloadUrl(auth: Auth, link: string | undefined): string {
  if (!link)
    throw new ItemError('confluence attachment has no download link', 'fetch_failed', true);
  const url = new URL(link, auth.site);
  if (url.origin !== auth.site.origin) {
    throw new ItemError(
      'confluence attachment download left the site origin',
      'fetch_failed',
      false,
    );
  }
  if (url.username || url.password) {
    throw new ItemError(
      'confluence attachment download contains credentials',
      'fetch_failed',
      false,
    );
  }
  const context = trimSlash(auth.site.pathname);
  if (context !== '' && url.pathname !== context && !url.pathname.startsWith(`${context}/`)) {
    throw new ItemError(
      'confluence attachment download left the site context',
      'fetch_failed',
      false,
    );
  }
  return url.href;
}

type Attachment = {
  id: string;
  title?: string;
  mediaType?: string;
  version?: number;
  fileSize?: number;
  download?: string;
};

/** Normalize the Cloud and DC attachment shapes before emitting a document. */
function cloudAttachment(value: z.infer<typeof cloudAttachmentSchema>): Attachment {
  return {
    id: value.id,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    ...(value.version?.number === undefined ? {} : { version: value.version.number }),
    ...(value.fileSize === undefined ? {} : { fileSize: value.fileSize }),
    ...(value._links?.download === undefined ? {} : { download: value._links.download }),
  };
}

function dcAttachment(value: z.infer<typeof dcAttachmentSchema>): Attachment {
  return {
    id: value.id,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.metadata?.mediaType === undefined ? {} : { mediaType: value.metadata.mediaType }),
    ...(value.version?.number === undefined ? {} : { version: value.version.number }),
    ...(value._links?.download === undefined ? {} : { download: value._links.download }),
  };
}

async function emitPage(
  auth: Auth,
  page: z.infer<typeof cloudPageDetailSchema> | z.infer<typeof dcPageDetailSchema>,
  spaceName: string,
  items: SourceItem[],
  failures: SourceFailure[],
  usedPaths: Set<string>,
  usedStems: Set<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const externalId = `confluence:page:${page.id}`;
  const title = `${sanitizeSegment(page.title, page.id)}.html`;
  const pageStem = uniquePath(
    `${sanitizeSegment(spaceName, 'space')}/${sanitizeSegment(page.title, page.id)}`,
    usedStems,
    page.id,
  );
  try {
    const html = pageBodyHtml(page);
    const revision = revisionOf(page);
    items.push({
      externalId,
      title,
      path: `${pageStem}.html`,
      sourceUrl: humanUrl(page._links?.webui, auth.site),
      content: '',
      bytes: Buffer.from(html, 'utf8'),
      mimeType: 'text/html',
      ...(revision === undefined ? {} : { revision }),
    });
  } catch (err) {
    rethrowAuth(err);
    failures.push(failureOf(externalId, title, err));
  }

  try {
    const attachments =
      auth.settings.authMode === 'dc_pat'
        ? (await listDcAttachments(auth, page.id, signal)).map(dcAttachment)
        : (await listCloudAttachments(auth, page.id, signal)).map(cloudAttachment);
    for (const attachment of attachments) {
      await emitAttachment(auth, page, attachment, pageStem, items, failures, usedPaths, signal);
    }
  } catch (err) {
    rethrowAuth(err);
    failures.push(failureOf(externalId, title, err));
  }
}

async function emitAttachment(
  auth: Auth,
  page: z.infer<typeof cloudPageDetailSchema> | z.infer<typeof dcPageDetailSchema>,
  attachment: Attachment,
  pageStem: string,
  items: SourceItem[],
  failures: SourceFailure[],
  usedPaths: Set<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const externalId = `confluence:attachment:${attachment.id}`;
  const declared = attachment.mediaType;
  const mime = mimeOfFile(attachment.title ?? '', declared);
  const title = filenameOf(attachment.title, attachment.id, mime);
  if (!mime) {
    failures.push(
      failureOf(
        externalId,
        title,
        new ItemError(
          `unsupported attachment type ${extensionOf(title) || '(none)'}`,
          'unsupported_type',
          false,
        ),
      ),
    );
    return;
  }
  const revision = attachment.version;
  try {
    const url =
      auth.settings.authMode === 'dc_pat'
        ? dcDownloadUrl(auth, attachment.download)
        : cloudDownloadUrl(auth, page.id, attachment.id);
    const bytes = await fetchBytes(url, downloadOptions(auth, signal), 'confluence attachment');
    if (bytes.length === 0) {
      throw new ItemError('confluence attachment downloaded 0 bytes', 'fetch_failed', true);
    }
    if (attachment.fileSize !== undefined && attachment.fileSize !== bytes.length) {
      throw new ItemError(
        `confluence attachment downloaded ${bytes.length} bytes, declared ${attachment.fileSize}`,
        'fetch_failed',
        true,
      );
    }
    items.push({
      externalId,
      title,
      path: uniquePath(`${pageStem}/${title}`, usedPaths, attachment.id),
      sourceUrl: '',
      content: '',
      bytes,
      mimeType: mime,
      ...(revision === undefined ? {} : { revision: String(revision) }),
    });
  } catch (err) {
    rethrowAuth(err);
    failures.push(failureOf(externalId, title, err));
  }
}

export async function readConfluence(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous =
    cursor === undefined || Object.keys(cursor).length === 0
      ? undefined
      : cursorSchema.parse(cursor);
  const auth = await authenticate(config);
  signal?.throwIfAborted();

  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];
  const usedPaths = new Set<string>();
  const usedStems = new Set<string>();
  const resourceId = auth.settings.resourceId;

  if (auth.settings.rangeKind === 'confluence_space') {
    const space = await fetchSpace(auth, signal);
    if (space.id !== undefined && space.id !== resourceId) {
      throw new Error(`confluence space ${resourceId} returned metadata for ${space.id}`);
    }
    if (auth.settings.authMode === 'dc_pat' && !space.key?.trim()) {
      throw new Error('confluence space metadata did not return a space key');
    }
    const spaceKey = space.key?.trim();
    const spaceName = spaceKey || space.name?.trim() || resourceId;
    if (auth.settings.authMode === 'dc_pat') {
      if (spaceKey === undefined)
        throw new Error('confluence space metadata did not return a space key');
      const pages = await listDcPages(auth, spaceKey, signal);
      for (const page of pages) {
        signal?.throwIfAborted();
        let detail: z.infer<typeof dcPageDetailSchema>;
        try {
          detail = await fetchDcPage(auth, page.id, signal, true);
        } catch (err) {
          rethrowAuth(err);
          failures.push(failureOf(`confluence:page:${page.id}`, page.title, err));
          continue;
        }
        if (detail.space?.key !== undefined && detail.space.key !== spaceName) {
          throw new Error('confluence space listing crossed into another space');
        }
        await emitPage(auth, detail, spaceName, items, failures, usedPaths, usedStems, signal);
      }
    } else {
      const pages = await listCloudPages(auth, resourceId, signal);
      for (const page of pages) {
        signal?.throwIfAborted();
        if (page.spaceId !== undefined && page.spaceId !== resourceId) {
          throw new Error('confluence space listing crossed into another space');
        }
        let detail: z.infer<typeof cloudPageDetailSchema>;
        try {
          detail = await fetchCloudPage(auth, page.id, signal, true);
        } catch (err) {
          rethrowAuth(err);
          failures.push(failureOf(`confluence:page:${page.id}`, page.title ?? page.id, err));
          continue;
        }
        if (detail.spaceId !== resourceId) {
          throw new Error('confluence space listing crossed into another space');
        }
        await emitPage(auth, detail, spaceName, items, failures, usedPaths, usedStems, signal);
      }
    }
  } else {
    if (auth.settings.authMode === 'dc_pat') {
      const root = await fetchDcPage(auth, resourceId, signal, true);
      const spaceName = root.space?.key?.trim() || root.space?.name?.trim() || resourceId;
      const pages = await collectDcTree(auth, root, signal, failures);
      for (const page of pages) {
        signal?.throwIfAborted();
        await emitPage(auth, page, spaceName, items, failures, usedPaths, usedStems, signal);
      }
    } else {
      const root = await fetchCloudPage(auth, resourceId, signal, true);
      const pages = await collectCloudTree(auth, root, signal, failures);
      for (const page of pages) {
        signal?.throwIfAborted();
        await emitPage(
          auth,
          page,
          root.spaceId || resourceId,
          items,
          failures,
          usedPaths,
          usedStems,
          signal,
        );
      }
    }
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

export async function probeConfluence(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const auth = await authenticate(config);
  signal?.throwIfAborted();
  const resourceId = auth.settings.resourceId;
  if (auth.settings.rangeKind === 'confluence_space') {
    const space = await fetchSpace(auth, signal);
    if (space.id !== undefined && space.id !== resourceId) {
      throw new Error(`confluence space ${resourceId} returned metadata for ${space.id}`);
    }
    if (auth.settings.authMode === 'dc_pat' && !space.key?.trim()) {
      throw new Error('confluence space metadata did not return a space key');
    }
    return;
  }
  if (auth.settings.authMode === 'dc_pat') {
    await fetchDcPage(auth, resourceId, signal, false);
  } else {
    await fetchCloudPage(auth, resourceId, signal, false);
  }
}
