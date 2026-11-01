import { type Database, repo } from '@agentport/db';
import type {
  KnowledgeListInput,
  KnowledgeListResult,
  KnowledgeReadInput,
  KnowledgeReadResult,
  KnowledgeSearchHit,
  KnowledgeTarget,
} from '@agentport/shared';
import {
  knowledgeImageChunkMetadataSchema,
  knowledgeListInputSchema,
  knowledgeReadImageInputSchema,
  knowledgeReadInputSchema,
  knowledgeSearchQuerySchema,
} from '@agentport/shared';
import type { CallToolResult, McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { KnowledgeReadImageError, readKnowledgeImage } from './read-image.js';
import { type SearchKnowledgeResult, searchKnowledge } from './retrieval.js';

const QUOTE_LIMIT = 1200;

export interface KnowledgeServerInput {
  db: Database;
  /** server.config.knowledgeBaseId：工具只能看这一库。 */
  baseId: string;
  serverId: string;
  runId: string;
  secretKey: string;
  /** 与 worker 共享的解析产物根目录。 */
  knowledgeDir: string;
  signal?: AbortSignal | undefined;
}

const baseIdArg = z.object({ baseId: z.string().optional() });

class KnowledgeReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeReadError';
  }
}

/** 工具结果统一走 §5 wire：JSON 文本，前端与对话引用共用同一解析器。 */
function jsonResult(value: SearchKnowledgeResult | KnowledgeReadResult | KnowledgeListResult): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

/** read 只认当前有效发布版：显式 versionId 必须等于它，不能用旧版本绕过撤权。 */
function currentVersionOf(target: KnowledgeTarget, current: string | null): string {
  if (current === null) {
    throw new KnowledgeReadError(
      target.kind === 'wiki' ? 'WIKI_NOT_FOUND' : 'DOCUMENT_NOT_FOUND',
      target.kind === 'wiki' ? 'Wiki 页面没有可读的线上版本' : '文档不存在或尚未就绪',
    );
  }
  return current;
}

interface TextChunk {
  id: string;
  content: string;
  heading: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  locator: KnowledgeSearchHit['locator'];
  metadata: Record<string, unknown>;
}

interface ChunkRange {
  chunk: TextChunk;
  start: number;
  end: number;
}

/** 正文来自当前启用 leaf 的阅读顺序；父块与禁用块不进入正文。 */
async function loadDocumentBody(
  db: Database,
  versionId: string,
): Promise<{ markdown: string; ranges: ChunkRange[] }> {
  const result = await db.execute<{
    id: string;
    content: string;
    heading: string | null;
    page_from: number | null;
    page_to: number | null;
    locator: KnowledgeSearchHit['locator'];
    metadata: Record<string, unknown>;
  }>(sql`
    select id, content, heading, page_from, page_to, locator, metadata
    from knowledge_chunks
    where version_id = ${versionId}
      and enabled
      and coalesce(index_role, 'leaf') = 'leaf'
    order by ordinal, id
  `);
  let markdown = '';
  let codePoints = 0;
  const ranges: ChunkRange[] = [];
  for (const row of result.rows) {
    const separator = markdown.length === 0 ? '' : '\n\n';
    const start = codePoints + Array.from(separator).length;
    markdown += separator + row.content;
    const length = Array.from(row.content).length;
    ranges.push({
      chunk: {
        id: row.id,
        content: row.content,
        heading: row.heading,
        pageFrom: row.page_from,
        pageTo: row.page_to,
        locator: row.locator,
        metadata: row.metadata,
      },
      start,
      end: start + length,
    });
    codePoints = start + length;
  }
  return { markdown, ranges };
}

function citationOf(
  input: { target: KnowledgeTarget; versionId: string; title: string; sourceUrl: string | null },
  chunk: {
    id: string;
    content: string;
    heading: string | null;
    pageFrom: number | null;
    pageTo: number | null;
    locator: KnowledgeSearchHit['locator'];
    metadata?: Record<string, unknown>;
  },
): KnowledgeSearchHit {
  const parsed = chunk.metadata
    ? knowledgeImageChunkMetadataSchema.safeParse(chunk.metadata)
    : null;
  return {
    chunkId: chunk.id,
    documentId: input.target.id,
    versionId: input.versionId,
    target: input.target,
    targetVersionId: input.versionId,
    title: input.title,
    heading: chunk.heading,
    quote: Array.from(chunk.content).slice(0, QUOTE_LIMIT).join(''),
    pageFrom: chunk.pageFrom,
    pageTo: chunk.pageTo,
    locator: chunk.locator,
    parentContent: null,
    sourceUrl: input.sourceUrl,
    // 直接读取不是检索排序，不编造相关性分数。
    score: 0,
    scoreKind: 'rrf',
    scores: { keyword: null, vector: null, rrf: 0, rerank: null },
    image: parsed?.success ? parsed.data.image : null,
    faq: null,
  };
}

/** offset 是 Unicode code point 下标，不能用 UTF-16 的 String.slice 直接切。 */
function paginate(
  text: string,
  offset: number,
  limit: number,
): { markdown: string; offset: number; nextOffset: number | null; totalCharacters: number } {
  const chars = Array.from(text);
  const total = chars.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  return {
    markdown: chars.slice(start, end).join(''),
    offset: start,
    nextOffset: end < total ? end : null,
    totalCharacters: total,
  };
}

async function readDocumentTarget(
  db: Database,
  baseId: string,
  target: KnowledgeTarget,
  versionId: string | undefined,
  offset: number,
  limit: number,
): Promise<KnowledgeReadResult> {
  const document = await repo.knowledge.getReadableDocument(db, baseId, target.id);
  const expectedKind = target.kind === 'faq' ? 'faq' : 'document';
  if (!document || document.contentKind !== expectedKind) {
    throw new KnowledgeReadError('DOCUMENT_NOT_FOUND', '文档不存在或不可读');
  }
  const current = currentVersionOf(target, document.currentVersionId);
  if (versionId !== undefined && versionId !== current) {
    throw new KnowledgeReadError('VERSION_NOT_CURRENT', '只能读取当前有效版本');
  }

  let body: { markdown: string; ranges: ChunkRange[] };
  let citations: KnowledgeSearchHit[];
  if (target.kind === 'faq') {
    const version = await repo.knowledge.getVersion(db, current);
    const faq = version?.faq ?? null;
    if (!faq) throw new KnowledgeReadError('DOCUMENT_NOT_FOUND', 'FAQ 发布版正文不存在');
    const markdown = `${faq.question}\n\n${faq.answers.join('\n\n')}`;
    body = { markdown, ranges: [] };
    citations = [
      citationOf(
        { target, versionId: current, title: document.title, sourceUrl: document.sourceUrl },
        {
          id: `faq:${document.id}:${current}`,
          content: markdown,
          heading: faq.question,
          pageFrom: null,
          pageTo: null,
          locator: null,
        },
      ),
    ];
  } else {
    body = await loadDocumentBody(db, current);
    citations = [];
  }

  const page = paginate(body.markdown, offset, limit);
  if (target.kind === 'document') {
    const end = page.offset + Array.from(page.markdown).length;
    citations = body.ranges
      .filter((range) => range.start < end && range.end > page.offset)
      .map((range) =>
        citationOf(
          { target, versionId: current, title: document.title, sourceUrl: document.sourceUrl },
          range.chunk,
        ),
      );
  }
  return {
    target,
    versionId: current,
    title: document.title,
    sourceUrl: document.sourceUrl,
    markdown: page.markdown,
    offset: page.offset,
    nextOffset: page.nextOffset,
    totalCharacters: page.totalCharacters,
    citations,
  };
}

async function readWikiTarget(
  db: Database,
  baseId: string,
  target: KnowledgeTarget,
  versionId: string | undefined,
  offset: number,
  limit: number,
): Promise<KnowledgeReadResult> {
  const readable = await repo.knowledge.getReadableWikiPage(db, baseId, target.id);
  if (!readable) throw new KnowledgeReadError('WIKI_NOT_FOUND', 'Wiki 页面不存在或不可读');
  const { page, version } = readable;
  const current = currentVersionOf(target, page.currentVersionId);
  if (version.id !== current) {
    throw new KnowledgeReadError('WIKI_NOT_FOUND', 'Wiki 线上正文不存在');
  }
  if (versionId !== undefined && versionId !== current) {
    throw new KnowledgeReadError('VERSION_NOT_CURRENT', '只能读取当前有效版本');
  }
  const paged = paginate(version.markdown, offset, limit);
  return {
    target,
    versionId: current,
    title: page.title,
    sourceUrl: null,
    markdown: paged.markdown,
    offset: paged.offset,
    nextOffset: paged.nextOffset,
    totalCharacters: paged.totalCharacters,
    citations: [
      citationOf(
        { target, versionId: current, title: page.title, sourceUrl: null },
        {
          id: `wiki:${page.id}:${current}`,
          content: version.markdown,
          heading: null,
          pageFrom: null,
          pageTo: null,
          locator: null,
        },
      ),
    ],
  };
}

export async function readKnowledgeTarget(
  input: KnowledgeServerInput,
  args: KnowledgeReadInput,
): Promise<KnowledgeReadResult> {
  if (args.target.kind === 'wiki') {
    return readWikiTarget(
      input.db,
      input.baseId,
      args.target,
      args.versionId,
      args.offset,
      args.limit,
    );
  }
  return readDocumentTarget(
    input.db,
    input.baseId,
    args.target,
    args.versionId,
    args.offset,
    args.limit,
  );
}

interface ListCursor {
  /** DB 微秒精度时间文本，只作分页键；对外展示另用 ISO。 */
  updatedAt: string;
  id: string;
  kind: KnowledgeTarget['kind'];
}

function decodeCursor(value: string | undefined): ListCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ListCursor).updatedAt === 'string' &&
      typeof (parsed as ListCursor).id === 'string' &&
      ['document', 'faq', 'wiki'].includes((parsed as ListCursor).kind)
    ) {
      return parsed as ListCursor;
    }
  } catch {
    // 落到统一的 INVALID_INPUT，不把解析细节暴露给模型。
  }
  throw new KnowledgeReadError('INVALID_INPUT', 'cursor 不合法');
}
/** 原始 SQL 的 timestamptz 在不同驱动下可能是 Date 或字符串，统一成 ISO。 */
function timestampOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 分页键取数据库的微秒精度文本：Date.toISOString 只保留毫秒，
 * 同一事务内共享微秒的多个对象会被游标比较整段跳过。
 */
function cursorTimeSql(alias: string): ReturnType<typeof sql> {
  return sql`to_char(${sql.raw(alias)}.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

async function listReadable(
  db: Database,
  baseId: string,
  input: KnowledgeListInput,
): Promise<KnowledgeListResult> {
  const cursor = decodeCursor(input.cursor);
  const limit = input.limit;
  const parts = [];
  const docKinds = input.kinds.filter((kind) => kind !== 'wiki');
  if (docKinds.length > 0) {
    parts.push(sql`select d.id, d.title, d.folder_id, d.updated_at, ${cursorTimeSql('d')} as cursor_updated_at, d.content_kind as kind,
        d.current_version_id as version_id
      from knowledge_documents d
      where d.base_id = ${baseId}
        and ${repo.knowledge.readableDocumentSql('d')}
        and d.content_kind = any(array[${sql.join(
          docKinds.map((kind) => sql`${kind}`),
          sql`, `,
        )}]::text[])`);
  }
  if (input.kinds.includes('wiki')) {
    parts.push(sql`select p.id, p.title, null::text as folder_id, p.updated_at, ${cursorTimeSql('p')} as cursor_updated_at,
        'wiki'::text as kind, p.current_version_id as version_id
      from knowledge_wiki_pages p
      where ${repo.knowledge.readableWikiPageSql('p', baseId)}`);
  }
  const union = sql.join(parts, sql` union all `);
  const after = cursor
    ? sql`where (updated_at, id, kind) < (${cursor.updatedAt}::timestamptz, ${cursor.id}, ${cursor.kind})`
    : sql``;
  const result = await db.execute<{
    id: string;
    title: string;
    folder_id: string | null;
    updated_at: Date | string;
    cursor_updated_at: string;
    kind: KnowledgeTarget['kind'];
    version_id: string;
  }>(sql`
    with items as (${union})
    select id, title, folder_id, updated_at, cursor_updated_at, kind, version_id
    from items
    ${after}
    order by updated_at desc, id desc, kind desc
    limit ${limit + 1}
  `);
  const rows = result.rows.slice(0, limit);
  const tags = await repo.knowledge.getDocumentTagNames(
    db,
    rows.filter((row) => row.kind !== 'wiki').map((row) => row.id),
  );
  const items = rows.map((row) => ({
    target: { kind: row.kind, id: row.id } satisfies KnowledgeTarget,
    versionId: row.version_id,
    title: row.title,
    folderId: row.folder_id,
    tags: row.kind === 'wiki' ? [] : (tags.get(row.id) ?? []),
    updatedAt: timestampOf(row.updated_at),
  }));
  const last = rows.at(-1);
  return {
    items,
    nextCursor:
      result.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              updatedAt: last.cursor_updated_at,
              id: last.id,
              kind: last.kind,
            } satisfies ListCursor),
          ).toString('base64url')
        : null,
  };
}

export function buildKnowledgeServer(input: KnowledgeServerInput): McpHttpHandler {
  return createMcpHandler(async () => {
    const server = new McpServer({ name: `kb-${input.baseId}`, version: '1.0.0' });
    const base = await repo.knowledge.getBase(input.db, input.baseId);
    // 每次连接只读一次状态：handler 是每请求重建的，禁用后下一次调用即生效。
    const baseActive = base?.status === 'active';
    // 图片处理关闭时不暴露读图工具；普通检索/读取不受影响。
    const imageProcessingEnabled = base?.settings.imageProcessing?.enabled === true;

    const guard = (args: unknown): CallToolResult | null => {
      if (!baseActive) return toolError('BASE_DISABLED', '知识库已禁用');
      const parsed = baseIdArg.safeParse(args);
      const requested = parsed.success ? parsed.data.baseId : undefined;
      // 显式换库是越权意图，不能静默改回绑定库；工具不开放任意 base。
      if (requested !== undefined && requested !== input.baseId) {
        return toolError('BASE_MISMATCH', '只能访问当前绑定的知识库');
      }
      return null;
    };

    server.registerTool(
      'knowledge_search',
      {
        description:
          'Search the knowledge base bound to this connection and return cited chunks. Use it for factual questions the bound documents, FAQs or wiki pages may answer; it cannot reach any other base. Results carry hits with citations, a degraded flag and warnings when retrieval fell back, and directAnswer when an FAQ answers directly. Parameters: q is the query; kinds limits the sources; limit caps hits; folders and tags narrow the scope; rerank reorders by relevance; minVectorScore sets the minimum similarity for text-vector recall (keyword hits and the separate image-vector path are unaffected); onlyRecommended restricts FAQ hits to recommended entries; faqPriority also enables directAnswer and places FAQ hits first; faqDirectAnswerThreshold sets the raw-question cosine threshold for directAnswer.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            q: {
              type: 'string',
              minLength: 1,
              maxLength: 500,
              description: 'Query text (required, 1–500 characters).',
            },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['document', 'faq', 'wiki'] },
              description: 'Source kinds to search; omit to include document, FAQ and wiki.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Maximum number of hits (1–50, default 10).',
            },
            folders: {
              type: 'array',
              items: { type: 'string' },
              description: 'Restrict the search to these folders.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Return only entries carrying these tags.',
            },
            rerank: {
              type: 'boolean',
              description: 'Reorder hits with the rerank model (default true).',
            },
            minVectorScore: {
              type: 'number',
              minimum: -1,
              maximum: 1,
              description:
                'Minimum similarity for text-vector recall; keyword hits and the image-vector path are unaffected (default 0.3).',
            },
            onlyRecommended: {
              type: 'boolean',
              description:
                'Keep only recommended FAQ entries; documents and wiki pages are unaffected.',
            },
            faqPriority: {
              type: 'boolean',
              description:
                'Place FAQ hits before other results and enable directAnswer when retrieval is not degraded (default false).',
            },
            faqDirectAnswerThreshold: {
              type: 'number',
              minimum: -1,
              maximum: 1,
              description:
                'Raw-question cosine threshold for directAnswer; directAnswer also requires faqPriority=true and non-degraded retrieval (default 0.9).',
            },
            baseId: {
              type: 'string',
              description: 'Must be the bound knowledge base ID; other bases are rejected.',
            },
          },
          required: ['q'],
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args, ctx) => {
        const denied = guard(args);
        if (denied) return denied;
        // wire schema 自带默认值；diagnostics 只属于管理 REST，MCP 强制关闭。
        const parsed = knowledgeSearchQuerySchema.safeParse({ ...args, diagnostics: false });
        if (!parsed.success) return toolError('INVALID_INPUT', '检索参数不合法');
        const result = await searchKnowledge(input.db, input.baseId, parsed.data, {
          secretKey: input.secretKey,
          signal: input.signal ?? ctx.mcpReq.signal,
        });
        // 不返回候选诊断与内部配置，但 degraded/warnings/directAnswer 必须完整保留。
        return jsonResult({
          hits: result.hits,
          degraded: result.degraded,
          warnings: result.warnings,
          directAnswer: result.directAnswer,
        });
      },
    );

    server.registerTool(
      'knowledge_read',
      {
        description:
          'Read the current readable version of one document, FAQ or published wiki page as markdown. Use it when a search hit is not enough. Long content is paged with offset (Unicode code-point index) and limit; the result carries nextOffset while more remains. Only targets readable from the bound base can be read; anything else fails with an error.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            target: {
              type: 'object',
              description:
                'Target to read; kind is document, faq or wiki and id comes from search/list results.',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['document', 'faq', 'wiki'],
                  description: 'Target kind.',
                },
                id: { type: 'string', description: 'Target ID.' },
              },
              required: ['kind', 'id'],
            },
            versionId: {
              type: 'string',
              description:
                'Must equal the current effective version, otherwise VERSION_NOT_CURRENT is returned; omit to read the current effective version.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Start position (Unicode code-point index).',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20_000,
              description: 'Maximum characters to return (1–20000).',
            },
            baseId: { type: 'string', description: 'Must be the bound knowledge base ID.' },
          },
          required: ['target'],
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args) => {
        const denied = guard(args);
        if (denied) return denied;
        const parsed = knowledgeReadInputSchema.safeParse(args);
        if (!parsed.success) return toolError('INVALID_INPUT', '读取参数不合法');
        try {
          return jsonResult(await readKnowledgeTarget(input, parsed.data));
        } catch (err) {
          if (err instanceof KnowledgeReadError) return toolError(err.code, err.message);
          throw err;
        }
      },
    );

    server.registerTool(
      'knowledge_list',
      {
        description:
          'List readable documents, FAQs and published wiki pages in the knowledge base bound to this connection. Use it to discover what exists before searching, or to find IDs for knowledge_read. Filter by kinds; page with cursor and limit. A disabled base fails with BASE_DISABLED, and another base ID is rejected.',
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          type: 'object',
          properties: {
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['document', 'faq', 'wiki'] },
              description: 'Source kinds to list; omit to include document, FAQ and wiki.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from the previous page; omit for the first page.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Maximum items per page (1–50).',
            },
            baseId: { type: 'string', description: 'Must be the bound knowledge base ID.' },
          },
        } as Parameters<typeof fromJsonSchema>[0]),
      },
      async (args) => {
        const denied = guard(args);
        if (denied) return denied;
        const parsed = knowledgeListInputSchema.safeParse(args);
        if (!parsed.success) return toolError('INVALID_INPUT', '列表参数不合法');
        try {
          return jsonResult(await listReadable(input.db, input.baseId, parsed.data));
        } catch (err) {
          if (err instanceof KnowledgeReadError) return toolError(err.code, err.message);
          throw err;
        }
      },
    );

    if (imageProcessingEnabled) {
      server.registerTool(
        'knowledge_read_image',
        {
          description:
            'Read one image hit returned by knowledge_search. format=description (default) returns the stored OCR/caption text as JSON; format=image returns the original image plus its JSON metadata for vision models. chunkId must come from a prior search hit. Only available when image processing is enabled on the base; invalid parameters fail with an error.',
          inputSchema: fromJsonSchema<Record<string, unknown>>({
            type: 'object',
            properties: {
              chunkId: {
                type: 'string',
                description: 'Image chunk ID from a prior knowledge_search hit.',
              },
              format: {
                type: 'string',
                description:
                  'description (default) returns text; image returns the original image.',
              },
              baseId: { type: 'string', description: 'Must be the bound knowledge base ID.' },
            },
            required: ['chunkId'],
          } as Parameters<typeof fromJsonSchema>[0]),
        },
        async (args, ctx) => {
          const denied = guard(args);
          if (denied) return denied;
          const parsed = knowledgeReadImageInputSchema.safeParse(args);
          if (!parsed.success) return toolError('INVALID_INPUT', '图片参数不合法');
          try {
            const { result, image } = await readKnowledgeImage(
              { ...input, signal: input.signal ?? ctx.mcpReq.signal },
              parsed.data,
            );
            // 每次保留 JSON text：历史 trace 与 Web 引用按同一 wire 解析；图片作为额外块追加。
            const content: CallToolResult['content'] = [
              { type: 'text', text: JSON.stringify(result) },
              ...(image
                ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }]
                : []),
            ];
            return { content };
          } catch (err) {
            if (err instanceof KnowledgeReadImageError) return toolError(err.code, err.message);
            throw err;
          }
        },
      );
    }

    return server;
  });
}
