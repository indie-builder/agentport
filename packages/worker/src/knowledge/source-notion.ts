import { z } from 'zod';
import {
  type FetchOptions,
  fetchChecked,
  fetchJson,
  readBytesCapped,
  SourceAuthError,
  validateSourceUrl,
} from './source-http.js';
import { uniquePath } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * Notion 来源：页面正文走官方原生 Markdown，块接口只负责发现子页面/子数据库与附件。
 * 不在来源层重写一套块渲染器；properties 与正文同时保留，截断/未知块明确失败。
 */
const NOTION_API = 'https://api.notion.com';
const NOTION_VERSION = '2026-03-11';
const MAX_PAGES = 1000;
const MAX_BLOCKS = 50_000;
const DATA_SOURCE_RESULT_LIMIT = 10_000;

class TruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedError';
  }
}

const richTextSchema = z.looseObject({
  plain_text: z.string().optional(),
  href: z.string().nullish(),
});

const fileObjectSchema = z.looseObject({
  type: z.string(),
  name: z.string().nullish(),
  file: z.looseObject({ url: z.string(), expiry_time: z.string().optional() }).nullish(),
  external: z.looseObject({ url: z.string() }).nullish(),
  file_upload: z.looseObject({ id: z.string() }).nullish(),
  caption: z.array(richTextSchema).nullish(),
});

const propertySchema = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  title: z.array(richTextSchema).optional(),
  rich_text: z.array(richTextSchema).optional(),
  number: z.number().nullish(),
  select: z.looseObject({ name: z.string() }).nullish(),
  status: z.looseObject({ name: z.string() }).nullish(),
  multi_select: z.array(z.looseObject({ name: z.string() })).optional(),
  date: z.looseObject({ start: z.string(), end: z.string().nullish() }).nullish(),
  checkbox: z.boolean().nullish(),
  url: z.string().nullish(),
  email: z.string().nullish(),
  phone_number: z.string().nullish(),
  relation: z.array(z.looseObject({ id: z.string() })).optional(),
  people: z
    .array(z.looseObject({ id: z.string().optional(), name: z.string().nullish() }))
    .optional(),
  // 官方关系等数组属性超过一页时会在值上标记 has_more，必须再走 property-item 分页。
  has_more: z.boolean().optional(),
  files: z.array(fileObjectSchema).optional(),
  unique_id: z.looseObject({ prefix: z.string().nullish(), number: z.number() }).nullish(),
  created_time: z.string().nullish(),
  last_edited_time: z.string().nullish(),
  created_by: z.looseObject({ id: z.string().optional(), name: z.string().nullish() }).nullish(),
  last_edited_by: z
    .looseObject({ id: z.string().optional(), name: z.string().nullish() })
    .nullish(),
  formula: z
    .looseObject({
      type: z.string(),
      string: z.string().nullish(),
      number: z.number().nullish(),
      boolean: z.boolean().nullish(),
      date: z.looseObject({ start: z.string() }).nullish(),
    })
    .nullish(),
  rollup: z
    .looseObject({
      type: z.string(),
      number: z.number().nullish(),
      date: z.looseObject({ start: z.string() }).nullish(),
      array: z.array(z.unknown()).nullish(),
    })
    .nullish(),
});

const pageSchema = z.looseObject({
  object: z.string().optional(),
  id: z.string(),
  url: z.string().optional(),
  last_edited_time: z.string().optional(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
  properties: z.record(z.string(), propertySchema).optional(),
  // 数据库对象把标题放在顶层 title rich text 数组里。
  title: z.array(richTextSchema).optional(),
});

const databaseSchema = z.looseObject({
  object: z.string().optional(),
  id: z.string(),
  title: z.array(richTextSchema).optional(),
  // 官方 database 一定返回 data_sources；缺字段是部分对象，不能当成空数据库完整收尾。
  data_sources: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })),
});

const dataSourceSchema = z.looseObject({ object: z.string().optional(), id: z.string() });

const propertyItemListSchema = z.looseObject({
  object: z.literal('list'),
  type: z.string().optional(),
  property_item: z
    .looseObject({
      id: z.string().optional(),
      type: z.string().optional(),
      next_url: z.string().nullish(),
    })
    .optional(),
  results: z.array(z.looseObject({ object: z.string().optional(), type: z.string() })),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
});

const markdownSchema = z.looseObject({
  object: z.string().optional(),
  id: z.string(),
  markdown: z.string(),
  truncated: z.boolean(),
  unknown_block_ids: z.array(z.string()),
  warnings: z.array(z.unknown()).optional(),
});

const blockSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  has_children: z.boolean().optional(),
  child_page: z.looseObject({ title: z.string().optional() }).optional(),
  child_database: z.looseObject({ title: z.string().optional() }).optional(),
  file: fileObjectSchema.optional(),
  pdf: fileObjectSchema.optional(),
  image: fileObjectSchema.optional(),
  video: fileObjectSchema.optional(),
  audio: fileObjectSchema.optional(),
});

const blockListSchema = z.looseObject({
  object: z.string().optional(),
  results: z.array(blockSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
  request_status: z
    .looseObject({ type: z.string(), incomplete_reason: z.string().optional() })
    .optional(),
});

const dataSourceResultSchema = z.looseObject({
  object: z.literal('data_source'),
  id: z.string(),
  title: z.array(richTextSchema).optional(),
});

const pageResultSchema = pageSchema.extend({ object: z.literal('page') });

const queryResultSchema = z.union([dataSourceResultSchema, pageResultSchema]);

const querySchema = z.looseObject({
  object: z.string().optional(),
  results: z.array(queryResultSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
  request_status: z
    .looseObject({ type: z.string(), incomplete_reason: z.string().optional() })
    .optional(),
});

const settingsSchema = z.object({
  rangeKind: z.enum(['notion_page', 'notion_database', 'notion_data_source']),
  resourceId: z.string(),
});

const cursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

type Page = z.infer<typeof pageSchema>;
type Block = z.infer<typeof blockSchema>;
type FileObject = z.infer<typeof fileObjectSchema>;
type Property = z.infer<typeof propertySchema>;

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
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

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries({ ...TEXT_MIME_BY_EXTENSION, ...BINARY_MIME_BY_EXTENSION }).map(
    ([extension, mime]) => [mime, extension],
  ),
);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** 扩展名优先：下载响应头常缺失或误报文本，不能拿它覆盖真实原件类型。 */
function mimeForName(name: string, contentType: string | null): string {
  const byExtension =
    BINARY_MIME_BY_EXTENSION[extensionOf(name)] ?? TEXT_MIME_BY_EXTENSION[extensionOf(name)];
  if (byExtension) return byExtension;
  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return 'application/octet-stream';
}

function ensureExtension(name: string, mimeType: string): string {
  if (extensionOf(name)) return name;
  return `${name}${EXTENSION_BY_MIME[mimeType] ?? '.bin'}`;
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

function compactId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '');
}

function normalizeUuid(raw: string): string {
  const compact = compactId(raw);
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error(`invalid Notion UUID: ${raw}`);
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

function notionPageUrl(id: string): string {
  return `https://www.notion.so/${compactId(id)}`;
}

function fileNameFromUrl(raw: string): string {
  try {
    const last = new URL(raw).pathname.split('/').pop() ?? '';
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      // 保留原始段，后面还会过 sanitize。
    }
    return sanitizeSegment(decoded, 'attachment');
  } catch {
    return 'attachment';
  }
}

type NotionContext = {
  config: SourceConfig;
  base: string;
  apiKey: string;
  signal: AbortSignal | undefined;
  items: SourceItem[];
  failures: SourceFailure[];
  visitedPages: Set<string>;
  visitedDatabases: Set<string>;
  visitedDataSources: Set<string>;
  usedPaths: Set<string>;
};

function notionNetwork(config: SourceConfig, signal: AbortSignal | undefined) {
  return {
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
}

function notionOptions(
  config: SourceConfig,
  apiKey: string,
  signal: AbortSignal | undefined,
  method?: 'GET' | 'POST',
  body?: string,
): FetchOptions {
  return {
    headers: {
      authorization: `Bearer ${apiKey}`,
      'notion-version': NOTION_VERSION,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    authOrigin: new URL(notionBase(config)).origin,
    ...notionNetwork(config, signal),
    ...(method ? { method } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

function notionBase(config: SourceConfig): string {
  return (config.url.trim() || NOTION_API).replace(/\/+$/, '');
}

function failureOf(
  externalId: string,
  title: string,
  err: unknown,
  retryable: boolean,
): SourceFailure {
  const truncated = err instanceof TruncatedError;
  return {
    externalId,
    title,
    code: truncated ? 'truncated' : retryable ? 'fetch_failed' : 'unsupported_type',
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    retryable: truncated ? false : retryable,
  };
}

/** 调用方取消不能被降级成单项失败：整轮读取必须立即结束。 */
function rethrowAbort(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? err;
}

function richTextPlain(items: readonly { plain_text?: string | undefined }[] | undefined): string {
  return (items ?? []).map((item) => item.plain_text ?? '').join('');
}

/** rollup.array 的条目就是无 property ID 的类型值，复用同一序列化逻辑保留真实值。 */
function rollupArrayValues(items: readonly unknown[]): string {
  return items
    .map((item) =>
      item !== null && typeof item === 'object' && 'type' in item
        ? propertyValue(item as Property)
        : '',
    )
    .filter((value) => value !== '')
    .join(', ');
}

function propertyValue(property: Property): string {
  switch (property.type) {
    case 'title':
      return richTextPlain(property.title);
    case 'rich_text':
      return richTextPlain(property.rich_text);
    case 'number':
      return property.number === null || property.number === undefined
        ? ''
        : String(property.number);
    case 'select':
      return property.select?.name ?? '';
    case 'status':
      return property.status?.name ?? '';
    case 'multi_select':
      return (property.multi_select ?? []).map((entry) => entry.name).join(', ');
    case 'date':
      return property.date
        ? `${property.date.start}${property.date.end ? ` → ${property.date.end}` : ''}`
        : '';
    case 'checkbox':
      return property.checkbox === null || property.checkbox === undefined
        ? ''
        : String(property.checkbox);
    case 'url':
      return property.url ?? '';
    case 'email':
      return property.email ?? '';
    case 'phone_number':
      return property.phone_number ?? '';
    case 'relation':
      return (property.relation ?? []).map((entry) => entry.id).join(', ');
    case 'people':
      return (property.people ?? []).map((entry) => entry.name ?? entry.id ?? '').join(', ');
    case 'files':
      return (property.files ?? [])
        .map((entry) => entry.name ?? fileNameFromUrl(fileUrl(entry) ?? ''))
        .join(', ');
    case 'unique_id':
      return property.unique_id
        ? `${property.unique_id.prefix ?? ''}${property.unique_id.number}`
        : '';
    case 'created_time':
      return property.created_time ?? '';
    case 'last_edited_time':
      return property.last_edited_time ?? '';
    case 'created_by':
      return property.created_by?.name ?? property.created_by?.id ?? '';
    case 'last_edited_by':
      return property.last_edited_by?.name ?? property.last_edited_by?.id ?? '';
    case 'formula': {
      const formula = property.formula;
      if (!formula) return '';
      if (formula.string !== null && formula.string !== undefined) return formula.string;
      if (formula.number !== null && formula.number !== undefined) return String(formula.number);
      if (formula.boolean !== null && formula.boolean !== undefined) return String(formula.boolean);
      return formula.date?.start ?? '';
    }
    case 'rollup': {
      const rollup = property.rollup;
      if (!rollup) return '';
      if (rollup.number !== null && rollup.number !== undefined) return String(rollup.number);
      if (rollup.type === 'array') return rollupArrayValues(rollup.array ?? []);
      return rollup.date?.start ?? '';
    }
    default:
      // 未支持的属性类型不伪造内容；正文仍来自官方 Markdown。
      return '';
  }
}

function pageTitle(page: Page): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === 'title') return richTextPlain(property.title).trim();
  }
  return richTextPlain(page.title).trim();
}

const PAGINATED_PROPERTY_TYPES = new Set(['title', 'rich_text', 'people', 'relation']);

/**
 * 官方内联的 title/rich_text/people 超过阈值会静默截断，且不一定给 has_more，
 * 只有 property-item 接口能读全；relation 仍按内联 has_more 决定是否补页。
 */
const ALWAYS_COMPLETE_PROPERTY_TYPES = new Set(['title', 'rich_text', 'people']);

/**
 * 官方 property-item 接口从第一页返回完整数组，读取到终页后替换内联值。
 * 任何不完整（缺 cursor、cursor 重复、没有 property id）都让整页失败，不产出假完整。
 */
async function completePaginatedProperty(
  ctx: NotionContext,
  pageId: string,
  name: string,
  property: Property,
): Promise<Property> {
  if (property.has_more !== true && !ALWAYS_COMPLETE_PROPERTY_TYPES.has(property.type)) {
    return property;
  }
  if (!PAGINATED_PROPERTY_TYPES.has(property.type)) {
    throw new Error(
      `notion property ${name} on ${pageId} reports has_more for unsupported type ${property.type}`,
    );
  }
  if (!property.id) {
    throw new Error(
      `notion property ${name} on ${pageId} has no property id; cannot prove complete`,
    );
  }
  const inline = (property as Record<string, unknown>)[property.type];
  const values: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const response = await fetchJson(
      `${ctx.base}/v1/pages/${encodeURIComponent(pageId)}/properties/${encodeURIComponent(property.id)}?${params.toString()}`,
      propertyItemListSchema,
      notionOptions(ctx.config, ctx.apiKey, ctx.signal),
      'notion page property',
    );
    for (const item of response.results) {
      if (item.type !== property.type) {
        throw new Error(
          `notion property ${name} on ${pageId} returned ${item.type} instead of ${property.type}`,
        );
      }
      const value = (item as Record<string, unknown>)[item.type];
      if (value === undefined) {
        throw new Error(`notion property ${name} on ${pageId} has no ${item.type} value`);
      }
      values.push(value);
    }
    if (!response.has_more) {
      // 内联有值而终页为空是矛盾响应，不能当成空属性静默覆盖。
      if (values.length === 0 && Array.isArray(inline) && inline.length > 0) {
        throw new Error(`notion property ${name} on ${pageId} returned no items`);
      }
      const merged = { ...property } as Record<string, unknown>;
      merged[property.type] = values;
      merged.has_more = false;
      return merged as Property;
    }
    const next = response.next_cursor ?? '';
    if (!next) throw new Error(`notion property ${name} on ${pageId} has no next_cursor`);
    if (cursors.has(next)) {
      throw new Error(`notion property ${name} on ${pageId} repeated cursor ${next}`);
    }
    cursors.add(next);
    cursor = next;
  }
  throw new TruncatedError(`notion property ${name} on ${pageId} exceeded ${MAX_PAGES} pages`);
}

async function completePageProperties(
  ctx: NotionContext,
  pageId: string,
  page: Page,
): Promise<Page> {
  if (!page.properties) return page;
  const entries = Object.entries(page.properties);
  const needsCompletion = entries.some(
    ([, property]) =>
      property.has_more === true || ALWAYS_COMPLETE_PROPERTY_TYPES.has(property.type),
  );
  if (!needsCompletion) return page;
  const properties: Record<string, Property> = {};
  for (const [name, property] of entries) {
    properties[name] = await completePaginatedProperty(ctx, pageId, name, property);
  }
  return { ...page, properties };
}

function pageContent(title: string, page: Page, markdown: string): string {
  const lines = [`# ${title}`];
  for (const [name, property] of Object.entries(page.properties ?? {})) {
    if (property.type === 'title') continue;
    const value = propertyValue(property)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (value !== '') lines.push(`- ${name}: ${value}`);
  }
  const body = markdown.trim();
  if (body !== '') lines.push('', body);
  return `${lines.join('\n')}\n`;
}

function fileUrl(file: FileObject): string | undefined {
  return file.file?.url ?? file.external?.url ?? undefined;
}

function isExpiredFile(file: FileObject): boolean {
  const expiry = file.file?.expiry_time;
  if (!expiry) return false;
  const time = Date.parse(expiry);
  return Number.isFinite(time) && time <= Date.now();
}

/** fetchChecked 在 authFailure 'item' 下把 401/403 抛成普通错误；仅这两类可重取签名 URL。 */
function isExpiredAuthError(err: unknown): boolean {
  return err instanceof Error && /^HTTP (401|403) /.test(err.message);
}

function downloadOptions(ctx: NotionContext): FetchOptions {
  return { ...notionNetwork(ctx.config, ctx.signal), authFailure: 'item' };
}

async function listBlockChildren(ctx: NotionContext, blockId: string): Promise<Block[]> {
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const response = await fetchJson(
      `${ctx.base}/v1/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
      blockListSchema,
      notionOptions(ctx.config, ctx.apiKey, ctx.signal),
      'notion block children',
    );
    if (response.request_status?.type === 'incomplete') {
      throw new TruncatedError(
        `notion block children for ${blockId} are incomplete (${response.request_status.incomplete_reason ?? 'unknown reason'})`,
      );
    }
    blocks.push(...response.results);
    if (blocks.length > MAX_BLOCKS) {
      throw new TruncatedError(`notion block tree exceeded ${MAX_BLOCKS} blocks`);
    }
    if (!response.has_more) return blocks;
    const next = response.next_cursor ?? '';
    if (!next) throw new Error(`notion block pagination for ${blockId} has no next_cursor`);
    if (seen.has(next)) {
      throw new Error(`notion block pagination for ${blockId} repeated cursor ${next}`);
    }
    seen.add(next);
    cursor = next;
  }
  throw new TruncatedError(`notion block pagination for ${blockId} exceeded ${MAX_PAGES} pages`);
}

/** 递归发现后代块；child_page/child_database 由调用方单独遍历，不在这里展开。 */
async function collectBlocks(ctx: NotionContext, rootId: string): Promise<Block[]> {
  const result: Block[] = [];
  const pending = [rootId];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const containerId = pending[index] as string;
    if (visited.has(containerId)) continue;
    visited.add(containerId);
    for (const block of await listBlockChildren(ctx, containerId)) {
      if (result.length >= MAX_BLOCKS) {
        throw new TruncatedError(`notion block tree exceeded ${MAX_BLOCKS} blocks`);
      }
      result.push(block);
      if (
        block.has_children === true &&
        block.type !== 'child_page' &&
        block.type !== 'child_database'
      ) {
        pending.push(block.id);
      }
    }
  }
  return result;
}

async function queryDataSource(ctx: NotionContext, dataSourceId: string): Promise<Page[]> {
  const sourceKey = compactId(dataSourceId);
  if (ctx.visitedDataSources.has(sourceKey)) return [];
  ctx.visitedDataSources.add(sourceKey);

  const rows: Page[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const response = await fetchJson(
      `${ctx.base}/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      querySchema,
      notionOptions(ctx.config, ctx.apiKey, ctx.signal, 'POST', JSON.stringify(body)),
      'notion data source query',
    );
    if (response.request_status?.type === 'incomplete') {
      throw new TruncatedError(
        `notion data source ${dataSourceId} query is incomplete (${response.request_status.incomplete_reason ?? 'unknown reason'}); split the range`,
      );
    }
    for (const result of response.results) {
      // Wiki data source 的查询结果可以是子 data_source；按 object 递归，绝不能拿它的 ID 当 page 读。
      if (result.object === 'data_source') {
        rows.push(...(await queryDataSource(ctx, result.id)));
      } else {
        rows.push(result);
      }
    }
    if (rows.length >= DATA_SOURCE_RESULT_LIMIT) {
      throw new TruncatedError(
        `notion data source ${dataSourceId} reached the ${DATA_SOURCE_RESULT_LIMIT} result limit; split the range`,
      );
    }
    if (!response.has_more) return rows;
    const next = response.next_cursor ?? '';
    if (!next) {
      throw new Error(`notion data source ${dataSourceId} pagination has no next_cursor`);
    }
    if (seen.has(next)) {
      throw new Error(`notion data source ${dataSourceId} pagination repeated cursor ${next}`);
    }
    seen.add(next);
    cursor = next;
  }
  throw new TruncatedError(
    `notion data source ${dataSourceId} pagination exceeded ${MAX_PAGES} pages`,
  );
}

async function fetchPage(ctx: NotionContext, pageId: string): Promise<Page> {
  return fetchJson(
    `${ctx.base}/v1/pages/${encodeURIComponent(pageId)}`,
    pageSchema,
    notionOptions(ctx.config, ctx.apiKey, ctx.signal),
    'notion page',
  );
}

async function fetchMarkdown(
  ctx: NotionContext,
  pageId: string,
): Promise<z.infer<typeof markdownSchema>> {
  return fetchJson(
    `${ctx.base}/v1/pages/${encodeURIComponent(pageId)}/markdown?markdown_version=v2`,
    markdownSchema,
    notionOptions(ctx.config, ctx.apiKey, ctx.signal),
    'notion page markdown',
  );
}

async function fetchBlockFile(ctx: NotionContext, block: Block): Promise<FileObject> {
  const resolved = await fetchJson(
    `${ctx.base}/v1/blocks/${encodeURIComponent(block.id)}`,
    blockSchema,
    notionOptions(ctx.config, ctx.apiKey, ctx.signal),
    'notion block',
  );
  const raw = (resolved as Record<string, unknown>)[resolved.type];
  const parsed = fileObjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`notion block ${block.id} file upload has no readable shape`);
  }
  if (!fileUrl(parsed.data)) {
    throw new Error(`notion block ${block.id} file upload did not resolve to a URL`);
  }
  return parsed.data;
}

async function resolveFileObject(
  ctx: NotionContext,
  block: Block,
  file: FileObject,
): Promise<FileObject> {
  if (fileUrl(file)) return file;
  if (!file.file_upload?.id) {
    throw new Error(`notion block ${block.id} has no downloadable file URL`);
  }
  return fetchBlockFile(ctx, block);
}

async function emitAttachment(
  ctx: NotionContext,
  input: {
    externalId: string;
    pageId: string;
    pageUrl: string;
    pathPrefix: string[];
    file: FileObject;
    /** 签名 URL 或 ACL 失效时重取拥有者 metadata；只允许一次。 */
    refresh?: () => Promise<FileObject>;
  },
): Promise<void> {
  let file = input.file;
  let url = fileUrl(file);
  if (!url) throw new Error(`notion attachment ${input.externalId} has no download URL`);
  let refreshed = false;
  if (input.refresh && isExpiredFile(file)) {
    file = await input.refresh();
    refreshed = true;
    url = fileUrl(file);
    if (!url) throw new Error(`notion attachment ${input.externalId} has no download URL`);
  }
  // 附件 URL 是供应商签名/外链，401/403 只说明链接或 ACL 失效，不能停掉整个来源。
  let response: Response;
  try {
    response = await fetchChecked(url, downloadOptions(ctx));
  } catch (err) {
    if (refreshed || !input.refresh || !isExpiredAuthError(err)) throw err;
    file = await input.refresh();
    url = fileUrl(file);
    if (!url) throw new Error(`notion attachment ${input.externalId} has no download URL`);
    response = await fetchChecked(url, downloadOptions(ctx));
  }
  const bytes = await readBytesCapped(response, `notion attachment ${input.externalId}`);
  if (bytes.length === 0) throw new Error(`notion attachment ${input.externalId} is empty`);
  const rawName = file.name?.trim() || fileNameFromUrl(url);
  const mimeType = mimeForName(rawName, response.headers.get('content-type'));
  const title = ensureExtension(sanitizeSegment(rawName, 'attachment'), mimeType);
  ctx.items.push({
    externalId: input.externalId,
    title,
    path: uniquePath(
      [...input.pathPrefix, title].join('/'),
      ctx.usedPaths,
      compactId(input.pageId),
    ),
    sourceUrl: input.pageUrl,
    content: '',
    bytes,
    mimeType,
  });
}

async function emitBlockAttachment(
  ctx: NotionContext,
  pageId: string,
  pageUrl: string,
  pathPrefix: string[],
  block: Block,
): Promise<void> {
  const externalId = `notion:file:${pageId}:${block.id}`;
  const title = block.type;
  if (block.type === 'video' || block.type === 'audio') {
    ctx.failures.push(
      failureOf(externalId, title, new Error(`unsupported notion block type ${block.type}`), false),
    );
    return;
  }
  const raw = (block as Record<string, unknown>)[block.type];
  const parsed = fileObjectSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.failures.push(
      failureOf(externalId, title, new Error(`invalid notion ${block.type} block`), false),
    );
    return;
  }
  try {
    const file = await resolveFileObject(ctx, block, parsed.data);
    await emitAttachment(ctx, {
      externalId,
      pageId,
      pageUrl,
      pathPrefix: [...pathPrefix, 'attachments'],
      file,
      refresh: () => fetchBlockFile(ctx, block),
    });
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    rethrowAbort(err, ctx.signal);
    ctx.failures.push(failureOf(externalId, title, err, true));
  }
}

async function emitPropertyFiles(
  ctx: NotionContext,
  pageId: string,
  pageUrl: string,
  pathPrefix: string[],
  page: Page,
): Promise<void> {
  for (const [name, property] of Object.entries(page.properties ?? {})) {
    if (property.type !== 'files') continue;
    for (const [index, file] of (property.files ?? []).entries()) {
      const fileId = file.file_upload?.id ?? String(index);
      const externalId = `notion:file:${pageId}:${property.id ?? name}:${fileId}`;
      const refresh = async (): Promise<FileObject> => {
        const freshPage = await fetchPage(ctx, pageId);
        const freshProperty = freshPage.properties?.[name];
        if (freshProperty?.type !== 'files') {
          throw new Error(`notion page ${pageId} property ${name} is no longer a files property`);
        }
        const freshFiles = freshProperty.files ?? [];
        const fresh =
          file.file_upload?.id === undefined
            ? freshFiles[index]
            : freshFiles.find((entry) => entry.file_upload?.id === file.file_upload?.id);
        if (!fresh) {
          throw new Error(
            `notion page ${pageId} property ${name} no longer has attachment ${fileId}`,
          );
        }
        return fresh;
      };
      try {
        await emitAttachment(ctx, {
          externalId,
          pageId,
          pageUrl,
          pathPrefix: [...pathPrefix, 'attachments'],
          file,
          refresh,
        });
      } catch (err) {
        if (err instanceof SourceAuthError) throw err;
        rethrowAbort(err, ctx.signal);
        ctx.failures.push(failureOf(externalId, file.name ?? `${name} ${index}`, err, true));
      }
    }
  }
}

async function walkPage(
  ctx: NotionContext,
  rawPageId: string,
  prefix: string[],
  options: { knownPage?: Page; root?: boolean } = {},
): Promise<void> {
  const pageId = normalizeUuid(rawPageId);
  if (ctx.visitedPages.has(pageId)) return;
  ctx.visitedPages.add(pageId);

  const externalId = `notion:page:${pageId}`;
  let page = options.knownPage;
  if (!page) {
    try {
      page = await fetchPage(ctx, pageId);
    } catch (err) {
      // 根失联不是空根：404/403 直接失败，不能变成“空全集 + complete”。
      if (err instanceof SourceAuthError || options.root) throw err;
      rethrowAbort(err, ctx.signal);
      ctx.failures.push(failureOf(externalId, pageId, err, true));
      return;
    }
  }
  if (page.archived === true || page.in_trash === true) {
    if (options.root) throw new Error(`notion root page ${pageId} is archived or in trash`);
    return;
  }

  try {
    page = await completePageProperties(ctx, pageId, page);
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    rethrowAbort(err, ctx.signal);
    ctx.failures.push(failureOf(externalId, pageTitle(page) || pageId, err, true));
    return;
  }

  const title = sanitizeSegment(pageTitle(page) || 'Untitled', pageId);
  const pagePath = [...prefix, title];
  const pageUrl = page.url ?? notionPageUrl(pageId);

  let markdown: string | undefined;
  try {
    const response = await fetchMarkdown(ctx, pageId);
    if (compactId(response.id) !== compactId(pageId)) {
      throw new Error(`notion markdown id ${response.id} did not match page ${pageId}`);
    }
    if (response.truncated) {
      throw new TruncatedError(`notion markdown for ${pageId} is truncated`);
    }
    if (response.unknown_block_ids.length > 0) {
      throw new TruncatedError(
        `notion markdown for ${pageId} has unknown blocks: ${response.unknown_block_ids.join(', ')}`,
      );
    }
    if ((response.warnings?.length ?? 0) > 0) {
      throw new TruncatedError(`notion markdown for ${pageId} returned warnings`);
    }
    markdown = response.markdown;
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    rethrowAbort(err, ctx.signal);
    ctx.failures.push(failureOf(externalId, title, err, true));
  }

  if (markdown !== undefined) {
    ctx.items.push({
      externalId,
      title,
      path: uniquePath(`${pagePath.join('/')}.md`, ctx.usedPaths, compactId(pageId)),
      sourceUrl: pageUrl,
      content: pageContent(title, page, markdown),
      mimeType: 'text/markdown',
      ...(page.last_edited_time ? { revision: page.last_edited_time } : {}),
    });
    await emitPropertyFiles(ctx, pageId, pageUrl, pagePath, page);
  }

  let blocks: Block[];
  try {
    blocks = await collectBlocks(ctx, pageId);
  } catch (err) {
    if (err instanceof SourceAuthError) throw err;
    rethrowAbort(err, ctx.signal);
    ctx.failures.push(failureOf(externalId, title, err, true));
    return;
  }

  for (const block of blocks) {
    if (block.type === 'child_page') {
      await walkPage(ctx, block.id, pagePath);
      continue;
    }
    if (block.type === 'child_database') {
      await walkDatabase(ctx, block.id, pagePath);
      continue;
    }
    if (
      block.type === 'file' ||
      block.type === 'pdf' ||
      block.type === 'image' ||
      block.type === 'video' ||
      block.type === 'audio'
    ) {
      if (markdown === undefined) continue;
      await emitBlockAttachment(ctx, pageId, pageUrl, pagePath, block);
    }
  }
}

async function walkDatabase(
  ctx: NotionContext,
  rawDatabaseId: string,
  prefix: string[],
): Promise<void> {
  const databaseId = normalizeUuid(rawDatabaseId);
  if (ctx.visitedDatabases.has(databaseId)) return;
  ctx.visitedDatabases.add(databaseId);

  const database = await fetchJson(
    `${ctx.base}/v1/databases/${encodeURIComponent(databaseId)}`,
    databaseSchema,
    notionOptions(ctx.config, ctx.apiKey, ctx.signal),
    'notion database',
  );
  const databaseTitle = richTextPlain(database.title).trim();
  const recordPrefix =
    databaseTitle === '' ? prefix : [...prefix, sanitizeSegment(databaseTitle, databaseId)];
  for (const dataSource of database.data_sources) {
    // 一个 database 可能有多个 data_source；只取第一个会漏掉记录。
    const records = await queryDataSource(ctx, dataSource.id);
    for (const record of records) {
      if (record.archived === true || record.in_trash === true) continue;
      await walkPage(ctx, record.id, recordPrefix, { knownPage: record });
    }
  }
}

export async function readNotion(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous =
    cursor === undefined || Object.keys(cursor).length === 0
      ? undefined
      : cursorSchema.parse(cursor);
  const settings = settingsSchema.parse(config.settings);
  const apiKey = config.credentials.apiKey?.trim();
  if (!apiKey) throw new Error('notion credentials.apiKey is required');

  const base = notionBase(config);
  await validateSourceUrl(base, notionNetwork(config, signal));

  const ctx: NotionContext = {
    config,
    base,
    apiKey,
    signal,
    items: [],
    failures: [],
    visitedPages: new Set(),
    visitedDatabases: new Set(),
    visitedDataSources: new Set(),
    usedPaths: new Set(),
  };
  const resourceId = normalizeUuid(settings.resourceId);

  if (settings.rangeKind === 'notion_page') {
    await walkPage(ctx, resourceId, [], { root: true });
  } else if (settings.rangeKind === 'notion_database') {
    await walkDatabase(ctx, resourceId, []);
  } else {
    const records = await queryDataSource(ctx, resourceId);
    for (const record of records) {
      if (record.archived === true || record.in_trash === true) continue;
      await walkPage(ctx, record.id, [], { knownPage: record });
    }
  }

  return {
    items: ctx.items,
    ...(ctx.failures.length > 0 ? { failures: ctx.failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    // 任一页面/附件/查询不完整都不能证明全集，删除推导据此关闭。
    complete: ctx.failures.length === 0,
  };
}

/** 只核选定对象的 metadata；不遍历、不推进游标、不下载附件。 */
export async function probeNotion(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const settings = settingsSchema.parse(config.settings);
  const apiKey = config.credentials.apiKey?.trim();
  if (!apiKey) throw new Error('notion credentials.apiKey is required');
  const base = notionBase(config);
  await validateSourceUrl(base, notionNetwork(config, signal));
  const resourceId = normalizeUuid(settings.resourceId);
  const options = notionOptions(config, apiKey, signal);

  if (settings.rangeKind === 'notion_page') {
    await fetchJson(
      `${base}/v1/pages/${encodeURIComponent(resourceId)}`,
      pageSchema,
      options,
      'notion page',
    );
    return;
  }
  if (settings.rangeKind === 'notion_database') {
    await fetchJson(
      `${base}/v1/databases/${encodeURIComponent(resourceId)}`,
      databaseSchema,
      options,
      'notion database',
    );
    return;
  }
  await fetchJson(
    `${base}/v1/data_sources/${encodeURIComponent(resourceId)}`,
    dataSourceSchema,
    options,
    'notion data source',
  );
}
