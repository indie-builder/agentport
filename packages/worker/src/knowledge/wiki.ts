import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { segmentForSearch } from '@agentport/core';
import { type Database, repo, schema } from '@agentport/db';
import type { KnowledgeJobPayload } from '@agentport/shared';
import { errorText, knowledgeJobPayloadSchema } from '@agentport/shared';
import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hermeticQueryOptions, runOneShotSdkQuery } from '../one-shot-sdk.js';
import { KnowledgeCancelled } from './ingestion.js';

type WikiPageRow = typeof schema.knowledgeWikiPages.$inferSelect;
type JobRow = typeof schema.knowledgeJobs.$inferSelect;
type WikiGeneratePayload = Extract<KnowledgeJobPayload, { type: 'wiki_generate' }>;

const WIKI_TOOL_NAMES = ['wiki_search', 'wiki_read', 'wiki_save_draft'] as const;
export const WIKI_ALLOWED_TOOLS = WIKI_TOOL_NAMES.map((name) => `mcp__knowledge__${name}`);

const READ_LIMIT = 20_000;
const QUOTE_LIMIT = 1200;
const SEARCH_LIMIT = 10;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * SDK 边界：测试可替换 query 实现，真实运行时直接使用官方 query。
 * 返回 AsyncGenerator 而非 AsyncIterable：收尾要 await return()，
 * 官方 Query.return() 才会等 cleanup（含子进程退出）完成。
 */
export type WikiQueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncGenerator<SDKMessage, void>;

export interface WikiGenerateDeps {
  db: Database;
  config: { KNOWLEDGE_DIR: string; KNOWLEDGE_WIKI_MODEL?: string | undefined };
  signal: AbortSignal;
  /** 替换真实 SDK query；测试注入假实现，不 mock 模块。 */
  queryFn?: WikiQueryFn;
}

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'page';
}

async function resolvePage(db: Database, payload: WikiGeneratePayload): Promise<WikiPageRow> {
  if (payload.pageId) {
    const page = await repo.knowledge.getWikiPage(db, payload.pageId);
    if (!page || page.baseId !== payload.baseId) throw new Error('Wiki 页面不存在或不属于该知识库');
    return page;
  }
  const title = payload.title?.trim() || '未命名页面';
  const [existing] = await db
    .select({ id: schema.knowledgeWikiPages.id })
    .from(schema.knowledgeWikiPages)
    .where(
      sql`${schema.knowledgeWikiPages.baseId} = ${payload.baseId}
        and ${schema.knowledgeWikiPages.slug} = ${slugify(title)}`,
    )
    .limit(1);
  const slug = existing ? `${slugify(title)}-${Date.now().toString(36).slice(-5)}` : slugify(title);
  return repo.knowledge.createWikiPage(db, { baseId: payload.baseId, slug, title });
}

interface SearchRow extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  version_id: string;
  heading: string | null;
  content: string;
  page_from: number | null;
  page_to: number | null;
  title: string;
  source_url: string | null;
  rank: number;
}

/**
 * shortcut: 关键词单路检索（无向量/rerank）；Wiki 草稿的取证够用，
 * 需要与聊天检索完全同分时改为调用 API 侧 searchKnowledge。
 */
async function searchBase(
  db: Database,
  baseId: string,
  q: string,
  limit: number,
  allowedDocumentIds: string[],
) {
  const segmented = segmentForSearch(q);
  if (segmented.length === 0) return [];
  const documentFilter =
    allowedDocumentIds.length > 0
      ? sql`and c.document_id in (${sql.join(
          allowedDocumentIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``;
  const result = await db.execute<SearchRow>(sql`
    select c.id as chunk_id, c.document_id, c.version_id, c.heading, c.content,
      c.page_from, c.page_to, d.title, d.source_url,
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', ${segmented})) as rank
    from knowledge_chunks c
    join knowledge_documents d on d.id = c.document_id
    where c.base_id = ${baseId}
      and c.enabled
      and d.current_version_id = c.version_id
      and ${repo.knowledge.readableDocumentSql('d')}
      and d.content_kind <> 'wiki'
      and c.search_vector @@ plainto_tsquery('simple', ${segmented})
      ${documentFilter}
    order by rank desc, c.id
    limit ${limit}
  `);
  return result.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    title: row.title,
    heading: row.heading,
    quote: row.content.slice(0, QUOTE_LIMIT),
    pageFrom: row.page_from,
    pageTo: row.page_to,
    sourceUrl: row.source_url,
    score: Number(row.rank),
  }));
}

async function readDocument(
  db: Database,
  knowledgeDir: string,
  baseId: string,
  documentId: string,
) {
  const document = await repo.knowledge.getReadableDocument(db, baseId, documentId);
  if (!document?.currentVersionId) return null;
  const markdown = await readFile(
    join(knowledgeDir, 'docs', document.id, document.currentVersionId, 'markdown.md'),
    'utf8',
  ).catch(() => null);
  if (markdown === null) return null;
  const truncated = markdown.length > READ_LIMIT;
  return {
    documentId: document.id,
    versionId: document.currentVersionId,
    title: document.title,
    sourceUrl: document.sourceUrl,
    markdown: truncated ? markdown.slice(0, READ_LIMIT) : markdown,
    truncated,
  };
}

async function validateSourceChunks(
  db: Database,
  baseId: string,
  sourceChunkIds: string[],
  allowedDocumentIds: string[],
): Promise<Array<{ id: string; documentId: string; versionId: string }>> {
  if (sourceChunkIds.length === 0) return [];
  const rows = await db
    .select({
      id: schema.knowledgeChunks.id,
      documentId: schema.knowledgeChunks.documentId,
      versionId: schema.knowledgeChunks.versionId,
    })
    .from(schema.knowledgeChunks)
    .innerJoin(
      schema.knowledgeDocuments,
      eq(schema.knowledgeDocuments.id, schema.knowledgeChunks.documentId),
    )
    .where(
      and(
        inArray(schema.knowledgeChunks.id, sourceChunkIds),
        eq(schema.knowledgeChunks.baseId, baseId),
        eq(schema.knowledgeChunks.enabled, true),
        sql`${schema.knowledgeChunks.versionId} = ${schema.knowledgeDocuments.currentVersionId}`,
        sql`${schema.knowledgeDocuments.contentKind} <> 'wiki'`,
        repo.knowledge.readableDocumentSql('knowledge_documents'),
        ...(allowedDocumentIds.length > 0
          ? [inArray(schema.knowledgeChunks.documentId, allowedDocumentIds)]
          : []),
      ),
    );
  if (rows.length !== new Set(sourceChunkIds).size) {
    const found = new Set(rows.map((row) => row.id));
    const invalid = sourceChunkIds.filter((id) => !found.has(id));
    throw new Error(`无效引用 chunkId: ${invalid.join(', ')}`);
  }
  return rows;
}

function buildPrompt(input: {
  baseName: string;
  pageTitle: string;
  instruction?: string | undefined;
  sourceDocumentIds?: string[] | undefined;
}): string {
  const lines = [
    `你是知识库《${input.baseName}》的 Wiki 编辑。请为页面「${input.pageTitle}」撰写 Markdown 草稿。`,
    '步骤：先用 wiki_search 检索证据，必要时用 wiki_read 阅读原文，最后用 wiki_save_draft 提交完整草稿。',
    '草稿必须基于检索到的内容，不得编造；sourceChunkIds 必须列出至少一个实际引用到的 chunkId。',
    '只提交一次草稿，提交后不要再修改。',
  ];
  if (input.instruction) lines.push(`补充要求：${input.instruction}`);
  if (input.sourceDocumentIds && input.sourceDocumentIds.length > 0) {
    lines.push(`只允许使用这些文档：${input.sourceDocumentIds.join(', ')}`);
  }
  return lines.join('\n');
}

export async function runWikiGenerate(job: JobRow, deps: WikiGenerateDeps): Promise<void> {
  const { db, signal } = deps;
  if (signal.aborted) throw new KnowledgeCancelled();
  const payload = knowledgeJobPayloadSchema.parse(job.payload);
  if (payload.type !== 'wiki_generate') throw new Error('只有 wiki_generate 任务可以生成 Wiki');

  const base = await repo.knowledge.getBase(db, payload.baseId);
  if (!base) throw new Error('知识库不存在，可能已被删除');
  const model = deps.config.KNOWLEDGE_WIKI_MODEL;
  if (!model) throw new Error('KNOWLEDGE_WIKI_MODEL 未配置，无法生成 Wiki');

  const page = await resolvePage(db, payload);
  const knowledgeDir = deps.config.KNOWLEDGE_DIR;
  const allowedDocumentIds = payload.sourceDocumentIds ?? [];
  const cwd = join(knowledgeDir, 'wiki-sdk', job.id);

  try {
    const savedVersions: string[] = [];
    const save = async (input: { markdown: string; sourceChunkIds: string[] }) => {
      if (signal.aborted) throw new KnowledgeCancelled();
      if (input.sourceChunkIds.length === 0) {
        throw new Error('MODEL_SOURCE_REQUIRED: 模型草稿必须引用至少一个来源 chunk');
      }
      const current = await repo.knowledge.getJob(db, job.id);
      if (current?.status !== 'running') throw new Error('任务已结束，拒绝写入草稿');
      const chunks = await validateSourceChunks(
        db,
        payload.baseId,
        input.sourceChunkIds,
        allowedDocumentIds,
      );
      const version = await repo.knowledge.saveWikiDraft(db, page.id, {
        markdown: input.markdown,
        sourceChunkIds: chunks.map((chunk) => chunk.id),
        model,
        generatedBy: 'sdk',
      });
      if (!version) throw new Error('Wiki 页面不存在，可能已被删除');
      savedVersions.push(version.id);
      return version.id;
    };

    const server = createSdkMcpServer({
      name: 'knowledge',
      version: '1.0.0',
      tools: [
        tool(
          'wiki_search',
          'Search the bound knowledge base; returns chunks with ids you can cite.',
          { q: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() },
          async (args) => {
            const hits = await searchBase(
              db,
              payload.baseId,
              args.q,
              args.limit ?? SEARCH_LIMIT,
              allowedDocumentIds,
            );
            return text({ hits });
          },
        ),
        tool(
          'wiki_read',
          'Read the current version of one document as markdown.',
          { documentId: z.string().min(1) },
          async (args) => {
            if (allowedDocumentIds.length > 0 && !allowedDocumentIds.includes(args.documentId)) {
              return toolError('DOCUMENT_NOT_IN_SCOPE: 该文档不在本次生成范围内');
            }
            const result = await readDocument(db, knowledgeDir, payload.baseId, args.documentId);
            return result ? text(result) : toolError('DOCUMENT_NOT_FOUND: 文档不存在或尚未就绪');
          },
        ),
        tool(
          'wiki_save_draft',
          'Save the full markdown draft for the bound page. Does not publish it.',
          {
            markdown: z.string().min(1),
            sourceChunkIds: z.array(z.string().min(1)).min(1),
          },
          async (args) => {
            try {
              const versionId = await save({
                markdown: args.markdown,
                sourceChunkIds: args.sourceChunkIds ?? [],
              });
              return text({ pageId: page.id, versionId, saved: true });
            } catch (err) {
              return toolError(errorText(err));
            }
          },
        ),
      ],
    });

    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const queryFn = deps.queryFn ?? query;
    const outcome = await runOneShotSdkQuery({
      signal,
      cwd,
      create: (controller) =>
        queryFn({
          prompt: buildPrompt({
            baseName: base.name,
            pageTitle: page.title,
            instruction: payload.instruction,
            sourceDocumentIds: payload.sourceDocumentIds,
          }),
          options: hermeticQueryOptions({
            model,
            cwd,
            mcpServers: { knowledge: server },
            allowedTools: WIKI_ALLOWED_TOOLS,
            abortController: controller,
            maxTurns: 12,
            maxBudgetUsd: 0.5,
          }),
        }),
    });
    if (outcome.status === 'aborted') throw new KnowledgeCancelled();
    if (outcome.status === 'no_result') throw new Error('SDK 没有返回结果');
    if (outcome.status === 'failure') throw new Error(outcome.message);
    if (savedVersions.length === 0) throw new Error('模型没有保存任何草稿');
  } catch (err) {
    if (signal.aborted || err instanceof KnowledgeCancelled) {
      throw new KnowledgeCancelled();
    }
    throw err;
  }
}
