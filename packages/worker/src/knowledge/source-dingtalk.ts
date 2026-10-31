import { z } from 'zod';
import {
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * DingTalk wiki (知识库) leaf reader.
 *
 * A wiki node ID is not a document key: native ALIDOC documents are read
 * through `/v2.0/doc/items?url=` → `dentry.docKey`, and uploaded files through
 * the storage space/dentry pair. Identity stays the wiki node ID so a renamed
 * or moved node keeps the same document.
 */

const BASE = 'https://api.dingtalk.com';
const MAX_PAGES = 1000;
const BLOCK_PAGE_SIZE = 100;

/** 钉钉博客上传文件的可解析格式；其它类型没有本契约内的读取链。 */
const BINARY_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

const settingsSchema = z.object({
  clientId: z.string().trim().min(1),
  operatorUnionId: z.string().trim().min(1),
  rangeKind: z.enum(['dingtalk_workspace', 'dingtalk_node']),
  resourceId: z.string().trim().min(1),
});

const tokenSchema = z.object({
  accessToken: z.string().optional(),
});

const nodeSchema = z.object({
  nodeId: z.string().min(1),
  workspaceId: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  extension: z.string().optional(),
  url: z.string().optional(),
  hasChildren: z.boolean().optional(),
  modifiedTime: z.string().optional(),
  modifiedTimestamp: z.union([z.number(), z.string()]).optional(),
});

const workspaceSchema = z.object({
  workspace: z.object({
    workspaceId: z.string().trim().min(1),
    rootNodeId: z.string().trim().min(1),
  }),
});

const nodeResponseSchema = z.object({ node: nodeSchema });

const nodeListSchema = z.object({
  nodes: z.array(nodeSchema),
  nextToken: z.string().optional(),
});

const derefId = z.union([z.string(), z.number()]);

const dentrySchema = z.object({
  docKey: z.string().optional(),
  dentryUuid: z.string().optional(),
  spaceId: derefId.optional(),
  dentryId: derefId.optional(),
});

const queryItemSchema = z.object({
  dentry: dentrySchema.optional(),
});

const dentryRefSchema = z.object({
  dentryId: derefId.optional(),
  spaceId: derefId.optional(),
});

const downloadInfoSchema = z.object({
  headerSignatureInfo: z
    .object({
      headers: z.record(z.string(), z.string()).optional(),
      resourceUrls: z.array(z.string()).optional(),
    })
    .optional(),
});

const blocksSchema = z.object({
  success: z.boolean().optional(),
  result: z
    .object({
      data: z.array(z.unknown()),
    })
    .optional(),
});

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

type Settings = z.infer<typeof settingsSchema>;
type Node = z.infer<typeof nodeSchema>;

type Auth = {
  settings: Settings;
  headers: Record<string, string>;
};

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

function apiOptions(auth: Auth, signal: AbortSignal | undefined) {
  return {
    headers: auth.headers,
    authOrigin: new URL(BASE).origin,
    ...signalOption(signal),
  };
}

async function authenticate(config: SourceConfig, signal: AbortSignal | undefined): Promise<Auth> {
  const settings = settingsSchema.parse(config.settings);
  const secret = config.credentials.clientSecret?.trim();
  if (!secret) throw new Error('dingtalk credentials.clientSecret is required');

  const response = await fetchJson(
    `${BASE}/v1.0/oauth2/accessToken`,
    tokenSchema,
    {
      method: 'POST',
      body: JSON.stringify({ appKey: settings.clientId, appSecret: secret }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      authOrigin: new URL(BASE).origin,
      ...signalOption(signal),
    },
    'dingtalk access token',
  );
  const token = response.accessToken?.trim();
  if (!token) throw new Error('dingtalk access token response was empty');

  return {
    settings,
    headers: {
      'x-acs-dingtalk-access-token': token,
      'content-type': 'application/json; charset=utf-8',
    },
  };
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

function revisionOf(node: Node): string {
  if (typeof node.modifiedTimestamp === 'number') return String(node.modifiedTimestamp);
  return (node.modifiedTimestamp ?? node.modifiedTime ?? '').trim();
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

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot + 1).toLowerCase();
}

function titleWithExtension(name: string, extension: string): string {
  return extensionOf(name) === extension.toLowerCase() ? name : `${name}.${extension}`;
}

function isFolder(node: Node): boolean {
  return node.type?.toUpperCase() === 'FOLDER';
}

function isOnlineDocument(node: Node): boolean {
  return (
    node.type?.toUpperCase() === 'FILE' &&
    node.category?.toUpperCase() === 'ALIDOC' &&
    node.extension?.toLowerCase() === 'adoc'
  );
}

function isUploadedDocument(node: Node): boolean {
  return (
    node.type?.toUpperCase() === 'FILE' &&
    node.category?.toUpperCase() === 'DOCUMENT' &&
    BINARY_MIME_BY_EXTENSION[node.extension?.toLowerCase() ?? ''] !== undefined
  );
}

function belongsToWorkspace(node: Node, workspaceId: string): boolean {
  return !node.workspaceId || !workspaceId || node.workspaceId === workspaceId;
}

async function listChildren(
  auth: Auth,
  parentNodeId: string,
  signal: AbortSignal | undefined,
  firstPageOnly = false,
): Promise<Node[]> {
  const nodes: Node[] = [];
  const seen = new Set<string>();
  let nextToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      parentNodeId,
      operatorId: auth.settings.operatorUnionId,
      maxResults: '50',
    });
    if (nextToken) params.set('nextToken', nextToken);
    const response = await fetchJson(
      `${BASE}/v2.0/wiki/nodes?${params.toString()}`,
      nodeListSchema,
      apiOptions(auth, signal),
      'dingtalk wiki nodes',
    );
    nodes.push(...response.nodes);
    const next = response.nextToken?.trim() ?? '';
    // 非终止空页说明枚举不完整；继续翻页会把「空页」当成正常终止。
    if (response.nodes.length === 0 && next) {
      throw new Error('dingtalk wiki nodes returned an empty page with a nextToken');
    }
    if (firstPageOnly) return nodes;
    if (!next) return nodes;
    if (seen.has(next)) throw new Error(`dingtalk wiki pagination repeated nextToken ${next}`);
    seen.add(next);
    nextToken = next;
  }
  throw new Error(`dingtalk wiki pagination exceeded ${MAX_PAGES} pages`);
}

async function getNode(auth: Auth, nodeId: string, signal: AbortSignal | undefined): Promise<Node> {
  const params = new URLSearchParams({ operatorId: auth.settings.operatorUnionId });
  const response = await fetchJson(
    `${BASE}/v2.0/wiki/nodes/${encodeURIComponent(nodeId)}?${params.toString()}`,
    nodeResponseSchema,
    apiOptions(auth, signal),
    'dingtalk wiki node',
  );
  return response.node;
}

async function queryDentry(
  auth: Auth,
  nodeUrl: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof dentrySchema>> {
  const params = new URLSearchParams({
    operatorId: auth.settings.operatorUnionId,
    url: nodeUrl,
  });
  const response = await fetchJson(
    `${BASE}/v2.0/doc/items?${params.toString()}`,
    queryItemSchema,
    apiOptions(auth, signal),
    'dingtalk document metadata',
  );
  if (!response.dentry) {
    throw new ItemError('dingtalk document metadata had no dentry', 'invalid_response', false);
  }
  return response.dentry;
}

async function resolveStorageIds(
  auth: Auth,
  dentry: z.infer<typeof dentrySchema>,
  signal: AbortSignal | undefined,
): Promise<{ spaceId: string; dentryId: string }> {
  const spaceId = asString(dentry.spaceId);
  const dentryId = asString(dentry.dentryId);
  if (/^\d+$/.test(spaceId) && /^\d+$/.test(dentryId)) return { spaceId, dentryId };

  const dentryUuid = dentry.dentryUuid?.trim() ?? '';
  if (!dentryUuid) {
    throw new ItemError('dingtalk document has no storage location', 'missing_storage_id', false);
  }
  const params = new URLSearchParams({ operatorId: auth.settings.operatorUnionId });
  const response = await fetchJson(
    `${BASE}/v2.0/doc/dentries/${encodeURIComponent(dentryUuid)}/queryDentryId?${params.toString()}`,
    dentryRefSchema,
    apiOptions(auth, signal),
    'dingtalk dentry location',
  );
  const resolvedSpace = asString(response.spaceId);
  const resolvedId = asString(response.dentryId);
  if (!/^\d+$/.test(resolvedSpace) || !/^\d+$/.test(resolvedId)) {
    throw new ItemError('dingtalk dentry location was incomplete', 'missing_storage_id', false);
  }
  return { spaceId: resolvedSpace, dentryId: resolvedId };
}

async function requestDownloadInfo(
  auth: Auth,
  storage: { spaceId: string; dentryId: string },
  signal: AbortSignal | undefined,
): Promise<{ url: string; headers: Record<string, string> }> {
  const params = new URLSearchParams({ unionId: auth.settings.operatorUnionId });
  const response = await fetchJson(
    `${BASE}/v1.0/storage/spaces/${encodeURIComponent(storage.spaceId)}/dentries/${encodeURIComponent(storage.dentryId)}/downloadInfos/query?${params.toString()}`,
    downloadInfoSchema,
    {
      ...apiOptions(auth, signal),
      method: 'POST',
      body: JSON.stringify({ option: { version: 1, preferIntranet: false } }),
    },
    'dingtalk document download info',
  );
  const info = response.headerSignatureInfo;
  const url = info?.resourceUrls?.[0]?.trim() ?? '';
  if (!url) {
    throw new ItemError('dingtalk returned no download URL', 'content_unavailable', false);
  }
  return { url, headers: info?.headers ?? {} };
}

/** 签名 URL 的 header 只能来自本次 API 响应；路由/hop-by-hop 头与 CR/LF 一律丢弃。 */
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
function sanitizeDownloadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return 'download URL';
    }
  });
  return new Error(redacted);
}

async function downloadSigned(
  config: SourceConfig,
  info: { url: string; headers: Record<string, string> },
  signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  try {
    const target = await validateSourceUrl(info.url, origins(config));
    const response = await fetchChecked(target.href, {
      headers: safeDownloadHeaders(info.headers),
      authOrigin: target.origin,
      authFailure: 'item',
      ...origins(config),
      ...signalOption(signal),
    });
    return {
      bytes: await readBytesCapped(response, 'dingtalk document'),
      contentType: response.headers.get('content-type'),
    };
  } catch (err) {
    if (err instanceof SourceAuthError || isAbort(err, signal)) throw err;
    throw sanitizeDownloadError(err);
  }
}

async function readUploadedDocument(
  config: SourceConfig,
  auth: Auth,
  node: Node,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const nodeUrl = node.url?.trim() ?? '';
  if (!nodeUrl) {
    throw new ItemError('dingtalk node has no document URL', 'missing_node_url', false);
  }
  const dentry = await queryDentry(auth, nodeUrl, signal);
  const storage = await resolveStorageIds(auth, dentry, signal);

  let lastError: unknown;
  // 预签名链接可能已过期；重新取一次 info 再下载，过期不是整源失败。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const info = await requestDownloadInfo(auth, storage, signal);
      return await downloadSigned(config, info, signal);
    } catch (err) {
      if (err instanceof SourceAuthError) throw err;
      if (err instanceof ItemError || isAbort(err, signal)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type Block = Record<string, unknown>;

function recordOf(value: unknown): Block | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Block)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function levelOf(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(textOf(value));
  if (!Number.isFinite(raw)) return 0;
  return Math.min(6, Math.max(0, Math.trunc(raw)));
}

function escapeText(value: string): string {
  return value
    .replace(/\0/g, '')
    .replace(/([\\`*_{}[\]<>#+!])/g, '\\$1')
    .replace(/^(\s*)([-~])/gm, '$1\\$2');
}

function safeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return '';
    }
  } catch {
    return '';
  }
  return trimmed.replace(/[\\ ()<>]/g, (char) => encodeURIComponent(char));
}

function styleText(value: string, inline: Block): string {
  let text = escapeText(value.replace(/\0/g, ''));
  if (text === '') return '';
  if (textOf(inline.fonts).toLowerCase() === 'monospace') text = `\`${text}\``;
  if (inline.bold === true) text = `**${text}**`;
  if (inline.italic === true) text = `*${text}*`;
  if (inline.strike === true || inline.stike === true) text = `~~${text}~~`;
  return text;
}

function renderInlines(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) {
    throw new ItemError('dingtalk inline children were not an array', 'unsupported_block', false);
  }
  let result = '';
  for (const child of value) {
    const inline = recordOf(child);
    if (!inline) {
      throw new ItemError('dingtalk inline element was not an object', 'unsupported_block', false);
    }
    if (typeof inline.blockType === 'string') {
      throw new ItemError(
        `unsupported nested block ${inline.blockType} inside inline content`,
        'unsupported_block',
        false,
      );
    }
    const properties = recordOf(inline.properties);
    const elementType = textOf(inline.elementType).toLowerCase();
    switch (elementType) {
      case '':
      case 'text':
        result += styleText(textOf(inline.text), inline);
        break;
      case 'sticker':
        result += escapeText(textOf(properties?.code));
        break;
      case 'image': {
        const src = safeUrl(textOf(properties?.src));
        if (!src) {
          throw new ItemError(
            'dingtalk image element had no usable source',
            'unsupported_block',
            false,
          );
        }
        result += `![image](${src})`;
        break;
      }
      case 'link': {
        const label = renderInlines(inline.children) || escapeText(textOf(inline.text));
        const href = safeUrl(textOf(properties?.href));
        result += href ? `[${label}](${href})` : label;
        break;
      }
      default:
        // 未建模的 inline 可能承载正文；继续渲染或猜测都会产出不完整文档。
        throw new ItemError(
          `unsupported dingtalk inline element type ${elementType}`,
          'unsupported_block',
          false,
        );
    }
  }
  return result;
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(cellText).join('');
  const record = recordOf(value);
  if (!record) return '';
  const text = textOf(record.text);
  if (text) return text;
  return record.children ? cellText(record.children) : '';
}

function tableRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (Array.isArray(row) ? row.map(cellText) : []));
}

function renderTable(value: unknown): string {
  const rows = tableRows(value);
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return '';
  const normalize = (row: string[]): string[] =>
    Array.from({ length: columns }, (_, index) =>
      (row[index] ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|'),
    );
  const line = (row: string[]): string => `| ${normalize(row).join(' | ')} |\n`;
  let result = line(rows[0] ?? []);
  result += line(Array.from({ length: columns }, () => '---'));
  for (const row of rows.slice(1)) result += line(row);
  return `${result}\n`;
}

function renderList(block: Block, ordered: boolean): string {
  const list = recordOf(ordered ? block.orderedList : block.unorderedList);
  // 文档形态把条目正文放在 children 的 inline 元素里；上游实测也把同一正文放在 text。
  const text = renderInlines(block.children) || escapeText(textOf(list?.text));
  if (!text) {
    throw new ItemError('dingtalk list block had no readable text', 'unsupported_block', false);
  }
  const level = levelOf(recordOf(list?.list)?.level);
  const indent = '  '.repeat(level);
  const marker = ordered ? '1. ' : '- ';
  const lines = text.split('\n');
  let result = `${indent}${marker}${lines[0] ?? ''}\n`;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    result += `${indent}${' '.repeat(marker.length)}${line}\n`;
  }
  return result;
}

function renderBlock(value: unknown): string {
  const block = recordOf(value);
  if (!block) throw new ItemError('dingtalk block was not an object', 'invalid_response', false);
  const blockType = textOf(block.blockType).toLowerCase();
  switch (blockType) {
    case 'paragraph': {
      const text =
        renderInlines(block.children) || escapeText(textOf(recordOf(block.paragraph)?.text));
      return text ? `${text}\n\n` : '';
    }
    case 'heading': {
      const heading = recordOf(block.heading);
      const text = renderInlines(block.children) || escapeText(textOf(heading?.text));
      if (!text) return '';
      return `${'#'.repeat(Math.max(1, levelOf(heading?.level)))} ${text}\n\n`;
    }
    case 'blockquote': {
      const text =
        renderInlines(block.children) || escapeText(textOf(recordOf(block.blockquote)?.text));
      if (!text) return '';
      return `${text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    }
    case 'orderedlist':
      return renderList(block, true);
    case 'unorderedlist':
      return renderList(block, false);
    case 'code': {
      const code = recordOf(block.code);
      const text = textOf(code?.text);
      if (!text) throw new ItemError('dingtalk code block was empty', 'unsupported_block', false);
      const title = textOf(code?.title)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      const syntax = textOf(code?.syntax)
        .replace(/[`\r\n]/g, '')
        .trim();
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
      return `${title ? `**${escapeText(title)}**\n\n` : ''}${fence}${syntax}\n${text}${
        text.endsWith('\n') ? '' : '\n'
      }${fence}\n\n`;
    }
    case 'table':
      return renderTable(recordOf(block.table)?.cells);
    case 'attachment': {
      const attachment = recordOf(block.attachment);
      const name = textOf(attachment?.name)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!name) {
        throw new ItemError('dingtalk attachment block had no name', 'unsupported_block', false);
      }
      const size = typeof attachment?.size === 'number' ? attachment.size : 0;
      return `Attachment: ${escapeText(name)}${size > 0 ? ` (${size} bytes)` : ''}\n\n`;
    }
    default:
      throw new ItemError(
        `unsupported dingtalk block type ${blockType || '(missing)'}`,
        'unsupported_block',
        false,
      );
  }
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.split(/[^`]+/)) longest = Math.max(longest, run.length);
  return longest;
}

function renderDocument(blocks: unknown[]): string {
  let result = '';
  for (const block of blocks) result += renderBlock(block);
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

async function readBlocks(
  auth: Auth,
  docKey: string,
  signal: AbortSignal | undefined,
  firstPageOnly = false,
): Promise<unknown[]> {
  const blocks: unknown[] = [];
  const seenIds = new Set<string>();
  const seenPages = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * BLOCK_PAGE_SIZE;
    const params = new URLSearchParams({
      operatorId: auth.settings.operatorUnionId,
      startIndex: String(start),
      endIndex: String(start + BLOCK_PAGE_SIZE - 1),
    });
    const response = await fetchJson(
      `${BASE}/v1.0/doc/suites/documents/${encodeURIComponent(docKey)}/blocks?${params.toString()}`,
      blocksSchema,
      apiOptions(auth, signal),
      'dingtalk document blocks',
    );
    if (response.success !== true || !response.result) {
      throw new Error('dingtalk document blocks request was unsuccessful');
    }
    const data = response.result.data;
    if (data.length === 0) return blocks;

    const signature = JSON.stringify(data);
    if (seenPages.has(signature)) {
      throw new Error('dingtalk document block pagination repeated a page');
    }
    seenPages.add(signature);

    for (const block of data) {
      const id = asString(recordOf(block)?.id);
      if (!id) continue;
      if (seenIds.has(id)) throw new Error(`dingtalk document repeated block id ${id}`);
      seenIds.add(id);
    }
    blocks.push(...data);
    if (firstPageOnly || data.length < BLOCK_PAGE_SIZE) return blocks;
  }
  throw new Error(`dingtalk document block pagination exceeded ${MAX_PAGES} pages`);
}

async function readOnlineDocument(
  auth: Auth,
  node: Node,
  signal: AbortSignal | undefined,
  firstPageOnly = false,
): Promise<string> {
  const nodeUrl = node.url?.trim() ?? '';
  if (!nodeUrl) {
    throw new ItemError('dingtalk node has no document URL', 'missing_node_url', false);
  }
  const dentry = await queryDentry(auth, nodeUrl, signal);
  const docKey = dentry.docKey?.trim() ?? '';
  // nodeId 不是 docKey；缺 docKey 时不能用节点 ID 猜。
  if (!docKey) {
    throw new ItemError('dingtalk document metadata had no docKey', 'missing_document_key', false);
  }
  const blocks = await readBlocks(auth, docKey, signal, firstPageOnly);
  if (firstPageOnly) return '';
  const markdown = renderDocument(blocks);
  if (markdown === '') {
    throw new ItemError('dingtalk document body was empty', 'empty_content', false);
  }
  return markdown;
}

async function emitNode(
  config: SourceConfig,
  auth: Auth,
  node: Node,
  workspaceId: string,
  prefix: string[],
  usedPaths: Set<string>,
  folders: Set<string>,
  items: SourceItem[],
  failures: SourceFailure[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!belongsToWorkspace(node, workspaceId)) {
    failures.push(
      failureOf(
        `dingtalk:node:${node.nodeId}`,
        sanitizeSegment(node.name ?? '', node.nodeId),
        new ItemError('dingtalk node belongs to another workspace', 'invalid_response', false),
      ),
    );
    return;
  }

  const name = sanitizeSegment(node.name?.trim() ?? '', node.nodeId);
  if (isFolder(node)) {
    if (folders.has(node.nodeId)) return;
    folders.add(node.nodeId);
    for (const child of await listChildren(auth, node.nodeId, signal)) {
      await emitNode(
        config,
        auth,
        child,
        workspaceId,
        [...prefix, name],
        usedPaths,
        folders,
        items,
        failures,
        signal,
      );
    }
    return;
  }

  const externalId = `dingtalk:node:${node.nodeId}`;
  const revision = revisionOf(node) || undefined;
  try {
    if (isOnlineDocument(node)) {
      const markdown = await readOnlineDocument(auth, node, signal);
      items.push({
        externalId,
        title: name,
        path: uniquePath([...prefix, `${name}.md`].join('/'), usedPaths, node.nodeId),
        sourceUrl: node.url?.trim() ?? '',
        content: markdown,
        mimeType: 'text/markdown',
        ...(revision ? { revision } : {}),
      });
    } else if (isUploadedDocument(node)) {
      const extension = node.extension?.toLowerCase() ?? '';
      const title = titleWithExtension(name, extension);
      const { bytes, contentType } = await readUploadedDocument(config, auth, node, signal);
      items.push({
        externalId,
        title,
        path: uniquePath([...prefix, title].join('/'), usedPaths, node.nodeId),
        sourceUrl: node.url?.trim() ?? '',
        content: '',
        bytes,
        mimeType: binaryMime(extension, contentType),
        ...(revision ? { revision } : {}),
      });
    } else {
      throw new ItemError(
        `unsupported dingtalk node type ${node.type ?? ''}/${node.category ?? ''}/${node.extension ?? ''}`,
        'unsupported_type',
        false,
      );
    }
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    if (isAbort(err, signal)) throw err;
    failures.push(failureOf(externalId, name, err));
  }

  // 文件节点也可能有后代（hasChildren），正文失败也不能漏掉子树。
  if (node.hasChildren === true && !folders.has(node.nodeId)) {
    folders.add(node.nodeId);
    for (const child of await listChildren(auth, node.nodeId, signal)) {
      await emitNode(
        config,
        auth,
        child,
        workspaceId,
        [...prefix, name],
        usedPaths,
        folders,
        items,
        failures,
        signal,
      );
    }
  }
}

function binaryMime(extension: string, contentType: string | null): string {
  const byExtension = BINARY_MIME_BY_EXTENSION[extension.toLowerCase()];
  if (byExtension) return byExtension;
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  return declared && declared !== 'application/octet-stream'
    ? declared
    : 'application/octet-stream';
}

async function resolveRoot(
  auth: Auth,
  signal: AbortSignal | undefined,
): Promise<{ workspaceId: string; rootNodeId: string; node?: Node }> {
  const { rangeKind, resourceId } = auth.settings;
  if (rangeKind === 'dingtalk_workspace') {
    const params = new URLSearchParams({ operatorId: auth.settings.operatorUnionId });
    const workspace = (
      await fetchJson(
        `${BASE}/v2.0/wiki/workspaces/${encodeURIComponent(resourceId)}?${params.toString()}`,
        workspaceSchema,
        apiOptions(auth, signal),
        'dingtalk workspace',
      )
    ).workspace;
    if (workspace.workspaceId !== resourceId) {
      throw new Error('dingtalk workspace response did not match the requested workspace');
    }
    return {
      workspaceId: workspace.workspaceId,
      rootNodeId: workspace.rootNodeId,
    };
  }

  const node = await getNode(auth, resourceId, signal);
  if (node.nodeId !== resourceId) {
    throw new Error('dingtalk node response did not match the requested node');
  }
  const workspaceId = node.workspaceId?.trim() ?? '';
  if (!workspaceId) throw new Error('dingtalk node did not report a workspace');
  return { workspaceId, rootNodeId: node.nodeId, node };
}

export async function readDingtalk(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous =
    cursor === undefined || Object.keys(cursor).length === 0
      ? undefined
      : z.object({ version: z.literal(1), initial: z.boolean() }).parse(cursor);
  const auth = await authenticate(config, signal);
  const root = await resolveRoot(auth, signal);
  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];
  const usedPaths = new Set<string>();
  const folders = new Set<string>();

  if (root.node) {
    await emitNode(
      config,
      auth,
      root.node,
      root.workspaceId,
      [],
      usedPaths,
      folders,
      items,
      failures,
      signal,
    );
  } else {
    for (const child of await listChildren(auth, root.rootNodeId, signal)) {
      await emitNode(
        config,
        auth,
        child,
        root.workspaceId,
        [],
        usedPaths,
        folders,
        items,
        failures,
        signal,
      );
    }
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

export async function probeDingtalk(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const auth = await authenticate(config, signal);
  const root = await resolveRoot(auth, signal);

  if (root.node && !isFolder(root.node)) {
    await probeNode(auth, root.node, signal);
    return;
  }
  const children = await listChildren(auth, root.rootNodeId, signal, true);
  const candidate = children.find((node) => !isFolder(node));
  if (candidate) {
    if (!belongsToWorkspace(candidate, root.workspaceId)) {
      throw new Error('dingtalk node belongs to another workspace');
    }
    await probeNode(auth, candidate, signal);
  }
}

async function probeNode(auth: Auth, node: Node, signal: AbortSignal | undefined): Promise<void> {
  if (isOnlineDocument(node)) {
    await readOnlineDocument(auth, node, signal, true);
    return;
  }
  if (isUploadedDocument(node)) {
    const nodeUrl = node.url?.trim() ?? '';
    if (!nodeUrl) throw new Error('dingtalk node has no document URL');
    const dentry = await queryDentry(auth, nodeUrl, signal);
    const storage = await resolveStorageIds(auth, dentry, signal);
    await requestDownloadInfo(auth, storage, signal);
    return;
  }
  // 非文档节点本身不代表凭证/范围不可用；列表已完成即为可用。
}
