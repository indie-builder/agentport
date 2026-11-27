import { INVALID_CURSOR_MESSAGE, KNOWLEDGE_BASE_DISABLED_MESSAGE } from '@agentport/core';
import { type Database, isCanonicalTimestamp, repo } from '@agentport/db';
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
import type { CallToolResult, JsonSchemaType, McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { toolError } from '../../lib/mcp.js';
import {
  KnowledgeReadImageError,
  type KnowledgeServerInput,
  readKnowledgeImage,
} from './read-image.js';
import { QUOTE_LIMIT, type SearchKnowledgeResult, searchKnowledge } from './retrieval.js';

const baseIdArg = z.object({
  baseId: z
    .string()
    .optional()
    .describe('Must be the bound knowledge base ID; other bases are rejected.'),
});

function toolInput(schema: z.ZodObject) {
  return fromJsonSchema<Record<string, unknown>>(
    z.toJSONSchema(schema, { io: 'input' }) as unknown as JsonSchemaType,
  );
}

class KnowledgeReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeReadError';
  }
}

function jsonResult(value: SearchKnowledgeResult | KnowledgeReadResult | KnowledgeListResult): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

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
  for (const row of result) {
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
  updatedAt: string;
  id: string;
  kind: KnowledgeTarget['kind'];
}

function decodeCursor(value: string | undefined): ListCursor | null {
  if (value === undefined) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const canonical = Buffer.from(text, 'utf8').toString('base64url') === value;
  let parsed: unknown = null;
  if (canonical) {
    try {
      parsed = JSON.parse(text);
    } catch {}
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const cursor = parsed as Partial<ListCursor>;
    if (
      typeof cursor.updatedAt === 'string' &&
      isCanonicalTimestamp(cursor.updatedAt) &&
      typeof cursor.id === 'string' &&
      cursor.id !== '' &&
      !cursor.id.includes('\u0000') &&
      (cursor.kind === 'document' || cursor.kind === 'faq' || cursor.kind === 'wiki')
    )
      return cursor as ListCursor;
  }
  throw new KnowledgeReadError('INVALID_INPUT', INVALID_CURSOR_MESSAGE);
}
/** 原始 SQL 的 timestamptz 在不同驱动下可能是 Date 或字符串，统一成 ISO。 */
function timestampOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

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
  if (cursor !== null) {
    const [anchor] = await db.execute<{ id: string }>(sql`
      select id from (${union}) items where id = ${cursor.id} and kind = ${cursor.kind} limit 1
    `);
    if (!anchor) throw new KnowledgeReadError('INVALID_INPUT', INVALID_CURSOR_MESSAGE);
  }
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
  const rows = result.slice(0, limit);
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
      result.length > limit && last
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
    const baseActive = base?.status === 'active';
    const imageProcessingEnabled = base?.settings.imageProcessing?.enabled === true;

    const guard = (args: unknown): CallToolResult | null => {
      if (!baseActive) return toolError('BASE_DISABLED', KNOWLEDGE_BASE_DISABLED_MESSAGE);
      const parsed = baseIdArg.safeParse(args);
      const requested = parsed.success ? parsed.data.baseId : undefined;
      if (requested !== undefined && requested !== input.baseId) {
        return toolError('BASE_MISMATCH', '只能访问当前绑定的知识库');
      }
      return null;
    };

    server.registerTool(
      'knowledge_search',
      {
        description:
          'Search the knowledge base bound to this connection and return cited chunks. Use it for factual questions the bound documents, FAQs or wiki pages may answer; it cannot reach any other base. Results carry hits with citations, a degraded flag and warnings when retrieval fell back, and directAnswer when an FAQ answers directly.',
        inputSchema: toolInput(
          knowledgeSearchQuerySchema.omit({ diagnostics: true }).extend(baseIdArg.shape),
        ),
      },
      async (args, ctx) => {
        const denied = guard(args);
        if (denied) return denied;
        const parsed = knowledgeSearchQuerySchema.safeParse({ ...args, diagnostics: false });
        if (!parsed.success) return toolError('INVALID_INPUT', '检索参数不合法');
        const result = await searchKnowledge(input.db, input.baseId, parsed.data, {
          secretKey: input.secretKey,
          signal: input.signal ?? ctx.mcpReq.signal,
        });
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
        inputSchema: toolInput(knowledgeReadInputSchema.extend(baseIdArg.shape)),
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
        inputSchema: toolInput(knowledgeListInputSchema.extend(baseIdArg.shape)),
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
          inputSchema: toolInput(knowledgeReadImageInputSchema.extend(baseIdArg.shape)),
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
