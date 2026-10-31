import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type FetchOptions,
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import { trimSlash } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * Seafile 11+ leaf reader.
 *
 * Identity is `<repo uuid>:sha256(canonical absolute path)` because this API has
 * no permanent cross-rename file ID; a rename is a new document and the old path
 * merely stops being visible. Directory roots are stored relative to the repo
 * root (empty paths means `/`), while API calls use the absolute path. The
 * download URL returned by the API is followed without the long-lived token,
 * even when the file server shares the API origin. The link response's `oid`
 * header is checked against the listing before the download starts, so a link
 * that resolves to a newer revision cannot pass as the listed one.
 */

const settingsSchema = z.object({
  repoId: z.string().trim().min(1),
  paths: z.array(z.string()).default([]),
});

const entrySchema = z.object({
  type: z.string(),
  name: z.string(),
  size: z.number().optional(),
  mtime: z.number().optional(),
  id: z.string().optional(),
  oid: z.string().optional(),
});

const listingSchema = z.array(entrySchema);
const downloadLinkSchema = z.string();

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

type Entry = z.infer<typeof entrySchema>;
type Auth = {
  repoId: string;
  paths: string[];
  apiBase: string;
  origin: string;
  token: string;
  network: Network;
};
type Network = { allowLoopback?: boolean; trustedHosts?: readonly string[] };

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

function normalizeRelativePath(value: string): string {
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      /%2f|%5c/i.test(segment)
    ) {
      throw new Error(`seafile path is not a canonical repo-relative path: ${value}`);
    }
  }
  return segments.join('/');
}

function safeName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !/%2f|%5c/i.test(name)
  );
}

function absolutePath(relative: string): string {
  return relative === '' ? '/' : `/${relative}`;
}

function pathHash(relative: string): string {
  return createHash('sha256').update(absolutePath(relative), 'utf8').digest('hex');
}

function fileExternalId(repoId: string, relative: string): string {
  return `seafile:file:${repoId}:${pathHash(relative)}`;
}

function directoryExternalId(repoId: string, relative: string): string {
  return `seafile:dir:${repoId}:${pathHash(relative)}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function mimeOf(name: string): string | undefined {
  const extension = extensionOf(name);
  return BINARY_MIME_BY_EXTENSION[extension] ?? TEXT_MIME_BY_EXTENSION[extension];
}

function revisionOf(entry: Entry): string | undefined {
  const parts = [entry.id ?? entry.oid ?? '', entry.mtime, entry.size].map((value) =>
    value === undefined ? '' : String(value),
  );
  return parts.some((part) => part !== '') ? parts.join(':') : undefined;
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

async function authenticate(config: SourceConfig): Promise<Auth> {
  const settings = settingsSchema.parse(config.settings);
  const repoId = settings.repoId;
  if (!/^[0-9A-Za-z-]+$/.test(repoId)) {
    throw new Error(`seafile repo ID is invalid: ${repoId}`);
  }
  const paths = settings.paths.map(normalizeRelativePath);
  const network = networkOptions(config);
  const site = new URL(await validateSourceUrl(config.url, network));
  if (site.search || site.hash) {
    throw new Error('seafile base URL must not contain a query or fragment');
  }
  const token = config.credentials.apiToken?.trim() ?? '';
  if (token === '') throw new Error('seafile credentials.apiToken is required');
  const root = `${site.origin}${trimSlash(site.pathname)}`;
  const apiBase = /\/api2$/.test(root) ? root : `${root}/api2`;
  return {
    repoId,
    paths,
    apiBase,
    origin: site.origin,
    token,
    network,
  };
}

function authOptions(
  auth: Auth,
  signal: AbortSignal | undefined,
  itemFailure = false,
): FetchOptions {
  return {
    headers: { authorization: `Bearer ${auth.token}` },
    authOrigin: auth.origin,
    authFailure: itemFailure ? 'item' : 'source',
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

/** The returned fileserver URL is used without the long-lived API token. */
function downloadOptions(auth: Auth, signal: AbortSignal | undefined): FetchOptions {
  return {
    authFailure: 'item',
    ...auth.network,
    ...(signal === undefined ? {} : { signal }),
  };
}

function directoryUrl(auth: Auth, relative: string): string {
  return `${auth.apiBase}/repos/${encodeURIComponent(auth.repoId)}/dir/?p=${encodeURIComponent(absolutePath(relative))}`;
}

async function listDirectory(
  auth: Auth,
  relative: string,
  signal: AbortSignal | undefined,
  itemFailure = false,
): Promise<Entry[]> {
  return fetchJson(
    directoryUrl(auth, relative),
    listingSchema,
    authOptions(auth, signal, itemFailure),
    'seafile directory',
  );
}

async function fetchDownloadLink(
  auth: Auth,
  relative: string,
  signal: AbortSignal | undefined,
): Promise<{ url: string; objectId: string | null }> {
  const linkUrl = `${auth.apiBase}/repos/${encodeURIComponent(auth.repoId)}/file/?p=${encodeURIComponent(absolutePath(relative))}&reuse=1`;
  const response = await fetchChecked(linkUrl, authOptions(auth, signal));
  // Seafile 11 sets the authoritative file object ID on the link response, not on
  // the fileserver download, so the download header cannot be the only evidence.
  const objectId = response.headers.get('oid');
  const text = new TextDecoder().decode(await readBytesCapped(response, 'seafile download link'));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('seafile download link returned invalid JSON');
  }
  const parsed = downloadLinkSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('seafile download link response does not match the expected schema');
  }
  return { url: parsed.data, objectId };
}

async function downloadFile(
  auth: Auth,
  relative: string,
  entry: Entry,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const link = await fetchDownloadLink(auth, relative, signal);
  const listedOid = entry.id ?? entry.oid;
  if (listedOid !== undefined && link.objectId === null) {
    throw new ItemError(
      'seafile download link did not return an object ID',
      'invalid_response',
      false,
    );
  }
  if (listedOid !== undefined && link.objectId !== null && link.objectId !== listedOid) {
    throw new ItemError(
      'seafile download link object ID differs from the listing',
      'fetch_failed',
      true,
    );
  }
  const response = await fetchChecked(link.url, downloadOptions(auth, signal));
  const downloadOid = response.headers.get('x-seafile-object-id');
  const bytes = await readBytesCapped(response, 'seafile file');
  if (listedOid !== undefined && downloadOid !== null && downloadOid !== listedOid) {
    throw new ItemError(
      'seafile downloaded object ID differs from the listing',
      'fetch_failed',
      true,
    );
  }
  return bytes;
}

async function emitFile(
  auth: Auth,
  relative: string,
  entry: Entry,
  items: SourceItem[],
  failures: SourceFailure[],
  seen: Set<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const externalId = fileExternalId(auth.repoId, relative);
  if (seen.has(externalId)) return;
  const mime = mimeOf(entry.name);
  if (!mime) {
    failures.push(
      failureOf(
        externalId,
        entry.name,
        new ItemError(
          `unsupported file type ${extensionOf(entry.name) || '(none)'}`,
          'unsupported_type',
          false,
        ),
      ),
    );
    return;
  }
  seen.add(externalId);
  try {
    const bytes = await downloadFile(auth, relative, entry, signal);
    if (bytes.length === 0) {
      throw new ItemError('seafile file downloaded 0 bytes', 'fetch_failed', true);
    }
    if (entry.size !== undefined && bytes.length !== entry.size) {
      throw new ItemError(
        `seafile file size mismatch: listed ${entry.size}, downloaded ${bytes.length}`,
        'fetch_failed',
        true,
      );
    }
    const revision = revisionOf(entry);
    items.push({
      externalId,
      title: entry.name,
      path: relative,
      sourceUrl: '',
      content: '',
      bytes,
      mimeType: mime,
      ...(revision === undefined ? {} : { revision }),
    });
  } catch (err) {
    rethrowAuth(err);
    failures.push(failureOf(externalId, entry.name, err));
  }
}

async function walk(
  auth: Auth,
  relative: string,
  items: SourceItem[],
  failures: SourceFailure[],
  seen: Set<string>,
  visited: Set<string>,
  signal: AbortSignal | undefined,
  isRoot: boolean,
): Promise<void> {
  if (visited.has(relative)) return;
  visited.add(relative);
  signal?.throwIfAborted();

  let entries: Entry[];
  try {
    entries = await listDirectory(auth, relative, signal, !isRoot);
  } catch (err) {
    rethrowAuth(err);
    // A selected root that is missing or forbidden is not an empty repository.
    if (isRoot) throw err;
    failures.push(
      failureOf(directoryExternalId(auth.repoId, relative), relative === '' ? '/' : relative, err),
    );
    return;
  }

  const names = new Set<string>();
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!safeName(entry.name)) {
      failures.push(
        failureOf(
          directoryExternalId(auth.repoId, relative),
          relative === '' ? '/' : relative,
          new ItemError(
            `unsafe entry name ${JSON.stringify(entry.name)}`,
            'invalid_response',
            false,
          ),
        ),
      );
      continue;
    }
    if (names.has(entry.name)) {
      failures.push(
        failureOf(
          directoryExternalId(auth.repoId, relative),
          entry.name,
          new ItemError(`duplicate directory entry ${entry.name}`, 'invalid_response', false),
        ),
      );
      continue;
    }
    names.add(entry.name);
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.type === 'dir') {
      await walk(auth, child, items, failures, seen, visited, signal, false);
    } else if (entry.type === 'file') {
      await emitFile(auth, child, entry, items, failures, seen, signal);
    } else {
      failures.push(
        failureOf(
          pathSeed(auth.repoId, child),
          entry.name,
          new ItemError(`unknown seafile entry type ${entry.type}`, 'invalid_response', false),
        ),
      );
    }
  }
}

/** Failure identity for entries that never became a document. */
function pathSeed(repoId: string, relative: string): string {
  return `seafile:entry:${repoId}:${pathHash(relative)}`;
}

export async function readSeafile(
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
  const seen = new Set<string>();
  const visited = new Set<string>();
  const roots = auth.paths.length === 0 ? [''] : [...new Set(auth.paths)];
  for (const root of roots) {
    // A missing/forbidden selected root is a range failure, not an empty repo.
    await walk(auth, root, items, failures, seen, visited, signal, true);
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

export async function probeSeafile(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const auth = await authenticate(config);
  signal?.throwIfAborted();
  const ping = await fetchChecked(`${auth.apiBase}/auth/ping/`, authOptions(auth, signal));
  await readBytesCapped(ping, 'seafile ping');
  for (const root of auth.paths.length === 0 ? [''] : [...new Set(auth.paths)]) {
    // Validate the repo and each selected directory without enumerating its tree.
    await listDirectory(auth, root, signal);
    signal?.throwIfAborted();
  }
}
