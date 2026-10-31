import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import { sanitizeSegment, uniquePath } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * IMA knowledge-base leaf reader.
 *
 * Only the explicitly configured knowledge base is enumerated. Media identity
 * is `media_id`; same-name items are never merged, and a replaced media ID is a
 * new document. The public listing has no reliable revision, so every run
 * re-reads the listing and media info and leaves change detection to the
 * ingestion content hash.
 */

const BASE = 'https://ima.qq.com';
const WIKI_PATH = '/openapi/wiki/v1';
const NOTE_PATH = '/openapi/note/v1';
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

const settingsSchema = z.object({
  clientId: z.string().trim().min(1),
  knowledgeBaseId: z.string().trim().min(1),
});

const envelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});

const listSchema = z.object({
  knowledge_list: z.array(z.unknown()),
  is_end: z.boolean(),
  next_cursor: z.string().optional(),
});

const mediaInfoSchema = z.object({
  media_type: z.number().int(),
  url_info: z
    .object({
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  notebook_ext_info: z
    .object({
      notebook_id: z.string().optional(),
    })
    .optional(),
});

const noteContentSchema = z.object({
  content: z.string().optional(),
});

/** 官方 MediaType 中可由本契约读取原文的类型。 */
const MEDIA: Record<number, { extension: string; mime: string }> = {
  1: { extension: 'pdf', mime: 'application/pdf' },
  2: { extension: 'html', mime: 'text/html' },
  3: {
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  4: {
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  5: {
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  6: { extension: 'html', mime: 'text/html' },
  7: { extension: 'md', mime: 'text/markdown' },
  9: { extension: 'png', mime: 'image/png' },
  13: { extension: 'txt', mime: 'text/plain' },
  20: { extension: 'html', mime: 'text/html' },
  21: { extension: 'epub', mime: 'application/epub+zip' },
};

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'application/md': 'md',
  'application/markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/epub+zip': 'epub',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  epub: 'application/epub+zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 官方 MediaType 允许的下载格式；同一媒体类型可能对应新旧 Office 格式或 CSV。 */
const EXTENSIONS_BY_MEDIA_TYPE: Record<number, readonly string[]> = {
  1: ['pdf'],
  2: ['html'],
  3: ['doc', 'docx'],
  4: ['ppt', 'pptx'],
  5: ['xls', 'xlsx', 'csv'],
  6: ['html'],
  7: ['md'],
  9: ['png', 'jpg', 'gif', 'webp'],
  13: ['txt'],
  20: ['html'],
  21: ['epub'],
};

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'keep-alive',
]);

const NOTEBOOK_MEDIA_TYPE = 11;
const FOLDER_MEDIA_TYPE = 99;

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

type Auth = {
  knowledgeBaseId: string;
  headers: Record<string, string>;
};

type ListResult = z.infer<typeof listSchema>;

function origins(config: SourceConfig): {
  trustedHosts?: readonly string[];
  allowLoopback?: boolean;
} {
  return {
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
  };
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function options(auth: Auth, signal: AbortSignal | undefined) {
  return {
    method: 'POST' as const,
    headers: auth.headers,
    authOrigin: new URL(BASE).origin,
    ...signalOption(signal),
  };
}

function authenticate(config: SourceConfig): Auth {
  const settings = settingsSchema.parse(config.settings);
  const apiKey = config.credentials.apiKey?.trim();
  if (!apiKey) throw new Error('ima credentials.apiKey is required');
  return {
    knowledgeBaseId: settings.knowledgeBaseId,
    headers: {
      'ima-openapi-clientid': settings.clientId,
      'ima-openapi-apikey': apiKey,
      'content-type': 'application/json; charset=utf-8',
    },
  };
}

async function callIma<T>(
  auth: Auth,
  path: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  const envelope = await fetchJson(
    `${BASE}${path}`,
    envelopeSchema,
    { ...options(auth, signal), body: JSON.stringify(body) },
    label,
  );
  if (envelope.code !== 0) {
    const message = redactUrls(
      `ima ${label} error: code=${envelope.code}${envelope.msg ? ` msg=${envelope.msg}` : ''}`,
    );
    // 官方 110030 表示无权限：长期 API 明确失权按现有语义停用来源。
    throw envelope.code === 110030 ? new SourceAuthError(message) : new Error(message);
  }
  const parsed = schema.safeParse(envelope.data ?? {});
  if (!parsed.success) {
    throw new ItemError(
      `ima ${label} response does not match the expected schema`,
      'invalid_response',
      false,
    );
  }
  return parsed.data;
}

function listKnowledge(
  auth: Auth,
  folderId: string,
  cursor: string,
  signal: AbortSignal | undefined,
): Promise<ListResult> {
  return callIma(
    auth,
    `${WIKI_PATH}/get_knowledge_list`,
    {
      knowledge_base_id: auth.knowledgeBaseId,
      ...(folderId ? { folder_id: folderId } : {}),
      cursor,
      limit: PAGE_SIZE,
    },
    listSchema,
    signal,
    'get_knowledge_list',
  );
}

function assertListPage(response: ListResult): void {
  const next = response.next_cursor?.trim() ?? '';
  // 非终止空页说明枚举不完整；继续翻页会在后页终止时把空集合误判为完整。
  if (response.knowledge_list.length === 0 && !response.is_end) {
    throw new Error('ima get_knowledge_list returned an empty page before the end');
  }
  if (!response.is_end && !next) {
    throw new Error('ima get_knowledge_list set is_end=false without a next_cursor');
  }
}

function failureOf(externalId: string, title: string, err: unknown): SourceFailure {
  if (err instanceof ItemError) {
    return {
      externalId,
      title,
      code: err.code,
      message: err.message.slice(0, 500),
      retryable: err.retryable,
    };
  }
  return {
    externalId,
    title,
    code: 'fetch_failed',
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    retryable: true,
  };
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot + 1).toLowerCase();
}

function titleWithExtension(name: string, extension: string): string {
  return extensionOf(name) === extension.toLowerCase() ? name : `${name}.${extension}`;
}

function extensionFromContentType(contentType: string | null): string {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_CONTENT_TYPE[mime] ?? '';
}

function mediaExtension(mediaType: number, contentType: string | null, title: string): string {
  const allowed = EXTENSIONS_BY_MEDIA_TYPE[mediaType];
  const fromContentType = extensionFromContentType(contentType);
  // 可信 MIME 优先；MediaType 5 同时涵盖 xls/xlsx/csv，MediaType 3/4 也含旧 Office 格式。
  if (fromContentType && allowed?.includes(fromContentType)) {
    return fromContentType;
  }
  // 没有可信 MIME 时沿用标题里已允许的扩展，避免把 Budget.csv 改成 .xlsx。
  const fromTitle = extensionOf(title);
  if (fromTitle && allowed?.includes(fromTitle)) {
    return fromTitle;
  }
  return MEDIA[mediaType]?.extension ?? '';
}

function mediaMime(mediaType: number, extension: string, contentType: string | null): string {
  const byExtension = MIME_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return MEDIA[mediaType]?.mime ?? 'application/octet-stream';
}

/** IMA 返回的下载 header 只准发往本次 URL 的 origin；路由/hop-by-hop 头与 CR/LF 丢弃。 */
function safeDownloadHeaders(raw: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.trim().toLowerCase();
    if (!key || HOP_BY_HOP_HEADERS.has(key)) continue;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
    headers[key] = value;
  }
  return headers;
}

/** 预签名 URL 的 query 可能带着长期令牌，失败信息里必须去掉。 */
function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return 'download URL';
    }
  });
}

function sanitizeDownloadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(redactUrls(message));
}

async function downloadMedia(
  config: SourceConfig,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  try {
    const target = await validateSourceUrl(url, origins(config));
    const response = await fetchChecked(target.href, {
      headers: safeDownloadHeaders(headers),
      authOrigin: target.origin,
      authFailure: 'item',
      ...origins(config),
      ...signalOption(signal),
    });
    return {
      bytes: await readBytesCapped(response, 'ima media'),
      contentType: response.headers.get('content-type'),
    };
  } catch (err) {
    if (err instanceof SourceAuthError || isAbort(err, signal)) throw err;
    throw sanitizeDownloadError(err);
  }
}

async function getMediaInfo(
  auth: Auth,
  mediaId: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof mediaInfoSchema>> {
  return callIma(
    auth,
    `${WIKI_PATH}/get_media_info`,
    { media_id: mediaId },
    mediaInfoSchema,
    signal,
    'get_media_info',
  );
}

type Folder = { id: string; name: string };

type MediaCandidate = {
  mediaId: string;
  title: string;
};

function officialFolder(raw: Record<string, unknown>): Folder | undefined {
  const folderId = textOf(raw.folder_id).trim();
  if (!folderId) return undefined;
  const name = textOf(raw.name).trim();
  if (!name) {
    // 有 folder_id 却没有名字：目录形状不完整，不能当空目录继续。
    throw new ItemError('ima folder item had no name', 'invalid_response', false);
  }
  return { id: folderId, name };
}

function upstreamFolder(raw: Record<string, unknown>): Folder | undefined {
  if (raw.media_type !== FOLDER_MEDIA_TYPE) return undefined;
  const mediaId = textOf(raw.media_id).trim();
  if (!mediaId) {
    throw new ItemError('ima folder item had no media_id', 'invalid_response', false);
  }
  // 上游实测形状把目录名放在 title；缺标题时用目录 ID 仅作路径占位，不生成文档。
  return { id: mediaId, name: textOf(raw.title).trim() || mediaId };
}

function mediaCandidate(raw: Record<string, unknown>): MediaCandidate | undefined {
  const mediaId = textOf(raw.media_id).trim();
  if (!mediaId) return undefined;
  return { mediaId, title: textOf(raw.title).trim() || mediaId };
}

async function readMedia(
  config: SourceConfig,
  auth: Auth,
  candidate: MediaCandidate,
  folderPath: string[],
  usedPaths: Set<string>,
  items: SourceItem[],
  failures: SourceFailure[],
  signal: AbortSignal | undefined,
): Promise<Folder | undefined> {
  const externalId = `ima:media:${auth.knowledgeBaseId}:${candidate.mediaId}`;
  try {
    const info = await getMediaInfo(auth, candidate.mediaId, signal);
    if (info.media_type === FOLDER_MEDIA_TYPE) {
      return { id: candidate.mediaId, name: candidate.title };
    }
    if (info.media_type === NOTEBOOK_MEDIA_TYPE) {
      const noteId = info.notebook_ext_info?.notebook_id?.trim() ?? '';
      if (!noteId) {
        throw new ItemError('ima note had no notebook_id', 'invalid_response', false);
      }
      const note = await callIma(
        auth,
        `${NOTE_PATH}/get_doc_content`,
        { note_id: noteId, target_content_format: 0 },
        noteContentSchema,
        signal,
        'get_doc_content',
      );
      const content = note.content ?? '';
      if (content.trim() === '') {
        // 笔记是纯文本且仅作者可读；空笔记不能用标题占位冒充正文。
        throw new ItemError('ima note body was empty', 'empty_content', false);
      }
      const name = sanitizeSegment(candidate.title, candidate.mediaId);
      const title = titleWithExtension(name, 'txt');
      items.push({
        externalId,
        title,
        path: uniquePath([...folderPath, title].join('/'), usedPaths, candidate.mediaId),
        sourceUrl: '',
        content: '',
        bytes: Buffer.from(content, 'utf8'),
        mimeType: 'text/plain',
      });
      return undefined;
    }

    const spec = MEDIA[info.media_type];
    if (!spec) {
      throw new ItemError(
        `unsupported ima media type ${info.media_type}`,
        'unsupported_type',
        false,
      );
    }
    const url = info.url_info?.url?.trim() ?? '';
    if (!url) {
      // 官方允许 code=0 但无 url_info；没有公开原文能力，不能生成标题空文。
      throw new ItemError('ima media has no downloadable URL', 'content_unavailable', false);
    }
    const { bytes, contentType } = await downloadMedia(
      config,
      url,
      info.url_info?.headers ?? {},
      signal,
    );
    if (bytes.length === 0) {
      throw new ItemError('ima media download was empty', 'empty_content', false);
    }
    const name = sanitizeSegment(candidate.title, candidate.mediaId);
    const extension = mediaExtension(info.media_type, contentType, name);
    const title = titleWithExtension(name, extension);
    items.push({
      externalId,
      title,
      path: uniquePath([...folderPath, title].join('/'), usedPaths, candidate.mediaId),
      sourceUrl: '',
      content: '',
      bytes,
      mimeType: mediaMime(info.media_type, extension, contentType),
    });
    return undefined;
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    if (isAbort(err, signal)) throw err;
    failures.push(failureOf(externalId, candidate.title, err));
    return undefined;
  }
}

function unknownFailureId(auth: Auth, raw: unknown): string {
  const mediaId = textOf(recordOf(raw)?.media_id).trim();
  if (mediaId) return `ima:media:${auth.knowledgeBaseId}:${mediaId}`;
  const digest = createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16);
  return `ima:unknown:${auth.knowledgeBaseId}:${digest}`;
}

export async function readIma(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous =
    cursor === undefined || Object.keys(cursor).length === 0
      ? undefined
      : z.object({ version: z.literal(1), initial: z.boolean() }).parse(cursor);
  const auth = authenticate(config);
  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];
  const usedPaths = new Set<string>();
  // 根目录的 folder_id 等于 KB ID；把它当作已访问，避免列表回指根时再枚举一次。
  const visitedFolders = new Set<string>([auth.knowledgeBaseId]);

  const queue: Array<{ id: string; path: string[] }> = [{ id: '', path: [] }];
  while (queue.length > 0) {
    const folder = queue.shift();
    if (!folder) break;
    let pageCursor = '';
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await listKnowledge(auth, folder.id, pageCursor, signal);
      assertListPage(response);
      for (const raw of response.knowledge_list) {
        const record = recordOf(raw);
        if (!record) {
          failures.push(
            failureOf(
              unknownFailureId(auth, raw),
              'unknown item',
              new ItemError('ima knowledge item was not an object', 'invalid_response', false),
            ),
          );
          continue;
        }

        let child: Folder | undefined;
        try {
          child = officialFolder(record) ?? upstreamFolder(record);
        } catch (err) {
          failures.push(failureOf(unknownFailureId(auth, record), textOf(record.title), err));
          continue;
        }
        if (child) {
          if (!visitedFolders.has(child.id)) {
            visitedFolders.add(child.id);
            queue.push({
              id: child.id,
              path: [...folder.path, sanitizeSegment(child.name, child.id)],
            });
          }
          continue;
        }

        const candidate = mediaCandidate(record);
        if (!candidate) {
          failures.push(
            failureOf(
              unknownFailureId(auth, record),
              'unknown item',
              new ItemError('ima knowledge item had no media_id', 'invalid_response', false),
            ),
          );
          continue;
        }
        const resolved = await readMedia(
          config,
          auth,
          candidate,
          folder.path,
          usedPaths,
          items,
          failures,
          signal,
        );
        if (resolved && !visitedFolders.has(resolved.id)) {
          visitedFolders.add(resolved.id);
          queue.push({
            id: resolved.id,
            path: [...folder.path, sanitizeSegment(resolved.name, resolved.id)],
          });
        }
      }

      if (response.is_end) break;
      const next = response.next_cursor?.trim() ?? '';
      if (seenCursors.has(next)) {
        throw new Error(`ima get_knowledge_list repeated next_cursor ${next}`);
      }
      seenCursors.add(next);
      pageCursor = next;
      if (page === MAX_PAGES - 1) {
        throw new Error(`ima get_knowledge_list exceeded ${MAX_PAGES} pages`);
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

export async function probeIma(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const auth = authenticate(config);
  // 只验证指定知识库首屏可读；addable 列表不是权限证明，也不读全部笔记。
  assertListPage(await listKnowledge(auth, '', '', signal));
}
