import { createHash } from 'node:crypto';
import { errorText } from '@agentport/shared';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import {
  type FetchOptions,
  fetchChecked,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import { trimSlash } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * Nextcloud WebDAV leaf reader.
 *
 * A range is an absolute directory inside the account's files root. File
 * identity is the globally namespaced `oc:id`, never the path or `oc:fileid`;
 * renames keep the identity and only change sourcePath. PROPFIND stays
 * PROPFIND (never silently a GET), and every 207 response is inspected per
 * response/propstat because 207 only means the multistatus container worked.
 */

const DAV_URI = 'DAV:';
const OC_URI = 'http://owncloud.org/ns';
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/>' +
  '<d:getcontentlength/><d:getcontenttype/><oc:id/></d:prop></d:propfind>';

const settingsSchema = z.object({
  username: z.string().trim().min(1),
  path: z.string().trim().min(1),
});

const cursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

type Network = { allowLoopback?: boolean; trustedHosts?: readonly string[] };

type Auth = {
  username: string;
  relative: string;
  base: string;
  origin: string;
  authorization: string;
  network: Network;
};

type DavEntry = {
  href: string;
  collection: boolean;
  etag?: string;
  size?: number;
  modified?: string;
  contentType?: string;
  id: string;
};

type DavResult = { ok: true; entry: DavEntry } | { ok: false; href?: string; error: unknown };

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

function normalizeDavPath(value: string): string {
  if (!value.startsWith('/')) {
    throw new Error(`nextcloud path must be absolute inside the files root: ${value}`);
  }
  if (value === '/') return '';
  const trimmed = value.replace(/\/+$/, '');
  const segments = trimmed.slice(1).split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      /%2f|%5c/i.test(segment)
    ) {
      throw new Error(`nextcloud path is not a canonical files-root path: ${value}`);
    }
  }
  return segments.join('/');
}

function safeSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function mimeOf(name: string, declared: string | undefined): string | undefined {
  const extension = extensionOf(name);
  const byExtension = BINARY_MIME_BY_EXTENSION[extension] ?? TEXT_MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const mime = declared?.split(';')[0]?.trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && EXTENSION_BY_MIME[mime]) return mime;
  return undefined;
}

function titleOf(relative: string, mime: string | undefined): string {
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  if (extensionOf(name)) return name;
  const extension = mime ? EXTENSION_BY_MIME[mime] : undefined;
  return extension ? `${name}.${extension}` : name;
}

function failureOf(externalId: string, title: string, err: unknown): SourceFailure {
  const itemError = err instanceof ItemError ? err : undefined;
  return {
    externalId,
    title,
    code: itemError?.code ?? 'fetch_failed',
    message: errorText(err).slice(0, 500),
    retryable: itemError?.retryable ?? true,
  };
}

function rethrowAuth(err: unknown): void {
  if (err instanceof SourceAuthError) throw err;
}

async function authenticate(config: SourceConfig): Promise<Auth> {
  const settings = settingsSchema.parse(config.settings);
  const username = settings.username;
  if (!safeSegment(username)) {
    throw new Error(`nextcloud username is not a single path segment: ${username}`);
  }
  const path = normalizeDavPath(settings.path);
  const network = networkOptions(config);
  const site = new URL(await validateSourceUrl(config.url, network));
  if (site.search || site.hash) {
    throw new Error('nextcloud base URL must not contain a query or fragment');
  }
  if (site.pathname.includes('/remote.php')) {
    throw new Error('nextcloud base URL must be the instance root, not a DAV URL');
  }
  const token = config.credentials.appPassword?.trim() ?? '';
  if (token === '') throw new Error('nextcloud credentials.appPassword is required');
  const base = `${site.origin}${trimSlash(site.pathname)}`;
  const authorization = `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`;
  return { username, relative: path, base, origin: site.origin, authorization, network };
}

function davUrl(auth: Auth, relative: string): string {
  const user = encodeURIComponent(auth.username);
  const suffix =
    relative === ''
      ? ''
      : `/${relative
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}`;
  return `${auth.base}/remote.php/dav/files/${user}${suffix}`;
}

function davRootPath(auth: Auth): string {
  return new URL(davUrl(auth, '')).pathname.replace(/\/*$/, '/');
}

function authHeaders(auth: Auth, depth: '0' | '1'): Record<string, string> {
  return {
    authorization: auth.authorization,
    depth,
    'content-type': 'text/xml; charset=utf-8',
    accept: 'application/xml',
  };
}

function propfindOptions(
  auth: Auth,
  depth: '0' | '1',
  signal: AbortSignal | undefined,
): FetchOptions {
  return {
    method: 'PROPFIND',
    body: PROPFIND_BODY,
    headers: authHeaders(auth, depth),
    authOrigin: auth.origin,
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const text = (value as Record<string, unknown>)['#text'];
  return typeof text === 'string' ? text : undefined;
}

function statusCode(value: unknown): number | undefined {
  const status = textOf(value);
  if (status === undefined) return undefined;
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(status.trim());
  return match === null ? undefined : Number(match[1]);
}

type Namespaces = ReadonlyMap<string, string>;
const NO_NAMESPACES: Namespaces = new Map();

type XmlElement = {
  uri: string | undefined;
  local: string;
  value: unknown;
  namespaces: Namespaces;
};

/**
 * XML namespaces are resolved from each element's effective scope, so any
 * prefix (or the default namespace) works and a local rebinding keeps its own
 * URI. A same-name element in another URI is never treated as DAV/ownCloud.
 */
function scopedNamespaces(record: Record<string, unknown>, parent: Namespaces): Namespaces {
  let scoped: Map<string, string> | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key !== '@_xmlns' && !key.startsWith('@_xmlns:')) continue;
    scoped ??= new Map(parent);
    scoped.set(key === '@_xmlns' ? '' : key.slice('@_xmlns:'.length), textOf(value) ?? '');
  }
  return scoped ?? parent;
}

function childrenOf(value: unknown, parent: Namespaces): XmlElement[] {
  const elements: XmlElement[] = [];
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (key.startsWith('@_') || key.startsWith('?') || key === '#text') continue;
    const colon = key.indexOf(':');
    const prefix = colon < 0 ? '' : key.slice(0, colon);
    const local = colon < 0 ? key : key.slice(colon + 1);
    for (const item of asArray(raw)) {
      const namespaces =
        item !== null && typeof item === 'object'
          ? scopedNamespaces(item as Record<string, unknown>, parent)
          : parent;
      elements.push({ uri: namespaces.get(prefix), local, value: item, namespaces });
    }
  }
  return elements;
}

function findElement(elements: XmlElement[], uri: string, local: string): XmlElement | undefined {
  return elements.find((element) => element.uri === uri && element.local === local);
}

/** Directory listings need a DAV collection child, not merely any resourcetype. */
function isCollection(resourceType: XmlElement): boolean {
  return childrenOf(resourceType.value, resourceType.namespaces).some(
    (element) => element.uri === DAV_URI && element.local === 'collection',
  );
}

function parseResponse(element: XmlElement): DavEntry {
  const children = childrenOf(element.value, element.namespaces);
  const href = textOf(findElement(children, DAV_URI, 'href')?.value);
  if (href === undefined || href === '') {
    throw new Error('nextcloud DAV response has no href');
  }
  let collection = false;
  let resourceTypeSeen = false;
  let etag: string | undefined;
  let size: number | undefined;
  let modified: string | undefined;
  let contentType: string | undefined;
  let id: string | undefined;
  let ok = false;
  let failed: Error | undefined;

  for (const propstat of children) {
    if (propstat.uri !== DAV_URI || propstat.local !== 'propstat') continue;
    const parts = childrenOf(propstat.value, propstat.namespaces);
    const code = statusCode(findElement(parts, DAV_URI, 'status')?.value);
    const prop = findElement(parts, DAV_URI, 'prop');
    if (code === 200) {
      ok = true;
      if (prop === undefined) continue;
      const props = childrenOf(prop.value, prop.namespaces);
      const resourceType = findElement(props, DAV_URI, 'resourcetype');
      if (resourceType !== undefined) {
        resourceTypeSeen = true;
        collection = isCollection(resourceType);
      }
      etag = textOf(findElement(props, DAV_URI, 'getetag')?.value)?.trim() || etag;
      const length = textOf(findElement(props, DAV_URI, 'getcontentlength')?.value)?.trim();
      if (length !== undefined && /^\d+$/.test(length)) size = Number(length);
      modified = textOf(findElement(props, DAV_URI, 'getlastmodified')?.value)?.trim() || modified;
      contentType =
        textOf(findElement(props, DAV_URI, 'getcontenttype')?.value)?.trim() || contentType;
      id = textOf(findElement(props, OC_URI, 'id')?.value)?.trim() || id;
      continue;
    }
    if (code === 404) {
      // Only properties this reader can live without may be reported missing.
      if (prop === undefined) continue;
      const required = childrenOf(prop.value, prop.namespaces).find(
        (property) =>
          (property.uri === DAV_URI && property.local === 'resourcetype') ||
          (property.uri === OC_URI && property.local === 'id'),
      );
      if (required !== undefined) {
        failed ??= new Error(
          `nextcloud DAV response marks required ${required.local} as unavailable`,
        );
      }
      continue;
    }
    // 207 only means the container worked: a failed propstat cannot be offset
    // by another propstat that happened to return 200.
    failed ??= new Error(
      `nextcloud DAV propstat failed with HTTP ${code === undefined ? 'unknown' : code}`,
    );
  }
  if (!ok) throw new Error('nextcloud DAV response has no successful propstat');
  if (failed !== undefined) throw failed;
  if (!resourceTypeSeen) throw new Error('nextcloud DAV response is missing resourcetype');
  if (id === undefined || id === '') throw new Error('nextcloud DAV response is missing oc:id');
  // getlastmodified is an HTTP-date; an unparsable value cannot be a validator.
  if (modified !== undefined && !Number.isFinite(Date.parse(modified))) {
    throw new Error('nextcloud DAV response has an invalid getlastmodified date');
  }
  return {
    href,
    collection,
    id,
    ...(etag === undefined ? {} : { etag }),
    ...(size === undefined ? {} : { size }),
    ...(modified === undefined ? {} : { modified }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function parseMultistatus(raw: string): DavResult[] {
  // Entities and DTDs are never needed for a propfind response; refusing them
  // removes external-entity and expansion attacks before parsing.
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    throw new Error('nextcloud DAV response must not contain a DTD or entity declaration');
  }
  const valid = XMLValidator.validate(raw);
  if (valid !== true) throw new Error(`invalid nextcloud DAV XML: ${valid.err.msg}`);
  const topLevel = childrenOf(parser.parse(raw), NO_NAMESPACES);
  const multistatus = topLevel.find(
    (element) => element.uri === DAV_URI && element.local === 'multistatus',
  );
  if (multistatus === undefined) {
    throw new Error(
      topLevel.some((element) => element.uri === DAV_URI)
        ? 'nextcloud DAV response is not a multistatus document'
        : 'nextcloud DAV response is not in the DAV namespace',
    );
  }
  const responses = childrenOf(multistatus.value, multistatus.namespaces).filter(
    (element) => element.uri === DAV_URI && element.local === 'response',
  );
  if (responses.length === 0) {
    throw new Error('nextcloud DAV response is not a multistatus document');
  }
  return responses.map((response): DavResult => {
    const href = textOf(
      findElement(childrenOf(response.value, response.namespaces), DAV_URI, 'href')?.value,
    );
    try {
      return { ok: true, entry: parseResponse(response) };
    } catch (error) {
      // One failing child (for example 403) must not hide the other responses.
      return {
        ok: false,
        ...(href === undefined ? {} : { href }),
        error,
      };
    }
  });
}

async function propfind(
  auth: Auth,
  relative: string,
  depth: '0' | '1',
  signal: AbortSignal | undefined,
): Promise<DavResult[]> {
  const response = await fetchChecked(davUrl(auth, relative), propfindOptions(auth, depth, signal));
  const text = (await readBytesCapped(response, 'nextcloud propfind')).toString('utf8');
  return parseMultistatus(text);
}

/**
 * Convert a response href into a files-root-relative path. Only the same
 * origin, the same instance context and the current user's DAV root are
 * accepted; encoded slashes, parent segments and deeper-than-Deep-1 entries are
 * rejected instead of being fetched.
 */
function relativeFromHref(href: string, auth: Auth, request: string, current: string): string {
  if (/%2f|%5c/i.test(href)) {
    throw new Error('nextcloud DAV href contains an encoded slash');
  }
  const url = new URL(href, request);
  if (url.origin !== auth.origin) throw new Error('nextcloud DAV href left the instance origin');
  if (url.username || url.password) {
    throw new Error('nextcloud DAV href contains credentials');
  }
  const root = davRootPath(auth);
  if (!url.pathname.startsWith(root)) {
    throw new Error('nextcloud DAV href left the current user DAV root');
  }
  const encoded = url.pathname.slice(root.length);
  const segments = encoded.split('/').filter((segment) => segment !== '');
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new Error('nextcloud DAV href has an invalid percent-encoding');
    }
    if (!safeSegment(value)) throw new Error('nextcloud DAV href has an unsafe path segment');
    decoded.push(value);
  }
  const relative = decoded.join('/');
  if (relative !== current) {
    const prefix = current === '' ? '' : `${current}/`;
    if (!relative.startsWith(prefix) || relative.slice(prefix.length).includes('/')) {
      throw new Error('nextcloud DAV response contains an entry outside the requested directory');
    }
  }
  return relative;
}

function requireSelf(results: DavResult[], auth: Auth, current: string): DavEntry {
  const request = davUrl(auth, current);
  for (const result of results) {
    if (!result.ok) continue;
    const relative = relativeFromHref(result.entry.href, auth, request, current);
    if (relative === current) return result.entry;
  }
  // A failed self response (for example 403/404) is a range/auth failure, not
  // an empty directory.
  const failed = results.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) throw failed.error;
  throw new Error('nextcloud DAV response does not include the requested directory itself');
}

function stripWeak(etag: string): string {
  return etag.trim().replace(/^W\//i, '');
}

/** Only a strong validator can be compared byte-for-byte and sent as If-Match. */
function strongEtag(etag: string | undefined): string | undefined {
  const value = etag?.trim();
  return value === undefined || value === '' || /^W\//i.test(value) ? undefined : value;
}

function downloadOptions(
  auth: Auth,
  etag: string | undefined,
  signal: AbortSignal | undefined,
): FetchOptions {
  return {
    headers: {
      authorization: auth.authorization,
      ...(etag === undefined ? {} : { 'if-match': etag }),
    },
    authOrigin: auth.origin,
    authFailure: 'item',
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

async function revalidate(
  auth: Auth,
  relative: string,
  listed: DavEntry,
  signal: AbortSignal | undefined,
): Promise<void> {
  const entries = await propfind(auth, relative, '0', signal);
  const self = requireSelf(entries, auth, relative);
  if (self.id !== listed.id) {
    throw new ItemError('nextcloud file changed identity during download', 'fetch_failed', true);
  }
  if (listed.etag !== undefined && self.etag !== undefined) {
    if (stripWeak(listed.etag) !== stripWeak(self.etag)) {
      throw new ItemError('nextcloud file changed during download', 'fetch_failed', true);
    }
    return;
  }
  // Without a comparable ETag, only a complete modified+size fingerprint can
  // prove stability; two absent values must not compare equal by accident.
  if (
    listed.modified !== undefined &&
    listed.size !== undefined &&
    self.modified !== undefined &&
    self.size !== undefined
  ) {
    if (listed.size !== self.size || listed.modified !== self.modified) {
      throw new ItemError(
        'nextcloud file fingerprint changed during download',
        'fetch_failed',
        true,
      );
    }
    return;
  }
  throw new ItemError('nextcloud file has no comparable validator', 'fetch_failed', true);
}

async function emitFile(
  auth: Auth,
  relative: string,
  listed: DavEntry,
  items: SourceItem[],
  failures: SourceFailure[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const externalId = `nextcloud:file:${listed.id}`;
  const mime = mimeOf(relative.slice(relative.lastIndexOf('/') + 1), listed.contentType);
  const title = titleOf(relative, mime);
  if (!mime) {
    failures.push(
      failureOf(
        externalId,
        title,
        new ItemError(
          `unsupported file type ${extensionOf(title) || '(none)'}`,
          'unsupported_type',
          false,
        ),
      ),
    );
    return;
  }
  const ifMatch = strongEtag(listed.etag);
  try {
    const response = await fetchChecked(
      davUrl(auth, relative),
      downloadOptions(auth, ifMatch, signal),
    );
    const bytes = await readBytesCapped(response, 'nextcloud file');
    if (bytes.length === 0) {
      throw new ItemError('nextcloud file downloaded 0 bytes', 'fetch_failed', true);
    }
    if (listed.size !== undefined && bytes.length !== listed.size) {
      throw new ItemError(
        `nextcloud file size mismatch: listed ${listed.size}, downloaded ${bytes.length}`,
        'fetch_failed',
        true,
      );
    }
    const responseEtag = response.headers.get('etag') ?? undefined;
    const responseStrong = strongEtag(responseEtag);
    if (
      listed.etag !== undefined &&
      responseEtag !== undefined &&
      stripWeak(listed.etag) !== stripWeak(responseEtag)
    ) {
      throw new ItemError('nextcloud download ETag differs from the listing', 'fetch_failed', true);
    }
    // A weak or missing validator cannot prove the bytes stayed stable, even
    // when the download reports the same weak ETag as the listing.
    if (ifMatch === undefined || responseStrong === undefined || ifMatch !== responseStrong) {
      await revalidate(auth, relative, listed, signal);
    }
    const revision =
      listed.etag ??
      (listed.modified === undefined ? undefined : `${listed.modified}:${listed.size ?? ''}`);
    items.push({
      externalId,
      title,
      path: relative,
      sourceUrl: '',
      content: '',
      bytes,
      mimeType: mime,
      ...(revision === undefined ? {} : { revision }),
    });
  } catch (err) {
    rethrowAuth(err);
    failures.push(failureOf(externalId, title, err));
  }
}

async function walk(
  auth: Auth,
  relative: string,
  items: SourceItem[],
  failures: SourceFailure[],
  visited: Set<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (visited.has(relative)) return;
  visited.add(relative);
  signal?.throwIfAborted();

  const results = await propfind(auth, relative, '1', signal);
  if (!requireSelf(results, auth, relative).collection) {
    throw new Error('nextcloud directory stopped being a collection');
  }
  const request = davUrl(auth, relative);
  const seenChildren = new Set<string>();
  for (const result of results) {
    signal?.throwIfAborted();
    if (!result.ok) {
      const href = result.href;
      if (href === undefined) {
        failures.push(
          failureOf(`nextcloud:path:${createPathDigest(relative)}`, relative, result.error),
        );
        continue;
      }
      const child = relativeFromHref(href, auth, request, relative);
      if (child === relative) throw result.error;
      failures.push(failureOf(`nextcloud:path:${createPathDigest(child)}`, child, result.error));
      continue;
    }
    const entry = result.entry;
    const child = relativeFromHref(entry.href, auth, request, relative);
    if (child === relative) continue;
    if (seenChildren.has(child)) {
      failures.push(
        failureOf(
          `nextcloud:path:${createPathDigest(child)}`,
          child,
          new ItemError(`duplicate DAV response for ${child}`, 'invalid_response', false),
        ),
      );
      continue;
    }
    seenChildren.add(child);
    if (!entry.collection && entry.size === undefined) {
      failures.push(
        failureOf(
          `nextcloud:file:${entry.id}`,
          child,
          new ItemError('nextcloud file response is missing its size', 'invalid_response', false),
        ),
      );
      continue;
    }
    if (entry.collection) {
      await walk(auth, child, items, failures, visited, signal);
    } else {
      await emitFile(auth, child, entry, items, failures, signal);
    }
  }
}

function createPathDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export async function readNextcloud(
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

  // The selected directory must exist and be a directory before any recursion.
  const root = await propfind(auth, auth.relative, '0', signal);
  const self = requireSelf(root, auth, auth.relative);
  if (!self.collection) throw new Error('nextcloud range path is not a directory');

  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];
  await walk(auth, auth.relative, items, failures, new Set(), signal);

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

export async function probeNextcloud(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const auth = await authenticate(config);
  signal?.throwIfAborted();
  const root = await propfind(auth, auth.relative, '0', signal);
  const self = requireSelf(root, auth, auth.relative);
  if (!self.collection) throw new Error('nextcloud range path is not a directory');
  const firstLayer = await propfind(auth, auth.relative, '1', signal);
  if (!requireSelf(firstLayer, auth, auth.relative).collection) {
    throw new Error('nextcloud directory stopped being a collection');
  }
  const failed = firstLayer.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) throw failed.error;
}
