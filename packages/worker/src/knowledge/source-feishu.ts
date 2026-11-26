import { z } from 'zod';
import {
  BINARY_MIME_BY_EXTENSION,
  declaredMime,
  extensionWithDot,
  MIME_BY_EXTENSION,
  mimeForExtension,
  textContentType,
} from './source-formats.js';
import {
  type FetchOptions,
  fetchBytes,
  fetchChecked,
  fetchJson,
  readBytesCapped,
  readCapped,
  SourceAuthError,
  type SourceUrlOptions,
  sourceNetworkOptions,
  validateSourceUrl,
} from './source-http.js';
import { sanitizeSegment, uniquePath } from './source-paths.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './source-types.js';
import {
  failureOf,
  parseCursor,
  SourceTruncatedError,
  snapshotOf,
  sourceCursorSchema,
  titleWithExtension,
} from './source-utils.js';

/** Documented Feishu credential/token failures; extend only with codes Feishu documents as auth. */
const FEISHU_AUTH_CODES = new Set([99991661, 99991663, 99991668]);

const MAX_FEISHU_BLOCKS = 50_000;

const EXTENSION_BY_MIME: Record<string, string> = {};
for (const [extension, mime] of Object.entries({
  ...MIME_BY_EXTENSION,
  ...BINARY_MIME_BY_EXTENSION,
})) {
  EXTENSION_BY_MIME[mime] ??= extension.slice(1);
}

type FeishuEmit =
  | {
      kind: 'item';
      title: string;
      path: string;
      sourceUrl: string;
      content: string;
      bytes?: Uint8Array;
      mimeType: string;
    }
  | { kind: 'failure'; failure: SourceFailure };

async function emitFeishuItem(input: {
  externalId: string;
  baseTitle: string;
  items: SourceItem[];
  failures: SourceFailure[];
  signal: AbortSignal | undefined;
  load: () => Promise<FeishuEmit>;
}): Promise<'continue' | 'stop'> {
  try {
    const loaded = await input.load();
    if (loaded.kind === 'failure') {
      input.failures.push(loaded.failure);
      return 'stop';
    }
    input.items.push({
      externalId: input.externalId,
      title: loaded.title,
      path: loaded.path,
      sourceUrl: loaded.sourceUrl,
      content: loaded.content,
      ...(loaded.bytes ? { bytes: loaded.bytes } : {}),
      mimeType: loaded.mimeType,
    });
    return 'continue';
  } catch (err) {
    if (err instanceof SourceAuthError || input.signal?.aborted) throw err;
    input.failures.push(failureOf(input.externalId, input.baseTitle, err, true));
    return 'continue';
  }
}

function driveFileMime(fileName: string, contentType: string | null): string {
  return (
    mimeForExtension(extensionWithDot(fileName)) ??
    declaredMime(contentType) ??
    'application/octet-stream'
  );
}

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
  region: z.enum(['feishu', 'lark']).optional(),
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

const EXPORT_KINDS: Record<string, { extension: 'docx' | 'xlsx'; mimeType: string }> = {
  doc: {
    extension: 'docx',
    mimeType: BINARY_MIME_BY_EXTENSION['.docx'],
  },
  docx: {
    extension: 'docx',
    mimeType: BINARY_MIME_BY_EXTENSION['.docx'],
  },
  sheet: {
    extension: 'xlsx',
    mimeType: BINARY_MIME_BY_EXTENSION['.xlsx'],
  },
  bitable: {
    extension: 'xlsx',
    mimeType: BINARY_MIME_BY_EXTENSION['.xlsx'],
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
  const mimeType = mimeForExtension(extension);
  return mimeType ? { extension: extension.slice(1), mimeType } : null;
}

function wikiDownloadFormat(
  downloadedName: string | undefined,
  contentType: string | null,
): DownloadFormat | 'conflict' | null {
  const named = downloadedName ? downloadFormat(extensionWithDot(downloadedName)) : null;
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const declaredExtension = EXTENSION_BY_MIME[mime];
  const declared = declaredExtension ? { extension: declaredExtension, mimeType: mime } : null;
  if (!named) return declared;
  if (!declared || named.mimeType === declared.mimeType) return named;
  const namedText = textContentType(named.mimeType);
  const declaredText = textContentType(declared.mimeType);
  if (namedText === declaredText) return namedText ? named : 'conflict';
  return declaredText ? named : declared;
}

function titleBinaryFormat(title: string): DownloadFormat | null {
  const extension = extensionWithDot(title);
  return BINARY_MIME_BY_EXTENSION[extension] ? downloadFormat(extension) : null;
}

function withFormatExtension(title: string, extension: string): string {
  const current = extensionWithDot(title);
  return `${current ? title.slice(0, -current.length) : title}.${extension}`;
}

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
    if (pageItems.length === 0 && response.data.has_more) {
      throw new Error('feishu wiki pagination returned an empty page with has_more');
    }
    nodes.push(...pageItems);
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
    if (pageFiles.length === 0 && response.data.has_more) {
      throw new Error('feishu drive pagination returned an empty page with has_more');
    }
    files.push(...pageFiles);
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
  const origins = sourceNetworkOptions(config);
  const base = feishuApiBase(config, settings);
  await validateSourceUrl(base, origins);

  const appId = String(config.settings.appId ?? '').trim();
  const appSecret = config.credentials.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error('feishu requires settings.appId and credentials.appSecret');
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
  if (!parsed.success) throw new Error('feishu token response does not match the expected schema');
  assertFeishuCode(parsed.data, 'token');
  const token = parsed.data.tenant_access_token;
  if (!token) throw new Error('feishu token response had no tenant_access_token');

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

export async function readFeishu(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous = parseCursor('feishu', sourceCursorSchema, cursor);
  const settings: FeishuSettings = feishuSettingsSchema.parse(config.settings);
  const { auth, base } = await feishuAuthFor(config, settings, signal);
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
        await emitFeishuItem({
          externalId,
          baseTitle,
          items,
          failures,
          signal,
          load: async () => {
            const exported = await exportFeishuFile(
              auth,
              file.token,
              file.type,
              signal,
              `feishu drive ${file.token}`,
            );
            const title = titleWithExtension(baseTitle, exported.extension);
            return {
              kind: 'item',
              title,
              path: uniquePath([...prefix, title].join('/'), usedPaths, file.token),
              sourceUrl,
              content: '',
              bytes: exported.bytes,
              mimeType: exported.mimeType,
            };
          },
        });
        return;
      }
      if (file.type === 'docx') {
        await emitFeishuItem({
          externalId,
          baseTitle,
          items,
          failures,
          signal,
          load: async () => {
            const blocks = await readDocxBlocks(auth, file.token);
            return {
              kind: 'item',
              title: baseTitle,
              path: uniquePath([...prefix, `${baseTitle}.md`].join('/'), usedPaths, file.token),
              sourceUrl,
              content: docxToMarkdown(blocks),
              mimeType: 'text/markdown',
            };
          },
        });
        return;
      }
      if (file.type === 'file') {
        await emitFeishuItem({
          externalId,
          baseTitle,
          items,
          failures,
          signal,
          load: async () => {
            const response = await fetchChecked(
              `${base}/open-apis/drive/v1/files/${encodeURIComponent(file.token)}/download`,
              { ...feishuFetchOptions(auth), authFailure: 'item' },
            );
            const contentType = response.headers.get('content-type');
            return {
              kind: 'item',
              title: baseTitle,
              path: uniquePath([...prefix, baseTitle].join('/'), usedPaths, file.token),
              sourceUrl,
              content: '',
              bytes: await readBytesCapped(response, `feishu drive file ${file.name}`),
              mimeType: driveFileMime(file.name, contentType),
            };
          },
        });
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
        await emitFeishuItem({
          externalId,
          baseTitle,
          items,
          failures,
          signal,
          load: async () => {
            const exported = await exportFeishuFile(
              auth,
              node.obj_token,
              node.obj_type,
              signal,
              `feishu wiki ${node.node_token}`,
            );
            const title = titleWithExtension(baseTitle, exported.extension);
            return {
              kind: 'item',
              title,
              path: uniquePath([...prefix, title].join('/'), usedPaths, node.node_token),
              sourceUrl: nodeLinks(node),
              content: '',
              bytes: exported.bytes,
              mimeType: exported.mimeType,
            };
          },
        });
      } else if (exportFiles && node.obj_type === 'file') {
        if (
          (await emitFeishuItem({
            externalId,
            baseTitle,
            items,
            failures,
            signal,
            load: async () => {
              const response = await fetchChecked(
                `${base}/open-apis/drive/v1/files/${encodeURIComponent(node.obj_token)}/download`,
                { ...feishuFetchOptions(auth), authFailure: 'item' },
              );
              const downloadedName = dispositionFilename(
                response.headers.get('content-disposition'),
              );
              const metadata = wikiDownloadFormat(
                downloadedName,
                response.headers.get('content-type'),
              );
              if (metadata === 'conflict') {
                return {
                  kind: 'failure',
                  failure: failureOf(
                    externalId,
                    baseTitle,
                    new Error(
                      `feishu wiki file ${node.node_token} download name and type disagree`,
                    ),
                    false,
                  ),
                };
              }
              const format = metadata ?? titleBinaryFormat(baseTitle);
              if (!format) {
                return {
                  kind: 'failure',
                  failure: failureOf(
                    externalId,
                    baseTitle,
                    new Error(
                      `feishu wiki file ${node.node_token} has no trustworthy download format`,
                    ),
                    false,
                  ),
                };
              }
              const title = withFormatExtension(baseTitle, format.extension);
              return {
                kind: 'item',
                title,
                path: uniquePath([...prefix, title].join('/'), usedPaths, node.node_token),
                sourceUrl: nodeLinks(node),
                content: '',
                bytes: await readBytesCapped(response, `feishu wiki file ${node.node_token}`),
                mimeType: format.mimeType,
              };
            },
          })) === 'stop'
        ) {
          return;
        }
      } else if (!exportFiles && node.obj_type === 'docx') {
        await emitFeishuItem({
          externalId,
          baseTitle,
          items,
          failures,
          signal,
          load: async () => {
            const blocks = await readDocxBlocks(auth, node.obj_token);
            return {
              kind: 'item',
              title: baseTitle,
              path: uniquePath(
                [...prefix, `${baseTitle}.md`].join('/'),
                usedPaths,
                node.node_token,
              ),
              sourceUrl: nodeLinks(node),
              content: docxToMarkdown(blocks),
              mimeType: 'text/markdown',
            };
          },
        });
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

  return snapshotOf(items, failures, previous);
}

export async function probeFeishu(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
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
