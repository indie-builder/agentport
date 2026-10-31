import { z } from 'zod';
import { type FetchOptions, fetchJson, SourceAuthError, validateSourceUrl } from './source-http.js';
import type { SourceConfig, SourceFailure, SourceItem, SourceSnapshot } from './sources.js';

/**
 * 语雀来源：数字 ID 才是身份；列表按 offset 读全，正文优先 body（Markdown），
 * 只有 body_html 时按 HTML bytes 交既有 parser，绝不把 body_lake 当 Markdown。
 */
const YUQUE_API = 'https://www.yuque.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

class TruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedError';
  }
}

const safePositiveInteger = z.number().int().safe().positive();

const summarySchema = z.looseObject({
  id: safePositiveInteger,
  type: z.string(),
  slug: z.string().optional(),
  title: z.string(),
  status: z.union([z.string(), z.number().int()]).optional(),
  content_updated_at: z.string().optional(),
});

const listSchema = z.looseObject({
  data: z.array(summarySchema),
  meta: z.looseObject({ total: z.number().int().safe().nonnegative().optional() }).optional(),
});

const detailSchema = z.looseObject({
  data: z.looseObject({
    id: safePositiveInteger,
    type: z.string(),
    title: z.string(),
    slug: z.string().optional(),
    status: z.union([z.string(), z.number().int()]).optional(),
    format: z.string().optional(),
    body: z.string().nullish(),
    body_html: z.string().nullish(),
    body_lake: z.string().nullish(),
    content_updated_at: z.string().optional(),
    book: z
      .looseObject({ namespace: z.string().optional(), slug: z.string().optional() })
      .optional(),
  }),
});

const userSchema = z.looseObject({
  data: z.looseObject({ id: safePositiveInteger, login: z.string() }),
});

const settingsSchema = z.object({ repoId: z.string() });

const cursorSchema = z.object({ version: z.literal(1), initial: z.boolean() });

type Summary = z.infer<typeof summarySchema>;
type Detail = z.infer<typeof detailSchema>['data'];
type YuqueContext = {
  base: string;
  repoId: string;
  options: FetchOptions;
};

function apiBase(config: SourceConfig): string {
  return (config.url.trim() || YUQUE_API).replace(/\/+$/, '');
}

function fetchOptions(
  config: SourceConfig,
  token: string,
  signal: AbortSignal | undefined,
): FetchOptions {
  const base = apiBase(config);
  return {
    headers: { 'x-auth-token': token },
    authOrigin: new URL(base).origin,
    ...(config.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(config.trustedHosts?.length ? { trustedHosts: config.trustedHosts } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
}

function repoIdOf(raw: string): string {
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`yuque repoId must be a positive integer: ${raw}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`yuque repoId is not a safe integer: ${raw}`);
  }
  return String(parsed);
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

function isPublished(status: string | number | undefined): boolean {
  return status !== undefined && String(status) === '1';
}

function skipped(externalId: string, title: string, message: string): SourceFailure {
  return { externalId, title, code: 'skipped', message: message.slice(0, 500), retryable: false };
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

function encodeLinkPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function sourceUrlOf(ctx: YuqueContext, detail: Detail, summary: Summary): string {
  const namespace = detail.book?.namespace;
  const slug = detail.slug ?? summary.slug;
  if (!namespace || !slug) return '';
  return `${ctx.base}/${encodeLinkPath(namespace)}/${encodeURIComponent(slug)}`;
}

/** 列表必须读到真实终页；重复 ID、越界、total 未到齐都失败，不能拿 offset 递增当完整证明。 */
async function listDocuments(ctx: YuqueContext): Promise<Summary[]> {
  const docs: Summary[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchJson(
      `${ctx.base}/api/v2/repos/${ctx.repoId}/docs?offset=${offset}&limit=${PAGE_SIZE}`,
      listSchema,
      ctx.options,
      'yuque docs',
    );
    const pageTotal = response.meta?.total;
    if (pageTotal !== undefined) {
      if (total !== undefined && pageTotal !== total) {
        throw new Error(`yuque meta.total changed from ${total} to ${pageTotal}`);
      }
      total = pageTotal;
    }
    for (const doc of response.data) {
      if (ids.has(doc.id)) throw new Error(`yuque docs repeated id ${doc.id}`);
      ids.add(doc.id);
      docs.push(doc);
    }
    if (total !== undefined && docs.length > total) {
      throw new Error(`yuque returned ${docs.length} docs but meta.total is ${total}`);
    }
    if (response.data.length === 0) {
      if (total !== undefined && docs.length !== total) {
        throw new Error(`yuque docs ended at ${docs.length} before meta.total ${total}`);
      }
      return docs;
    }
    if (total !== undefined) {
      // total 是权威计数：短页可能只是 API 分块方式不同，继续读到 total 或空页。
      if (docs.length === total) return docs;
    } else if (response.data.length < PAGE_SIZE) {
      return docs;
    }
    offset += response.data.length;
    if (page === MAX_PAGES - 1) {
      throw new TruncatedError(`yuque docs pagination exceeded ${MAX_PAGES} pages`);
    }
  }
  throw new TruncatedError(`yuque docs pagination exceeded ${MAX_PAGES} pages`);
}

function itemFor(
  ctx: YuqueContext,
  summary: Summary,
  detail: Detail,
  usedPaths: Set<string>,
): SourceItem {
  const title = sanitizeSegment(
    detail.title.trim() || summary.title.trim() || 'Untitled',
    String(summary.id),
  );
  const body = detail.body;
  const html = detail.body_html;
  const revision = detail.content_updated_at ?? summary.content_updated_at;

  let content = '';
  let bytes: Uint8Array | undefined;
  let mimeType: string;
  if (detail.format === 'markdown' || detail.format === 'lake') {
    // format=lake 时 body 仍是 Markdown 表示；body_lake 是编辑器内部格式，不能当正文。
    if (typeof body === 'string' && body.trim() !== '') {
      content = body;
      mimeType = 'text/markdown';
    } else if (typeof html === 'string' && html.trim() !== '') {
      bytes = Buffer.from(html, 'utf8');
      mimeType = 'text/html';
    } else {
      throw new Error(`yuque doc ${summary.id} has no readable body`);
    }
  } else if (detail.format === 'html') {
    // format=html 的 body 与 body_html 都是 HTML；body_html 只在 body 为空时兜底。
    const htmlBody =
      typeof body === 'string' && body.trim() !== ''
        ? body
        : typeof html === 'string' && html.trim() !== ''
          ? html
          : undefined;
    if (htmlBody === undefined) throw new Error(`yuque doc ${summary.id} has no readable body`);
    bytes = Buffer.from(htmlBody, 'utf8');
    mimeType = 'text/html';
  } else {
    throw new Error(
      `yuque doc ${summary.id} has unsupported format ${detail.format ?? '(missing)'}`,
    );
  }

  return {
    externalId: `yuque:doc:${summary.id}`,
    title,
    path: uniquePath(`${title}.md`, usedPaths, String(summary.id)),
    sourceUrl: sourceUrlOf(ctx, detail, summary),
    content,
    ...(bytes ? { bytes } : {}),
    mimeType,
    ...(revision ? { revision } : {}),
  };
}

export async function readYuque(
  config: SourceConfig,
  cursor: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
): Promise<SourceSnapshot> {
  const previous =
    cursor === undefined || Object.keys(cursor).length === 0
      ? undefined
      : cursorSchema.parse(cursor);
  const settings = settingsSchema.parse(config.settings);
  const token = config.credentials.apiToken?.trim();
  if (!token) throw new Error('yuque credentials.apiToken is required');
  const base = apiBase(config);
  await validateSourceUrl(base, fetchOptions(config, token, signal));

  const ctx: YuqueContext = {
    base,
    repoId: repoIdOf(settings.repoId),
    options: fetchOptions(config, token, signal),
  };
  const summaries = await listDocuments(ctx);

  const items: SourceItem[] = [];
  const failures: SourceFailure[] = [];
  const usedPaths = new Set<string>();

  for (const summary of summaries) {
    const externalId = `yuque:doc:${summary.id}`;
    const title = summary.title.trim() || 'Untitled';
    if (summary.type !== 'Doc') {
      failures.push(skipped(externalId, title, `unsupported yuque doc type ${summary.type}`));
      continue;
    }
    if (!isPublished(summary.status)) {
      failures.push(skipped(externalId, title, `yuque doc ${summary.id} is not published`));
      continue;
    }

    try {
      const detail = await fetchJson(
        `${ctx.base}/api/v2/repos/${ctx.repoId}/docs/${summary.id}`,
        detailSchema,
        ctx.options,
        'yuque doc',
      );
      if (detail.data.id !== summary.id) {
        throw new Error(`yuque detail id ${detail.data.id} did not match listed doc ${summary.id}`);
      }
      if (detail.data.type !== 'Doc') {
        failures.push(skipped(externalId, title, `unsupported yuque doc type ${detail.data.type}`));
        continue;
      }
      if (!isPublished(detail.data.status ?? summary.status)) {
        failures.push(skipped(externalId, title, `yuque doc ${summary.id} is not published`));
        continue;
      }
      items.push(itemFor(ctx, summary, detail.data, usedPaths));
    } catch (err) {
      if (err instanceof SourceAuthError) throw err;
      if (signal?.aborted === true) throw signal.reason ?? err;
      failures.push(failureOf(externalId, title, err, true));
    }
  }

  return {
    items,
    ...(failures.length > 0 ? { failures } : {}),
    cursor: { version: 1, initial: previous === undefined },
    complete: failures.length === 0,
  };
}

/** 只核 token 与选定 repo 的可读性；不拉详情、不推进游标。 */
export async function probeYuque(
  config: SourceConfig,
  signal: AbortSignal | undefined,
): Promise<void> {
  const settings = settingsSchema.parse(config.settings);
  const token = config.credentials.apiToken?.trim();
  if (!token) throw new Error('yuque credentials.apiToken is required');
  const base = apiBase(config);
  const options = fetchOptions(config, token, signal);
  await validateSourceUrl(base, options);
  const repoId = repoIdOf(settings.repoId);

  await fetchJson(`${base}/api/v2/user`, userSchema, options, 'yuque user');
  await fetchJson(
    `${base}/api/v2/repos/${repoId}/docs?offset=0&limit=1`,
    listSchema,
    options,
    'yuque docs',
  );
}
